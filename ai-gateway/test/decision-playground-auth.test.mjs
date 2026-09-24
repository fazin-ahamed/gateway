// The console holds an admin session, not an sk- API key. The playground's
// decision mode must ride an admin-guarded route, or every ask 401s — the
// exact failure seen live. The public /v1/systemone keeps requiring a key.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";
import { __test as gw } from "../src/index.js";

async function gateway() {
  const { createApp } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key-please-change", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(1, "TypeSafe", "https://up.local", "direct", "systemone", 1, 1, "round_robin", now).run();
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)")
    .bind(1, await gw.sealProviderKey(env, "dec-secret"), "primary", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled, model_kind, wire_format) VALUES (?,?,?,0,1,'decision','systemone')")
    .bind("jev", 1, "jev-latest").run();
  return { app: createApp(env), db };
}

const decisionBody = () => JSON.stringify({
  model: "jev",
  state: { task: "fix the session writer race" },
  questions: { verify: { type: "noul", instructions: "Does this need verification?" } }
});

test("the console decision mode authenticates with the admin session, not an sk- key", async () => {
  const { app } = await gateway();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ answers: { verify: { probability: 0.9 } } }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const res = await app.fetch(new Request("http://gw/admin/playground/systemone", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: decisionBody()
    }));
    assert.equal(res.status, 200, "the playground rides the admin session");
    const body = await res.json();
    assert.equal(body.answers.verify.probability, 0.9);
  } finally {
    globalThis.fetch = orig;
  }
});

test("the playground decision route rejects a caller with no admin session", async () => {
  const { app } = await gateway();
  const res = await app.fetch(new Request("http://gw/admin/playground/systemone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: decisionBody()
  }));
  assert.equal(res.status, 401, "an anonymous caller cannot reach the admin route");
});

test("/v1/systemone still requires a real API key", async () => {
  const { app } = await gateway();
  const res = await app.fetch(new Request("http://gw/v1/systemone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: decisionBody()
  }));
  assert.equal(res.status, 401, "the public surface keeps key auth");
});

test("the console posts to the admin route, not the public one", async () => {
  const src = readFileSync(new URL("../src/playground.js", import.meta.url), "utf8");
  assert.match(src, /admin\/playground\/systemone/, "decision mode must use the session-authenticated endpoint");
  assert.doesNotMatch(src, /fetch\(API\+'\/v1\/systemone'/, "the public endpoint is for sk- clients, not the console");
});
