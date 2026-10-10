import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDb } from "../../server/db.mjs";
import { createApp, __test as gw } from "../src/index.js";

function fixture() {
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO gateway_settings (key,value,updated_at) VALUES ('auto_enabled','off',?)").bind(new Date().toISOString()).run();
  const env = { DB: db, ADMIN_TOKEN: "private-admin", PROVIDER_CRYPTO_KEY: "private-crypto" };
  gw.__setModelsDevCache({});
  return { db, app: createApp(env) };
}
const url = "http://gateway.test/public/overview";
function provider(db, id, healthy = 1, enabled = 1, fmt = "openai") {
  db.prepare("INSERT INTO providers (id,name,base_url,transport,fmt,healthy,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, "private-provider-" + id, "https://private-provider.example", "direct", fmt, healthy, enabled, new Date().toISOString()).run();
}
function route(db, slug, id, enabled = 1, kind = "chat") {
  db.prepare("INSERT INTO model_routes (slug,provider_id,upstream_model,rank,enabled,model_kind,wire_format) VALUES (?,?,?,0,?,?,?)")
    .bind(slug, id, "private-upstream-model", enabled, kind, kind === "decision" ? "systemone" : "openai").run();
}
function record(db, id, created, status, input, output, total) {
  db.prepare("INSERT INTO request_summaries (request_id,key_id,model_kind,public_slug,created_at,status,prompt_tokens,completion_tokens,total_tokens,cost_usd,client_app,request_headers) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, "sk-private-person", "chat", "public-chat", created, status, input, output, total, 1234, "private-client", '{"user-agent":"private-request-header"}').run();
}

test("the public overview sums recorded history without route multiplicity or private request data", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-10T12:00:00.000Z") });
  const { app, db } = fixture();
  provider(db, 1); provider(db, 2);
  route(db, "public-chat", 1); route(db, "public-chat", 2);
  const today = new Date().toISOString().slice(0, 10) + "T12:00:00.000Z";
  const old = new Date(Date.now() - 20 * 86400000).toISOString();
  record(db, "private-request-1", old, "ok", 10, 7, 17);
  record(db, "private-request-2", today, "ok", 40, 60, 101);
  record(db, "private-request-3", today, "fail", 5, 0, 5);
  record(db, "private-request-4", today, "cancelled", 4, 5, 9);
  record(db, "private-request-5", today, "pending", 0, 0, 0);
  const response = await app.fetch(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  const body = await response.json();
  assert.deepEqual(body.usage, { requests: 5, input_tokens: 59, output_tokens: 72, total_tokens: 132, first_recorded_at: old, last_request_at: today });
  assert.equal(body.activity.points.at(-1).requests, 4);
  assert.equal(body.activity.points.at(-1).total_tokens, 115);
  assert.deepEqual(body.models.map((m) => m.id), ["public-chat"]);
  const text = JSON.stringify(body);
  for (const privateValue of ["private-admin", "private-crypto", "sk-private-person", "private-provider", "private-upstream-model", "private-request", "private-client", "private-request-header", "cost_usd", "provider_id", "route_id", "request_headers", "upstream_model", "key_id"])
    assert.equal(text.includes(privateValue), false, privateValue + " must not be public");
  assert.deepEqual(Object.keys(body.usage).sort(), ["first_recorded_at", "input_tokens", "last_request_at", "output_tokens", "requests", "total_tokens"]);
});

test("seven UTC calendar-day buckets include midnight and exclude records outside the window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-10T12:00:00.000Z") });
  const { app, db } = fixture();
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = today - 6 * 86400000;
  record(db, "before", new Date(start - 1).toISOString(), "ok", 1, 0, 1);
  record(db, "boundary", new Date(start).toISOString(), "ok", 10, 0, 10);
  record(db, "next", new Date(today + 86400000).toISOString(), "ok", 100, 0, 100);
  const body = await (await app.fetch(new Request(url))).json();
  assert.deepEqual(body.activity.points, Array.from({ length: 7 }, (_, i) => ({ date: new Date(start + i * 86400000).toISOString().slice(0, 10), requests: i === 0 ? 1 : 0, total_tokens: i === 0 ? 10 : 0 })));
  assert.equal(body.usage.total_tokens, 111, "history totals are independent of the seven-day display window");
});

test("an empty ledger is distinct from failure and exposes no invented coverage dates", async () => {
  const { app } = fixture();
  const response = await app.fetch(new Request(url));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.usage, { requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, first_recorded_at: null, last_request_at: null });
  assert.deepEqual(body.models, []);
  assert.equal(body.activity.points.every((p) => p.requests === 0 && p.total_tokens === 0), true);
});

