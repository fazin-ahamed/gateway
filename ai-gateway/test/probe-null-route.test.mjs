// Regression: a provider with NO model route still answers a credits/health
// read. probeEgress used to dereference route.transport and route.proxy_url
// unconditionally, so a routeless provider crashed instead of reporting.
import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";
import { __test as gw } from "../src/index.js";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const AUTH = { authorization: "Bearer admin" };

test("a provider with no model route reports its upstream credits instead of crashing", async () => {
  const { createApp } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,1,1,?,?)")
    .bind(1, "Routeless", "https://hyper.charm.land/v1", "direct", "openai", "round_robin", now).run();
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)")
    .bind(1, await gw.sealProviderKey(env, "sk-hyper-test"), "primary", now).run();
  // Deliberately NO model_routes row.
  const app = createApp(env);
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ balance: 5 }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const res = await app.fetch(new Request("http://gw/admin/providers/1/credits", { headers: AUTH }));
    const b = await res.json();
    assert.equal(b.ok, true, "no crash, no TypeError");
    assert.equal(b.balance, 5);
  } finally {
    globalThis.fetch = orig;
  }
  db.close?.();
});