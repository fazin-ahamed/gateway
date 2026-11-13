// Console taste endpoints: the session sees its own sanitized taste profile
// and verdict history, scoped to its account and owned keys.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createDb } from "../../server/db.mjs";
import { createApp, __test as gw } from "../src/index.js";
import { clearVerdicts } from "../src/taste.js";

function cookieFrom(res) {
  const set = res.headers.get("set-cookie") || "";
  const m = set.match(/gw_client=([^;]+)/);
  return m ? "gw_client=" + m[1] : "";
}

async function fixture(t, replies) {
  gw.__resetCircuitState();
  gw.__resetRouterHealthCache();
  gw.__setModelsDevCache({});
  clearVerdicts();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const content = replies[0];
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
  db.prepare("UPDATE api_keys SET console_auth=0 WHERE key_id='sk-c'").run();
  const app = createApp(env);
  const auth = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: "sk-c" })
  }));
  assert.equal(auth.status, 200);
  const cookie = cookieFrom(auth);
  return {
    db, app, cookie,
    call: () => app.fetch(new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-c", "content-type": "application/json", "x-gateway-cache": "off" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "give json" }], response_format: { type: "json_object" } })
    }), { waitUntil() {} })
  };
}

test("the console sees its own taste profile after traffic", async (t) => {
  const f = await fixture(t, ["not json"]);
  await f.call();
  await f.call();
  const res = await f.app.fetch(new Request("http://gw/console/api/taste", { headers: { cookie: f.cookie } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.samples >= 2, "two verdicts counted");
  assert.ok(body.rules.json_valid, "json_valid rule present");
  assert.ok(body.rules.json_valid.mean < 0.5, "the model fails json_valid: " + body.rules.json_valid.mean);
  assert.ok(body.taste != null, "a taste score exists");
  // Sanitized: no request or response text in the profile.
  const json = JSON.stringify(body);
  assert.ok(!json.includes("give json"), "no request prompt");
  assert.ok(!json.includes("not json"), "no response body");
});

test("the verdicts feed returns sanitized rows, newest first", async (t) => {
  const f = await fixture(t, ["not json"]);
  await f.call();
  const res = await f.app.fetch(new Request("http://gw/console/api/taste/verdicts", { headers: { cookie: f.cookie } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.verdicts));
  assert.ok(body.verdicts.length >= 1);
  const v = body.verdicts[0];
  assert.equal(v.slug, "m");
  assert.equal(typeof v.score, "number");
  assert.ok(Array.isArray(v.violations));
  assert.ok(v.violations.includes("json_valid"));
  assert.ok(v.account_id.length > 0, "scoped to an account");
  const json = JSON.stringify(body);
  assert.ok(!json.includes("give json"), "no request prompt in the feed");
  assert.ok(!json.includes("not json"), "no response body in the feed");
});

test("the trend buckets scores per hour", async (t) => {
  const f = await fixture(t, ["not json"]);
  await f.call();
  const res = await f.app.fetch(new Request("http://gw/console/api/taste", { headers: { cookie: f.cookie } }));
  const body = await res.json();
  assert.ok(Array.isArray(body.trend));
  assert.ok(body.trend.length >= 1, "at least one hour bucket");
  assert.equal(typeof body.trend[0].score, "number");
  assert.ok(body.trend[0].n >= 1);
});

test("a session with no traffic gets an empty profile, not an error", async (t) => {
  const f = await fixture(t, []);
  const res = await f.app.fetch(new Request("http://gw/console/api/taste", { headers: { cookie: f.cookie } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.taste, null);
  assert.equal(body.samples, 0);
  assert.deepEqual(body.trend, []);
});

test("taste endpoints require a session", async (t) => {
  const f = await fixture(t, []);
  const res = await f.app.fetch(new Request("http://gw/console/api/taste"));
  assert.equal(res.status, 401);
  const res2 = await f.app.fetch(new Request("http://gw/console/api/taste/verdicts"));
  assert.equal(res2.status, 401);
});

test("another key's verdicts are not visible to this session", async (t) => {
  const f = await fixture(t, ["not json"]);
  // Traffic from a DIFFERENT key.
  const now = new Date().toISOString();
  f.db.prepare("INSERT INTO api_keys (key_id,name,budget_mode,budget_limit,allowed_models,created_at,updated_at) VALUES ('sk-other','other','tokens',1000000,'m',?,?)").bind(now, now).run();
  await f.app.fetch(new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer sk-other", "content-type": "application/json", "x-gateway-cache": "off" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] })
  }), { waitUntil() {} });
  const res = await f.app.fetch(new Request("http://gw/console/api/taste", { headers: { cookie: f.cookie } }));
  const body = await res.json();
  assert.equal(body.samples, 0, "sk-c sees none of sk-other's verdicts");
});
