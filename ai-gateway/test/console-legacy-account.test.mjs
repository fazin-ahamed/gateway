// The client console for an account that predates account ownership: the
// legacy 1:1 shape, where console_accounts.key_id IS the api key. Such an
// account must still see its own key, still see its limits, sign in with
// either the key or the username, and mint further keys alongside it.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

async function gateway() {
  const { createApp } = await import("../src/index.js");
  const { createHash } = await import("node:crypto");
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  const hash = createHash("sha256").update("password1").digest("hex");
  // A legacy key: it has a budget of its own and no account_id, and the account
  // row is keyed by this same key id.
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,1,?,?,?,?)")
    .bind("sk-legacy", "legacy-key", "usd", 25, now, now).run();
  db.prepare("INSERT INTO console_accounts (key_id, username, password_hash, created_at, budget_mode, budget_limit) VALUES (?,?,?,?,?,?)")
    .bind("sk-legacy", "veteran", hash, now, "usd", null).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(1, "P", "http://p.local", "direct", "openai", 1, 1, "round_robin", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)")
    .bind("glm-5.3", 1, "g").run();
  return { app: createApp({ DB: db, ADMIN_TOKEN: "admin" }), db };
}

function jar(res) {
  const raw = res.headers.get("set-cookie") || "";
  return raw.split(",").map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

const PASS = "password1";

// The gateway hashes with plain SHA-256 hex; compute the same without reaching
// into the module.
async function passHash() {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(PASS).digest("hex");
}

// A console session the way a real holder gets one: the key identifies the
// account, then the account's own credentials are presented. A bare key must
// not mint a session on its own.
async function signInWithKey(app, key, username) {
  const first = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key })
  }));
  const hint = await first.json().catch(() => ({}));
  const name = username || hint.username;
  return app.fetch(new Request("http://gw/console/auth", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, username: name, password: PASS })
  }));
}

test("a bare key does not hand over a console session", async () => {
  const { app, db } = await gateway();
  const res = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "sk-legacy" })
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.account, true, "the key alone only identifies the account");
  assert.equal(body.username, "veteran");
  assert.equal(res.headers.get("set-cookie"), null, "and issues no session");
  db.close?.();
});

test("a legacy key signs in and sees the account it belongs to", async () => {
  const { app, db } = await gateway();
  const res = await signInWithKey(app, "sk-legacy");
  assert.equal(res.status, 200, "the legacy key still signs in");
  const cookie = jar(res);

  const me = await app.fetch(new Request("http://gw/console/api/me", { headers: { cookie } }));
  assert.equal(me.status, 200);

  const keys = await (await app.fetch(new Request("http://gw/console/api/keys", { headers: { cookie } }))).json();
  assert.ok(keys.account, "the session resolves to the account, not to nothing");
  assert.equal(keys.account.username, "veteran");
  assert.equal(keys.keys.length, 1, "the account's own key is listed");
  assert.equal(keys.keys[0].key_id, "sk-legacy");
  assert.equal(keys.keys[0].own, true, "it is marked as the account's original key");
  db.close?.();
});

test("a legacy account reports the cap that actually binds, not uncapped", async () => {
  const { app, db } = await gateway();
  const cookie = jar(await signInWithKey(app, "sk-legacy"));
  const limits = await (await app.fetch(new Request("http://gw/console/api/limits", { headers: { cookie } }))).json();
  // The account row has no cap of its own; the key's 25 is what stops a request.
  assert.equal(limits.budget.limit, 25, "the key's cap is reported");
  assert.equal(limits.budget.uncapped, false);
  assert.equal(limits.budget_scope, "key");
  assert.equal(limits.keys, 1);
  db.close?.();
});

