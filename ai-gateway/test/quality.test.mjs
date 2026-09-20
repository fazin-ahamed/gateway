import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SIGNALS,
  QUALITY_PRIOR_ALPHA,
  QUALITY_PRIOR_BETA,
  TOOL_VALID_WEIGHT_SOLO,
  TOOL_VALID_WEIGHT_DEDUPED,
  deriveQualityFromAttempt,
  deriveToolValidFromToolCalls,
  fractionalUpdate,
  emitQualityObservations,
  resolveServingAttemptId,
  loadQualityShadow
} from "../src/router/quality.js";
import { createApp, __test as t } from "../src/index.js";
import { createDb } from "../../server/db.mjs";

function memDb() {
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return db;
}
const ctxOf = (db) => ({ env: { DB: db } });
const count = (db, table) => db.prepare("SELECT COUNT(*) AS n FROM " + table).all().results[0].n;

// ---------- derivation (pure) ----------

test("a bare 200 with no evidence derives zero quality signals", () => {
  assert.deepEqual(deriveQualityFromAttempt({ success: 1 }), []);
  assert.deepEqual(deriveQualityFromAttempt({ success: 1, prompt_tokens: 12 }), []);
});

test("a failed request carries no answer-quality evidence even with tool fields", () => {
  assert.deepEqual(deriveQualityFromAttempt({ success: 0, tool_valid: 1, tool_success: 1 }), []);
});

test("tool_valid is solo-weighted alone and deduped when tool_success exists", () => {
  const solo = deriveQualityFromAttempt({ success: 1, tool_valid: 1 });
  assert.deepEqual(solo.map((s) => [s.signal_type, s.weight]), [["tool_valid", TOOL_VALID_WEIGHT_SOLO]]);
  const both = deriveQualityFromAttempt({ success: 1, tool_valid: 1, tool_success: 1 });
  const w = Object.fromEntries(both.map((s) => [s.signal_type, s.weight]));
  assert.equal(w.tool_valid, TOOL_VALID_WEIGHT_DEDUPED);
  assert.equal(w.tool_success, SIGNALS.tool_success.weight);
  const inv = deriveQualityFromAttempt({ success: 1, tool_valid: 0 });
  assert.equal(inv[0].signal_type, "tool_invalid");
  assert.equal(inv[0].value, 0);
});

test("verifier scores clamp to 0..1 and keep their continuous value", () => {
  const sig = deriveQualityFromAttempt({ success: 1, verification_score: 1.7 });
  assert.equal(sig.length, 1);
  assert.equal(sig[0].signal_type, "verifier_score");
  assert.equal(sig[0].value, 1);
});

test("fractional Beta update combines binary and continuous evidence", () => {
  const { dAlpha, dBeta, w, ow, sw } = fractionalUpdate([
    { weight: 0.5, value: 0.8, objective: 0 },
    { weight: 0.9, value: 1, objective: 1 }
  ]);
  assert.ok(Math.abs(dAlpha - 1.3) < 1e-9, "alpha += 0.5*0.8 + 0.9*1");
  assert.ok(Math.abs(dBeta - 0.1) < 1e-9, "beta += 0.5*0.2 + 0.9*0");
  assert.ok(Math.abs(w - 1.4) < 1e-9);
  assert.equal(ow, 0.9);
  assert.equal(sw, 0.5);
});

test("tool-call structural validity: null when none emitted, 1 valid, 0 malformed", () => {
  assert.equal(deriveToolValidFromToolCalls(undefined), null);
  assert.equal(deriveToolValidFromToolCalls([]), null);
  assert.equal(deriveToolValidFromToolCalls([{ type: "function", function: { name: "f", arguments: '{"a":1}' } }]), 1);
  assert.equal(deriveToolValidFromToolCalls([{ type: "function", function: { name: "f", arguments: '{"a":1' } }]), 0);
  assert.equal(deriveToolValidFromToolCalls([{ function: { arguments: "{}" } }]), 0);
  assert.equal(deriveToolValidFromToolCalls([{ type: "function", function: { name: "f", arguments: "" } }]), 1);
});

