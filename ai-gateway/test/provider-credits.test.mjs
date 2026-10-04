// Upstream provider credits (/admin/providers/:id/credits): a live balance
// read against the provider's own upstream, using the provider's own sealed
// key. Charm Hyper answers {"balance":N} with the team's remaining
// Hypercredits; a team with hypercredit display off gets {"balance_usd":X}
// and NO shard figure. The gateway must report exactly what the upstream
// says and never invent a number, and must survive every failure shape:
// non-200, unparseable body, missing key, unknown provider.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";
import { __test as gw } from "../src/index.js";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const AUTH = { authorization: "Bearer admin" };

async function providerGateway(keyCount = 1) {
  const { createApp } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,1,1,?,?)")
    .bind(1, "Charm Hyper", "https://hyper.charm.land/v1", "direct", "openai", "round_robin", now).run();
  for (let i = 0; i < keyCount; i++) {
    db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)")
      .bind(1, await gw.sealProviderKey(env, "sk-hyper-test-" + i), "key-" + i, now).run();
  }
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)")
    .bind("hyper/glm-5.3", 1, "glm-5.3").run();
  return { db, app: createApp(env) };
}

async function withStubFetch(handler, fn) {
  const orig = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), headers: init && init.headers || {} };
    return handler();
  };
  try {
    return { result: await fn(), seen };
  } finally {
    globalThis.fetch = orig;
  }
}

const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

test("a Hyper balance answer returns the upstream's shards with unit hypercredits", async () => {
  const { db, app } = await providerGateway();
  const { result, seen } = await withStubFetch(
    () => jsonRes({ balance: 100 }),
    () => app.fetch(new Request("http://gw/admin/providers/1/credits", { headers: AUTH }))
  );
  assert.equal(result.status, 200);
  const b = await result.json();
  assert.equal(b.ok, true);
  assert.equal(b.balance, 100, "the upstream's exact figure, never invented");
  assert.equal(b.unit, "hypercredits");
  assert.equal(b.balance_usd, null);
  assert.ok(b.fetched_at, "the read is timestamped");
  assert.ok(seen.url.endsWith("/credits"), "the probe hits the credits path, got " + seen.url);
  assert.equal(seen.headers.Authorization, "Bearer sk-hyper-test-0", "the provider's own key authenticates");
});

test("a team with hypercredit display off gets balance_usd and NO shard figure", async () => {
  const { db, app } = await providerGateway();
  const { result } = await withStubFetch(
    () => jsonRes({ balance_usd: 1.5 }),
    () => app.fetch(new Request("http://gw/admin/providers/1/credits", { headers: AUTH }))
  );
  const b = await result.json();
  assert.equal(b.ok, true);
  assert.equal(b.balance, null, "no stale shard figure for a dollars team");
  assert.equal(b.balance_usd, 1.5);
  assert.equal(b.unit, "usd");
  db.close?.();
});

test("a non-200 from the upstream is reported, not guessed", async () => {
  const { db, app } = await providerGateway();
  const { result } = await withStubFetch(
    () => jsonRes({ error: { message: "invalid api key", type: "authentication_error" } }, 401),
    () => app.fetch(new Request("http://gw/admin/providers/1/credits", { headers: AUTH }))
  );
  const b = await result.json();
  assert.equal(b.ok, false, "every key failed, so the read is not ok");
  assert.equal(b.balance, null, "an all-failed read must not look like zero balance");
  assert.equal(b.keys.length, 1);
  assert.equal(b.keys[0].status, 401);
  assert.match(b.keys[0].error, /invalid api key/);
  db.close?.();
});

test("an unparseable body reports no figure, never a fake balance", async () => {
  const { db, app } = await providerGateway();
  const { result } = await withStubFetch(
    () => new Response("<html>gateway page</html>", { status: 200 }),
    () => app.fetch(new Request("http://gw/admin/providers/1/credits", { headers: AUTH }))
  );
  const b = await result.json();
  assert.equal(b.ok, true);
  assert.equal(b.balance, null);
  assert.equal(b.balance_usd, null);
  assert.equal(b.unit, null);
  db.close?.();
});

