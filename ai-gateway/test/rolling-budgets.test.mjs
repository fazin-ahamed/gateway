// Rolling 24h / 30d budgets and prepaid credits. Window math is exercised with
// an injected clock; the HTTP tests prove admission, the console limits shape,
// the admin routes, and the unpriced-model fallback charge end to end.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDb } from "../../server/db.mjs";
import {
  ensureBudgetSchema, rollingStatus, checkAdmission, settleSpend, parseBudgetPatch, fallbackCost, DEFAULT_FALLBACK
} from "../src/budgets.js";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const H = 3600000;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");

function fixture({ daily = null, monthly = null, credits = 0 } = {}) {
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const now = new Date(T0).toISOString();
  db.prepare("INSERT INTO console_accounts (key_id, username, password_hash, created_at, budget_daily_usd, budget_monthly_usd, credits_usd) VALUES (?,?,?,?,?,?,?)")
    .bind("acct", "fazin", "x", now, daily, monthly, credits).run();
  return db;
}
const credits = (db) => Number(db.prepare("SELECT credits_usd c FROM console_accounts WHERE key_id='acct'").first().c);
const spend = (db, usd, at) => settleSpend(db, { accountId: "acct", keyId: "k", requestId: "r" + Math.random(), usd }, at);

test("windows roll: spend leaves the 24h window after a day but stays in the 30d window", async () => {
  const db = fixture({ daily: 20, monthly: 300 });
  await spend(db, 6.25, T0);
  let s = await rollingStatus(db, "acct", T0 + 1 * H);
  assert.equal(s.windows[0].spent_usd, 6.25);
  assert.equal(s.windows[0].remaining_usd, 13.75);
  assert.equal(s.windows[1].remaining_usd, 293.75);
  s = await rollingStatus(db, "acct", T0 + 25 * H);
  assert.equal(s.windows[0].spent_usd, 0, "24h window forgot it");
  assert.equal(s.windows[1].spent_usd, 6.25, "30d window kept it");
  assert.equal(s.windows[0].resets_at, null);
  db.close?.();
});

test("resets_in_s is when the oldest spend in the window ages out", async () => {
  const db = fixture({ daily: 20, monthly: 300 });
  await spend(db, 1, T0);
  await spend(db, 2, T0 + 5 * H);
  const s = await rollingStatus(db, "acct", T0 + 10 * H);
  const day = s.windows[0];
  assert.equal(day.resets_in_s, 14 * 3600, "oldest spend (10h ago) leaves in 14h");
  assert.equal(day.resets_at, new Date(T0 + 24 * H).toISOString());
  assert.equal(s.windows[1].resets_in_s, (720 - 10) * 3600);
  db.close?.();
});

test("an account with no cap and no credits is never blocked and reports binding none", async () => {
  const db = fixture();
  await spend(db, 1000, T0);
  const a = await checkAdmission(db, "acct", T0);
  assert.equal(a.allowed, true);
  assert.equal(a.status.binding, "none");
  assert.equal(a.status.enabled, false);
  db.close?.();
});

test("a spent window blocks with its reset time; credits lift the block", async () => {
  const db = fixture({ daily: 5, monthly: 300, credits: 0 });
  await spend(db, 5, T0);
  let a = await checkAdmission(db, "acct", T0 + 2 * H);
  assert.equal(a.allowed, false);
  assert.equal(a.window, "24h");
  assert.equal(a.retry_after_s, 22 * 3600);
  assert.equal(a.status.binding, "exhausted");
  db.prepare("UPDATE console_accounts SET credits_usd=10 WHERE key_id='acct'").run();
  a = await checkAdmission(db, "acct", T0 + 2 * H);
  assert.equal(a.allowed, true);
  assert.equal(a.status.binding, "credits");
  a = await checkAdmission(db, "acct", T0 + 25 * H);
  assert.equal(a.status.binding, "window", "the window freed up, credits stay untouched");
  db.close?.();
});

test("settlement debits credits only for the overshoot, never below zero", async () => {
  const db = fixture({ daily: 10, monthly: 300, credits: 3 });
  await spend(db, 8, T0);
  assert.equal(credits(db), 3, "inside the window: credits untouched");
  await spend(db, 4, T0 + 1000);
  assert.equal(credits(db), 1, "2 left in the window, 4 spent: 2 overflow comes from credits");
  await spend(db, 5, T0 + 2000);
  assert.equal(credits(db), 0, "overflow larger than the balance floors at zero");
  db.close?.();
});

