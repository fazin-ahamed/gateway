// The operator credit book (/admin/credits): every allocation the gateway
// enforces in one read. Accounts and keys each get a quota row (kind, total,
// used, available), and the grand total must add remaining and spent amounts
// across BOTH shapes without ever counting an uncapped row's "infinite
// remainder" into the available sums.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const AUTH = { authorization: "Bearer admin" };

async function creditsGateway() {
  const { createApp } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  return { db, app: createApp(env), now };
}

async function getCredits(app) {
  const res = await app.fetch(new Request("http://gw/admin/credits", { headers: AUTH }));
  assert.equal(res.status, 200);
  return await res.json();
}

function rowFor(body, kind, id) {
  return (body.rows || []).find((r) => r.kind === kind && r.id === id);
}

test("each account and key gets its own quota row, capped and uncapped alike", async () => {
  const { db, app, now } = await creditsGateway();
  // Account-first shape: the customer carries the cap, keys inherit.
  db.prepare("INSERT INTO console_accounts (key_id, username, password_hash, created_at, budget_mode, budget_limit, used_usd, used_tokens) VALUES (?,?,?,?,?,?,?,?)")
    .bind("acct-a", "alice", "x", now, "usd", 10, 2.5, 1000).run();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, account_id, used_usd, used_tokens, created_at, updated_at) VALUES (?,?,1,'usd',50,?,0.5,200,?,?)")
    .bind("sk-alice", "alice-key", "acct-a", now, now).run();
  // Legacy shape: the account row IS the key's id, account_id NULL.
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, used_usd, used_tokens, created_at, updated_at) VALUES (?,?,1,'usd',4,1,900,?,?)")
    .bind("sk-legacy", "legacy-key", now, now).run();
  db.prepare("INSERT INTO console_accounts (key_id, username, password_hash, created_at, budget_mode, budget_limit, used_usd, used_tokens) VALUES (?,?,?,?,?,?,?,?)")
    .bind("sk-legacy", "veteran", "x", now, "usd", 4, 1, 900).run();
  // Standalone operator key, uncapped: api_keys.budget_limit is NOT NULL, and
  // both write paths enforce a positive number, so 0 is the legacy no-cap
  // marker the endpoint must read as uncapped (accounts use real NULL).
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, used_usd, used_tokens, created_at, updated_at) VALUES (?,?,1,'usd',0,7,3000,?,?)")
    .bind("sk-lonely", "operator-key", now, now).run();

  const body = await getCredits(app);

  const alice = rowFor(body, "account", "acct-a");
  assert.ok(alice, "the account row exists");
  assert.equal(alice.name, "alice");
  assert.deepEqual(alice.quota, { kind: "usd", total: 10, used: 2.5, available: 7.5 });

  const aliceKey = rowFor(body, "key", "sk-alice");
  assert.deepEqual(aliceKey.quota, { kind: "usd", total: 50, used: 0.5, available: 49.5 });
  assert.equal(aliceKey.owned_by_account, "acct-a", "the key points at its owning account");

  const legacyAcct = rowFor(body, "account", "sk-legacy");
  assert.deepEqual(legacyAcct.quota, { kind: "usd", total: 4, used: 1, available: 3 });

  const lonely = rowFor(body, "key", "sk-lonely");
  assert.deepEqual(lonely.quota, { kind: "usd", total: null, used: 7, available: null }, "uncapped reads total/available null, never a fake number");
  db.close?.();
});

test("token-mode budgets report kind tokens and use the token counters", async () => {
  const { db, app, now } = await creditsGateway();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, used_usd, used_tokens, created_at, updated_at) VALUES (?,?,1,'tokens',100000,3,60000,?,?)")
    .bind("sk-tok", "token-key", now, now).run();
  const body = await getCredits(app);
  const k = rowFor(body, "key", "sk-tok");
  assert.equal(k.quota.kind, "tokens");
  assert.equal(k.quota.used, 60000, "tokens mode must count tokens, not usd");
  assert.equal(k.quota.available, 40000);
  db.close?.();
});

test("grand totals sum remaining and used across rows, uncapped rows contribute usage only", async () => {
  const { db, app, now } = await creditsGateway();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, used_usd, used_tokens, created_at, updated_at) VALUES (?,?,1,'usd',10,4,0,?,?)")
    .bind("sk-one", "one", now, now).run();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, used_usd, used_tokens, created_at, updated_at) VALUES (?,?,1,'usd',0,1,0,?,?)")
    .bind("sk-uncapped", "uncapped", now, now).run();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, used_usd, used_tokens, created_at, updated_at) VALUES (?,?,1,'tokens',1000,0,400,?,?)")
    .bind("sk-tok", "tok", now, now).run();

  const body = await getCredits(app);
  assert.equal(body.total.usd.used, 5, "4 (capped) + 1 (uncapped) usage");
  assert.equal(body.total.usd.available, 6, "only the capped row's remainder (10-4) counts");
  assert.equal(body.total.tokens.used, 400);
  assert.equal(body.total.tokens.available, 600);
  db.close?.();
});

test("a spent-past-cap budget clamps available at zero, never negative", async () => {
  const { db, app, now } = await creditsGateway();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, used_usd, used_tokens, created_at, updated_at) VALUES (?,?,1,'usd',5,9,0,?,?)")
    .bind("sk-over", "over", now, now).run();
  const body = await getCredits(app);
  assert.equal(rowFor(body, "key", "sk-over").quota.available, 0);
  assert.equal(body.total.usd.available, 0, "the total never goes negative either");
  db.close?.();
});

test("the endpoint requires admin auth", async () => {
  const { db, app } = await creditsGateway();
  const res = await app.fetch(new Request("http://gw/admin/credits"));
  assert.equal(res.status, 401);
  db.close?.();
});

test("the Charm Hyper preset exists and points at hyper.charm.land/v1", async () => {
  const { db, app } = await creditsGateway();
  const res = await app.fetch(new Request("http://gw/admin/provider-presets", { headers: AUTH }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const preset = (body.presets || []).find((p) => p.id === "charm-hyper");
  assert.ok(preset, "the charm-hyper preset is offered to the console");
  assert.equal(preset.base_url, "https://hyper.charm.land/v1");
  assert.equal(preset.fmt, "openai");
  assert.ok(preset.routes.length >= 2, "seeds more than one route");
  db.close?.();
});