// ---------- emission + derived stats (in-memory DB) ----------

test("emission: a bare 200 writes zero quality rows anywhere", async () => {
  const db = memDb();
  const signals = await emitQualityObservations(ctxOf(db), 1, { request_id: "r1", success: 1, upstream_model: "up-m", task_type: "chat:casual" });
  assert.deepEqual(signals, []);
  assert.equal(count(db, "quality_observations"), 0);
  assert.equal(count(db, "model_quality_stats"), 0);
});

test("emission: failure with tool fields still writes nothing (no answer existed)", async () => {
  const db = memDb();
  const signals = await emitQualityObservations(ctxOf(db), 1, { request_id: "r2", success: 0, tool_valid: 0, tool_success: 0 });
  assert.deepEqual(signals, []);
  assert.equal(count(db, "quality_observations"), 0);
});

test("emission: tool evidence writes observations, folds fractional stats, and replays idempotently", async () => {
  const db = memDb();
  const c = ctxOf(db);
  const a = { request_id: "r3", success: 1, upstream_model: "up-m", task_type: "code:debug", tool_valid: 1, tool_success: 1 };
  const first = await emitQualityObservations(c, 11, a);
  assert.equal(first.length, 2);
  const obs = db.prepare("SELECT signal_type, weight FROM quality_observations WHERE route_attempt_id=11").all().results;
  assert.equal(obs.length, 2);
  const w = Object.fromEntries(obs.map((o) => [o.signal_type, o.weight]));
  assert.equal(w.tool_valid, TOOL_VALID_WEIGHT_DEDUPED);
  assert.equal(w.tool_success, SIGNALS.tool_success.weight);
  const s1 = db.prepare("SELECT quality_alpha, quality_beta, observation_weight, objective_weight FROM model_quality_stats WHERE model_identity='raw:up-m' AND task_type='code:debug'").all().results[0];
  assert.ok(Math.abs(s1.quality_alpha - (QUALITY_PRIOR_ALPHA + TOOL_VALID_WEIGHT_DEDUPED + SIGNALS.tool_success.weight)) < 1e-9);
  assert.ok(Math.abs(s1.quality_beta - QUALITY_PRIOR_BETA) < 1e-9);
  assert.ok(Math.abs(s1.observation_weight - (TOOL_VALID_WEIGHT_DEDUPED + SIGNALS.tool_success.weight)) < 1e-9);
  assert.equal(s1.objective_weight, s1.observation_weight, "tool evidence is objective");
  // Replay the same (request, attempt, signal, source) — UNIQUE dedup, no double-count.
  await emitQualityObservations(c, 11, a);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quality_observations WHERE route_attempt_id=11").all().results[0].n, 2);
  const s2 = db.prepare("SELECT quality_alpha FROM model_quality_stats WHERE model_identity='raw:up-m' AND task_type='code:debug'").all().results[0];
  assert.ok(Math.abs(s2.quality_alpha - s1.quality_alpha) < 1e-9, "replay must not double-count");
});

test("shadow loader withholds the mean until evidence matures", async () => {
  const db = memDb();
  const c = ctxOf(db);
  db.prepare("INSERT INTO model_quality_stats (model_identity, task_type, quality_alpha, quality_beta, observation_weight, objective_weight, subjective_weight, updated_at) VALUES ('raw:m1','code:debug',8,2,10,10,0,?)")
    .bind(new Date().toISOString()).run();
  const mature = await loadQualityShadow(c, "raw:m1", "code:debug");
  assert.equal(mature.sufficient, true);
  assert.equal(mature.mean, 0.8);
  const cold = await loadQualityShadow(c, "raw:m2", "code:debug");
  assert.equal(cold.sufficient, false);
  assert.ok(!("mean" in cold), "no fake 50% from the prior mean");
});