test("public discovery excludes disabled and unhealthy routes and preserves decision endpoints without internals", async () => {
  const { app, db } = fixture();
  provider(db, 1); provider(db, 2, 0); provider(db, 3, 1, 0); provider(db, 4, 1, 1, "systemone");
  route(db, "chat", 1); route(db, "unhealthy", 2); route(db, "disabled-provider", 3); route(db, "disabled-route", 1, 0); route(db, "decision", 4, 1, "decision");
  const body = await (await app.fetch(new Request(url))).json();
  assert.deepEqual(body.models.map((m) => m.id), ["chat", "decision"]);
  assert.equal(body.models[0].endpoint, "/v1/chat/completions");
  assert.ok(body.models[0].max_output_tokens > 0, "unknown model output must still advertise a usable ceiling");
  assert.equal(body.models[0].capabilities.streaming, true);
  assert.deepEqual(body.models[1], { id: "decision", model_kind: "decision", endpoint: "/v1/systemone", context_window: null, max_output_tokens: null, capabilities: { choice: true, score: true, noul: true } });
  assert.equal((await app.fetch(new Request("http://gateway.test/v1/models"))).status, 401);
  assert.equal((await app.fetch(new Request("http://gateway.test/console/api/overview"))).status, 401);
  assert.equal((await app.fetch(new Request("http://gateway.test/status"))).status, 401);
});

test("edge-excluded formats do not leak into the public model catalogue", async () => {
  const { app, db } = fixture();
  provider(db, 1, 1, 1, "openai"); provider(db, 2, 1, 1, "zaiweb");
  route(db, "allowed-chat", 1); route(db, "excluded-chat", 2);
  const previous = globalThis.HORIZON_EXCLUDED_FORMATS;
  globalThis.HORIZON_EXCLUDED_FORMATS = ["zaiweb"];
  try {
    const body = await (await app.fetch(new Request(url))).json();
    assert.deepEqual(body.models.map((m) => m.id), ["allowed-chat"]);
  } finally {
    if (previous === undefined) delete globalThis.HORIZON_EXCLUDED_FORMATS;
    else globalThis.HORIZON_EXCLUDED_FORMATS = previous;
  }
});

test("public snapshots are isolated by database and renew after their bounded cache window", async (t) => {
  const { app, db } = fixture();
  const now = new Date();
  t.mock.timers.enable({ apis: ["Date"], now });
  record(db, "one", now.toISOString(), "ok", 2, 3, 5);
  assert.equal((await (await app.fetch(new Request(url))).json()).usage.total_tokens, 5);
  record(db, "two", now.toISOString(), "ok", 4, 6, 10);
  assert.equal((await (await app.fetch(new Request(url))).json()).usage.total_tokens, 5);
  const other = fixture();
  assert.equal((await (await other.app.fetch(new Request(url))).json()).usage.total_tokens, 0);
  t.mock.timers.tick(30001);
  assert.equal((await (await app.fetch(new Request(url))).json()).usage.total_tokens, 15);
});

test("a failed public snapshot returns a generic error and can recover without a cached zero fallback", async () => {
  const { app, db } = fixture();
  db.exec("ALTER TABLE request_summaries RENAME TO unavailable_summaries");
  const failed = await app.fetch(new Request(url));
  assert.equal(failed.status, 503);
  const failedBody = await failed.json();
  assert.equal(failedBody.error.type, "service_unavailable");
  assert.equal(JSON.stringify(failedBody).includes("request_summaries"), false, "database error details must remain private");
  assert.equal(failedBody.usage, undefined, "failure must not publish fabricated zero usage");
  assert.equal(failed.headers.get("cache-control"), "no-store");
  db.exec("ALTER TABLE unavailable_summaries RENAME TO request_summaries");
  record(db, "recovered", new Date().toISOString(), "ok", 12, 8, 20);
  const recovered = await app.fetch(new Request(url));
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).usage.total_tokens, 20);
});

test("public Auto discovery reflects the explicitly enabled chat capability envelope", async () => {
  const { app, db } = fixture();
  db.prepare("UPDATE gateway_settings SET value='on' WHERE key='auto_enabled'").run();
  provider(db, 1); provider(db, 2, 1, 1, "systemone");
  route(db, "chat", 1); route(db, "decision", 2, 1, "decision");
  gw.__setModelsDevCache({ provider: { models: { "private-upstream-model": { limit: { context: 64000, output: 12000 }, tool_call: true, reasoning: true, modalities: { input: ["text", "image"] } } } } });
  const body = await (await app.fetch(new Request(url))).json();
  const automatic = body.models.find((m) => m.id === "auto");
  const chat = body.models.find((m) => m.id === "chat");
  assert.equal(automatic.model_kind, "chat");
  assert.equal(automatic.endpoint, "/v1/chat/completions");
  assert.equal(automatic.context_window, chat.context_window);
  assert.equal(automatic.max_output_tokens, chat.max_output_tokens);
  assert.deepEqual(automatic.capabilities, chat.capabilities);
  assert.equal(automatic.capabilities.choice, undefined);
});
