// Auto capability envelope. The number a client is told must be a context at
// least two different providers can actually serve, not the biggest route.

import test from "node:test";
import assert from "node:assert/strict";

import { buildCapabilityEnvelope, contextLimit, autoModelEntry, UNKNOWN_CONTEXT_CEILING } from "../src/router/capability-envelope.js";

const route = (providerId, extra) => ({ providerId, context: 0, output: 0, tools: false, vision: false, reasoning: false, ...extra });

test("one 2M route with two 256k backups is resilient at 256k", () => {
  const env = buildCapabilityEnvelope([
    route(1, { context: 2000000, output: 65536, tools: true, vision: true, reasoning: true }),
    route(2, { context: 262144, output: 8192, tools: true, reasoning: true }),
    route(3, { context: 262144, output: 8192, tools: true, reasoning: true })
  ]);
  assert.equal(env.routing.max_context, 2000000);
  assert.equal(env.routing.resilient_context, 262144);
  assert.equal(env.context_window, 262144, "the ordinary context is the resilient one");
  assert.equal(env.routing.independent_providers, 3);
  assert.equal(env.routing.eligible_routes, 3);
  assert.equal(env.routing.resilient.vision, false, "vision on one provider is not resilient");
  assert.equal(env.capabilities.vision, true);
  assert.equal(env.routing.resilient.tools, true);
});

test("two independent 1M routes are resilient at 1M", () => {
  const env = buildCapabilityEnvelope([
    route(1, { context: 1000000 }),
    route(2, { context: 1000000 })
  ]);
  assert.equal(env.routing.resilient_context, 1000000);
  assert.equal(env.context_window, 1000000);
});

test("two 1M routes from the same provider are not resilient at 1M", () => {
  const env = buildCapabilityEnvelope([
    route(1, { context: 1000000 }),
    route(1, { context: 1000000 }),
    route(2, { context: 131072 })
  ]);
  assert.equal(env.routing.max_context, 1000000);
  assert.equal(env.routing.resilient_context, 131072, "one provider's two routes are one failure domain");
  assert.equal(env.routing.independent_providers, 2);
  assert.equal(env.routing.eligible_routes, 3);
});

test("a known model with no context window is capped, never unlimited", () => {
  assert.equal(contextLimit({ context: 0, unknown: false }), UNKNOWN_CONTEXT_CEILING);
  assert.equal(contextLimit({ unknown: true }), UNKNOWN_CONTEXT_CEILING);
  assert.equal(contextLimit({ context: 128000, unknown: false }), 128000);
  const env = buildCapabilityEnvelope([
    route(1, { context: 0 }),
    route(2, { context: 0 })
  ]);
  assert.equal(env.routing.max_context, UNKNOWN_CONTEXT_CEILING);
  assert.ok(env.routing.max_context < 1000000, "a missing limit must not read as a million-token model");
});

test("an open circuit removes the route from the envelope", () => {
  const env = buildCapabilityEnvelope([
    route(1, { context: 2000000, circuitOpen: true }),
    route(2, { context: 65536 })
  ]);
  assert.equal(env.routing.max_context, 65536);
  assert.equal(env.routing.eligible_routes, 1);
  assert.equal(env.routing.resilient_context, 0, "one live provider has no second failure domain");
  assert.equal(env.context_window, 65536, "with no resilient value the ordinary window is the max");
});

test("the auto model entry carries the envelope and nothing else", () => {
  const env = buildCapabilityEnvelope([route(1, { context: 8192, output: 1024, tools: true })]);
  const entry = autoModelEntry(env);
  assert.equal(entry.id, "auto");
  assert.equal(entry.owned_by, "gateway");
  assert.equal(entry.context_window, 8192);
  assert.equal(entry.capabilities.tools, true);
  assert.equal(entry.capabilities.vision, false);
});

test("GET /v1/models hides auto when it is off and sizes it from the key's routes", async () => {
  const { createApp, __test: t } = await import("../src/index.js");
  const { createDb } = await import("../../server/db.mjs");
  const { readFileSync } = await import("node:fs");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").bind("sk-env", "t", 1, "usd", 1e9, now, now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(1, "Big", "http://big.local/v1", "direct", "openai", 1, 1, "round_robin", now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(2, "Small", "http://small.local/v1", "direct", "openai", 1, 1, "round_robin", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)").bind("big-model", 1, "big").run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)").bind("small-model", 2, "small").run();
  db.prepare("INSERT INTO gateway_settings (key, value, updated_at) VALUES ('auto_enabled','off',?)").bind(now).run();
  t.__setModelsDevCache({
    p1: { models: { "big-model": { cost: { input: 1, output: 2 }, limit: { context: 2000000, output: 65536 }, modalities: { input: ["text", "image"] }, tool_call: true, reasoning: true } } },
    p2: { models: { "small-model": { cost: { input: 0.2, output: 0.4 }, limit: { context: 262144, output: 8192 }, modalities: { input: ["text"] }, tool_call: true, reasoning: true } } }
  });
  const app = createApp({ DB: db, ADMIN_TOKEN: "admin" });
  const off = await app.fetch(new Request("http://gw/v1/models", { headers: { authorization: "Bearer sk-env" } }));
  const offBody = await off.json();
  assert.equal(off.status, 200);
  assert.equal(offBody.data.some((m) => m.id === "auto"), false, "auto must not be advertised while it is disabled");
  assert.ok(offBody.data.some((m) => m.id === "big-model"));

  db.prepare("UPDATE gateway_settings SET value='on' WHERE key='auto_enabled'").run();
  const on = await app.fetch(new Request("http://gw/v1/models", { headers: { authorization: "Bearer sk-env" } }));
  const onBody = await on.json();
  const auto = onBody.data.find((m) => m.id === "auto");
  assert.ok(auto, "auto is advertised once enabled and routes exist");
  assert.equal(auto.routing.max_context, 2000000);
  assert.equal(auto.routing.resilient_context, 262144, "one huge route does not make auto a 2M model");
  assert.equal(auto.context_window, 262144);
  assert.equal(auto.capabilities.vision, true);
  assert.equal(auto.routing.resilient.vision, false, "vision on a single provider is not resilient");
  t.__setModelsDevCache(null);
});
