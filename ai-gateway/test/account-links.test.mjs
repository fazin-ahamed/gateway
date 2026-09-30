// Admin-side account management: reset links, invite links, the account roster,
// and the public redemption page they open. A link is single-use and expires;
// the operator can revoke a pending one; deleting a key drops its links.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function adminHeaders() {
  return { authorization: "Bearer admin" };
}

async function freshGateway() {
  const { createApp } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind("sk-one", "one", 1, "usd", 5, now, now).run();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind("sk-two", "two", 1, "usd", 10, now, now).run();
  db.prepare("INSERT INTO model_tiers (id, name, models, created_at, updated_at) VALUES (?,?,?, ?,?)")
    .bind(1, "basic", "glm-5.3,glm-5.2", now, now).run();
  db.prepare("INSERT INTO api_key_model_tiers (key_id, tier_id) VALUES (?,?)").bind("sk-two", 1).run();
  const app = createApp({ DB: db, ADMIN_TOKEN: "admin" });
  return { app, db };
}

async function signInAccount(app, keyId, username, password) {
  await app.fetch(new Request("http://gw/console/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: keyId, username, password })
  }));
}

test("an account roster lists account caps, tiers, and key counts", async () => {
  const { app, db } = await freshGateway();
  await signInAccount(app, "sk-two", "alice", "password1");
  // Attach alice's key to her account so it counts as account-owned.
  db.prepare("UPDATE api_keys SET account_id=(SELECT key_id FROM console_accounts WHERE username='alice') WHERE key_id='sk-two'").run();
  const res = await app.fetch(new Request("http://gw/admin/accounts", { headers: adminHeaders() }));
  const body = await res.json();
  assert.equal(res.status, 200);
  const acct = body.accounts.find((a) => a.username === "alice");
  assert.ok(acct, "alice is listed");
  assert.equal(acct.key_count, 1, "her key counts toward the account");
  db.close?.();
});

test("an admin can create and copy a password reset link for an account", async () => {
  const { app } = await freshGateway();
  await signInAccount(app, "sk-one", "bob", "oldpass1");
  const res = await app.fetch(new Request("http://gw/admin/accounts/sk-one/reset-link", {
    method: "POST",
    headers: adminHeaders()
  }));
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.match(body.url, /^http:\/\/gw\/console\/redeem\?token=rst_/, "a full copyable URL comes back");
  const probe = await app.fetch(new Request("http://gw/console/redeem-api?token=" + body.token));
  const info = await probe.json();
  assert.equal(info.valid, true);
  assert.equal(info.purpose, "reset");
  assert.equal(info.username, "bob");
});

test("redeeming a reset link replaces the password and signs the user in", async () => {
  const { app } = await freshGateway();
  await signInAccount(app, "sk-one", "bob", "oldpass1");
  const issued = await (await app.fetch(new Request("http://gw/admin/accounts/sk-one/reset-link", {
    method: "POST",
    headers: adminHeaders()
  }))).json();
  const res = await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: issued.token, username: "bob", password: "newpass1" })
  }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  // The old password must stop working.
  const old = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "bob", password: "oldpass1" })
  }));
  assert.equal(old.status, 401);
  const neu = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "bob", password: "newpass1" })
  }));
  assert.equal(neu.status, 200);
});

test("a reset link is single-use: a second redemption is refused", async () => {
  const { app } = await freshGateway();
  await signInAccount(app, "sk-one", "bob", "oldpass1");
  const issued = await (await app.fetch(new Request("http://gw/admin/accounts/sk-one/reset-link", {
    method: "POST",
    headers: adminHeaders()
  }))).json();
  const first = await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: issued.token, username: "bob", password: "newpass1" })
  }));
  assert.equal(first.status, 200);
  const second = await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: issued.token, username: "bob", password: "otherpas" })
  }));
  assert.equal(second.status, 401);
  const probe = await app.fetch(new Request("http://gw/console/redeem-api?token=" + issued.token));
  assert.equal((await probe.json()).valid, false, "a used link probes invalid");
});

