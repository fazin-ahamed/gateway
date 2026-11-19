// Passive detection and optional S3 storage. Detection records and surfaces,
// never blocks. Storage is off by default and a backup path, not the live store.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDb } from "../../server/db.mjs";
import { observeRequest, loadDetectionFeed, loadDetectionSummary, ensureDetectionSchema } from "../src/detection.js";
import { storageConfigured } from "../src/storage.js";

function dbWithTraffic() {
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO console_accounts (key_id,username,password_hash,created_at) VALUES ('acct-a','a','h',?)").bind(now).run();
  db.prepare("INSERT INTO api_keys (key_id,name,budget_mode,budget_limit,account_id,created_at,updated_at) VALUES ('sk-a','a','usd',100,'acct-a',?,?)").bind(now, now).run();
  return db;
}

test("distillation: heavy multi-model sweep raises the score, never blocks", async () => {
  const db = dbWithTraffic();
  await ensureDetectionSchema(db);
  const now = Date.now();
  // Seed an hour of heavy traffic across 6 models from one account.
  for (let i = 0; i < 320; i++) {
    const slug = "m" + (i % 6);
    const at = new Date(now - Math.floor(Math.random() * 3500000)).toISOString();
    db.prepare("INSERT INTO request_summaries (request_id,key_id,model_kind,public_slug,created_at,finished_at,status,http_status) VALUES (?,?,?,?,?,?,?,?)")
      .bind("r" + i, "sk-a", "chat", slug, at, at, "ok", 200).run();
  }
  // Observing one more request triggers the analysis.
  await observeRequest(db, { accountId: "acct-a", keyId: "sk-a", model: "m0", ok: 1, status: 200 });
  const summary = await loadDetectionSummary(db);
  const dist = summary.find((s) => s.account_id === "acct-a" && s.kind === "distillation");
  assert.ok(dist, "a distillation signal exists for the sweeping account");
  assert.ok(dist.score > 0.1, "score is non-trivial: " + dist.score);
  // The request was never blocked: observeRequest returns normally and the
  // traffic rows are untouched.
  const count = (await db.prepare("SELECT COUNT(*) n FROM request_summaries").first()).n;
  assert.equal(Number(count), 320, "no request is deleted or blocked");
});

test("bypass: a burst of 429s raises a bypass signal", async () => {
  const db = dbWithTraffic();
  await ensureDetectionSchema(db);
  const now = Date.now();
  for (let i = 0; i < 4; i++) {
    const at = new Date(now - i * 30000).toISOString();
    db.prepare("INSERT INTO request_summaries (request_id,key_id,model_kind,public_slug,created_at,finished_at,status,http_status) VALUES (?,?,?,?,?,?,?,?)")
      .bind("d" + i, "sk-a", "chat", "m0", at, at, "fail", 429).run();
  }
  for (let i = 0; i < 4; i++)
    await observeRequest(db, { accountId: "acct-a", keyId: "sk-a", model: "m0", ok: 0, status: 429 });
  const summary = await loadDetectionSummary(db);
  const bypass = summary.find((s) => s.account_id === "acct-a" && s.kind === "bypass");
  assert.ok(bypass, "a bypass signal exists after repeated 429s");
});

test("clean usage produces no detection events", async () => {
  const db = dbWithTraffic();
  await ensureDetectionSchema(db);
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    const at = new Date(now - i * 600000).toISOString();
    db.prepare("INSERT INTO request_summaries (request_id,key_id,model_kind,public_slug,created_at,finished_at,status,http_status) VALUES (?,?,?,?,?,?,?,?)")
      .bind("c" + i, "sk-a", "chat", "m0", at, at, "ok", 200).run();
    await observeRequest(db, { accountId: "acct-a", keyId: "sk-a", model: "m0", ok: 1, status: 200 });
  }
  const feed = await loadDetectionFeed(db);
  assert.equal(feed.length, 0, "no events for ordinary usage");
});

test("detection events store facts, never prompt or response text", async () => {
  const db = dbWithTraffic();
  await ensureDetectionSchema(db);
  const now = Date.now();
  for (let i = 0; i < 320; i++) {
    const at = new Date(now - Math.floor(Math.random() * 3500000)).toISOString();
    db.prepare("INSERT INTO request_summaries (request_id,key_id,model_kind,public_slug,created_at,finished_at,status,http_status) VALUES (?,?,?,?,?,?,?,?)")
      .bind("r" + i, "sk-a", "chat", "m" + (i % 6), at, at, "ok", 200).run();
  }
  for (let i = 0; i < 40; i++)
    await observeRequest(db, { accountId: "acct-a", keyId: "sk-a", model: "m0", ok: 1, status: 200 });
  const feed = await loadDetectionFeed(db, { accountId: "acct-a" });
  for (const ev of feed) {
    const json = JSON.stringify(ev.facts);
    assert.ok(!json.includes("prompt") && !json.includes("content") && !json.includes("response"), "no prompt/response text in facts");
    for (const key of Object.keys(ev.facts))
      assert.ok(["requests_per_hour", "distinct_models", "distinct_keys_per_hour", "recent_denials_10m", "last_status"].includes(key), "only count facts: " + key);
  }
});

test("storage is off and unconfigured without env vars", () => {
  assert.equal(storageConfigured({}), null);
  assert.equal(storageConfigured({ S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com" }), null, "endpoint alone is not enough");
  const cfg = storageConfigured({
    S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
    S3_BUCKET: "my-bucket",
    S3_ACCESS_KEY_ID: "id",
    S3_SECRET_ACCESS_KEY: "secret",
    S3_REGION: "us-west-004"
  });
  assert.ok(cfg);
  assert.equal(cfg.bucket, "my-bucket");
  assert.equal(cfg.region, "us-west-004");
  assert.equal(cfg.prefix, "gateway/");
});
