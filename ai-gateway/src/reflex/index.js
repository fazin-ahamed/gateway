// ReflexCore — zero-compute decision primitives.
//
// Design rule from HORIZON-Ω: never use an LLM to decide what statistics can
// decide. Every primitive here is pure: no network, no token generation, no
// embedding model. Evidence combines hard constraints, task features,
// historical success (Beta posteriors), memory relevance, cost, latency,
// verification need and confidence margin.
//
// Freeze-safe: imported only by the skills/profiles boundary and tests.
// Never imported by src/index.js or src/horizon.js serving paths.

import { SKILL_BY_ID } from "../skills/catalog.js";

export const DEFAULT_LAMBDAS = Object.freeze({ cost: 0.35, latency: 0.15 });

// Beta posterior for a task × capability cell (model / skill / profile / tool).
// alpha = verified successes, beta = failures. EMA fields carry cost/latency.
export class Posterior {
  constructor({ alpha = 1, beta = 1, samples = 0, latencyEma = null, costEma = null, verifiedEma = null } = {}) {
    this.alpha = Number(alpha) || 1;
    this.beta = Number(beta) || 1;
    this.samples = Number(samples) || 0;
    this.latencyEma = latencyEma == null ? null : Number(latencyEma);
    this.costEma = costEma == null ? null : Number(costEma);
    this.verifiedEma = verifiedEma == null ? null : Number(verifiedEma);
  }
  // Posterior mean with a weak prior: an unseen cell is ~0.5, not 0.
  mean() {
    return this.alpha / (this.alpha + this.beta);
  }
  observe({ success, latencyMs = null, costUsd = null, verified = null }) {
    if (success) this.alpha += 1;
    else this.beta += 1;
    this.samples += 1;
    if (latencyMs != null)
      this.latencyEma = ema(this.latencyEma, Number(latencyMs), 0.3);
    if (costUsd != null)
      this.costEma = ema(this.costEma, Number(costUsd), 0.3);
    if (verified != null)
      this.verifiedEma = ema(this.verifiedEma, verified ? 1 : 0, 0.3);
  }
}

function ema(prev, value, alpha) {
  return prev == null ? value : prev * (1 - alpha) + value * alpha;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

// Evidence weights: how much each signal contributes to a candidate score.
// Sum < 1 leaves room for the posterior to dominate; calibration corrects
// the raw score against reality later.
export const EVIDENCE_WEIGHTS = Object.freeze({
  taskMatch: 0.34,
  lexical: 0.26,
  structure: 0.14,
  posterior: 0.20,
  memory: 0.06
});
export function score(context, candidate) {
  const c = context || {};
  const taskIR = c.taskIR || {};
  const evidence = c.evidence || {};
  const w = EVIDENCE_WEIGHTS;

  let s = 0;
  let totalW = 0;

  // Hard constraint: a candidate that cannot serve the task scores nothing.
  if (candidate.hardEligible === false) return -Infinity;

  if (candidate.taskPrefixes && candidate.taskPrefixes.length) {
    const t = String(taskIR.task || "");
    const hit = candidate.taskPrefixes.some((p) => t === p || t.startsWith(p));
    s += (hit ? 1 : 0) * w.taskMatch;
    totalW += w.taskMatch;
  }
  if (candidate.lexicalHit != null) {
    s += clamp01(candidate.lexicalHit) * w.lexical;
    totalW += w.lexical;
  }
  if (candidate.structureHit != null) {
    s += clamp01(candidate.structureHit) * w.structure;
    totalW += w.structure;
  }
  const post = evidence.posterior;
  if (post && typeof post.mean === "function") {
    s += clamp01(post.mean()) * w.posterior;
    totalW += w.posterior;
  }
  if (candidate.memoryHit != null) {
    s += clamp01(candidate.memoryHit) * w.memory;
    totalW += w.memory;
  }

  if (!totalW) return 0;
  return s / totalW;
}

// rank(context, options): options sorted best-first, each carrying its score.
export function rank(context, options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => ({ candidate: o, score: score(context, o) }))
    .filter((r) => Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score);
}

