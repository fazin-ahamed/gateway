// The shadow governor decides and records. It must never imply a launch.

import test from "node:test";
import assert from "node:assert/strict";

import { contextBucket, deadlineFor, chooseBackup, wouldHedge, DEFAULT_BASELINE_MS, DEADLINE_MIN_MS } from "../src/router/latency-governor.js";

const cand = (routeId, providerId, extra) => ({ routeId, providerId, slug: "m" + routeId, eligible: true, quality: 4, expectedTtftMs: 1000, ...extra });

test("context buckets cover the small and the huge", () => {
  assert.equal(contextBucket(1000), "lt8k");
  assert.equal(contextBucket(20000), "8k-32k");
  assert.equal(contextBucket(100000), "32k-128k");
  assert.equal(contextBucket(200000), "128k-512k");
  assert.equal(contextBucket(900000), "512k+");
});

test("a deadline uses the most specific baseline that has enough samples", () => {
  const d = deadlineFor({
    taskType: "code:generation",
    samples: [
      { key: "route-task-bucket", ttftMs: 1000, n: 3 },
      { key: "route-task", ttftMs: 2000, n: 12 },
      { key: "route", ttftMs: 9000, n: 40 }
    ]
  });
  assert.equal(d.source, "route-task", "three samples is not enough to trust");
  assert.equal(d.baselineMs, 2000);
  assert.equal(d.deadlineMs, 4400, "code waits 2.2x the baseline");
});

test("no history falls back to the static default and never below the floor", () => {
  const d = deadlineFor({ taskType: "chat", samples: [] });
  assert.equal(d.source, "default");
  assert.equal(d.baselineMs, DEFAULT_BASELINE_MS);
  assert.ok(d.deadlineMs >= DEADLINE_MIN_MS);
});

test("a fast primary would not hedge and a slow one would", () => {
  assert.equal(wouldHedge({ deadlineMs: 4000, ttftMs: 1200, finishedMs: 9000 }), false);
  assert.equal(wouldHedge({ deadlineMs: 4000, ttftMs: 8100, finishedMs: 20000 }), true);
});

test("a stream that dies after the deadline with no token would hedge", () => {
  assert.equal(wouldHedge({ deadlineMs: 4000, ttftMs: null, finishedMs: 30000 }), true);
});

test("a client cancel is not a latency failure", () => {
  assert.equal(wouldHedge({ deadlineMs: 4000, ttftMs: null, finishedMs: 30000, cancelled: true }), false);
});

test("an independent provider beats a faster route on the same provider", () => {
  const primary = cand(1, 10, { quality: 4.5 });
  const backup = chooseBackup(primary, [
    cand(2, 10, { expectedTtftMs: 200 }),
    cand(3, 20, { expectedTtftMs: 900 })
  ]);
  assert.equal(backup.routeId, 3);
  assert.equal(backup.providerId, 20);
});

test("a backup below the quality margin is rejected", () => {
  const primary = cand(1, 10, { quality: 4.5 });
  const backup = chooseBackup(primary, [
    cand(2, 20, { quality: 3.5, expectedTtftMs: 100 })
  ]);
  assert.equal(backup, null);
});

test("an ineligible backup is rejected even when it is fast", () => {
  const primary = cand(1, 10);
  const backup = chooseBackup(primary, [
    cand(2, 20, { eligible: false, expectedTtftMs: 50 })
  ]);
  assert.equal(backup, null);
});

test("with no independent provider the fastest same-provider route is the backup", () => {
  const primary = cand(1, 10);
  const backup = chooseBackup(primary, [
    cand(2, 10, { expectedTtftMs: 1500 }),
    cand(3, 10, { expectedTtftMs: 400 })
  ]);
  assert.equal(backup.routeId, 3);
});

test("an auto request writes one shadow row and legacy header-time rows never set the baseline", async () => {
  const { createApp, __test: gw } = await import("../src/index.js");
  const { createDb } = await import("../../server/db.mjs");
  const { readFileSync } = await import("node:fs");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key-please-change", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").bind("sk-auto", "t", 1, "usd", 1e9, now, now).run();
  for (const [id, name, url] of [[1, "A", "http://a.local/v1"], [2, "B", "http://b.local/v1"]]) {
    db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(id, name, url, "direct", "openai", 1, 1, "round_robin", now).run();
    db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)").bind(id, await gw.sealProviderKey(env, "secret-" + id), "primary", now).run();
  }
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)").bind("model-a", 1, "a").run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)").bind("model-b", 2, "b").run();
  // Pre-split rows: ttft_ms held header time, headers_ms is null. Enough to
  // dominate the baseline (and clamp the deadline to its max) if not excluded.
  for (const routeId of [1, 2])
    for (let i = 0; i < 12; i++)
      db.prepare("INSERT INTO route_attempts (request_id, route_id, public_slug, started_at, success, ttft_ms, headers_ms) VALUES (?,?,?,?,1,?,NULL)").bind("legacy-" + routeId + "-" + i, routeId, "m", now, 30000).run();
  gw.__setModelsDevCache({
    p: { models: {
      "model-a": { cost: { input: 1, output: 2 }, limit: { context: 128000, output: 8192 }, tool_call: true },
      "model-b": { cost: { input: 1, output: 2 }, limit: { context: 128000, output: 8192 }, tool_call: true }
    } }
  });
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const app = createApp(env);
    const res = await app.fetch(new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-auto", "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] })
    }));
    assert.equal(res.status, 200);
    assert.equal(calls, 1, "the shadow must not add an upstream call");
    const rows = (await db.prepare("SELECT * FROM latency_shadow_decisions").all()).results;
    assert.equal(rows.length, 1, "exactly one shadow row per auto request");
    assert.equal(rows[0].deadline_source, "default", "legacy header-time rows must not set the baseline");
    assert.ok(rows[0].deadline_ms > 0 && rows[0].deadline_ms < 60000, "a 30s legacy ttft must not clamp the deadline to its maximum");
    assert.equal(rows[0].would_hedge, 0, "a fast response is not late");
    assert.notEqual(rows[0].primary_route_id, null);
  } finally {
    globalThis.fetch = origFetch;
    gw.__setModelsDevCache(null);
  }
});
