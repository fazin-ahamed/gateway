import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createDb } from "../../server/db.mjs";
import { createApp, __test as gw } from "../src/index.js";
import { critique, parseStyleRules, updatePosteriors, loadTasteReport, clearVerdicts } from "../src/taste.js";

const ask = (over = {}) => ({ messages: [{ role: "user", content: "hi" }], ...over });
const msg = (content, extra = {}) => ({ role: "assistant", content, ...extra });

test("a clean answer scores 1 with no violations", () => {
  const v = critique({ request: ask(), message: msg("Hello there."), finishReason: "stop" });
  assert.equal(v.score, 1);
  assert.deepEqual(v.violations, []);
  assert.equal(v.hard_failed, false);
});

test("empty and truncated answers are hard violations", () => {
  const empty = critique({ request: ask(), message: msg(""), finishReason: "stop" });
  assert.deepEqual(empty.violations.map((v) => v.rule), ["non_empty"]);
  assert.equal(empty.hard_failed, true);
  const cut = critique({ request: ask(), message: msg("partial"), finishReason: "length" });
  assert.deepEqual(cut.violations.map((v) => v.rule), ["not_truncated"]);
  assert.equal(cut.score, 0.5);
});

test("JSON mode requires strictly valid JSON; fenced JSON is repairable and soft", () => {
  const req = ask({ response_format: { type: "json_object" } });
  assert.equal(critique({ request: req, message: msg('{"a":1}'), finishReason: "stop" }).hard_failed, false);
  const fenced = critique({ request: req, message: msg('```json\n{"a":1}\n```'), finishReason: "stop" });
  assert.ok(fenced.violations.some((v) => v.rule === "json_valid"), "fenced JSON fails strict json_valid");
  assert.ok(fenced.violations.some((v) => v.rule === "json_repairable"), "but it is repairable");
  assert.equal(fenced.hard_failed, false, "repairable JSON is not a hard failure");
});

test("json_schema responses are validated against the schema", () => {
  const req = ask({ response_format: { type: "json_schema", json_schema: { name: "x", schema: { type: "object", required: ["n"], properties: { n: { type: "integer" } } } } } });
  assert.equal(critique({ request: req, message: msg('{"n":3}'), finishReason: "stop" }).hard_failed, false);
  const bad = critique({ request: req, message: msg('{"n":"three"}'), finishReason: "stop" });
  assert.deepEqual(bad.violations.map((v) => v.rule), ["json_schema_ok"]);
});

test("tool calls must name an advertised tool with schema-valid arguments", () => {
  const tools = [{ type: "function", function: { name: "t", parameters: { type: "object", required: ["a"], properties: { a: { type: "string" } } } } }];
  const call = (name, args) => msg(null, { tool_calls: [{ id: "1", type: "function", function: { name, arguments: args } }] });
  assert.equal(critique({ request: ask({ tools }), message: call("t", '{"a":"x"}'), finishReason: "tool_calls" }).hard_failed, false);
  assert.equal(critique({ request: ask({ tools }), message: call("other", "{}"), finishReason: "tool_calls" }).hard_failed, true);
  assert.equal(critique({ request: ask({ tools }), message: call("t", "{}"), finishReason: "tool_calls" }).hard_failed, true);
  assert.equal(critique({ request: ask({ tools }), message: call("t", "{bad"), finishReason: "tool_calls" }).hard_failed, true);
});

test("style rules are soft: they lower the score but never fail hard", () => {
  const styleRules = parseStyleRules([{ id: "dash", pattern: "\\u2014", label: "em dash" }, { id: "x", pattern: "(" }, { pattern: "" }]);
  assert.equal(styleRules.length, 1, "uncompilable and empty patterns are ignored");
  const v = critique({ request: ask(), message: msg("a \u2014 b"), finishReason: "stop", styleRules });
  assert.equal(v.hard_failed, false);
  assert.deepEqual(v.violations, [{ rule: "style", severity: "soft", label: "em dash" }]);
  assert.ok(v.score < 1 && v.score > 0.5);
});

