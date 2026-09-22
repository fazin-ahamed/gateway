// ReflexCore tests — ranking, calibration, utility vs cost, posterior update.
// These assert decision behavior, not implementation shape.

import test from "node:test";
import assert from "node:assert/strict";

import { score, rank, choice, decide, utility, Posterior, Calibration, EVIDENCE_WEIGHTS } from "../src/reflex/index.js";
import { CALIBRATION_SEED, REFLEX_SCHEMA } from "../src/reflex/posteriors.js";

const ctx = (extra = {}) => ({
  taskIR: { task: "code:generation" },
  evidence: {},
  ...extra
});

const opt = (o) => ({ taskPrefixes: ["code:generation"], hardEligible: true, ...o });

test("score is 0 to 1 for eligible candidates and -Infinity when hard-ineligible", () => {
  assert.ok(score(ctx(), opt()) > 0);
  assert.equal(score(ctx(), opt({ hardEligible: false })), -Infinity);
  assert.equal(score(ctx(), opt({ taskPrefixes: [] })), 0, "no prefixes contributes nothing");
});

test("rank orders candidates best-first and drops hard-ineligible ones", () => {
  const ranked = rank(ctx(), [
    opt({ id: "a", lexicalHit: 0.2 }),
    opt({ id: "b", lexicalHit: 0.9 }),
    opt({ id: "c", hardEligible: false })
  ]);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].candidate.id, "b");
  assert.ok(ranked[0].score >= ranked[1].score);
});

test("choice returns the single best and null when nothing is admissible", () => {
  assert.equal(choice(ctx(), [opt({ id: "b", lexicalHit: 0.9 })]).id, "b");
  assert.equal(choice(ctx(), []), null);
  assert.equal(choice(ctx(), [opt({ hardEligible: false })]), null);
});

test("decide respects the required confidence threshold", () => {
  const low = decide({ ...ctx(), requiredConfidence: 0.9 }, opt({ lexicalHit: 0.1 }));
  assert.equal(low.accept, false);
  const high = decide({ ...ctx(), requiredConfidence: 0.2 }, opt({ lexicalHit: 1.0 }));
  assert.equal(high.accept, true);
  assert.ok(high.margin >= 0);
});

test("Posterior mean starts at 0.5 (weak prior) and moves with observation", () => {
  const p = new Posterior();
  assert.equal(p.mean(), 0.5);
  p.observe({ success: true });
  p.observe({ success: true });
  p.observe({ success: false });
  assert.ok(p.mean() > 0.5, "two wins one loss should land above 0.5");
  assert.equal(p.samples, 3);
});

test("Posterior EMA tracks latency and verified rate", () => {
  const p = new Posterior();
  p.observe({ success: true, latencyMs: 1000, verified: true });
  p.observe({ success: true, latencyMs: 2000, verified: false });
  assert.ok(p.latencyEma > 1000 && p.latencyEma < 2000);
  assert.ok(p.verifiedEma < 1);
});

test("utility penalizes cost and latency", () => {
  const p = new Posterior({ alpha: 8, beta: 2 });
  const cheap = utility(p, { cost: 0.001, latencyMs: 500 });
  const expensive = utility(p, { cost: 0.5, latencyMs: 60000 });
  assert.ok(cheap > expensive, "cheaper+faster must win at equal posterior");
});

test("utility rewards unexplored candidates (exploration bonus)", () => {
  const proven = new Posterior({ alpha: 30, beta: 2, samples: 32 });
  const untried = new Posterior({ alpha: 1, beta: 1, samples: 0 });
  const uProven = utility(proven, { cost: 0.01, latencyMs: 1000 });
  const uUntried = utility(untried, { cost: 0.01, latencyMs: 1000 });
  // A proven strong posterior should still win, but the gap must be modest,
  // not a permanent burial of the untried candidate.
  assert.ok(uProven > uUntried);
  assert.ok(uUntried > -1, "untried candidate stays reachable");
});

test("calibration pulls an overconfident score down to observed reality", () => {
  const cal = new Calibration(CALIBRATION_SEED);
  // Predicted 0.95 lands in the 0.9-1.0 bucket (observed 0.94): small move.
  assert.ok(cal.calibrate(0.95) < 0.96);
  // A bucket seeded at 0.4 observed pulls a raw 0.45 prediction down.
  assert.ok(cal.calibrate(0.45) < 0.45);
  // Empty calibration is a pass-through.
  assert.equal(new Calibration([]).calibrate(0.77), 0.77);
});

test("calibration output is always within [0,1]", () => {
  const cal = new Calibration(CALIBRATION_SEED);
  assert.ok(cal.calibrate(-5) >= 0);
  assert.ok(cal.calibrate(99) <= 1);
});

test("reflex schema is a CREATE TABLE IF NOT EXISTS statement", () => {
  assert.match(REFLEX_SCHEMA, /CREATE TABLE IF NOT EXISTS reflex_posteriors/);
  assert.match(REFLEX_SCHEMA, /PRIMARY KEY \(scope, scope_id, task_type\)/);
});

test("evidence weights are frozen and sum below 1", () => {
  assert.ok(Object.isFrozen(EVIDENCE_WEIGHTS));
  const sum = Object.values(EVIDENCE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(sum <= 1 + 1e-9, "weights must not exceed 1 in total");
});

test("observePosterior moves the latency EMA instead of freezing the first sample", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { migrateReflexPosteriors, observePosterior, loadPosterior } = await import("../src/reflex/posteriors.js");
  const raw = new DatabaseSync(":memory:");
  const db = {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        bind(...args) {
          return { run: () => stmt.run(...args), first: () => stmt.get(...args), all: () => ({ results: stmt.all(...args) }) };
        },
        run: () => stmt.run()
      };
    }
  };
  assert.equal(await migrateReflexPosteriors(db), true);
  await observePosterior(db, "route", "route:7", "chat", { success: true, latencyMs: 1000, costUsd: 0.01 });
  await observePosterior(db, "route", "route:7", "chat", { success: false, latencyMs: 100, costUsd: 0.01 });
  const row = await loadPosterior(db, "route", "route:7", "chat");
  assert.equal(row.samples, 2);
  assert.equal(row.alpha, 2, "prior 1 plus one success");
  assert.equal(row.beta, 2, "prior 1 plus one failure");
  assert.ok(row.latencyEma < 1000, "the second, faster sample must pull the EMA down");
  assert.ok(row.latencyEma > 100, "one sample must not erase the first");
  raw.close();
});
