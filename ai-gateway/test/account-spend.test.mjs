// Spend debits must land on the account that owns the key, under BOTH shapes:
// an account-owned key (api_keys.account_id set) and the legacy 1:1 shape,
// where the account row is keyed by the api key itself. The bug: recordUsage
// only debited via key.account_id, so a legacy account's spend froze at zero on
// every console surface (usage totals, limits, the budget ring) while the key
// counter kept growing — "the key says I spent, the account says nothing".

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

async function gateway() {
  const { __test } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  // The legacy shape: account row keyed by the key itself, account_id NULL.
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,1,'usd',50,?,?)")
    .bind("sk-legacy", "legacy-key", now, now).run();
  db.prepare("INSERT INTO console_accounts (key_id, username, password_hash, created_at, budget_mode, budget_limit) VALUES (?,?,?,?,?,NULL)")
    .bind("sk-legacy", "veteran", "x", now, "usd").run();
  // The owned shape: the key carries account_id.
  db.prepare("INSERT INTO console_accounts (key_id, username, password_hash, created_at, budget_mode, budget_limit) VALUES (?,?,?,?,?,NULL)")
    .bind("acct_new", "modern", "x", now, "usd").run();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, account_id, created_at, updated_at) VALUES (?,?,1,'usd',50,?,?,?)")
    .bind("sk-owned", "modern-key", "acct_new", now, now).run();
  // An operator key with no account at all: its spend must touch no account row.
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,1,'usd',50,?,?)")
    .bind("sk-lonely", "operator-key", now, now).run();
  return { db, __test };
}

async function spend(db, __test, keyId, usage) {
  const key = db.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(keyId).first();
  await __test.recordUsage({ env: { DB: db } }, key, usage);
}

function acctRow(db, id) {
  return db.prepare("SELECT used_usd, used_tokens FROM console_accounts WHERE key_id=?").bind(id).first();
}
function keyRow(db, id) {
  return db.prepare("SELECT used_usd, used_tokens, request_count FROM api_keys WHERE key_id=?").bind(id).first();
}

test("a legacy key's spend debits the account it is", async () => {
  const { db, __test } = await gateway();
  await spend(db, __test, "sk-legacy", { total_tokens: 100, cost_usd: 0.4 });
  const k = keyRow(db, "sk-legacy");
  assert.equal(Number(k.used_usd), 0.4, "the key counter grows");
  assert.equal(Number(k.request_count), 1);
  const a = acctRow(db, "sk-legacy");
  assert.equal(Number(a.used_usd), 0.4, "and so does the account it belongs to");
  assert.equal(Number(a.used_tokens), 100);
  db.close?.();
});

test("an owned key's spend debits its account, not the key's own row", async () => {
  const { db, __test } = await gateway();
  await spend(db, __test, "sk-owned", { total_tokens: 200, cost_usd: 0.6 });
  const a = acctRow(db, "acct_new");
  assert.equal(Number(a.used_usd), 0.6);
  assert.equal(Number(a.used_tokens), 200);
  const wrongAcct = acctRow(db, "sk-owned");
  assert.ok(!wrongAcct, "no phantom account keyed by the key itself was debited");
  db.close?.();
});

test("a key with no account debits no account row", async () => {
  const { db, __test } = await gateway();
  await spend(db, __test, "sk-lonely", { total_tokens: 50, cost_usd: 0.1 });
  const k = keyRow(db, "sk-lonely");
  assert.equal(Number(k.used_usd), 0.1, "the key counter still grows");
  const rows = db.prepare("SELECT COUNT(*) n FROM console_accounts WHERE used_usd > 0").first();
  assert.equal(Number(rows.n), 0, "but no account was touched");
  db.close?.();
});

test("repeat spend accumulates on both shapes", async () => {
  const { db, __test } = await gateway();
  await spend(db, __test, "sk-legacy", { total_tokens: 100, cost_usd: 0.4 });
  await spend(db, __test, "sk-legacy", { total_tokens: 100, cost_usd: 0.4 });
  await spend(db, __test, "sk-owned", { total_tokens: 200, cost_usd: 0.6 });
  assert.equal(Number(acctRow(db, "sk-legacy").used_usd), 0.8);
  assert.equal(Number(acctRow(db, "acct_new").used_usd), 0.6);
  assert.equal(Number(keyRow(db, "sk-legacy").request_count), 2);
  db.close?.();
});

