// Dual-decision invariants for the constraint-first quality shadow.
//
// shadowDecide computes TWO picks and compares them without changing serving:
//   operational_only_pick — the existing Pareto/policy pick (no quality input)
//   quality_aware_pick    — constraint-first pick (reliability + quality floors)
// Invariants under test:
//   1. A mature known_bad canonical is rejected by the quality floor.
//   2. A mature known_good canonical stays eligible.
//   3. A cold (immature) canonical is a cold-start allowance: eligible, no
//      fabricated mean, explicit reason.
//   4. Quality never influences the operational pick or what is served.
//   5. The comparison block reports floors, eligibility counts, and rejected
//      routes with per-route reasons.

import test from "node:test";
import assert from "node:assert/strict";

import { __test as t } from "../src/index.js";
import { compileTaskIR } from "../src/router/task-ir.js";
import {
  shadowDecide,
  constraintFirstPick,
  floorsFor,
  qualityGate,
  qualityStateOf
} from "../src/router/policies.js";

const CHAT = { messages: [{ role: "user", content: "hi" }] };

function route(slug, { costKnown = true, cost = 0.01, latencyEma = 500, quality = null, posterior } = {}) {
  return {
    slug,
    model: slug,
    upstream_model: slug,
    canonicalModelId: slug,
    routeId: 1,
    providerId: 1,
    transport: "direct",
    cost,
    costKnown,
    latencyEma,
    latencyKnown: latencyEma > 0,
    capable: true,
    workhorse: false,
    luxury: false,
    tiny: false,
    eligible: true,
    hardEligible: true,
    enabledKeyCount: 1,
    usableKeyCount: 1,
    hasCredential: true,
    circuitOpen: false,
    // A strong mature operational posterior by default: successOf ≈ 0.99 clears
    // the 0.92 chat reliability floor, so these tests exercise the QUALITY gate
    // in isolation instead of tripping the reliability gate first (a null
    // posterior falls to the 0.72 no-data default, below every floor). A fresh
    // updatedAt keeps age() from decaying the evidence at read time.
    posterior: posterior ?? { alpha: 200, beta: 1, updatedAt: Date.now() },
    quality
  };
}

const GOOD = { state: "known_good", mean: 0.85, evidence: 10 };
const BAD = { state: "known_bad", mean: 0.30, evidence: 12 };
const COLD = { state: "cold", mean: null, evidence: 0 };

test("floorsFor keys by task prefix and falls back to the default", () => {
  assert.deepEqual(floorsFor(compileTaskIR(CHAT)), { reliability: 0.92, quality: 0.60 }, "chat:casual -> chat floors");
  const debug = floorsFor(compileTaskIR({ messages: [{ role: "user", content: "debug this TypeError stack trace in src/a.ts" }] }));
  assert.equal(debug.reliability, 0.95);
  assert.equal(debug.quality, 0.72);
  assert.deepEqual(floorsFor({ task: "unknown:thing" }), { reliability: 0.90, quality: 0.55 }, "unknown prefix -> default");
});

test("a mature known_bad canonical is rejected by the quality floor; known_good stays eligible", () => {
  const taskIR = compileTaskIR(CHAT);
  const qa = constraintFirstPick([route("cheap-bad", { quality: BAD }), route("solid", { quality: GOOD, cost: 0.05 })], taskIR);
  assert.equal(qa.pick.slug, "solid", "the bad-quality route is rejected, the good one is picked");
  assert.equal(qa.eligibleCount, 1);
  const rejected = qa.rejected.find((r) => r.slug === "cheap-bad");
  assert.equal(rejected.reason, "below quality floor");
  assert.equal(rejected.qualityState, "known_bad");
});

