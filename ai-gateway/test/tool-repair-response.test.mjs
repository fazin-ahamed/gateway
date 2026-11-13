// Response-side tool-call repair, end to end through the Hono app against a
// local stub upstream, for both the non-stream and the stream path.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createDb } from "../../server/db.mjs";
import { createApp, __test as gw } from "../src/index.js";
import { repairResponseToolCall, getToolRepairStats, resetToolRepairStats } from "../src/tool-response-repair.js";

const TOOLS = [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: { path: { type: "string" }, limit: { type: "integer" } }
    }
  }
}];

async function fixture(t, handler) {
  gw.__resetCircuitState();
  gw.__resetRouterHealthCache();
  gw.__setModelsDevCache({});
  resetToolRepairStats();
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
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
    db,
    app,
    call({ stream = false, tools = TOOLS } = {}) {
      return app.fetch(new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-c", "content-type": "application/json", "x-gateway-cache": "off" },
        body: JSON.stringify({ model: "m", stream, messages: [{ role: "user", content: "go" }], ...(tools ? { tools } : {}) })
      }), { waitUntil() {} });
    }
  };
}

const completion = (args, finish = "tool_calls") => ({
  id: "x", object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Read_File", arguments: args } }] }, finish_reason: finish }],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
});

function sse(res, frames) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of frames) res.write("data: " + (typeof f === "string" ? f : JSON.stringify(f)) + "\n\n");
}
const chunk = (delta, finish) => ({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] });

async function readAll(res) {
  const text = await res.text();
  return text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
}

test("non-stream: malformed arguments are repaired against the schema and the fix is reported", async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(completion("{path: 'a.js', limit: '5', stray: 1,}")));
  });
  const res = await f.call();
  assert.equal(res.status, 200);
  const body = await res.json();
  const call = body.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "read_file", "name alias healed to the advertised spelling");
  assert.deepEqual(JSON.parse(call.function.arguments), { path: "a.js", limit: 5 });
  const fixes = res.headers.get("x-gateway-tool-repair").split(",");
  for (const k of ["json_syntax", "type_coercion", "unknown_prop_dropped", "name_alias"]) assert.ok(fixes.includes(k), k);
  const stats = getToolRepairStats();
  assert.equal(stats.totals.repaired, 1);
});

test("non-stream: valid calls are untouched byte-for-byte and there is no repair header", async (t) => {
  const args = '{"path":"a.js"}';
  const f = await fixture(t, (_req, res) => {
    const c = completion(args);
    c.choices[0].message.tool_calls[0].function.name = "read_file";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(c));
  });
  const res = await f.call();
  const body = await res.json();
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, args);
  assert.equal(res.headers.get("x-gateway-tool-repair"), null);
});

test("non-stream: a call cut off by max_tokens is dropped and finish_reason stays length", async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(completion('{"path":"a.js","content":"half writ', "length")));
  });
  const body = await (await f.call()).json();
  assert.equal(body.choices[0].finish_reason, "length");
  assert.equal(body.choices[0].message.tool_calls, undefined, "a truncated call is never executable");
  assert.equal(getToolRepairStats().totals.dropped_truncated, 1);
});

test("requests without tools take the untouched path", async (t) => {
  const bad = "{path: 'a'}";
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(completion(bad)));
  });
  const body = await (await f.call({ tools: null })).json();
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, bad);
});

test("operators can switch repair off", async (t) => {
  const bad = "{path: 'a'}";
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(completion(bad)));
  });
  const off = await f.app.fetch(new Request("http://gw/admin/tool-repair", { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) }));
  assert.equal((await off.json()).enabled, false);
  const body = await (await f.call()).json();
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, bad);
});

test("stream: split argument deltas arrive as one repaired call before the finish chunk", async (t) => {
  const f = await fixture(t, (_req, res) => {
    sse(res, [
      chunk({ role: "assistant" }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{path: 'a" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ".js', limit: '7'}" } }] }),
      chunk({}, "tool_calls"),
      "[DONE]"
    ]);
    res.end();
  });
  const res = await f.call({ stream: true });
  const frames = await readAll(res);
  const parsed = frames.filter((x) => x !== "[DONE]").map((x) => JSON.parse(x));
  const toolChunks = parsed.filter((c) => c.choices[0].delta && c.choices[0].delta.tool_calls);
  assert.equal(toolChunks.length, 1, "exactly one consolidated tool chunk");
  const call = toolChunks[0].choices[0].delta.tool_calls[0];
  assert.equal(call.index, 0);
  assert.equal(call.id, "call_1");
  assert.equal(call.function.name, "read_file");
  assert.deepEqual(JSON.parse(call.function.arguments), { path: "a.js", limit: 7 });
  const finishAt = parsed.findIndex((c) => c.choices[0].finish_reason);
  assert.equal(parsed.indexOf(toolChunks[0]) < finishAt, true, "tool call precedes the finish chunk");
  assert.equal(parsed[finishAt].choices[0].finish_reason, "tool_calls");
  assert.equal(frames.filter((x) => x === "[DONE]").length, 1);
});

test("stream: text deltas are not delayed by tool buffering", async (t) => {
  const f = await fixture(t, (_req, res) => {
    sse(res, [chunk({ content: "Let me look. " }), chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a"}' } }] }), chunk({}, "tool_calls"), "[DONE]"]);
    res.end();
  });
  const frames = (await readAll(await f.call({ stream: true }))).filter((x) => x !== "[DONE]").map((x) => JSON.parse(x));
  assert.equal(frames[0].choices[0].delta.content, "Let me look. ");
});

test("stream: a stream cut mid-call drops the call and ends with length, never an executable call", async (t) => {
  const f = await fixture(t, (_req, res) => {
    sse(res, [
      chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a.js","content":"half' } }] })
    ]);
    res.end(); // EOF with no finish_reason and no [DONE]
  });
  const frames = (await readAll(await f.call({ stream: true }))).filter((x) => x !== "[DONE]").map((x) => JSON.parse(x));
  assert.equal(frames.some((c) => c.choices[0].delta && c.choices[0].delta.tool_calls), false);
  const finish = frames.map((c) => c.choices[0].finish_reason).filter(Boolean);
  assert.deepEqual(finish, ["length"]);
});

test("unit: unknown tool names and unparseable arguments pass through as unrepairable", () => {
  resetToolRepairStats();
  const r = repairResponseToolCall({ id: "1", type: "function", function: { name: "mystery", arguments: "not json at all" } }, TOOLS);
  assert.equal(r.status, "unrepairable");
  assert.equal(r.call.function.arguments, "not json at all");
});
