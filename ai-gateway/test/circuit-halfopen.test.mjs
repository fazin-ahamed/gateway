// The half-open probe deadlock, from the operator report: a provider tripped
// its breaker, the cooldown expired, ONE half-open probe ran and failed, and
// the breaker stayed open forever. Two code paths caused it:
//   1. recordFailOn reset fails=0 before the threshold check, so the probe's
//      single failure (fails=1 < 3) never re-opened the circuit, while
//      probeUsed stayed true and blocked every future probe.
//   2. a probe failing into a FILTERED class (relay 400s, caller 4xx) never
//      reached recordFailOn at all - same stuck probeUsed, no bound.
// Also: the admin test button and mark-up are live operator evidence, so a
// successful test probe or mark-up must release the provider breaker.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const AUTH = { authorization: "Bearer admin" };

async function gw() {
  const { createApp, __test } = await import("../src/index.js");
  __test.__resetCircuitState();
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,1,1,?,?)")
    .bind(1, "Relbackend", "http://127.0.0.1:39921/v1", "direct", "openai", "round_robin", now).run();
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)")
    .bind(1, await __test.sealProviderKey(env, "up-secret"), "primary", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)")
    .bind("loadout/rivet", 1, "rivet").run();
  return { db, app: createApp(env), __test };
}

test("a failed half-open probe re-opens the breaker with an escalated cooldown", async () => {
  const { db, app, __test } = await gw();
  // Trip the breaker: 3 provider-kind failures in the window.
  for (let i = 0; i < 3; i++) __test.circuitRecordFailure("provider", 1, { status: 503, kind: "unknown" });
  assert.ok(__test.circuitOpen("provider", 1), "breaker is open after 3 failures");
  // Force the cooldown to expire, then run the ONE allowed probe.
  const st = __test.circuitSnapshot().find((s) => s.key === "provider:1");
  const origNow = Date.now;
  const travel = (ms) => { Date.now = () => origNow() + ms; };
  try {
    travel((st.openUntil || 0) - origNow() + 10);
    assert.equal(__test.circuitOpen("provider", 1), false, "cooldown expired: the probe is allowed through");
    // The probe FAILS with a provider-kind 5xx. Before the fix this call
    // silently left the breaker half-open with probeUsed=true forever.
    __test.circuitRecordFailure("provider", 1, { status: 503, kind: "unknown" });
    const after = __test.circuitSnapshot().find((s) => s.key === "provider:1");
    assert.ok(after.open, "the failed probe re-opened the breaker");
    assert.ok(after.consecutiveOpens >= 2, "the re-open escalated the cooldown series");
    assert.equal(after.halfOpen, false, "no longer half-open: a new probe window will be granted");
    // And the NEXT request after the new cooldown expires gets its own probe.
    travel((after.openUntil || 0) - origNow() + 10);
    assert.equal(__test.circuitOpen("provider", 1), false, "a fresh probe is granted after the new cooldown");
  } finally {
    Date.now = origNow;
    __test.__resetCircuitState();
  }
  db.close?.();
});

test("a probe that fails into a filtered class re-arms instead of deadlocking open", async () => {
  const { db, __test } = await gw();
  for (let i = 0; i < 3; i++) __test.circuitRecordFailure("provider", 1, { status: 503, kind: "unknown" });
  const origNow = Date.now;
  const base = origNow();
  try {
    const st = __test.circuitSnapshot().find((s) => s.key === "provider:1");
    Date.now = () => st.openUntil + 10;
    assert.equal(__test.circuitOpen("provider", 1), false, "probe granted");
    assert.equal(__test.circuitOpen("provider", 1), true, "second caller within the probe window is blocked");
    // The probe fails with a FILTERED class (relay): circuitRecordFailure
    // drops it entirely. The settle window must still release probeUsed.
    __test.circuitRecordFailure("provider", 1, { status: 400, kind: "relay" });
    Date.now = () => st.openUntil + 10 + 31000; // one base cooldown later
    assert.equal(__test.circuitOpen("provider", 1), false, "after the settle window a new probe is granted - not deadlocked");
  } finally {
    Date.now = origNow;
    __test.__resetCircuitState();
  }
  db.close?.();
  assert.equal(base > 0, true);
});

test("a successful admin test probe and a mark-up clear the provider, route, and key breakers", async () => {
  const { db, app, __test } = await gw();
  for (let i = 0; i < 3; i++) __test.circuitRecordFailure("provider", 1, { status: 503, kind: "unknown" });
  assert.ok(__test.circuitOpen("provider", 1), "open before operator action");
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    // The admin test button against a stubbed serving upstream.
    const res = await app.fetch(new Request("http://gw/admin/providers/1/test", { method: "POST", headers: AUTH }));
    const b = await res.json();
    assert.equal(b.ok, true);
    const st = __test.circuitSnapshot().find((s) => s.key === "provider:1");
    assert.equal(st && st.open, false, "the successful test probe released the provider breaker");
    // The route and key breakers must be released too: a live successful probe
    // through the route with the key proves all three layers serve.
    __test.circuitRecordFailure("route", 1, { status: 503, kind: "unknown" });
    __test.circuitRecordFailure("route", 1, { status: 503, kind: "unknown" });
    __test.circuitRecordFailure("route", 1, { status: 503, kind: "unknown" });
    const keyId = db.prepare("SELECT id FROM provider_keys WHERE provider_id=1 LIMIT 1").first().id;
    __test.circuitRecordFailure("key", keyId, { status: 503, kind: "unknown" });
    __test.circuitRecordFailure("key", keyId, { status: 503, kind: "unknown" });
    __test.circuitRecordFailure("key", keyId, { status: 503, kind: "unknown" });
    assert.ok(__test.circuitOpen("route", 1), "route breaker tripped for the test");
    assert.ok(__test.circuitOpen("key", keyId), "key breaker tripped for the test");
    const res2 = await app.fetch(new Request("http://gw/admin/providers/1/test", { method: "POST", headers: AUTH }));
    assert.equal((await res2.json()).ok, true);
    assert.equal(__test.circuitOpen("route", 1), false, "the test probe released the route breaker");
    assert.equal(__test.circuitOpen("key", keyId), false, "the test probe released the key breaker");
    // Mark-down then mark-up also clears it.
    __test.circuitRecordFailure("provider", 1, { status: 503, kind: "unknown" });
    __test.circuitRecordFailure("provider", 1, { status: 503, kind: "unknown" });
    __test.circuitRecordFailure("provider", 1, { status: 503, kind: "unknown" });
    assert.ok(__test.circuitOpen("provider", 1));
    const up = await app.fetch(new Request("http://gw/admin/providers/1/toggle", { method: "POST", headers: AUTH })); // healthy 1 -> 0
    await up.json();
    const up2 = await app.fetch(new Request("http://gw/admin/providers/1/toggle", { method: "POST", headers: AUTH })); // 0 -> 1: mark-up
    const tb = await up2.json();
    assert.equal(tb.healthy, true);
    const st2 = __test.circuitSnapshot().find((s) => s.key === "provider:1");
    assert.equal(st2 && st2.open, false, "mark-up cleared the provider breaker");
  } finally {
    globalThis.fetch = orig;
    __test.__resetCircuitState();
  }
  db.close?.();
});