test("credits are not debited when no window is capped", async () => {
  const db = fixture({ credits: 50 });
  await spend(db, 5, T0);
  assert.equal(credits(db), 50);
  db.close?.();
});

test("the tightest capped window sets the headroom", async () => {
  const db = fixture({ daily: 100, monthly: 6, credits: 10 });
  await spend(db, 5, T0);
  await spend(db, 3, T0 + 1000);
  assert.equal(credits(db), 8, "monthly had 1 left, so 2 of the 3 came from credits");
  db.close?.();
});

test("ensureBudgetSchema upgrades a legacy console_accounts table in place", async () => {
  const db = createDb(":memory:");
  db.exec("CREATE TABLE console_accounts (key_id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)");
  db.prepare("INSERT INTO console_accounts VALUES ('a','u','x','2026-01-01')").run();
  await ensureBudgetSchema(db);
  const row = db.prepare("SELECT budget_daily_usd d, credits_usd c FROM console_accounts").first();
  assert.equal(row.d, null);
  assert.equal(Number(row.c), 0);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='spend_events'").first());
  db.close?.();
});

test("patch validation rejects negatives and NaN, allows null to clear", () => {
  assert.ok(parseBudgetPatch({ budget_daily_usd: -1 }).error);
  assert.ok(parseBudgetPatch({ budget_monthly_usd: "abc" }).error);
  assert.ok(parseBudgetPatch({ credits_usd: -5 }).error);
  assert.ok(parseBudgetPatch({}).error);
  assert.deepEqual(parseBudgetPatch({ budget_daily_usd: null }).patch, { budget_daily_usd: null });
  assert.deepEqual(parseBudgetPatch({ credits_add_usd: -2.5 }).patch, { credits_add_usd: -2.5 });
});

test("fallbackCost bills input and output tokens at the fallback rates", () => {
  assert.equal(fallbackCost({ prompt_tokens: 500000, completion_tokens: 250000 }, DEFAULT_FALLBACK), 3);
  assert.equal(fallbackCost({}, DEFAULT_FALLBACK), 0);
});

// ---- HTTP level ----

async function gateway() {
  const { createApp, __test } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(SCHEMA);
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key-please-change", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,1,'usd',1e12,?,?)")
    .bind("sk-acct", "acct-key", now, now).run();
  db.prepare("INSERT INTO console_accounts (key_id, username, password_hash, created_at) VALUES (?,?,?,?)")
    .bind("sk-acct", "fazin", "x", now).run();
  return { app: createApp(env), db, env, __test };
}
const admin = { authorization: "Bearer admin", "content-type": "application/json" };