test("a cold canonical is a cold-start allowance: eligible with no fabricated mean", () => {
  const taskIR = compileTaskIR(CHAT);
  const qa = constraintFirstPick([route("cold-new", { quality: COLD })], taskIR);
  assert.equal(qa.pick.slug, "cold-new", "cold routes stay eligible (exploration rule)");
  assert.equal(qa.eligibleCount, 1);
  assert.equal(qa.rejected.length, 0, "cold is not rejected as below-floor");
  // The gate reason says so explicitly rather than pretending a measurement.
  const gate = qualityGate(qa.pick, taskIR);
  assert.equal(gate.cold, true);
  assert.equal(gate.quality, null);
  assert.match(gate.reason, /insufficient evidence/);
  assert.equal(qualityStateOf(qa.pick).mean, null, "no fake 50%");
});

test("quality never influences the operational pick; shadow.changed flags when it would", () => {
  const taskIR = compileTaskIR(CHAT);
  // Operational pick (Pareto/policy) favors the cheapest eligible route and
  // cannot see quality; the quality-constrained pick must reject the bad one.
  const d = shadowDecide({ routes: [route("cheap-bad", { quality: BAD }), route("solid", { quality: GOOD, cost: 0.05 })], taskIR, preference: 70 });
  assert.equal(d.shadow.operational_only_pick.slug, "cheap-bad", "operational pick is quality-blind");
  assert.equal(d.shadow.quality_aware_pick.slug, "solid", "quality-constrained pick avoids the bad canonical");
  assert.equal(d.shadow.changed, true, "the two picks differ and the block says so");
  assert.deepEqual(d.shadow.floors, { reliability: 0.92, quality: 0.60 });
  // Serving is untouched: the top-level picked policy is still the operational one.
  assert.equal(d.picked.primary, "cheap-bad", "shadow does not change what is served");
});

test("when both picks agree the comparison reports no change", () => {
  const taskIR = compileTaskIR(CHAT);
  const d = shadowDecide({ routes: [route("solid", { quality: GOOD, cost: 0.01 })], taskIR, preference: 70 });
  assert.equal(d.shadow.quality_aware_pick.slug, "solid");
  assert.equal(d.shadow.changed, false);
  assert.equal(d.shadow.considered, 1);
  assert.equal(d.shadow.eligible, 1);
  assert.equal(d.shadow.rejected_by_constraint.length, 0);
});

test("the comparison reports every rejected route with its own reason", () => {
  const taskIR = compileTaskIR(CHAT);
  const qa = constraintFirstPick([
    route("bad-quality", { quality: BAD }),
    route("bad-both", { quality: BAD, cost: 0.09 }),
    route("solid", { quality: GOOD, cost: 0.05 })
  ], taskIR);
  const reasons = qa.rejected.map((r) => [r.slug, r.reason]);
  assert.deepEqual(reasons.sort(), [
    ["bad-both", "below quality floor"],
    ["bad-quality", "below quality floor"]
  ]);
  assert.equal(qa.consideredCount, 3);
  assert.equal(qa.eligibleCount, 1);
});

test("known_good pool beats the cold fallback pool: a cheap unproven model does not win", () => {
  const taskIR = compileTaskIR(CHAT);
  // A cheap COLD route would win a pure cost sort; the mature known_good
  // route must be preferred even though it costs more.
  const qa = constraintFirstPick([
    route("cheap-cold", { quality: COLD, cost: 0.001 }),
    route("pricey-good", { quality: GOOD, cost: 0.05 })
  ], taskIR);
  assert.equal(qa.pick.slug, "pricey-good", "mature known_good wins over a cheap cold route");
  assert.equal(qa.eligibleCount, 2, "both are eligible; the pool ordering is what differs");
});

test("a cold route wins only when no mature known_good route passes", () => {
  const taskIR = compileTaskIR(CHAT);
  const qa = constraintFirstPick([
    route("bad-good", { quality: BAD, cost: 0.002 }),
    route("cold-fallback", { quality: COLD, cost: 0.04 })
  ], taskIR);
  assert.equal(qa.pick.slug, "cold-fallback", "cold is the fallback pool, used only without a mature pass");
  const rejected = qa.rejected.find((r) => r.slug === "bad-good");
  assert.equal(rejected.reason, "below quality floor");
});