test("request-level feedback attaches to the final SUCCESSFUL attempt", async () => {
  const db = memDb();
  const now = new Date().toISOString();
  // public_slug is NOT NULL in the DDL — the seed must satisfy every NOT NULL
  // column, not just the ones this assertion reads back.
  const ins = db.prepare("INSERT INTO route_attempts (request_id, public_slug, attempt_index, key_attempt_index, started_at, finished_at, success, health_impact) VALUES (?,?,?,?,?,?,?,?)");
  ins.bind("r4", "m", 0, 0, now, now, 0, 1).run();
  ins.bind("r4", "m", 1, 0, now, now, 1, 1).run();
  ins.bind("r4", "m", 2, 0, now, now, 0, 1).run();
  const expected = db.prepare("SELECT id FROM route_attempts WHERE attempt_index=1").all().results[0].id;
  const serving = await resolveServingAttemptId(ctxOf(db), "r4");
  assert.equal(serving, expected, "the serving attempt is the last success, not the last attempt");
});

// ---------- end-to-end through the gateway ----------

async function seedGatewayWorld(db, env) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind("sk-test", "t", 1, "usd", 1e9, now, now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (1,'P','http://up.local/v1','direct','openai',1,1,'round_robin',?)")
    .bind(now).run();
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)")
    .bind(1, await t.sealProviderKey(env, "secret"), "k1", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES ('m',1,'up-m',0,1)").run();
}

test("end-to-end: plain 200 trains nothing; a tool-call 200 trains tool_valid at solo weight", async () => {
  const db = memDb();
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key-please-change", ADMIN_TOKEN: "admin" };
  await seedGatewayWorld(db, env);
  const app = createApp(env);

  const chatBody = (toolCalls) => JSON.stringify({
    id: "x", object: "chat.completion",
    choices: [{
      index: 0,
      message: toolCalls
        ? { role: "assistant", content: null, tool_calls: toolCalls }
        : { role: "assistant", content: "hi" },
      finish_reason: toolCalls ? "tool_calls" : "stop"
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  });

  let withTools = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("up.local"))
      return new Response(chatBody(withTools ? [{ type: "function", id: "c1", function: { name: "get_weather", arguments: '{"city":"Dubai"}' } }] : null), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("unexpected " + u, { status: 500 });
  };
  try {
    const call = (content) => app.fetch(new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content }] })
    }));

    // 1) Plain 200, no tool calls: zero quality rows anywhere, tool_valid NULL.
    withTools = false;
    const r1 = await call("hi");
    assert.equal(r1.status, 200);
    assert.equal(count(db, "quality_observations"), 0);
    assert.equal(count(db, "model_quality_stats"), 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM route_attempts WHERE tool_valid IS NOT NULL").all().results[0].n, 0);

    // 2) 200 with a structurally valid tool call: tool_valid evidence trains
    //    the provisional raw:up-m identity at the solo weight (no execution
    //    outcome known yet — no dedup, no tool_success signal).
    withTools = true;
    const r2 = await call("what is the weather in Dubai right now?");
    assert.equal(r2.status, 200);
    const att = db.prepare("SELECT id, tool_valid FROM route_attempts WHERE tool_valid IS NOT NULL ORDER BY id DESC").all().results[0];
    assert.equal(att.tool_valid, 1);
    const obs = db.prepare("SELECT signal_type, value, weight FROM quality_observations WHERE route_attempt_id=?").bind(att.id).all().results;
    assert.deepEqual(obs.map((o) => o.signal_type), ["tool_valid"]);
    assert.equal(obs[0].value, 1);
    assert.equal(obs[0].weight, TOOL_VALID_WEIGHT_SOLO);
    const s = db.prepare("SELECT quality_alpha, quality_beta FROM model_quality_stats WHERE model_identity='raw:up-m'").all().results[0];
    assert.ok(Math.abs(s.quality_alpha - (QUALITY_PRIOR_ALPHA + TOOL_VALID_WEIGHT_SOLO)) < 1e-9);
    assert.ok(Math.abs(s.quality_beta - QUALITY_PRIOR_BETA) < 1e-9);
  } finally {
    globalThis.fetch = realFetch;
  }
});
