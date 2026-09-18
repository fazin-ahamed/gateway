import test from "node:test";
import assert from "node:assert/strict";

import { createZaiWafController, isZaiWafBlock } from "../src/zai-waf.js";

test("WAF breaker fails fast with a retry hint and escalates cooldown", () => {
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

  now += 60_001;
  assert.doesNotThrow(() => waf.assertAvailable());
  waf.recordBlock("completion");
  assert.equal(waf.status().cooldownMs, 120_000);
});

test("a confirmed healthy response resets WAF backoff", () => {
  let now = 0;
  const waf = createZaiWafController({ now: () => now, sleep: async () => {}, random: () => 0 });
  waf.recordBlock();
  now += 60_001;
  waf.recordBlock();
  assert.ok(waf.status().blockCount >= 2);
  waf.recordSuccess();
  assert.deepEqual(waf.status(), { blocked: false, blockCount: 0, cooldownMs: 0, retryAfterSec: 0, lastReason: "" });
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
});


test("probe-backed WAF breaker stays closed to user traffic until completion edge recovers", async () => {
  let now = 1_000;
  let timer = null;
  const probeResults = [true, false];
  let probes = 0;

  const waf = createZaiWafController({
    now: () => now,
    sleep: async () => {},
    random: () => 0,
    baseCooldownMs: 100,
    maxCooldownMs: 800,
    minPaceMs: 0,
    maxPaceMs: 0,
    probe: async () => {
      probes++;
      return probeResults.shift();
    },
    setTimer: (fn, ms) => {
      timer = { fn, ms, unref() {} };
      return timer;
    },
    clearTimer: () => {}
  });

  waf.recordBlock("completion");
  assert.equal(waf.status().blocked, true);
  assert.equal(timer.ms, 100);

  now += 100;
  assert.throws(() => waf.assertAvailable(), (err) => err?.code === "zai_waf_blocked");

  await timer.fn();
  assert.equal(probes, 1);
  assert.equal(waf.status().blocked, true);
  assert.equal(waf.status().cooldownMs, 200);
  assert.equal(timer.ms, 200);

  now += 200;
  await timer.fn();
  assert.equal(probes, 2);
  assert.equal(waf.status().blocked, false);
  assert.doesNotThrow(() => waf.assertAvailable());
});