test("the credits probe is a GET with no body, so undici never rejects it", async () => {
  // Regression: probeEgress takes (..., headers, body, timeoutMs) positionally.
  // Passing the timeout in the body slot made the GET carry a body, and fetch
  // rejected it with "Request with GET/HEAD method cannot have body" — which a
  // body-ignoring fetch stub never surfaced, so this is pinned here.
  const { db, app } = await providerGateway();
  const orig = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { method: init.method, body: init.body };
    return new Response(JSON.stringify({ balance: 12 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const res = await app.fetch(new Request("http://gw/admin/providers/1/credits", { headers: AUTH }));
    assert.equal((await res.json()).balance, 12);
    assert.equal(seen.method, "GET");
    assert.ok(!seen.body, "a GET probe must send no body, got " + String(seen.body));
  } finally {
    globalThis.fetch = orig;
  }
  db.close?.();
});

test("multiple keys are summed into one balance with a per-key breakdown", async () => {
  const { db, app } = await providerGateway(3);
  let call = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    call++;
    return jsonRes({ balance: 20 + call }); // 21, 22, 23 -> sum 66
  };
  try {
    const res = await app.fetch(new Request("http://gw/admin/providers/1/credits", { headers: AUTH }));
    const b = await res.json();
    assert.equal(call, 3, "every key is read, not just the first");
    assert.equal(b.ok, true);
    assert.equal(b.balance, 66, "the total is the sum across all keys");
    assert.equal(b.unit, "hypercredits");
    assert.equal(b.keys.length, 3);
    assert.deepEqual(b.keys.map((k) => k.balance).sort(), [21, 22, 23], "each key's own figure is auditable");
    assert.equal(b.key_label, "3 keys");
  } finally {
    globalThis.fetch = orig;
  }
  db.close?.();
});

test("a failed key is reported per key and contributes nothing to the total", async () => {
  const { db, app } = await providerGateway(2);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(init.headers.Authorization).endsWith("test-0"))
      return jsonRes({ error: { message: "revoked" } }, 401);
    return jsonRes({ balance: 40 });
  };
  try {
    const res = await app.fetch(new Request("http://gw/admin/providers/1/credits", { headers: AUTH }));
    const b = await res.json();
    assert.equal(b.ok, true, "one key reported, so the read is ok");
    assert.equal(b.balance, 40, "only the working key's figure is summed, no phantom from the dead one");
    assert.equal(b.keys.length, 2);
    const failed = b.keys.find((k) => !k.ok);
    assert.equal(failed.status, 401);
    assert.match(failed.error, /revoked/);
  } finally {
    globalThis.fetch = orig;
  }
  db.close?.();
});

test("all keys failing reads as no balance, never zero", async () => {
  const { db, app } = await providerGateway(2);
  const { result } = await withStubFetch(
    () => jsonRes({ error: { message: "down" } }, 503),
    () => app.fetch(new Request("http://gw/admin/providers/1/credits", { headers: AUTH }))
  );
  const b = await result.json();
  assert.equal(b.ok, false);
  assert.equal(b.balance, null, "an all-failed pool must not read as an empty balance");
  assert.ok(b.keys.every((k) => k.status === 503));
  db.close?.();
});

test("the endpoint requires admin auth, a real provider, and a usable key", async () => {
  const { db, app } = await providerGateway();
  const noAuth = await app.fetch(new Request("http://gw/admin/providers/1/credits"));
  assert.equal(noAuth.status, 401);
  const missing = await app.fetch(new Request("http://gw/admin/providers/999/credits", { headers: AUTH }));
  assert.equal(missing.status, 404);
  // A provider with no key reports ok false with a reason, never a crash.
  db.prepare("DELETE FROM provider_keys WHERE provider_id=1").run();
  const noKey = await app.fetch(new Request("http://gw/admin/providers/1/credits", { headers: AUTH }));
  const kb = await noKey.json();
  assert.equal(kb.ok, false);
  assert.equal(kb.error, "provider has no usable key");
  db.close?.();
});
