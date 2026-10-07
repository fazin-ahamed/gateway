import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDb } from "../../server/db.mjs";
import { migrateConsoleAccounts } from "../../server/migrations.mjs";
import { createApp } from "../src/index.js";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const headers = { authorization: "Bearer admin", "content-type": "application/json" };

for (const parent of ["api_keys", "console_accounts"]) {
  test(`account invites survive the legacy token reference to ${parent}`, async () => {
    const db = createDb(":memory:");
    db.exec(schema);
    db.exec(`
      INSERT INTO api_keys (key_id, name, created_at, updated_at) VALUES ('sk-legacy', 'legacy', '2026-10-07', '2026-10-07');
      INSERT INTO console_accounts (key_id, username, password_hash, created_at) VALUES ('sk-legacy', 'legacy', 'unused', '2026-10-07');
      DROP TABLE console_account_tokens;
      CREATE TABLE console_account_tokens (
        token_hash TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES ${parent}(key_id) ON DELETE CASCADE,
        purpose TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
        budget_mode TEXT, budget_limit REAL, tier_ids TEXT
      );
      INSERT INTO console_account_tokens VALUES ('pending', 'sk-legacy', 'reset', '2026-10-07', '2099-01-01', NULL, 'usd', 12, '1,2');
      INSERT INTO console_account_tokens VALUES ('consumed', 'sk-legacy', 'invite', '2026-10-07', '2099-01-01', '2026-10-07', NULL, NULL, NULL);
    `);
    const existing = db.prepare("SELECT * FROM console_account_tokens ORDER BY token_hash").all().results;
    const app = createApp({ DB: db, ADMIN_TOKEN: "admin" });
    migrateConsoleAccounts(db);
    migrateConsoleAccounts(db);
    assert.deepEqual(db.prepare("SELECT * FROM console_account_tokens ORDER BY token_hash").all().results, existing);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all().results, []);
    const issued = await app.fetch(new Request("http://gw/admin/accounts", {
      method: "POST", headers, body: JSON.stringify({ budget_mode: "usd", budget_limit: 10, tier_ids: [] })
    }));
    assert.equal(issued.status, 201, await issued.clone().text());
    const link = await issued.json();
    assert.equal(db.prepare("SELECT key_id FROM console_accounts WHERE key_id=?").bind(link.account_id).first(), null);
    const redeemed = await app.fetch(new Request("http://gw/console/redeem-api", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link.token, username: "new-customer", password: "password123" })
    }));
    assert.equal(redeemed.status, 200, await redeemed.clone().text());
    const account = db.prepare("SELECT username, budget_limit FROM console_accounts WHERE key_id=?").bind(link.account_id).first();
    assert.equal(account.username, "new-customer");
    assert.equal(account.budget_limit, 10);
    const replay = await app.fetch(new Request("http://gw/console/redeem-api", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link.token, username: "replayed", password: "password123" })
    }));
    assert.equal(replay.status, 401);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all().results, []);
  });
}
