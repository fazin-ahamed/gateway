// The shadow governor decides and records. It must never imply a launch.

import test from "node:test";
import assert from "node:assert/strict";

import { contextBucket, deadlineFor, chooseBackup, wouldHedge, DEFAULT_BASELINE_MS, DEADLINE_MIN_MS } from "../src/router/latency-governor.js";

const cand = (routeId, providerId, extra) => ({ routeId, providerId, slug: "m" + routeId, eligible: true, quality: 4, expectedTtftMs: 1000, ...extra });

test("context buckets cover the small and the huge", () => {
  assert.equal(contextBucket(1000), "lt8k");
  assert.equal(contextBucket(20000), "8k-32k");
  assert.equal(contextBucket(100000), "32k-128k");
  assert.equal(contextBucket(200000), "128k-512k");
  assert.equal(contextBucket(900000), "512k+");
});

test("a deadline uses the most specific baseline that has enough samples", () => {
  const d = deadlineFor({
    taskType: "code:generation",
    samples: [
      { key: "route-task-bucket", ttftMs: 1000, n: 3 },
      { key: "route-task", ttftMs: 2000, n: 12 },
      { key: "route", ttftMs: 9000, n: 40 }
    ]
  });
  assert.equal(d.source, "route-task", "three samples is not enough to trust");
  assert.equal(d.baselineMs, 2000);
  assert.equal(d.deadlineMs, 4400, "code waits 2.2x the baseline");
});

test("no history falls back to the static default and never below the floor", () => {
  const d = deadlineFor({ taskType: "chat", samples: [] });
  assert.equal(d.source, "default");
  assert.equal(d.baselineMs, DEFAULT_BASELINE_MS);
  assert.ok(d.deadlineMs >= DEADLINE_MIN_MS);
});

test("a fast primary would not hedge and a slow one would", () => {
  assert.equal(wouldHedge({ deadlineMs: 4000, ttftMs: 1200, finishedMs: 9000 }), false);
  assert.equal(wouldHedge({ deadlineMs: 4000, ttftMs: 8100, finishedMs: 20000 }), true);
});

test("a stream that dies after the deadline with no token would hedge", () => {
  assert.equal(wouldHedge({ deadlineMs: 4000, ttftMs: null, finishedMs: 30000 }), true);
});

test("a client cancel is not a latency failure", () => {
  assert.equal(wouldHedge({ deadlineMs: 4000, ttftMs: null, finishedMs: 30000, cancelled: true }), false);
});

test("an independent provider beats a faster route on the same provider", () => {
  const primary = cand(1, 10, { quality: 4.5 });
  const backup = chooseBackup(primary, [
    cand(2, 10, { expectedTtftMs: 200 }),
    cand(3, 20, { expectedTtftMs: 900 })
  ]);
  assert.equal(backup.routeId, 3);
  assert.equal(backup.providerId, 20);
});

test("a backup below the quality margin is rejected", () => {
  const primary = cand(1, 10, { quality: 4.5 });
  const backup = chooseBackup(primary, [
    cand(2, 20, { quality: 3.5, expectedTtftMs: 100 })
  ]);
  assert.equal(backup, null);
});

test("an ineligible backup is rejected even when it is fast", () => {
  const primary = cand(1, 10);
  const backup = chooseBackup(primary, [
    cand(2, 20, { eligible: false, expectedTtftMs: 50 })
  ]);
  assert.equal(backup, null);
});

test("with no independent provider the fastest same-provider route is the backup", () => {
  const primary = cand(1, 10);
  const backup = chooseBackup(primary, [
    cand(2, 10, { expectedTtftMs: 1500 }),
    cand(3, 10, { expectedTtftMs: 400 })
  ]);
  assert.equal(backup.routeId, 3);
});