test("an admin can create an account invite link that sets up a fresh account", async () => {
  const { app } = await freshGateway();
  const issued = await (await app.fetch(new Request("http://gw/admin/accounts/sk-one/invite-link", {
    method: "POST",
    headers: adminHeaders()
  }))).json();
  assert.equal(issued.url.startsWith("http://gw/console/redeem?token=rst_"), true);
  const probe = await app.fetch(new Request("http://gw/console/redeem-api?token=" + issued.token));
  const info = await probe.json();
  assert.equal(info.purpose, "invite");
  assert.equal(info.has_account, false);
  const res = await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: issued.token, username: "carol", password: "password1" })
  }));
  assert.equal(res.status, 200);
  const roster = await (await app.fetch(new Request("http://gw/admin/accounts", { headers: adminHeaders() }))).json();
  assert.ok(roster.accounts.some((a) => a.username === "carol"));
});

test("an invite is refused when the key already has an account", async () => {
  const { app } = await freshGateway();
  await signInAccount(app, "sk-one", "bob", "oldpass1");
  const res = await app.fetch(new Request("http://gw/admin/accounts/sk-one/invite-link", {
    method: "POST",
    headers: adminHeaders()
  }));
  assert.equal(res.status, 409);
});

test("an admin can revoke a pending link", async () => {
  const { app } = await freshGateway();
  const issued = await (await app.fetch(new Request("http://gw/admin/accounts/sk-one/invite-link", {
    method: "POST",
    headers: adminHeaders()
  }))).json();
  const revoked = await app.fetch(new Request("http://gw/admin/account-tokens/" + issued.token, {
    method: "DELETE",
    headers: adminHeaders()
  }));
  assert.equal(revoked.status, 200);
  const probe = await app.fetch(new Request("http://gw/console/redeem-api?token=" + issued.token));
  assert.equal((await probe.json()).valid, false);
  const attempt = await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: issued.token, username: "carol", password: "password1" })
  }));
  assert.equal(attempt.status, 401);
});

test("a tampered or unknown token is refused with no state leak", async () => {
  const { app } = await freshGateway();
  const probe = await app.fetch(new Request("http://gw/console/redeem-api?token=rst_nope"));
  assert.equal(probe.status, 200);
  assert.equal((await probe.json()).valid, false);
  const attempt = await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "rst_nope", username: "carol", password: "password1" })
  }));
  assert.equal(attempt.status, 401);
});

test("a weak password on a redeem is rejected without consuming the link", async () => {
  const { app } = await freshGateway();
  const issued = await (await app.fetch(new Request("http://gw/admin/accounts/sk-one/invite-link", {
    method: "POST",
    headers: adminHeaders()
  }))).json();
  const weak = await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: issued.token, username: "carol", password: "short" })
  }));
  assert.equal(weak.status, 400);
  // The link survives a rejected attempt.
  const probe = await app.fetch(new Request("http://gw/console/redeem-api?token=" + issued.token));
  assert.equal((await probe.json()).valid, true);
});

test("deleting a key removes its pending account links", async () => {
  const { app, db } = await freshGateway();
  const issued = await (await app.fetch(new Request("http://gw/admin/accounts/sk-one/invite-link", {
    method: "POST",
    headers: adminHeaders()
  }))).json();
  const del = await app.fetch(new Request("http://gw/admin/keys/sk-one", { method: "DELETE", headers: adminHeaders() }));
  assert.equal(del.status, 200);
  const rows = db.prepare("SELECT COUNT(*) AS n FROM console_account_tokens WHERE key_id=?").bind("sk-one").first();
  assert.equal(rows.n, 0, "links die with the key");
  const probe = await app.fetch(new Request("http://gw/console/redeem-api?token=" + issued.token));
  assert.equal((await probe.json()).valid, false);
  db.close?.();
});
