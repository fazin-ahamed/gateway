// The account-link 500: on old host databases the lazy account migration
// (ensureAccountTokensTable) ALTERs api_keys without checking the table exists.
// PRAGMA table_info on a missing table returns no rows, so the ALTER threw
// "no such table: api_keys" and Hono turned it into a bare 500 with no reason
// the console could show. Two hardenings:
//   1. the migration skips the api_keys step when the table is absent (schema
//      auto-apply at boot owns creating it; the lazy path must not assume it
//      succeeded) - and marks migration done either way;
//   2. POST /admin/accounts wraps the migration and the token INSERT, so a
//      failure on an old database returns a structured error naming the cause
//      instead of a raw 500, and the operator sees it in the UI.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";

// The minimal old-host shape: console tables exist, api_keys does NOT.
const OLD_DB = `
CREATE TABLE gateway_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE console_accounts (key_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE console_account_tokens (token_hash TEXT PRIMARY KEY, key_id TEXT NOT NULL, purpose TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
`;

async function oldGateway() {
  const { createApp } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(OLD_DB);
  return { db, app: createApp({ DB: db, PROVIDER_CRYPTO_KEY: "k", ADMIN_TOKEN: "admin" }) };
}

const post = (app, body) => app.fetch(new Request("http://gw/admin/accounts", {
  method: "POST",
  headers: { authorization: "Bearer admin", "content-type": "application/json" },
  body: JSON.stringify(body)
}));

test("creating an account link on an old host DB without api_keys returns 201, not a 500", async () => {
  const { db, app } = await oldGateway();
  const res = await post(app, { budget_mode: "usd", budget_limit: 10, tier_ids: [] });
  assert.equal(res.status, 201, "the invite is issued; the missing api_keys table is the boot schema's job");
  const body = await res.json();
  assert.ok(body.url.includes("/console/redeem?token=rst_"), "the link is a redeem URL");
  assert.ok(body.token.startsWith("rst_"));
  db.close?.();
});

test("a migration failure that DOES happen surfaces the reason, never a bare 500", async () => {
  const { createApp } = await import("../src/index.js");
  const db = createDb(":memory:");
  // A tokens table the INSERT genuinely cannot satisfy: an extra NOT NULL
  // column with no default, as an old host table might carry. SQLite is
  // dynamically typed, so column TYPE mismatches never fail writes; a
  // required column the INSERT does not provide does.
  db.exec(OLD_DB);
  db.exec("DROP TABLE console_account_tokens;");
  db.exec("CREATE TABLE console_account_tokens (token_hash TEXT PRIMARY KEY, key_id TEXT NOT NULL, purpose TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, budget_mode TEXT, budget_limit REAL, tier_ids TEXT, legacy_required TEXT NOT NULL);");
  const app = createApp({ DB: db, PROVIDER_CRYPTO_KEY: "k", ADMIN_TOKEN: "admin" });
  const res = await post(app, { budget_mode: "usd", budget_limit: 10, tier_ids: [] });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.ok(body.error && body.error.message, "the 500 carries a structured reason");
  assert.match(body.error.message, /could not be (prepared|stored)/, "the reason names which step failed");
  db.close?.();
});