test("admin sets caps and credits; invalid input is rejected; unknown account 404s", async () => {
  const { app } = await gateway();
  const ok = await app.fetch(new Request("http://gw/admin/rolling-budgets/sk-acct", {
    method: "POST", headers: admin,
    body: JSON.stringify({ budget_daily_usd: 20, budget_monthly_usd: 300, credits_usd: 50 })
  }));
  assert.equal(ok.status, 200);
  const row = await ok.json();
  assert.equal(row.budget_daily_usd, 20);
  assert.equal(row.credits_usd, 50);
  assert.equal(row.windows[1].limit_usd, 300);

  const add = await app.fetch(new Request("http://gw/admin/rolling-budgets/sk-acct", {
    method: "POST", headers: admin, body: JSON.stringify({ credits_add_usd: -60 })
  }));
  assert.equal((await add.json()).credits_usd, 0, "credits floor at zero");

  for (const bad of [{ budget_daily_usd: -1 }, { credits_usd: "x" }, {}]) {
    const r = await app.fetch(new Request("http://gw/admin/rolling-budgets/sk-acct", { method: "POST", headers: admin, body: JSON.stringify(bad) }));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const missing = await app.fetch(new Request("http://gw/admin/rolling-budgets/nope", { method: "POST", headers: admin, body: JSON.stringify({ credits_usd: 1 }) }));
  assert.equal(missing.status, 404);

  const anon = await app.fetch(new Request("http://gw/admin/rolling-budgets"));
  assert.equal(anon.status, 401);
  const list = await (await app.fetch(new Request("http://gw/admin/rolling-budgets", { headers: admin }))).json();
  assert.equal(list.accounts.length, 1);
  assert.deepEqual(list.fallback_price, { prompt_per_1m: 4, completion_per_1m: 4 });

  const fb = await app.fetch(new Request("http://gw/admin/rolling-budgets-fallback", { method: "POST", headers: admin, body: JSON.stringify({ prompt_per_1m: 1.5, completion_per_1m: 6 }) }));
  assert.deepEqual((await fb.json()).fallback_price, { prompt_per_1m: 1.5, completion_per_1m: 6 });
  const badFb = await app.fetch(new Request("http://gw/admin/rolling-budgets-fallback", { method: "POST", headers: admin, body: JSON.stringify({ prompt_per_1m: -1, completion_per_1m: 1 }) }));
  assert.equal(badFb.status, 400);
});

test("a spent window answers 429 rolling_budget_exhausted with Retry-After; credits let it through", async () => {
  const { app, db, __test } = await gateway();
  db.prepare("UPDATE console_accounts SET budget_daily_usd=1 WHERE key_id='sk-acct'").run();
  const key = db.prepare("SELECT * FROM api_keys WHERE key_id='sk-acct'").first();
  await __test.recordUsage({ env: { DB: db } }, key, { total_tokens: 10, cost_usd: 1.5, request_id: "r1" });

  const call = () => app.fetch(new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer sk-acct", "content-type": "application/json" },
    body: JSON.stringify({ model: "nope", messages: [{ role: "user", content: "hi" }] })
  }));
  const blocked = await call();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  const body = await blocked.json();
  assert.equal(body.error.code, "rolling_budget_exhausted");
  assert.equal(body.error.window, "24h");
  assert.ok(body.error.resets_at);

  db.prepare("UPDATE console_accounts SET credits_usd=5 WHERE key_id='sk-acct'").run();
  const through = await call();
  assert.notEqual(through.status, 429, "credits cover the exhausted window (model is unknown, so a different error is fine)");
});

test("console limits reports the rolling contract shape for an account session", async () => {
  const { app, db } = await gateway();
  db.prepare("UPDATE console_accounts SET budget_daily_usd=20, budget_monthly_usd=300, credits_usd=50, password_hash=? WHERE key_id='sk-acct'")
    .bind(await sha256hex("pw")).run();
  const key = db.prepare("SELECT * FROM api_keys WHERE key_id='sk-acct'").first();
  const { __test } = await import("../src/index.js");
  await __test.recordUsage({ env: { DB: db } }, key, { total_tokens: 10, cost_usd: 6.25, request_id: "r1" });

  const auth = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "fazin", password: "pw" })
  }));
  assert.equal(auth.status, 200);
  const cookie = "gw_client=" + auth.headers.get("set-cookie").match(/gw_client=([^;]+)/)[1];
  const res = await app.fetch(new Request("http://gw/console/api/limits", { headers: { cookie } }));
  assert.equal(res.status, 200);
  const { rolling } = await res.json();
  assert.equal(rolling.enabled, true);
  assert.equal(rolling.binding, "window");
  assert.equal(rolling.credits.balance_usd, 50);
  assert.deepEqual(rolling.fallback_price, { prompt_per_1m: 4, completion_per_1m: 4 });
  const [day, month] = rolling.windows;
  assert.deepEqual([day.id, day.hours, day.limit_usd, day.spent_usd, day.remaining_usd], ["24h", 24, 20, 6.25, 13.75]);
  assert.deepEqual([month.id, month.hours, month.limit_usd, month.remaining_usd], ["30d", 720, 300, 293.75]);
  assert.ok(day.resets_in_s > 86300 && day.resets_in_s <= 86400);
  assert.ok(month.resets_at);
});

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("an unpriced model with a loaded catalog is charged the fallback rate; priced rows are untouched", async () => {
  const { db, env, __test } = await gateway();
  __test.__setModelsDevCache({ providers: {} });
  const c = { env };
  const usage = { prompt_tokens: 1000000, completion_tokens: 500000, total_tokens: 1500000 };
  const unpriced = await __test.computeCost(c, "mystery-model", usage, 0);
  assert.equal(unpriced, 6, "1M in + 0.5M out at 4/4 per 1M");
  db.prepare("INSERT INTO prices (slug, provider_id, prompt_per_1m, completion_per_1m, actual_mode, updated_at) VALUES ('free-model',0,0,0,'per_1m',?)").bind(new Date().toISOString()).run();
  assert.equal(await __test.computeCost(c, "free-model", usage, 0), 0, "an explicit zero price stays free");
});
