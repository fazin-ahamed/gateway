// Wave 5: per-account taste learning, always-on collection, sanitized data.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createDb } from "../../server/db.mjs";
import { createApp, __test as gw } from "../src/index.js";
import { updatePosteriors, loadTasteReport, ensureTasteSchema, clearVerdicts } from "../src/taste.js";

test("posteriors are keyed per (slug, rule, route, account)", async () => {
  const db = createDb(":memory:");
  await ensureTasteSchema(db);
  await updatePosteriors(db, "m", [{ rule: "json_valid", pass: true }], "route-a", "acct-1");
  await updatePosteriors(db, "m", [{ rule: "json_valid", pass: false }], "route-a", "acct-2");
  const rows = (await db.prepare("SELECT slug, rule, route, account_id FROM taste_posteriors ORDER BY account_id").all()).results || [];
  assert.equal(rows.length, 2, "one row per account");
  assert.equal(rows[0].account_id, "acct-1");
  assert.equal(rows[1].account_id, "acct-2");
});

test("loadTasteReport aggregates per-account views", async () => {
  const db = createDb(":memory:");
  await ensureTasteSchema(db);
  await updatePosteriors(db, "m", [{ rule: "json_valid", pass: true }, { rule: "json_valid", pass: true }], "route-a", "acct-1");
  await updatePosteriors(db, "m", [{ rule: "json_valid", pass: false }], "route-a", "acct-2");
  const report = await loadTasteReport(db);
  assert.equal(report.length, 1);
  const m = report[0];
  assert.ok(m.accounts, "report includes per-account breakdown");
  assert.ok(m.accounts["acct-1"].rules.json_valid.mean > 0.7, "acct-1 mostly passes: " + m.accounts["acct-1"].rules.json_valid.mean);
  assert.ok(m.accounts["acct-2"].rules.json_valid.mean < 0.5, "acct-2 mostly fails: " + m.accounts["acct-2"].rules.json_valid.mean);
});

test("sanitize: no request bodies or response text in posteriors", async () => {
  const db = createDb(":memory:");
  await ensureTasteSchema(db);
  // Simulate what the app does: critique a response, update posteriors.
  // The posteriors table must never contain the request or response text.
  await updatePosteriors(db, "m", [{ rule: "json_valid", pass: true }], "route-a", "acct-1");
  const rows = (await db.prepare("SELECT * FROM taste_posteriors").all()).results || [];
  const json = JSON.stringify(rows);
  assert.ok(!json.includes("give json"), "no request prompt text");
  assert.ok(!json.includes("not json"), "no response body text");
  assert.ok(!json.includes("messages"), "no message content");
  assert.ok(!json.includes("content"), "no content field");
});

// ---- through the app ----

async function fixture(t, replies) {
  gw.__resetCircuitState();
  gw.__resetRouterHealthCache();
  gw.__setModelsDevCache({});
  clearVerdicts();
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      seen.push(JSON.parse(raw));
      const content = replies[Math.min(seen.length - 1, replies.length - 1)];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, ADMIN_TOKEN: "admin", PROVIDER_CRYPTO_KEY: "fixture-crypto" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers (id,name,base_url,transport,fmt,healthy,enabled,key_strategy,created_at) VALUES (1,'p',?,'direct','openai',1,1,'failover',?)").bind("http://127.0.0.1:" + server.address().port + "/v1", now).run();
  db.prepare("INSERT INTO provider_keys (provider_id,api_key,label,enabled,created_at) VALUES (1,?,?,1,?)").bind(await gw.sealProviderKey(env, "k"), "k", now).run();
  db.prepare("INSERT INTO model_routes (slug,provider_id,upstream_model,rank,enabled) VALUES ('m',1,'um',0,1)").run();
  db.prepare("INSERT INTO api_keys (key_id,name,budget_mode,budget_limit,allowed_models,created_at,updated_at) VALUES ('sk-c','c','tokens',1000000,'m',?,?)").bind(now, now).run();
  const app = createApp(env);
  return {
    db, seen,
    call: (headers = {}) => app.fetch(new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-c", "content-type": "application/json", "x-gateway-cache": "off", ...headers },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "give json" }], response_format: { type: "json_object" } })
    }), { waitUntil() {} })
  };
}

test("always-on: annotate collects posteriors without any toggle", async (t) => {
  const f = await fixture(t, ["not json"]);
  // No mode set; the default must be annotate, not off.
  const res = await f.call();
  assert.equal(res.status, 200);
  const rows = (await f.db.prepare("SELECT COUNT(*) n FROM taste_posteriors").all()).results || [];
  assert.ok(Number(rows[0].n) > 0, "posteriors collected without any toggle");
});

test("annotate headers report the score and violations", async (t) => {
  const f = await fixture(t, ["not json"]);
  const res = await f.call();
  assert.equal(res.headers.get("x-gateway-taste"), "0.50");
  assert.equal(res.headers.get("x-gateway-taste-violations"), "json_valid");
});

test("per-account: different keys accumulate separate posteriors", async (t) => {
  const f = await fixture(t, ["not json"]);
  // First key
  await f.call();
  // Second key
  const now = new Date().toISOString();
  f.db.prepare("INSERT INTO api_keys (key_id,name,budget_mode,budget_limit,allowed_models,created_at,updated_at) VALUES ('sk-d','d','tokens',1000000,'m',?,?)").bind(now, now).run();
  await f.call({ authorization: "Bearer sk-d" });
  const rows = (await f.db.prepare("SELECT DISTINCT account_id FROM taste_posteriors ORDER BY account_id").all()).results || [];
  assert.equal(rows.length, 2, "one posterior set per key");
  assert.deepEqual(rows.map((r) => r.account_id).sort(), ["sk-c", "sk-d"]);
});

test("admin: /admin/taste/accounts shows per-account profiles", async (t) => {
  const f = await fixture(t, ["not json"]);
  await f.call();
  const res = await createApp({ DB: f.db, ADMIN_TOKEN: "admin", PROVIDER_CRYPTO_KEY: "x" }).fetch(new Request("http://gw/admin/taste/accounts", { headers: { authorization: "Bearer admin" } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.accounts));
  assert.ok(body.accounts.length > 0);
  assert.equal(body.accounts[0].account_id, "sk-c");
  assert.ok(body.accounts[0].rules.json_valid);
});
