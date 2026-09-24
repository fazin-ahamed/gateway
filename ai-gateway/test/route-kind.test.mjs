import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";
import { __test as gw0 } from "../src/index.js";

async function gateway() {
  const { createApp, __test: gw } = await import("../src/index.js");
  void gw0;
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key-please-change", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").bind("sk-k", "k", 1, "usd", 1e9, now, now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(1, "TypeSafe", "https://up.local", "direct", "openai", 1, 1, "round_robin", now).run();
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)").bind(1, await gw.sealProviderKey(env, "sec"), "primary", now).run();
  return { app: createApp(env), db };
}

test("a route added with model_kind=decision is a decision route and shows in Decision mode", async () => {
  const { app, db } = await gateway();
  const add = await app.fetch(new Request("http://gw/admin/routes", {
    method: "POST",
    headers: { authorization: "Bearer admin", "content-type": "application/json" },
    body: JSON.stringify({ slug: "jev", provider_id: 1, upstream_model: "jev-latest", rank: 0, enabled: true, model_kind: "decision", wire_format: "systemone" })
  }));
  assert.equal(add.status, 201);
  const created = await add.json();
  assert.equal(created.model_kind, "decision");
  assert.equal(created.wire_format, "systemone");

  const list = await (await app.fetch(new Request("http://gw/admin/routes", { headers: { authorization: "Bearer admin" } }))).json();
  const row = list.routes.find((r) => r.slug === "jev");
  assert.equal(row.model_kind, "decision");

  // The playground filters the model select by this exact field.
  const chat = list.routes.filter((r) => String(r.model_kind || "chat") !== "decision").map((r) => r.slug);
  const decision = list.routes.filter((r) => String(r.model_kind || "chat") === "decision").map((r) => r.slug);
  assert.deepEqual(chat, [], "jev must not appear as a chat model");
  assert.deepEqual(decision, ["jev"]);
});

test("PATCH can flip a chat route to decision and rejects an unknown kind", async () => {
  const { app } = await gateway();
  await app.fetch(new Request("http://gw/admin/routes", {
    method: "POST",
    headers: { authorization: "Bearer admin", "content-type": "application/json" },
    body: JSON.stringify({ slug: "dm", provider_id: 1, upstream_model: "dm-v3", rank: 0, enabled: true })
  }));
  const ok = await app.fetch(new Request("http://gw/admin/routes/1", {
    method: "PATCH",
    headers: { authorization: "Bearer admin", "content-type": "application/json" },
    body: JSON.stringify({ model_kind: "decision", wire_format: "systemone", endpoint_path: "/v1/systemone" })
  }));
  assert.equal(ok.status, 200);
  const row = (await ok.json()).route;
  assert.equal(row.model_kind, "decision");
  assert.equal(row.wire_format, "systemone");

  const bad = await app.fetch(new Request("http://gw/admin/routes/1", {
    method: "PATCH",
    headers: { authorization: "Bearer admin", "content-type": "application/json" },
    body: JSON.stringify({ model_kind: "bogus" })
  }));
  assert.equal(bad.status, 400);
});

test("the edit form receives the route's current kind", () => {
  const src = readFileSync(new URL("../src/playground.js", import.meta.url), "utf8");
  assert.match(src, /value:String\(r\.model_kind\|\|'chat'\)/, "edit form preselects the stored kind");
  assert.match(src, /data-kind/, "fallback button carries the parent kind");
  assert.match(src, /kindPill/, "the routes table marks decision slugs");
  assert.match(src, /Decision \/ System-One/, "the add form offers the decision type");
});