// choice(context, options): the single best option, or null when none is
// admissible (all hard-ineligible / empty input).
export function choice(context, options) {
  const ranked = rank(context, options);
  if (!ranked.length) return null;
  const best = ranked[0];
  if (!Number.isFinite(best.score) || best.score <= -Infinity) return null;
  return best.candidate;
}

// decide(context, proposition): yes/no with a calibrated margin. A proposition
// is admissible only when its margin exceeds the context's required threshold.
export function decide(context, proposition) {
  const s = score(context, proposition);
  const need = Number((context && context.requiredConfidence) || 0.5);
  if (!Number.isFinite(s)) return { accept: false, score: s, margin: -Infinity, need };
  const margin = s - need;
  return { accept: margin >= 0, score: s, margin, need };
}

// Utility = P(verified success) - λc·cost - λl·latency, normalized.
// Uncertainty (low sample count) yields an exploration bonus so an untried
// candidate is not permanently buried by a lucky incumbent.
export function utility(p, { cost = 0, latencyMs = 0, lambdas = DEFAULT_LAMBDAS } = {}) {
  if (!p || typeof p.mean !== "function") return -Infinity;
  const lambdaCost = Number(lambdas.cost) || 0;
  const lambdaLat = Number(lambdas.latency) || 0;
  const ps = p.mean();
  // Normalize cost/latency against a log1p curve: a 10x cost increase should
  // not linearly erase a strong posterior.
  const costTerm = lambdaCost * Math.log1p(Math.max(0, Number(cost) || 0));
  const latencyTerm = lambdaLat * Math.log1p(Math.max(0, Number(latencyMs) || 0) / 1000);
  // UCB-style exploration: more uncertainty = more willingness to try.
  const total = p.alpha + p.beta;
  const exploration = total > 0 ? Math.sqrt(2 * Math.log(Math.max(2, p.samples + 1)) / total) : 0.5;
  return ps - costTerm - latencyTerm + 0.1 * exploration;
}

// Calibration: bucket predicted vs observed success and correct the raw score.
// Buckets are empirical; a ReflexCore claiming 0.90 that only delivers 0.72
// gets pulled down to observed reality.
export class Calibration {
  constructor(buckets) {
    // buckets: array of {lo, hi, observed}
    this.buckets = Array.isArray(buckets) ? buckets.slice().sort((a, b) => a.lo - b.lo) : [];
  }
  calibrate(rawScore) {
    if (!this.buckets.length || !Number.isFinite(rawScore)) return rawScore;
    const r = clamp01(rawScore);
    const b = this.buckets.find((x) => r >= x.lo && r <= x.hi);
    if (!b) return r;
    // Blend toward observed frequency; weight observation over prediction.
    return clamp01(0.5 * r + 0.5 * Number(b.observed));
  }
}

// Skill shortlist from the catalog: metadata only, no bodies loaded. The
// caller loads only the returned SKILL.md files (progressive disclosure).
export function shortlistSkills(taskIR, { lexicalHit = null } = {}) {
  const context = { taskIR, evidence: {}, requiredConfidence: 0.4 };
  const options = [...SKILL_BY_ID.values()].map((s) => ({
    id: s.id,
    taskPrefixes: s.taskPrefixes,
    lexicalHit,
    hardEligible: !Array.isArray(s.taskPrefixes) || s.taskPrefixes.length > 0
  }));
  const ranked = rank(context, options);
  const primary = ranked.length ? ranked[0].candidate : null;
  const helper = ranked.length > 1 ? ranked[1].candidate : null;
  return { primary: primary ? primary.id : null, helper: helper ? helper.id : null, scores: ranked.map((r) => ({ id: r.candidate.id, score: r.score })) };
}
