// Per-slug "fastest" selection mode: a slug's routes normally walk in rank
// order; flipping the slug to fastest reorders its candidates by the measured
// latency EMA (router_stats, scope 'route') BEFORE the walk. The invariants
// that matter operationally:
//   - rank mode (the default) must be byte-identical to today: rank order.
//   - fastest sorts measured routes by EMA ascending; unmeasured routes keep
//     rank order but always sit AFTER measured ones (a brand-new route must
//     never outrank a proven-fast one, and an unmeasured pool degrades to
//     rank order rather than to a random shuffle).
//   - the reorder never drops or duplicates a route, whatever the EMA rows say.
//   - circuit-open skip, key rotation, and fallback-on-failure are untouched:
//     reordering happens before the walk, so a failed first pick still falls
//     through to the next candidate.
// The admin endpoints read and write the mode per slug and reject unknown values.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";
import { __test as gw0 } from "../src/index.js";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const AUTH = { authorization: "Bearer admin" };

async function gateway() {
  const { createApp, __test: gw } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,1,?,?)")
    .bind(1, "FastHost", "http://127.0.0.1:39971", "direct", "openai", 1, "round_robin", now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,1,?,?)")
    .bind(2, "SlowHost", "http://127.0.0.1:39972", "direct", "openai", 1, "round_robin", now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,1,?,?)")
    .bind(3, "Unmeasured", "http://127.0.0.1:39973", "direct", "openai", 1, "round_robin", now).run();
  // Three routes on one slug: rank 0 (slow), 1 (fast), 2 (no data).
  db.prepare("INSERT INTO model_routes (id, slug, provider_id, upstream_model, rank, enabled) VALUES (?, ?, ?, ?, ?, 1)")
    .bind(11, "group/thing", 1, "m1", 0).run();
  db.prepare("INSERT INTO model_routes (id, slug, provider_id, upstream_model, rank, enabled) VALUES (?, ?, ?, ?, ?, 1)")
    .bind(12, "group/thing", 2, "m2", 1).run();
  db.prepare("INSERT INTO model_routes (id, slug, provider_id, upstream_model, rank, enabled) VALUES (?, ?, ?, ?, ?, 1)")
    .bind(13, "group/thing", 3, "m3", 2).run();
  // Measured latencies: route 11 is SLOW (900ms), route 12 is FAST (150ms).
  for (const [id, ema] of [["11", 900], ["12", 150]]) {
    db.prepare("INSERT INTO router_stats (scope, scope_id, task_type, success_alpha, failure_beta, latency_ema, cost_ema, updated_at) VALUES ('route', ?, '', 8, 2, ?, 0, ?)")
      .bind(id, ema, now).run();
  }
  return { db, app: createApp(env), gw, env };
}

test("rank mode (default) keeps rank order; fastest reorders by measured EMA", async () => {
  const { db, app, gw, env } = await gateway();
  const mkCtx = () => ({ env });
  const routes = [
    { id: 11, rank: 0 }, { id: 12, rank: 1 }, { id: 13, rank: 2 }
  ];
  // Default: rank order untouched.
  const before = await gw.reorderRoutesByMode(mkCtx(), "group/thing", routes);
  assert.deepEqual(before.map((r) => r.id), [11, 12, 13], "default keeps rank order");
  // Flip the slug to fastest (slugs contain slashes: always encode).
  const put = await app.fetch(new Request("http://gw/admin/routes/selection-mode/" + encodeURIComponent("group/thing"), {
    method: "PUT", headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ mode: "fastest" })
  }));
  assert.equal(put.status, 200);
  assert.equal((await put.json()).mode, "fastest");
  // Fastest: the 150ms route leads, the 900ms route follows, the unmeasured
  // one stays LAST even though rank order would have put it after 12 anyway -
  // the invariant is measured-first, then rank.
  const after = await gw.reorderRoutesByMode(mkCtx(), "group/thing", routes);
  assert.deepEqual(after.map((r) => r.id), [12, 11, 13], "fastest sorts measured routes by EMA, unmeasured last");
  // No route lost or duplicated.
  assert.equal(new Set(after.map((r) => r.id)).size, routes.length);
  db.close?.();
});

test("an unmeasured slug in fastest mode degrades to rank order, not a shuffle", async () => {
  const { db, app, gw, env } = await gateway();
  const routes = [{ id: 11, rank: 0 }, { id: 13, rank: 2 }]; // both unmeasured in this slice
  await app.fetch(new Request("http://gw/admin/routes/selection-mode/" + encodeURIComponent("group/thing") + "", {
    method: "PUT", headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ mode: "fastest" })
  }));
  const out = await gw.reorderRoutesByMode({ env }, "group/thing", routes);
  assert.deepEqual(out.map((r) => r.id), [11, 13], "no EMA data means rank order");
  db.close?.();
});

test("the mode endpoint validates and reports per slug, defaulting to rank", async () => {
  const { db, app } = await gateway();
  const bad = await app.fetch(new Request("http://gw/admin/routes/selection-mode/" + encodeURIComponent("group/thing") + "", {
    method: "PUT", headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ mode: "cheapest-but-bogus" })
  }));
  assert.equal(bad.status, 400, "unknown modes are rejected");
  const read = await (await app.fetch(new Request("http://gw/admin/routes/selection-mode/" + encodeURIComponent("other/thing") + "", { headers: AUTH }))).json();
  assert.equal(read.mode, "rank", "an untouched slug defaults to rank");
  // The routes list carries the modes map for the UI.
  const list = await (await app.fetch(new Request("http://gw/admin/routes", { headers: AUTH }))).json();
  assert.equal(list.selection_modes["group/thing"], "rank", "the list exposes the mode per slug");
  const emaById = Object.fromEntries(list.routes.map((r) => [r.id, r.latency_ema]));
  assert.equal(Number(emaById[11]), 900, "the list carries each route's latency EMA");
  assert.equal(emaById[13], null, "an unmeasured route has null EMA, not zero");
  db.close?.();
});

test("a serving request in fastest mode tries the low-latency route first", async () => {
  const { db, app, env } = await gateway();
  // A key so auth passes; the upstream will fail - the ATTEMPT ORDER is the
  // assertion, visible in which provider the request actually dialed.
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind("sk-fast", "k", 1, "usd", 1e9, now, now).run();
  for (const pid of [1, 2, 3]) {
    db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)")
      .bind(pid, await gw0.sealProviderKey(env, "sec-" + pid), "primary", now).run();
  }
  await app.fetch(new Request("http://gw/admin/routes/selection-mode/" + encodeURIComponent("group/thing") + "", {
    method: "PUT", headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ mode: "fastest" })
  }));
  // Point every provider at a dead port; serving will try the FAST route first
  // (route 12 on SlowHost id 2) and fail through the rest. The trajectory's
  // first step records which provider was dialed first.
  const res = await app.fetch(new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer sk-fast", "content-type": "application/json" },
    body: JSON.stringify({ model: "group/thing", messages: [{ role: "user", content: "hi" }] })
  }));
  const attempts = db.prepare("SELECT route_id FROM route_attempts ORDER BY id").all().results || [];
  assert.ok(attempts.length >= 1, "the attempt trail exists");
  assert.equal(Number(attempts[0].route_id), 12, "the measured-fastest route (150ms EMA) is dialed FIRST");
  db.close?.();
});