// The cap gate must block on the same ownership the debit uses. Before the fix,
// a legacy account with a fully spent account-level cap sailed through auth
// because the gate only looked at key.account_id, which is NULL in that shape.
test("a legacy account whose cap is spent is blocked at auth", async () => {
  const { createApp } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,1,'usd',1000,?,?)")
    .bind("sk-original-key", "veteran-app", now, now).run();
  db.prepare("INSERT INTO console_accounts (key_id, username, password_hash, created_at, budget_mode, budget_limit) VALUES (?,?,?,?,'usd',10)")
    .bind("sk-original-key", "veteran", "x", now).run();
  db.prepare("UPDATE console_accounts SET used_usd=10 WHERE key_id='sk-original-key'").run();
  const app = createApp({ DB: db, ADMIN_TOKEN: "admin" });
  const res = await app.fetch(new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-original-key" },
    body: JSON.stringify({ model: "whatever", messages: [{ role: "user", content: "hi" }] })
  }));
  assert.equal(res.status, 429);
  assert.match((await res.json()).error.message, /Account spend limit reached/);
  db.close?.();
});

test("a legacy account under its cap passes auth, and a key with no account is not phantom-capped", async () => {
  const { createApp } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,1,1,?,?)")
    .bind(1, "P", "http://p.local", "direct", "openai", "round_robin", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)")
    .bind("m", 1, "up").run();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,1,'usd',1000,?,?)")
    .bind("sk-original-key", "veteran-app", now, now).run();
  db.prepare("INSERT INTO console_accounts (key_id, username, password_hash, created_at, budget_mode, budget_limit) VALUES (?,?,?,?,'usd',10)")
    .bind("sk-original-key", "veteran", "x", now).run();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,1,'usd',1000,?,?)")
    .bind("sk-lonely", "operator-key", now, now).run();
  const app = createApp({ DB: db, ADMIN_TOKEN: "admin" });
  for (const keyId of ["sk-original-key", "sk-lonely"]) {
    const res = await app.fetch(new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + keyId },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] })
    }));
    assert.notEqual(res.status, 429, keyId + " must not be blocked by a cap");
    // The request reached serving (it fails later only because the provider has
    // no credential in this fixture), which proves auth passed.
  }
  db.close?.();
});

// The historical drift this whole file fixes: spend that predates the fix sat
// only on the key counters. The host migration reconciles it once, per account,
// without double-counting accounts that already carried some spend.
test("migration backfills legacy account spend once, without double-counting", async () => {
  const { migrateConsoleAccounts } = await import("../../server/migrations.mjs");
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  // Legacy: the key spent 5.00, the account counter never moved.
  db.prepare("INSERT INTO api_keys (key_id,name,active,budget_mode,budget_limit,used_usd,used_tokens,created_at,updated_at) VALUES (?,?,1,'usd',100,5,1200,?,?)")
    .bind("sk-l", "legacy", now, now).run();
  db.prepare("INSERT INTO console_accounts (key_id,username,password_hash,created_at,budget_mode,budget_limit) VALUES (?,?,?,?,'usd',NULL)")
    .bind("sk-l", "veteran", "x", now).run();
  // Owned shape: same situation via account_id.
  db.prepare("INSERT INTO console_accounts (key_id,username,password_hash,created_at,budget_mode,budget_limit) VALUES (?,?,?,?,'usd',NULL)")
    .bind("acct-n", "modern", "x", now).run();
  db.prepare("INSERT INTO api_keys (key_id,name,active,budget_mode,budget_limit,used_usd,used_tokens,account_id,created_at,updated_at) VALUES (?,?,1,'usd',100,2,800,'acct-n',?,?)")
    .bind("sk-n", "modern-key", now, now).run();
  // Already-billed account: the fixed debit had run here; must stay as-is.
  db.prepare("INSERT INTO console_accounts (key_id,username,password_hash,created_at,budget_mode,budget_limit,used_usd,used_tokens) VALUES (?,?,?,?,'usd',NULL,1,300)")
    .bind("acct-d", "done", "x", now).run();
  db.prepare("INSERT INTO api_keys (key_id,name,active,budget_mode,budget_limit,used_usd,used_tokens,account_id,created_at,updated_at) VALUES (?,?,1,'usd',100,1,300,'acct-d',?,?)")
    .bind("sk-d", "done-key", now, now).run();

  const added = migrateConsoleAccounts(db);
  assert.ok(added.includes("account.spend_backfill"), "the backfill ran");
  assert.equal(Number(db.prepare("SELECT used_usd FROM console_accounts WHERE key_id='sk-l'").first().used_usd), 5);
  assert.equal(Number(db.prepare("SELECT used_usd FROM console_accounts WHERE key_id='acct-n'").first().used_usd), 2);
  assert.equal(Number(db.prepare("SELECT used_usd FROM console_accounts WHERE key_id='acct-d'").first().used_usd), 1, "no double count");

  migrateConsoleAccounts(db);
  assert.equal(Number(db.prepare("SELECT used_usd FROM console_accounts WHERE key_id='sk-l'").first().used_usd), 5, "idempotent on re-run");
  db.close?.();
});
