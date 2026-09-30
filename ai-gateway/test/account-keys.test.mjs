// The account-first flow: the operator creates a customer (cap + tiers) and
// hands over one link. The recipient sets up credentials with no key in
// sight, mints their own keys, and every key's spend counts against the
// account cap. Usage views cover every owned key, filterable to one.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const ADMIN = { authorization: "Bearer admin" };

async function gateway() {
  const { createApp } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind("sk-op", "operator", 1, "usd", 1e9, now, now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(1, "P", "http://p.local", "direct", "openai", 1, 1, "round_robin", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)")
    .bind("glm-5.3", 1, "g").run();
  db.prepare("INSERT INTO model_tiers (id, name, models, created_at, updated_at) VALUES (?,?,?, ?,?)")
    .bind(1, "basic", "glm-5.3", now, now).run();
  return { app: createApp({ DB: db, ADMIN_TOKEN: "admin" }), db };
}

function cookies(res) {
  const raw = res.headers.get("set-cookie") || "";
  return raw.split(",").map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

async function j(res) {
  return res.json();
}

test("operator creates an account, the link makes it real with no key involved", async () => {
  const { app, db } = await gateway();
  const created = await app.fetch(new Request("http://gw/admin/accounts", {
    method: "POST", headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ budget_mode: "usd", budget_limit: 25, tier_ids: [1] })
  }));
  const acct = await j(created);
  assert.equal(created.status, 201);
  assert.ok(acct.account_id.startsWith("acct_"), "the account id is its own entity, not a key");
  assert.match(acct.url, /\/console\/redeem\?token=rst_/);

  // No key exists yet; nothing in api_keys points at this account.
  const owned = db.prepare("SELECT COUNT(*) n FROM api_keys WHERE account_id=?").bind(acct.account_id).first();
  assert.equal(Number(owned.n), 0, "no key is minted before the user signs in");

  // The recipient redeems the link and lands signed-in.
  const probe = await j(await app.fetch(new Request("http://gw/console/redeem-api?token=" + acct.token)));
  assert.equal(probe.purpose, "invite");
  const redeemed = await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: acct.token, username: "maya", password: "password1" })
  }));
  assert.equal(redeemed.status, 200);
  const jar = cookies(redeemed);
  assert.ok(jar.includes("gw_client="), "redemption signs the account in");

  // The account carries the operator's cap and tier, not the redeemer's choice.
  const row = db.prepare("SELECT budget_mode, budget_limit FROM console_accounts WHERE username='maya'").first();
  assert.equal(Number(row.budget_limit), 25);
  const tiers = db.prepare("SELECT COUNT(*) n FROM console_account_tiers WHERE key_id=(SELECT key_id FROM console_accounts WHERE username='maya')").first();
  assert.equal(Number(tiers.n), 1, "the invite's tier reached the account");
  db.close?.();
});

test("the account holder mints keys that inherit tiers, and spend is capped at the account", async () => {
  const { app, db } = await gateway();
  const acct = await j(await app.fetch(new Request("http://gw/admin/accounts", {
    method: "POST", headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ budget_mode: "usd", budget_limit: 1, tier_ids: [1] })
  })));
  const redeemed = await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: acct.token, username: "maya", password: "password1" })
  }));
  const jar = cookies(redeemed);

  // Mint two keys from the console.
  const k1 = await j(await app.fetch(new Request("http://gw/console/api/keys", {
    method: "POST", headers: { "content-type": "application/json", cookie: jar },
    body: JSON.stringify({ name: "laptop" })
  })));
  assert.equal(k1.key.startsWith("sk-"), true, "a real key id comes back");
  const k2 = await j(await app.fetch(new Request("http://gw/console/api/keys", {
    method: "POST", headers: { "content-type": "application/json", cookie: jar },
    body: JSON.stringify({ name: "server" })
  })));
  assert.notEqual(k1.key, k2.key);

  // Both keys inherit the account tier.
  for (const key of [k1.key, k2.key]) {
    const tiers = db.prepare("SELECT COUNT(*) n FROM api_key_model_tiers WHERE key_id=?").bind(key).first();
    assert.equal(Number(tiers.n), 1, "the minted key inherits the account tier");
  }
  // Both point at the account.
  for (const key of [k1.key, k2.key]) {
    const owner = db.prepare("SELECT account_id FROM api_keys WHERE key_id=?").bind(key).first();
    assert.equal(owner.account_id, acct.account_id);
  }

  // Burn the cap through one key; both keys die at the account level.
  db.prepare("UPDATE console_accounts SET used_usd=1 WHERE key_id=?").bind(acct.account_id).run();
  const blocked = await app.fetch(new Request("http://gw/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + k2.key },
    body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] })
  }));
  assert.equal(blocked.status, 429, "the untouched key is blocked by its sibling's spend");
  assert.match((await blocked.json()).error.message, /Account spend limit/);
  db.close?.();
});

