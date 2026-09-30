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

// --- exports: the file must cover exactly what the table shows ---

// Exportable rows need a complete request/response pair, so these seeds carry
// bodies; the row-level helpers above deliberately do not.
async function gatewayWithBodies() {
  const { app, db } = await gateway();
  const now = new Date().toISOString();
  const req = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  const res = JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }] });
  db.prepare("UPDATE trajectories SET request_json=?, response_json=?").bind(req, res).run();
  return { app, db, now };
}

async function exportCount(app, query) {
  const res = await app.fetch(new Request("http://gw/admin/trajectories-export?" + query, { headers: ADMIN }));
  assert.equal(res.status, 200);
  const body = await res.text();
  const lines = body ? body.trim().split("\n") : [];
  return { header: res.headers.get("x-trajectory-count"), lines };
}

test("the export follows the account filter", async () => {
  const { app, db } = await gatewayWithBodies();
  // Five rows, but one is a failed run: a training export needs a completed
  // request/response pair, so that row is not exportable in these formats.
  const all = await exportCount(app, "format=openai");
  assert.equal(Number(all.header), 4);
  assert.equal(all.lines.length, 4);

  const a = await exportCount(app, "format=openai&account_id=acct_a");
  assert.equal(Number(a.header), 2, "only account A's completed runs are exported");
  assert.equal(a.lines.length, 2);
  db.close?.();
});

test("the export follows a key filter", async () => {
  const { app, db } = await gatewayWithBodies();
  const one = await exportCount(app, "format=openai&key_id=sk-k1b");
  assert.equal(Number(one.header), 1);
  assert.equal(one.lines.length, 1);
  db.close?.();
});

test("the export follows the model filter", async () => {
  const { app, db } = await gatewayWithBodies();
  const m = await exportCount(app, "format=openai&slug=glm-5.3");
  assert.equal(Number(m.header), 4, "four completed glm-5.3 runs");
  // The only glm-5.2 row failed, so nothing is exportable for it.
  const failedOnly = await exportCount(app, "format=openai&slug=glm-5.2");
  assert.equal(Number(failedOnly.header), 0);
  db.close?.();
});

test("a failed run is absent from a training export but present in vey", async () => {
  const { app, db } = await gatewayWithBodies();
  const training = await exportCount(app, "format=openai&key_id=sk-k1");
  assert.equal(Number(training.header), 1, "only the completed run exports");
  const vey = await app.fetch(new Request("http://gw/admin/trajectories-export?format=vey&key_id=sk-k1", { headers: ADMIN }));
  const veyText = await vey.text();
  assert.equal(veyText.trim().split("\n").length, 2, "vey keeps the failed attempt too");
  db.close?.();
});

test("a key and account together export only their intersection", async () => {
  const { app, db } = await gatewayWithBodies();
  // sk-op is not owned by acct_a, so the intersection is empty.
  const none = await exportCount(app, "format=openai&account_id=acct_a&key_id=sk-op");
  assert.equal(Number(none.header), 0);
  assert.equal(none.lines.length, 0);
  // sk-k1b is owned by acct_a, so it survives.
  const one = await exportCount(app, "format=openai&account_id=acct_a&key_id=sk-k1b");
  assert.equal(Number(one.header), 1);
  db.close?.();
});

test("an export filter that matches nothing produces an empty file", async () => {
  const { app, db } = await gatewayWithBodies();
  const none = await exportCount(app, "format=openai&account_id=acct_missing");
  assert.equal(Number(none.header), 0);
  assert.equal(none.lines.length, 0);
  db.close?.();
});

test("the vey export follows the same key and account scope", async () => {
  const { app, db } = await gatewayWithBodies();
  const countLines = async (q) => {
    const res = await app.fetch(new Request("http://gw/admin/trajectories-export?format=vey&" + q, { headers: ADMIN }));
    assert.equal(res.status, 200);
    const text = await res.text();
    return text ? text.trim().split("\n").length : 0;
  };
  assert.equal(await countLines(""), 5, "unfiltered vey exports everything");
  assert.equal(await countLines("account_id=acct_a"), 3);
  assert.equal(await countLines("key_id=sk-k1b"), 1, "a pure key filter reaches the stream");
  assert.equal(await countLines("key_id=sk-op"), 1);
  assert.equal(await countLines("slug=glm-5.2"), 1);
  assert.equal(await countLines("account_id=acct_missing"), 0);
  assert.equal(await countLines("account_id=acct_a&key_id=sk-op"), 0, "intersection, not union");
  db.close?.();
});
