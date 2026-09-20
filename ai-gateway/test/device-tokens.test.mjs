import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createApp } from "../src/index.js";
import { createDb } from "../../server/db.mjs";
import { takeDeviceToken, peekDeviceTokens } from "../src/zai-tokens.js";

function appWithDb() {
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  // No ZAI_TOKEN_STORE: the endpoints operate purely on the SQLite FIFO, never
  // touching the legacy .txt fallback path.
  const env = { DB: db, ADMIN_TOKEN: "admin" };
  return { app: createApp(env), db, env };
}
const AUTH = { authorization: "Bearer admin" };
const seed = (db, tokens) => {
  const now = new Date().toISOString();
  for (const t of tokens)
    db.prepare("INSERT OR IGNORE INTO zai_device_tokens (token, created_at) VALUES (?,?)").bind(t, now).run();
};
const statusReq = (headers) => new Request("http://gw/admin/zai/device-tokens/status", { headers });
const importReq = (body, headers) => new Request("http://gw/admin/zai/device-tokens/import", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body)
});

// ---------- auth ----------

test("both device-token endpoints require admin auth", async () => {
  const { app } = appWithDb();
  assert.equal((await app.fetch(statusReq({}))).status, 401);
  assert.equal((await app.fetch(importReq({ tokens: ["a"] }, {}))).status, 401);
});

// ---------- status: metadata only ----------

test("status returns counts only and never a token value; low flips under threshold", async () => {
  const { app, db } = appWithDb();
  seed(db, Array.from({ length: 30 }, (_, i) => "tok-" + i));
  const res = await app.fetch(statusReq(AUTH));
  assert.equal(res.status, 200);
  const raw = await res.text();
  const body = JSON.parse(raw);
  assert.equal(body.available, 30);
  assert.equal(body.low, false, "30 >= 25 threshold");
  assert.equal(typeof body.captcha_ready, "number");
  // No stored token value appears anywhere in the serialized response.
  assert.ok(!raw.includes("tok-0"), "status must not leak token values");
  assert.deepEqual(Object.keys(body).sort(), ["available", "captcha_ready", "low"]);
});

test("status reports low=true when the pool is under the threshold", async () => {
  const { app, db } = appWithDb();
  seed(db, ["only-one-token"]);
  const body = await (await app.fetch(statusReq(AUTH))).json();
  assert.equal(body.available, 1);
  assert.equal(body.low, true);
});

// ---------- import: shapes ----------

test("import accepts a JSON token array into the live FIFO", async () => {
  const { app, db } = appWithDb();
  const res = await app.fetch(importReq({ tokens: ["aaaaaaaa", "bbbbbbbb", "cccccccc"] }, AUTH));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { accepted: 3, duplicates: 0, invalid: 0, available: 3 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zai_device_tokens").all().results[0].n, 3);
});

test("import accepts a newline-delimited text body and ignores a trailing newline", async () => {
  const { app } = appWithDb();
  const res = await app.fetch(new Request("http://gw/admin/zai/device-tokens/import", {
    method: "POST",
    headers: { "content-type": "text/plain", ...AUTH },
    body: "token-one\ntoken-two\ntoken-three\n"
  }));
  const body = await res.json();
  assert.deepEqual(body, { accepted: 3, duplicates: 0, invalid: 0, available: 3 });
});

test("import accepts a newline string under the tokens key", async () => {
  const { app } = appWithDb();
  const body = await (await app.fetch(importReq({ tokens: "x1x1x1x1\ny2y2y2y2" }, AUTH))).json();
  assert.deepEqual(body, { accepted: 2, duplicates: 0, invalid: 0, available: 2 });
});

// ---------- import: dedup accounting ----------

test("duplicates within the batch AND against existing rows are both counted, not accepted", async () => {
  const { app, db } = appWithDb();
  seed(db, ["existing1", "existing2"]);
  // Batch: existing1 (existing dup), dupdupdup x2 (one new + one in-batch dup),
  // newtoken1 (new). Expect accepted=2, duplicates=2, invalid=0.
  const body = await (await app.fetch(importReq({
    tokens: ["existing1", "dupdupdup", "dupdupdup", "newtoken1"]
  }, AUTH))).json();
  assert.equal(body.accepted, 2, "dupdupdup + newtoken1 are the only new rows");
  assert.equal(body.duplicates, 2, "1 in-batch repeat + 1 already-present");
  assert.equal(body.invalid, 0);
  assert.equal(body.available, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM zai_device_tokens").all().results[0].n, 4);
});

test("blank/whitespace-only entries count as invalid; opaque tokens are not over-validated", async () => {
  const { app } = appWithDb();
  // "ab" is short and "has space" contains a space — under the old rule these
  // were rejected; the store contract only requires non-empty-after-trim, so
  // they must be ACCEPTED. Only the empty/whitespace entries are invalid.
  const body = await (await app.fetch(importReq({
    tokens: ["ab", "has space", "  ", "", "goodtoken"]
  }, AUTH))).json();
  assert.equal(body.invalid, 2, "'' and '  ' are the only invalid entries");
  assert.equal(body.accepted, 3, "short and spaced tokens are accepted (format is opaque)");
});

// ---------- import into non-empty FIFO + consumption order ----------

test("importing into a non-empty FIFO preserves existing tokens and appends new ones", async () => {
  const { app, db, env } = appWithDb();
  seed(db, ["first", "second"]);
  const body = await (await app.fetch(importReq({ tokens: ["third", "fourth"] }, AUTH))).json();
  assert.equal(body.accepted, 2);
  assert.equal(body.available, 4);
  assert.equal(await peekDeviceTokens(undefined, env.DB), 4);
});

test("FIFO consumption order survives an import: existing tokens drain before imported ones", async () => {
  const { app, db, env } = appWithDb();
  seed(db, ["alpha", "beta"]);
  await app.fetch(importReq({ tokens: ["gamma"] }, AUTH));
  const drained = [];
  for (let i = 0; i < 3; i++)
    drained.push((await takeDeviceToken(undefined, env.DB)).token);
  assert.deepEqual(drained, ["alpha", "beta", "gamma"], "insertion order is preserved through import");
});

// ---------- no token values in the import response ----------

test("the import response never echoes a submitted token value", async () => {
  const { app } = appWithDb();
  const secret = "SUPER-SECRET-DEVICE-TOKEN-9f3a";
  const raw = await (await app.fetch(importReq({ tokens: [secret] }, AUTH))).text();
  assert.ok(!raw.includes(secret), "import response must not contain the token value");
  assert.deepEqual(JSON.parse(raw), { accepted: 1, duplicates: 0, invalid: 0, available: 1 });
});