test("posteriors accumulate per (model, rule) as Beta counts", async () => {
  const db = createDb(":memory:");
  await updatePosteriors(db, "m", [{ rule: "json_valid", pass: true }, { rule: "json_valid", pass: true }, { rule: "non_empty", pass: false }]);
  await updatePosteriors(db, "m", [{ rule: "json_valid", pass: false }]);
  const report = await loadTasteReport(db);
  assert.equal(report.length, 1);
  assert.deepEqual(report[0].rules.json_valid, { mean: 0.6, n: 3 }, "Beta(3,2) has mean 0.6 after 2 passes and 1 failure");
  assert.deepEqual(report[0].rules.non_empty, { mean: 0.333, n: 1 });
  assert.ok(report[0].taste > 0 && report[0].taste < 1);
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
  const setMode = (mode) => app.fetch(new Request("http://gw/admin/taste", { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ mode }) }));
  return {
    db, seen, setMode,
    call: (headers = {}) => app.fetch(new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-c", "content-type": "application/json", "x-gateway-cache": "off", ...headers },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "give json" }], response_format: { type: "json_object" } })
    }), { waitUntil() {} })
  };
}

test("annotate by default: headers report the score, posteriors collect without a toggle", async (t) => {
  const f = await fixture(t, ["not json"]);
  const res = await f.call();
  assert.equal(res.headers.get("x-gateway-taste"), "0.50", "annotate reports the score");
  const rows = await f.db.prepare("SELECT COUNT(*) n FROM taste_posteriors").first();
  assert.ok(Number(rows.n) > 0, "posteriors collected without any toggle");
});

test("annotate leaves the body identical, reports headers and learns", async (t) => {
  const f = await fixture(t, ["not json"]);
  await f.setMode("annotate");
  const res = await f.call();
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "not json", "annotate never edits the answer");
  assert.equal(res.headers.get("x-gateway-taste"), "0.50");
  assert.equal(res.headers.get("x-gateway-taste-violations"), "json_valid");
  assert.equal(res.headers.get("x-gateway-taste-retry"), null);
  assert.equal(f.seen.length, 1);
  const report = await (await createApp({ DB: f.db, ADMIN_TOKEN: "admin", PROVIDER_CRYPTO_KEY: "x" }).fetch(new Request("http://gw/admin/taste", { headers: { authorization: "Bearer admin" } }))).json();
  assert.equal(report.mode, "annotate");
  assert.equal(report.models[0].slug, "m");
  assert.equal(report.models[0].rules.json_valid.n, 1);
  assert.equal(report.recent[0].violations[0], "json_valid");
});

test("enforce retries exactly once with the critique and keeps the better answer", async (t) => {
  const f = await fixture(t, ["not json", '{"ok":true}']);
  await f.setMode("enforce");
  const res = await f.call();
  const body = await res.json();
  assert.equal(f.seen.length, 2, "one original call and exactly one retry");
  assert.match(f.seen[1].messages.at(-1).content, /valid JSON/);
  assert.equal(body.choices[0].message.content, '{"ok":true}');
  assert.equal(res.headers.get("x-gateway-taste"), "1.00");
  assert.equal(res.headers.get("x-gateway-taste-retry"), "1");
});

test("enforce never retries twice, even when the retry is also bad; the better score wins", async (t) => {
  const f = await fixture(t, ["not json", "still not json"]);
  await f.setMode("enforce");
  const res = await f.call();
  assert.equal(f.seen.length, 2);
  assert.equal((await res.json()).choices[0].message.content, "not json", "a tie keeps the original");
});

test("a per-request header overrides the stored mode", async (t) => {
  const f = await fixture(t, ["not json"]);
  const res = await f.call({ "x-gateway-taste": "annotate" });
  assert.equal(res.headers.get("x-gateway-taste"), "0.50");
});

test("admin validates mode and style rules", async (t) => {
  const f = await fixture(t, ["x"]);
  assert.equal((await f.setMode("loud")).status, 400);
  const app = createApp({ DB: f.db, ADMIN_TOKEN: "admin", PROVIDER_CRYPTO_KEY: "x" });
  const bad = await app.fetch(new Request("http://gw/admin/taste", { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ style_rules: [{ id: "a", pattern: "(" }] }) }));
  assert.equal(bad.status, 400);
  const anon = await app.fetch(new Request("http://gw/admin/taste"));
  assert.equal(anon.status, 401);
});