test("usage views cover every owned key and narrow on ?key_id", async () => {
  const { app, db } = await gateway();
  const acct = await j(await app.fetch(new Request("http://gw/admin/accounts", {
    method: "POST", headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ budget_mode: "usd", budget_limit: 100, tier_ids: [1] })
  })));
  const redeemed = await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: acct.token, username: "maya", password: "password1" })
  }));
  const jar = cookies(redeemed);
  const k1 = (await j(await app.fetch(new Request("http://gw/console/api/keys", {
    method: "POST", headers: { "content-type": "application/json", cookie: jar }, body: JSON.stringify({ name: "a" })
  })))).key;
  const k2 = (await j(await app.fetch(new Request("http://gw/console/api/keys", {
    method: "POST", headers: { "content-type": "application/json", cookie: jar }, body: JSON.stringify({ name: "b" })
  })))).key;

  // Ledger rows for both keys; a third row for a stranger that must never show.
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO request_summaries (request_id, key_id, model_kind, public_slug, created_at, status, http_status, total_tokens, cost_usd, attempts) VALUES (?,?,?,?,?,?,?,?,?,?)");
  ins.bind("r1", k1, "chat", "glm-5.3", now, "ok", 200, 100, 0.4, 1).run();
  ins.bind("r2", k2, "chat", "glm-5.3", now, "ok", 200, 200, 0.6, 1).run();
  ins.bind("r3", "sk-op", "chat", "glm-5.3", now, "ok", 200, 999, 999, 1).run();

  const all = await j(await app.fetch(new Request("http://gw/console/api/overview?days=7", { headers: { cookie: jar } })));
  assert.equal(all.totals.requests, 2, "both owned keys count, the operator's does not");
  assert.equal(all.totals.tokens, 300);
  assert.equal(all.totals.spend_usd, 1);

  const one = await j(await app.fetch(new Request(`http://gw/console/api/overview?days=7&key_id=${k2}`, { headers: { cookie: jar } })));
  assert.equal(one.totals.requests, 1, "the filter narrows to the chosen key");
  assert.equal(one.totals.tokens, 200);

  const stranger = await j(await app.fetch(new Request("http://gw/console/api/overview?days=7&key_id=sk-op", { headers: { cookie: jar } })));
  assert.equal(stranger.totals.requests, 0, "a key the account does not own filters to nothing");

  const drawer = await app.fetch(new Request("http://gw/console/api/requests/r3", { headers: { cookie: jar } }));
  assert.equal(drawer.status, 404, "another key's request is invisible in the drawer");
  const mine = await app.fetch(new Request("http://gw/console/api/requests/r1", { headers: { cookie: jar } }));
  assert.equal(mine.status, 200);
  db.close?.();
});

test("a minted key can be disabled and deleted only by its owning account", async () => {
  const { app, db } = await gateway();
  const acct = await j(await app.fetch(new Request("http://gw/admin/accounts", {
    method: "POST", headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ budget_mode: "usd", budget_limit: 100, tier_ids: [1] })
  })));
  const redeemed = await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: acct.token, username: "maya", password: "password1" })
  }));
  const jar = cookies(redeemed);
  const k1 = (await j(await app.fetch(new Request("http://gw/console/api/keys", {
    method: "POST", headers: { "content-type": "application/json", cookie: jar }, body: JSON.stringify({ name: "a" })
  })))).key;

  // A different account cannot touch this key.
  const other = await j(await app.fetch(new Request("http://gw/admin/accounts", {
    method: "POST", headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ budget_mode: "usd", budget_limit: 100, tier_ids: [] })
  })));
  const otherJar = cookies(await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: other.token, username: "rafe", password: "password1" })
  })));
  const foreign = await app.fetch(new Request("http://gw/console/api/keys/" + k1 + "/active", {
    method: "POST", headers: { "content-type": "application/json", cookie: otherJar }, body: JSON.stringify({ active: false })
  }));
  assert.equal(foreign.status, 404, "another account cannot disable a key it does not own");

  // The owner can.
  const off = await app.fetch(new Request("http://gw/console/api/keys/" + k1 + "/active", {
    method: "POST", headers: { "content-type": "application/json", cookie: jar }, body: JSON.stringify({ active: false })
  }));
  assert.equal(off.status, 200);
  assert.equal((await j(off)).active, false);

  const del = await app.fetch(new Request("http://gw/console/api/keys/" + k1, { method: "DELETE", headers: { cookie: jar } }));
  assert.equal(del.status, 200);
  const gone = db.prepare("SELECT COUNT(*) n FROM api_keys WHERE key_id=?").bind(k1).first();
  assert.equal(Number(gone.n), 0, "the key is gone");
  db.close?.();
});

test("the operator can re-cut an account's cap and tiers after the fact", async () => {
  const { app, db } = await gateway();
  const acct = await j(await app.fetch(new Request("http://gw/admin/accounts", {
    method: "POST", headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ budget_mode: "usd", budget_limit: 50, tier_ids: [1] })
  })));
  await app.fetch(new Request("http://gw/console/redeem-api", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: acct.token, username: "maya", password: "password1" })
  }));
  const patch = await app.fetch(new Request("http://gw/admin/accounts/" + acct.account_id, {
    method: "PATCH", headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ budget_limit: 10, tier_ids: [] })
  }));
  assert.equal(patch.status, 200);
  const row = db.prepare("SELECT budget_limit FROM console_accounts WHERE key_id=?").bind(acct.account_id).first();
  assert.equal(Number(row.budget_limit), 10);
  const tiers = db.prepare("SELECT COUNT(*) n FROM console_account_tiers WHERE key_id=?").bind(acct.account_id).first();
  assert.equal(Number(tiers.n), 0, "the tier grant is cleared");
  db.close?.();
});
