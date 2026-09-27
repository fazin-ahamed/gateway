// Trajectory capture is optional body capture. The customer console must not
// depend on it: with capture disabled, the request ledger still records the
// request and the console endpoints still read it. Kept in its own file so no
// other test's fetch stub can leak into this one.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";
import { __test as gw, createApp } from "../src/index.js";

test("trajectory capture off has zero effect on the console ledger", async () => {
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key-please-change", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, console_auth, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind("sk-cap", "cap", 1, "usd", 1e9, 0, now, now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(1, "P", "http://up.local/v1", "direct", "openai", 1, 1, "round_robin", now).run();
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)")
    .bind(1, await gw.sealProviderKey(env, "sec"), "primary", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)").bind("glm-5.3", 1, "g").run();
  db.prepare("INSERT INTO gateway_settings (key, value, updated_at) VALUES ('trajectory_capture','off',?)").bind(now).run();
  const trajectoriesBefore = db.prepare("SELECT COUNT(*) n FROM trajectories").first().n;

  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  let app;
  try {
    app = createApp(env);
    const res = await app.fetch(new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-cap", "content-type": "application/json", "x-request-id": "cap-1" },
      body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] })
    }));
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = orig;
  }

  // The write side: the ledger row exists with real numbers.
  const row = db.prepare("SELECT * FROM request_summaries WHERE request_id=?").bind("cap-1").first();
  assert.ok(row, "the ledger row is written with capture off");
  assert.equal(row.status, "ok");
  assert.equal(row.total_tokens, 12);
  assert.equal(row.prompt_tokens, 9);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM trajectories").first().n, trajectoriesBefore,
    "with capture off no trajectory body row is written");

  // The read side: sign in AFTER the chat stub is restored, exactly the
  // pattern that passes in console-api.test.mjs.
  const auth = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: "sk-cap" })
  }));
  assert.equal(auth.status, 200);
  const cookie = "gw_client=" + auth.headers.get("set-cookie").match(/gw_client=([^;]+)/)[1];
  const ovRes = await app.fetch(new Request("http://gw/console/api/overview?days=7", { headers: { cookie } }));
  assert.equal(ovRes.status, 200, "the console session is usable after a chat request");
  const overview = await ovRes.json();
  assert.equal(overview.totals.requests, 1, "the overview counts the request from the ledger");
  assert.equal(overview.totals.ok_requests, 1, "ok_requests is real, not null");
  assert.equal(overview.totals.tokens, 12);
  const requests = await (await app.fetch(new Request("http://gw/console/api/requests?days=7", { headers: { cookie } }))).json();
  assert.equal(requests.requests.length, 1);
  const usage = await (await app.fetch(new Request("http://gw/console/api/usage?days=7", { headers: { cookie } }))).json();
  assert.equal(usage.models.length, 1);
  assert.equal(usage.models[0].requests, 1);
  assert.equal(usage.models[0].ok, 1);
});