test("a legacy account can mint additional keys beside its original", async () => {
  const { app, db } = await gateway();
  const cookie = jar(await signInWithKey(app, "sk-legacy"));
  const made = await app.fetch(new Request("http://gw/console/api/keys", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "second" })
  }));
  assert.equal(made.status, 201);
  const body = await made.json();
  assert.ok(body.key.startsWith("sk-"));

  const keys = await (await app.fetch(new Request("http://gw/console/api/keys", { headers: { cookie } }))).json();
  const ids = keys.keys.map((k) => k.key_id).sort();
  assert.deepEqual(ids, ["sk-legacy", body.key].sort(), "both the original and the new key are listed");
  db.close?.();
});

test("a client can set a per-key cap when minting", async () => {
  const { app, db } = await gateway();
  const cookie = jar(await signInWithKey(app, "sk-legacy"));
  const made = await app.fetch(new Request("http://gw/console/api/keys", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "capped", budget_limit: 3 })
  }));
  const body = await made.json();
  assert.equal(body.budget_limit, 3);
  const row = db.prepare("SELECT budget_limit FROM api_keys WHERE key_id=?").bind(body.key).first();
  assert.equal(Number(row.budget_limit), 3, "the chosen cap is stored on the key");
  // A nonsensical cap is refused.
  const bad = await app.fetch(new Request("http://gw/console/api/keys", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "nope", budget_limit: -5 })
  }));
  assert.equal(bad.status, 400);
  db.close?.();
});

test("a minted key resolves to its account and still demands the account credentials", async () => {
  const { app, db } = await gateway();
  const cookie = jar(await signInWithKey(app, "sk-legacy"));
  const made = await (await app.fetch(new Request("http://gw/console/api/keys", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "child" })
  }))).json();

  // The bare key identifies the account without handing over a session.
  const bare = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: made.key })
  }));
  const hint = await bare.json();
  assert.equal(hint.account, true, "no setup prompt and no session from the key alone");
  assert.equal(hint.setup, undefined);
  assert.equal(bare.headers.get("set-cookie"), null);

  // With the account credentials it lands in the account that owns it.
  const full = await signInWithKey(app, made.key);
  assert.equal(full.status, 200);
  const childCookie = jar(full);
  const keys = await (await app.fetch(new Request("http://gw/console/api/keys", { headers: { cookie: childCookie } }))).json();
  assert.equal(keys.account.username, "veteran", "it lands in the owning account");
  assert.equal(keys.keys.length, 2, "and sees that account's keys");
  db.close?.();
});

test("a legacy account still signs in with its username and password", async () => {
  const { app, db } = await gateway();
  // The gateway hashes with plain SHA-256 hex; compute the same without
  // reaching into the module.
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update("password1").digest("hex");
  db.prepare("UPDATE console_accounts SET password_hash=? WHERE key_id='sk-legacy'").bind(hash).run();
  const res = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "veteran", password: "password1" })
  }));
  assert.equal(res.status, 200);
  const keys = await (await app.fetch(new Request("http://gw/console/api/keys", { headers: { cookie: jar(res) } }))).json();
  assert.equal(keys.keys[0].own, true);
  db.close?.();
});

test("usage for a legacy account covers its own key and any it minted", async () => {
  const { app, db } = await gateway();
  const cookie = jar(await signInWithKey(app, "sk-legacy"));
  const made = await (await app.fetch(new Request("http://gw/console/api/keys", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "child" })
  }))).json();
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO request_summaries (request_id, key_id, model_kind, public_slug, created_at, status, http_status, total_tokens, cost_usd, attempts) VALUES (?,?,?,?,?,?,?,?,?,?)");
  ins.bind("r1", "sk-legacy", "chat", "glm-5.3", now, "ok", 200, 10, 0.1, 1).run();
  ins.bind("r2", made.key, "chat", "glm-5.3", now, "ok", 200, 20, 0.2, 1).run();
  const ov = await (await app.fetch(new Request("http://gw/console/api/overview?days=7", { headers: { cookie } }))).json();
  assert.equal(ov.totals.requests, 2, "both the original and minted key are in scope");
  assert.equal(ov.totals.tokens, 30);
  db.close?.();
});
