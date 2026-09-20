import test from "node:test";
import assert from "node:assert/strict";

import { createZaiWafController, isZaiWafBlock } from "../src/zai-waf.js";

test("WAF breaker fails fast, escalates cooldown, and stays blocked past the timer (probe owns recovery)", () => {
  let now = 1_000;
  const waf = createZaiWafController({
    now: () => now,
    sleep: async () => {},
    random: () => 0,
    baseCooldownMs: 60_000,
    maxCooldownMs: 30 * 60_000,
    minPaceMs: 200,
    maxPaceMs: 200
  });

  waf.recordBlock("completion");
  assert.equal(waf.status().blocked, true);
  assert.equal(waf.status().cooldownMs, 60_000);
  assert.throws(() => waf.assertAvailable(), (err) => err?.code === "zai_waf_blocked" && err?.retryAfterSec === 60);

  // Timer expiry alone must NOT reopen the breaker: with no probe registered,
  // a user request still fails fast. This is the core fix — traffic never
  // becomes the recovery test.
  now += 60_001;
  assert.throws(() => waf.assertAvailable(), (err) => err?.code === "zai_waf_blocked");
  assert.equal(waf.status().blocked, true, "still blocked after the timer with no successful probe");
});

test("recovery probe owns reopening: a passing probe clears the block, a failing one escalates backoff", async () => {
  let now = 0;
  let healthy = false;
  let probes = 0;
  const waf = createZaiWafController({
    now: () => now,
    sleep: async () => {},
    random: () => 0,
    baseCooldownMs: 60_000,
    maxCooldownMs: 30 * 60_000,
    probe: async () => { probes++; return healthy; }
  });

  waf.recordBlock("completion");
  assert.equal(waf.status().cooldownMs, 60_000);

  // Probe not yet due -> assertAvailable throws and does not probe.
  assert.throws(() => waf.assertAvailable());
  assert.equal(probes, 0, "no probe before the cooldown window elapses");

  // Cooldown elapsed, still blocked upstream: probe fires, fails, backs off.
  now += 60_001;
  assert.throws(() => waf.assertAvailable());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(probes, 1, "one recovery probe fired when due");
  assert.equal(waf.status().blocked, true, "failed probe keeps the breaker open");
  assert.equal(waf.status().cooldownMs, 120_000, "failed probe escalates the cooldown");

  // Upstream recovers: the next due probe passes and clears the block.
  healthy = true;
  now += 120_001;
  assert.throws(() => waf.assertAvailable());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(waf.status().blocked, false, "a passing probe reopens the breaker");
  assert.doesNotThrow(() => waf.assertAvailable());
});

test("a confirmed healthy response resets WAF backoff immediately", () => {
  let now = 0;
  const waf = createZaiWafController({ now: () => now, sleep: async () => {}, random: () => 0 });
  waf.recordBlock();
  now += 60_001;
  waf.recordBlock();
  assert.ok(waf.status().blockCount >= 2);
  waf.recordSuccess();
  assert.deepEqual(waf.status(), { blocked: false, blockCount: 0, consecutiveBlocks: 0, cooldownMs: 0, retryAfterSec: 0, probing: false, lastReason: "" });
});

test("shared pacing serializes upstream POST starts", async () => {
  let now = 0;
  const sleeps = [];
  const waf = createZaiWafController({
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    random: () => 0,
    minPaceMs: 200,
    maxPaceMs: 200
  });

  await Promise.all([waf.pace(), waf.pace(), waf.pace()]);
  assert.deepEqual(sleeps.filter((n) => n > 0), [200, 200]);
  assert.equal(now, 400);
});

test("WAF classifier recognizes the Aliyun block page but not generic security prose", () => {
  assert.equal(isZaiWafBlock(405, "<!doctype html><title>Aliyun WAF</title> request blocked"), true);
  assert.equal(isZaiWafBlock(403, "Access denied by aliyun cloud firewall"), true);
  assert.equal(isZaiWafBlock(403, JSON.stringify({ error: "security policy forbids this model" })), false);
  assert.equal(isZaiWafBlock(400, "captcha_verify_param is invalid"), false);
  // The block marker can sit past the first 300 bytes of an Aliyun HTML page;
  // detection must still see it (the completion path reads an 8KB window).
  const padded = "<!doctype html><head>" + " ".repeat(2000) + "</head><body>request blocked by aliyun waf</body>";
  assert.ok(padded.length > 300);
  assert.equal(isZaiWafBlock(403, padded), true, "marker beyond 300 chars is still detected");
});
