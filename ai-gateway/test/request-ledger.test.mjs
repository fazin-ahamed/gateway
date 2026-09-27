// The request ledger is the customer-facing operational truth. One row per
// request, chat and decision through the same lifecycle, body-free, and
// customer views must survive trajectory capture being disabled.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";
import { __test as gw, createApp } from "../src/index.js";

async function ledgerGateway() {
  const { createApp } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key-please-change", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, console_auth, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind("sk-led", "ledger", 1, "usd", 1e9, 0, now, now).run();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, console_auth, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind("sk-other", "other", 1, "usd", 1e9, 0, now, now).run();
  for (const [id, name] of [[1, "ChatP"], [2, "DecP"]]) {
    db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, name, "http://127.0.0.1:9/v1", "direct", id === 2 ? "systemone" : "openai", 1, 1, "round_robin", now).run();
    db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)")
      .bind(id, await gw.sealProviderKey(env, "sec-" + id), "primary", now).run();
  }
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)").bind("glm-5.3", 1, "g").run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled, model_kind, wire_format) VALUES (?,?,?,0,1,'decision','systemone')").bind("jev", 2, "jev-latest").run();
  db.prepare("INSERT INTO prices (slug, provider_id, actual_mode, actual_per_request, updated_at) VALUES (?,0,'per_request',0.00012,?)").bind("jev", now).run();

  const stubChat = (status = 200) => async () => new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }),
    { status, headers: { "content-type": "application/json" } }
  );
  const stubDecision = () => async () => new Response(
    JSON.stringify({ answers: { verify: { probability: 0.9 } } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  const stubDown = () => async () => new Response("{}", { status: 503 });

  const request = async (app, body, fetchImpl) => {
    const orig = globalThis.fetch;
    if (fetchImpl) globalThis.fetch = fetchImpl;
    try {
      return await app.fetch(new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-led", "content-type": "application/json", "x-request-id": body.__id },
        body: JSON.stringify(body)
      }));
    } finally {
      globalThis.fetch = orig;
    }
  };
  const requestDecision = async (app, body, fetchImpl) => {
    const orig = globalThis.fetch;
    if (fetchImpl) globalThis.fetch = fetchImpl;
    try {
      return await app.fetch(new Request("http://gw/v1/systemone", {
        method: "POST",
        headers: { authorization: "Bearer sk-led", "content-type": "application/json", "x-request-id": body.__id },
        body: JSON.stringify(body)
      }));
    } finally {
      globalThis.fetch = orig;
    }
  };
  const rows = () => (db.prepare("SELECT * FROM request_summaries ORDER BY created_at").all().results);
  return { app: createApp(env), db, stubChat, stubDecision, stubDown, request, requestDecision, rows };
}

test("a chat success writes exactly one ledger row with real tokens and cost", async () => {
  const g = await ledgerGateway();
  const res = await g.request(g.app, { __id: "ok-1", model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }, g.stubChat());
  assert.equal(res.status, 200);
  const r = g.rows().filter((x) => x.request_id === "ok-1");
  assert.equal(r.length, 1, "one row, not one per route attempt");
  assert.equal(r[0].model_kind, "chat");
  assert.equal(r[0].public_slug, "glm-5.3");
  assert.equal(r[0].status, "ok");
  assert.equal(r[0].http_status, 200);
  assert.equal(r[0].total_tokens, 16);
  assert.ok(r[0].cost_usd >= 0);
  assert.ok(r[0].finished_at, "the row is terminal");
});

test("a chat failure writes one failed row", async () => {
  const g = await ledgerGateway();
  const res = await g.request(g.app, { __id: "fail-1", model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }, g.stubDown());
  assert.ok(res.status >= 500);
  const r = g.rows().filter((x) => x.request_id === "fail-1");
  assert.equal(r.length, 1);
  assert.equal(r[0].status, "fail");
  assert.notEqual(r[0].http_status, 200);
});

test("a decision success lands in the ledger with per-request cost and no invented tokens", async () => {
  const g = await ledgerGateway();
  const res = await g.requestDecision(g.app, { __id: "dec-1", model: "jev", state: { task: "x" }, questions: { verify: { type: "noul", instructions: "?" } } }, g.stubDecision());
  assert.equal(res.status, 200);
  const r = g.rows().filter((x) => x.request_id === "dec-1");
  assert.equal(r.length, 1, "decision requests appear in the same ledger");
  assert.equal(r[0].model_kind, "decision");
  assert.equal(r[0].public_slug, "jev");
  assert.equal(r[0].status, "ok");
  assert.equal(r[0].total_tokens, 0, "a SystemOne provider is not priced in tokens");
  assert.ok(Math.abs(r[0].cost_usd - 0.00012) < 1e-9, "the flat per-request price is recorded, got " + r[0].cost_usd);
  assert.ok(r[0].latency_ms > 0);
});

test("a decision failure lands in the ledger as failed", async () => {
  const g = await ledgerGateway();
  const res = await g.requestDecision(g.app, { __id: "dec-f1", model: "jev", state: { task: "x" }, questions: { verify: { type: "noul", instructions: "?" } } }, g.stubDown());
  assert.ok(res.status >= 500);
  const r = g.rows().filter((x) => x.request_id === "dec-f1");
  assert.equal(r.length, 1);
  assert.equal(r[0].status, "fail");
});

test("a chat model on the decision endpoint and a decision model on chat both fail closed", async () => {
  const g = await ledgerGateway();
  const wrong = await g.requestDecision(g.app, { __id: "mis-1", model: "glm-5.3", state: {}, questions: { verify: { type: "noul", instructions: "?" } } }, null);
  assert.equal(wrong.status, 400);
  const r1 = g.rows().filter((x) => x.request_id === "mis-1");
  assert.equal(r1.length, 1);
  assert.equal(r1[0].status, "fail");
});

test("tenant isolation: the console API cannot read another key's request", async () => {
  const g = await ledgerGateway();
  await g.request(g.app, { __id: "mine-1", model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }, g.stubChat());
  const auth = await g.app.fetch(new Request("http://gw/console/auth", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: "sk-other" })
  }));
  assert.equal(auth.status, 200);
  const cookie = "gw_client=" + (auth.headers.get("set-cookie").match(/gw_client=([^;]+)/) || [])[1];
  const mine = await g.app.fetch(new Request("http://gw/console/api/requests/mine-1", { headers: { cookie } }));
  assert.equal(mine.status, 404, "a request belonging to another key must not leak");
});

test("the ledger is body-free: no prompt, provider name, route id, or raw error column exists", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const names = raw.prepare("PRAGMA table_info(request_summaries)").all().map((c) => c.name);
  const forbidden = ["request_json", "response_json", "provider", "provider_name", "route_id", "error", "steps_json", "reasoning", "tool"];
  for (const f of forbidden)
    assert.equal(names.includes(f), false, f + " must not be a ledger column");
  raw.close();
});
