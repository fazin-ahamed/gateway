// Trajectory filtering by account, key, and model. An account filter must
// reach every key the account owns, its stats must follow the filter rather
// than reporting gateway-wide totals, and a filter that matches nothing must
// return nothing instead of silently widening to all rows.

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
  db.prepare("INSERT INTO console_accounts (key_id, username, password_hash, created_at, budget_mode, budget_limit) VALUES (?,?,?,?,?,?)")
    .bind("acct_a", "alpha", "x", now, "usd", 10).run();
  db.prepare("INSERT INTO console_accounts (key_id, username, password_hash, created_at, budget_mode, budget_limit) VALUES (?,?,?,?,?,?)")
    .bind("acct_b", "beta", "x", now, "usd", 10).run();
  const mk = db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, account_id, created_at, updated_at) VALUES (?,?,1,?,?,?,?,?)");
  mk.bind("sk-k1", "a-laptop", "usd", 100, "acct_a", now, now).run();
  mk.bind("sk-k1b", "a-server", "usd", 100, "acct_a", now, now).run();
  mk.bind("sk-k2", "b-laptop", "usd", 100, "acct_b", now, now).run();
  mk.bind("sk-op", "operator", "usd", 100, null, now, now).run();
  const t = db.prepare("INSERT INTO trajectories (id, created_at, key_id, key_name, slug, status, provider, attempts, total_tokens, cost_usd, latency_ms, steps_json) VALUES (?,?,?,?,?,?,?,1,?,?,?,?)");
  t.bind("t1", now, "sk-k1", "a-laptop", "glm-5.3", "ok", "P", 100, 0.1, 500, "[]").run();
  t.bind("t2", now, "sk-k1", "a-laptop", "glm-5.2", "fail", "P", 50, 0, 900, "[]").run();
  t.bind("t3", now, "sk-k1b", "a-server", "glm-5.3", "ok", "P", 200, 0.2, 700, "[]").run();
  t.bind("t4", now, "sk-k2", "b-laptop", "glm-5.3", "ok", "P", 300, 0.3, 300, "[]").run();
  t.bind("t5", now, "sk-op", "operator", "glm-5.3", "ok", "P", 400, 0.4, 200, "[]").run();
  return { app: createApp({ DB: db, ADMIN_TOKEN: "admin" }), db };
}

async function fetchTrajectories(app, query) {
  const res = await app.fetch(new Request("http://gw/admin/trajectories" + (query ? "?" + query : ""), { headers: ADMIN }));
  assert.equal(res.status, 200);
  return res.json();
}

test("an account filter reaches every key the account owns", async () => {
  const { app, db } = await gateway();
  const all = await fetchTrajectories(app, "");
  assert.equal(all.trajectories.length, 5);

  const a = await fetchTrajectories(app, "account_id=acct_a");
  assert.equal(a.trajectories.length, 3, "both of the account's keys are in scope");
  const keys = [...new Set(a.trajectories.map((t) => t.key_id))].sort();
  assert.deepEqual(keys, ["sk-k1", "sk-k1b"]);
  assert.equal(a.page.matched, 3, "the match count follows the filter");
  assert.equal(Number(a.stats.total), 3, "stats are scoped to the filter, not the whole table");
  db.close?.();
});

test("each account sees only its own keys", async () => {
  const { app, db } = await gateway();
  const b = await fetchTrajectories(app, "account_id=acct_b");
  assert.equal(b.trajectories.length, 1);
  assert.equal(b.trajectories[0].key_id, "sk-k2");
  assert.equal(Number(b.stats.total), 1);
  db.close?.();
});

test("a key filter narrows to that key and a model filter to that model", async () => {
  const { app, db } = await gateway();
  const k = await fetchTrajectories(app, "key_id=sk-k1");
  assert.equal(k.trajectories.length, 2);
  assert.ok(k.trajectories.every((t) => t.key_id === "sk-k1"));

  const m = await fetchTrajectories(app, "slug=glm-5.3");
  assert.equal(m.trajectories.length, 4);
  assert.ok(m.trajectories.every((t) => t.slug === "glm-5.3"));

  const both = await fetchTrajectories(app, "slug=glm-5.3&key_id=sk-k1");
  assert.equal(both.trajectories.length, 1, "filters combine with AND");
  db.close?.();
});

test("a filter that matches nothing returns nothing, never everything", async () => {
  const { app, db } = await gateway();
  const none = await fetchTrajectories(app, "account_id=acct_missing");
  assert.equal(none.trajectories.length, 0);
  assert.equal(none.page.matched, 0);
  const noKey = await fetchTrajectories(app, "key_id=sk-nope");
  assert.equal(noKey.trajectories.length, 0);
  db.close?.();
});

test("a key with no account is reachable by key filter and by no account filter", async () => {
  const { app, db } = await gateway();
  const op = await fetchTrajectories(app, "key_id=sk-op");
  assert.equal(op.trajectories.length, 1);
  const byAccount = await fetchTrajectories(app, "account_id=sk-op");
  assert.equal(byAccount.trajectories.length, 0, "an operator key is not an account");
  db.close?.();
});

test("account and status filters combine", async () => {
  const { app, db } = await gateway();
  const failed = await fetchTrajectories(app, "account_id=acct_a&status=fail");
  assert.equal(failed.trajectories.length, 1);
  assert.equal(failed.trajectories[0].id, "t2");
  assert.equal(failed.trajectories[0].status, "fail");
  db.close?.();
});

test("the latency chart follows the filter too", async () => {
  const { app, db } = await gateway();
  const all = await fetchTrajectories(app, "");
  const a = await fetchTrajectories(app, "account_id=acct_a");
  const allN = all.latency.reduce((s, r) => s + r.n, 0);
  const aN = a.latency.reduce((s, r) => s + r.n, 0);
  assert.equal(allN, 4, "four successful runs overall");
  assert.equal(aN, 2, "two of them belong to account A");
  db.close?.();
});

test("rows carry the key so a filtered list is attributable", async () => {
  const { app, db } = await gateway();
  const k = await fetchTrajectories(app, "key_id=sk-k1b");
  assert.equal(k.trajectories[0].key_id, "sk-k1b");
  assert.equal(k.trajectories[0].key_name, "a-server");
  db.close?.();
});
