import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createDb } from "../../server/db.mjs";
import { createApp, __test as gw } from "../src/index.js";

const denial = { error: { code: "", message: "无权访问 openrouter 分组 (request id: private-upstream-request)", type: "new_api_error" } };
const completion = { id: "answer", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Working route answered" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } };

async function fixture(t, handler, secrets = ["upstream-key"]) {
  gw.__resetCircuitState();
  gw.__resetRouterHealthCache();
  gw.__setModelsDevCache({});
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, ADMIN_TOKEN: "admin", PROVIDER_CRYPTO_KEY: "fixture-crypto" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers (id,name,base_url,transport,fmt,healthy,enabled,key_strategy,created_at) VALUES (1,'private-provider',?,'direct','openai',1,1,'failover',?)")
    .bind("http://127.0.0.1:" + server.address().port + "/v1", now).run();
  for (const secret of secrets)
    db.prepare("INSERT INTO provider_keys (provider_id,api_key,label,enabled,created_at) VALUES (1,?,?,1,?)").bind(await gw.sealProviderKey(env, secret), secret, now).run();
  db.prepare("INSERT INTO model_routes (slug,provider_id,upstream_model,rank,enabled) VALUES ('public-model',1,'private-model',0,1)").run();
  db.prepare("INSERT INTO api_keys (key_id,name,budget_mode,budget_limit,allowed_models,created_at,updated_at) VALUES ('sk-client','client','tokens',100000,'public-model',?,?)").bind(now, now).run();
  const app = createApp(env);
  const work = [];
  return {
    db,
    work,
    request(stream = false) {
      return app.fetch(new Request("http://gateway.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-client", "content-type": "application/json", "x-gateway-cache": "off" },
        body: JSON.stringify({ model: "public-model", messages: [{ role: "user", content: "Hello" }], stream, max_tokens: 8 })
      }), { waitUntil: promise => work.push(promise) });
    }
  };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function consumeBounded(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        let text = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return text;
          text += decoder.decode(chunk.value, { stream: true });
        }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Gateway did not close the completed upstream stream")), 2000); })
    ]);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}

for (const [status, body, expectedCode] of [
  [403, denial, "upstream_access_denied"],
  [401, { error: { message: "invalid credential at https://private-provider.test/?key=secret" } }, "upstream_authentication_failed"],
  [403, { error: { code: "", message: "request rejected", type: "new_api_error" } }, "upstream_access_denied"]
]) {
  test("upstream " + status + " " + expectedCode + " is actionable, private and never retried in place", async t => {
    let calls = 0;
    const f = await fixture(t, (_req, res) => { calls++; json(res, status, body); });
    const response = await f.request();
    const output = await response.json();
    assert.equal(calls, 1);
    assert.equal(response.status, 502, "an upstream credential problem is not a bad gateway-client key");
    assert.equal(output.error.code, expectedCode);
    assert.equal(output.error.type, "upstream_error");
    assert.doesNotMatch(JSON.stringify(output), /private-provider|private-upstream-request|openrouter|secret|https?:\/\//);
    const attempts = f.db.prepare("SELECT http_status,health_impact FROM route_attempts ORDER BY id").all().results;
    assert.deepEqual(attempts.map(a => [a.http_status, a.health_impact]), [[status, 0]]);
    assert.equal(gw.circuitOpen("provider", 1), false);
  });
}

test("a group-restricted credential can fail over without quarantining credentials used by other groups", async t => {
  const seen = [];
  const f = await fixture(t, (req, res) => {
    const credential = req.headers.authorization;
    seen.push(credential);
    json(res, credential === "Bearer restricted-key" ? 403 : 200, credential === "Bearer restricted-key" ? denial : completion);
  }, ["restricted-key", "working-key"]);
  const response = await f.request();
  const output = await response.json();
  assert.equal(response.status, 200);
  assert.equal(output.choices[0].message.content, "Working route answered");
  assert.deepEqual(seen, ["Bearer restricted-key", "Bearer working-key"]);
  const key = f.db.prepare("SELECT id FROM provider_keys WHERE label='restricted-key'").first();
  assert.equal(gw.circuitOpen("key", key.id), false, "a model/group restriction does not revoke the whole credential");
});

for (const terminal of ["finish-and-done", "done-only", "error-and-done", "finish-error-and-done"]) {
  test("a " + terminal + " stream closes even when the upstream leaves its socket open", async t => {
    let released;
    const upstreamReleased = new Promise(resolve => { released = resolve; });
    const f = await fixture(t, (_req, res) => {
      res.on("close", released);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = { id: "stream", model: "private-model", choices: [{ index: 0, delta: { content: "Answer" }, finish_reason: null }] };
      res.write("data: " + JSON.stringify(event) + "\n\n");
      if (terminal.startsWith("finish")) res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n");
      if (terminal.includes("error")) res.write("data: " + JSON.stringify({ error: { message: "private-provider upstream failed at https://secret.test" } }) + "\n\n");
      res.write('data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n');
      res.write("data: [DONE]\n\n");
    });
    const response = await f.request(true);
    const text = await consumeBounded(response);
    assert.equal(text.match(/data: \[DONE\]/g)?.length, 1);
    const failed = terminal.includes("error");
    assert.equal(text.match(/"finish_reason":"stop"/g)?.length || 0, terminal === "error-and-done" ? 0 : 1);
    if (terminal === "error-and-done") assert.match(text, /"finish_reason":"length"/);
    assert.doesNotMatch(text, /private-provider|secret\.test/);
    assert.match(text, /Answer/);
    await Promise.all(f.work);
    const summary = f.db.prepare("SELECT status,total_tokens FROM request_summaries").first();
    assert.deepEqual({ ...summary }, { status: failed ? "fail" : "ok", total_tokens: 5 });
    const attempt = f.db.prepare("SELECT success,failure_class FROM route_attempts").first();
    assert.deepEqual({ ...attempt }, { success: failed ? 0 : 1, failure_class: failed ? "stream_error" : "success" });
    let timer;
    try {
      await Promise.race([upstreamReleased, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Completed upstream connection was not released")), 2000); })]);
    } finally { clearTimeout(timer); }
  });
}
