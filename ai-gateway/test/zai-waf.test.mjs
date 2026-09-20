import test from "node:test";
import assert from "node:assert/strict";

import { createZaiWafController, isZaiWafBlock } from "../src/zai-waf.js";

test("breaker fails fast, escalates cooldown, and stays blocked past the timer (probe owns recovery)", () => {
  let now = 1_000;
  const waf = createZaiWafController({
    now: () => now, sleep: async () => {}, random: () => 0,
    baseCooldownMs: 60_000, maxCooldownMs: 30 * 60_000, minPaceMs: 200, maxPaceMs: 200
  });

  waf.recordBlock("direct", "completion");
  assert.equal(waf.status("direct").blocked, true);
  assert.equal(waf.status("direct").cooldownMs, 60_000);
  assert.throws(() => waf.assertAvailable("direct"), (err) => err?.code === "zai_waf_blocked" && err?.retryAfterSec === 60);

  // Timer expiry alone must NOT reopen the breaker: with no probe registered, a
  // user request still fails fast. Traffic never becomes the recovery test.
  now += 60_001;
  assert.throws(() => waf.assertAvailable("direct"), (err) => err?.code === "zai_waf_blocked");
  assert.equal(waf.status("direct").blocked, true, "still blocked after the timer with no successful probe");
});

test("WAF state is per-egress: one blocked proxy never blocks the others or direct", () => {
  const waf = createZaiWafController({ now: () => 0, sleep: async () => {}, random: () => 0 });
  waf.recordBlock("proxy:17", "completion");
  assert.equal(waf.isBlocked("proxy:17"), true, "the blocked proxy's lane is open");
  assert.equal(waf.isBlocked("proxy:23"), false, "a different proxy is unaffected");
  assert.equal(waf.isBlocked("direct"), false, "direct is unaffected");
  assert.doesNotThrow(() => waf.assertAvailable("proxy:23"));
  assert.throws(() => waf.assertAvailable("proxy:17"));

  const roll = waf.status();
  assert.equal(roll.blocked, true, "rolled-up blocked = any egress blocked");
  assert.deepEqual(roll.blockedEgresses, ["proxy:17"]);
  assert.equal(roll.egresses.length, 3, "direct + proxy:17 + proxy:23 lanes seen");
});

test("recovery probe receives the frozen target of the blocked egress, not whatever is active now", async () => {
  let now = 0;
  const seenTargets = [];
  let healthy = false;
  const waf = createZaiWafController({
    now: () => now, sleep: async () => {}, random: () => 0,
    baseCooldownMs: 60_000, maxCooldownMs: 30 * 60_000,
    probe: async ({ egress, target }) => { seenTargets.push({ egress, target }); return healthy; }
  });

  // proxy:17 blocked; freeze its exact dialed URL as the probe target.
  waf.recordBlock("proxy:17", "completion", { egressId: 17, egressUrl: "http://user:pw@proxy17:8080" });
  now += 60_001;
  assert.throws(() => waf.assertAvailable("proxy:17"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seenTargets.length, 1, "one probe fired for proxy:17");
  assert.equal(seenTargets[0].egress, "proxy:17");
  assert.equal(seenTargets[0].target.egressId, 17, "probe re-dials the exact frozen egress");
  assert.equal(seenTargets[0].target.egressUrl, "http://user:pw@proxy17:8080");
  assert.equal(waf.status("proxy:17").cooldownMs, 120_000, "failed probe escalates that lane's backoff");

  // Upstream recovers on proxy:17: next due probe clears only that lane.
  healthy = true;
  now += 120_001;
  assert.throws(() => waf.assertAvailable("proxy:17"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(waf.isBlocked("proxy:17"), false, "a passing probe clears the blocked lane");
});

test("a confirmed healthy response resets that egress's backoff immediately", () => {
  let now = 0;
  const waf = createZaiWafController({ now: () => now, sleep: async () => {}, random: () => 0 });
  waf.recordBlock("proxy:5");
  now += 60_001;
  waf.recordBlock("proxy:5");
  assert.ok(waf.status("proxy:5").blockCount >= 2);
  waf.recordSuccess("proxy:5");
  assert.deepEqual(waf.status("proxy:5"), {
    egress: "proxy:5", blocked: false, blockCount: 0, consecutiveBlocks: 0,
    cooldownMs: 0, retryAfterSec: 0, probing: false, lastReason: ""
  });
});

test("shared pacing serializes upstream POST starts across all egresses", async () => {
  let now = 0;
  const sleeps = [];
  const waf = createZaiWafController({
    now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, random: () => 0,
    minPaceMs: 200, maxPaceMs: 200
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
