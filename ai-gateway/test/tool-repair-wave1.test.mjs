// Wave-1 regressions: the stream-tail gap, the enforce handoff shape, and the
// trajectory content buffer overflowing the cap. Each test names the invariant.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createDb } from "../../server/db.mjs";
import { createApp, __test as gw } from "../src/index.js";
import { resetToolRepairStats, getToolRepairStats } from "../src/tool-response-repair.js";

const TOOLS = [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } }
  }
}];

async function fixture(t, handler) {
  gw.__resetCircuitState();
  gw.__resetRouterHealthCache();
  gw.__setModelsDevCache({});
  resetToolRepairStats();
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, ADMIN_TOKEN: "admin", PROVIDER_CRYPTO_KEY: "fixture-crypto" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers (id,name,base_url,transport,fmt,healthy,enabled,key_strategy,created_at) VALUES (1,'p',?,'direct','openai',1,1,'failover',?)")
    .bind("http://127.0.0.1:" + server.address().port + "/v1", now).run();
  db.prepare("INSERT INTO provider_keys (provider_id,api_key,label,enabled,created_at) VALUES (1,?,?,1,?)").bind(await gw.sealProviderKey(env, "k"), "k", now).run();
  db.prepare("INSERT INTO model_routes (slug,provider_id,upstream_model,rank,enabled) VALUES ('m',1,'um',0,1)").run();
  db.prepare("INSERT INTO api_keys (key_id,name,budget_mode,budget_limit,allowed_models,created_at,updated_at) VALUES ('sk-c','c','tokens',1000000,'m',?,?)").bind(now, now).run();
  const app = createApp(env);
  return {
    db, app,
    call({ stream = false, tools = TOOLS, tasteMode = null } = {}) {
      const headers = { authorization: "Bearer sk-c", "content-type": "application/json", "x-gateway-cache": "off" };
      if (tasteMode) headers["x-gateway-taste"] = tasteMode;
      return app.fetch(new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "m", stream, messages: [{ role: "user", content: "go" }], ...(tools ? { tools } : {}) })
      }), { waitUntil() {} });
    },
    setTaste: (mode) => app.fetch(new Request("http://gw/admin/taste", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ mode })
    }))
  };
}

function sse(res, frames) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of frames) res.write("data: " + (typeof f === "string" ? f : JSON.stringify(f)) + "\n\n");
}
const chunk = (delta, finish) => ({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] });

async function readAll(res) {
  const text = await res.text();
  return text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
}

test("stream tail gap: a slot still open at finish_reason is flushed exactly once and never again", async (t) => {
  const f = await fixture(t, (_req, res) => {
    sse(res, [
      chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a.js"}' } }] }),
      chunk({}, "tool_calls"),
      chunk({ tool_calls: [{ index: 1, id: "c2", function: { name: "read_file", arguments: '{"path":"b.js"}' } }] }),
      "[DONE]"
    ]);
    res.end();
  });
  const frames = (await readAll(await f.call({ stream: true }))).filter((x) => x !== "[DONE]").map((x) => JSON.parse(x));
  const toolChunks = frames.filter((c) => c.choices[0].delta && c.choices[0].delta.tool_calls);
  const emittedIds = toolChunks.flatMap((c) => c.choices[0].delta.tool_calls.map((tc) => tc.id));
  // The first call flushes at finish_reason; the second, still open, flushes at
  // the terminal. Before the fix the finish() loop mutated this.slots while
  // iterating, so a slot could be re-emitted or dropped.
  assert.deepEqual(emittedIds.sort(), ["c1", "c2"], "each call emitted exactly once");
  // No tool delta may carry a finish_reason; finish belongs to the terminal chunk.
  const toolWithFinish = frames.filter((c) => c.choices[0].delta && c.choices[0].delta.tool_calls && c.choices[0].finish_reason);
  assert.equal(toolWithFinish.length, 0, "tool deltas never carry finish_reason");
});

test("enforce: retry receives the assistant tool_call turn, and cost is billed for both attempts", async (t) => {
  const seen = [];
  const f = await fixture(t, (req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      seen.push(JSON.parse(raw));
      const badCall = { id: "c1", type: "function", function: { name: "read_file", arguments: "{path: 'a.js'" } };
      const body = seen.length === 1
        ? { id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [badCall] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
        : { id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await f.setTaste("enforce");
  const res = await f.call();
  assert.equal(res.status, 200);
  assert.equal(seen.length, 2, "one original call plus exactly one retry");
  const retryMessages = seen[1].messages;
  const assistantTurn = retryMessages.find((m) => m.role === "assistant");
  assert.ok(assistantTurn, "the retry must see the assistant turn it is fixing");
  assert.ok(Array.isArray(assistantTurn.tool_calls) && assistantTurn.tool_calls.length === 1, "the retry carries the bad tool call");
  assert.equal(assistantTurn.tool_calls[0].function.arguments, "{path: 'a.js'", "the retry sees the original malformed arguments verbatim");
  const key = f.db.prepare("SELECT used_tokens FROM api_keys WHERE key_id='sk-c'").first();
  assert.equal(Number(key.used_tokens), 15 + 26, "both attempts are billed; the retry is not free");
  const body = await res.json();
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"path":"a.js"}');
});

test("traj content buffer stops growing at the cap and never becomes NaN", async (t) => {
  const big = "x".repeat(524288 + 10); // TRAJ_BODY_CAP is 512 KiB; overflow by a little
  const f = await fixture(t, (_req, res) => {
    sse(res, [chunk({ content: big }), chunk({ content: " tail" }), chunk({}, "stop"), "[DONE]"]);
    res.end();
  });
  const res = await f.call({ stream: true });
  const frames = await readAll(res);
  const joined = frames.filter((x) => x !== "[DONE]").map((x) => JSON.parse(x)).map((c) => c.choices[0].delta.content || "").join("");
  assert.ok(joined.startsWith("x"), "content still streams to the client");
  // persistOnce runs in a deferred task; give it a tick to land.
  await new Promise((r) => setTimeout(r, 100));
  const row = f.db.prepare("SELECT response_json FROM trajectories ORDER BY rowid DESC LIMIT 1").first();
  assert.ok(row && row.response_json, "a trajectory with a response body was recorded");
  const msg = JSON.parse(row.response_json).choices[0].message;
  assert.equal(typeof msg.content, "string");
  assert.ok(!msg.content.includes("NaN"), "the buffered content is not NaN-poisoned");
  assert.ok(msg.content.length <= 524288, "the buffer respects the cap, got " + msg.content.length);
});
