// Execution policies for Router V2. The unit of routing is a policy, not a
// model: Reflex / Blend / Verified / Conductor / Rescue. Dominated policies
// are dropped before selection.

import { isTinyModel, modelFamily, normalizeModelId } from "./identity.js";
import { lcb, mean, summarize } from "./posterior.js";

export const MODES = ["reflex", "blend", "verified", "conductor", "rescue"];

function costOf(route) {
  const n = Number(route && route.cost);
  return Number.isFinite(n) && n > 0 ? n : 0.5;
}

function latencyOf(route) {
  const n = Number(route && (route.p50Ms || route.avgMs));
  return Number.isFinite(n) && n > 0 ? n : 800;
}

function successOf(route, taskIR) {
  const post = route && route.posterior;
  const p = post ? (0.65 * lcb(post) + 0.35 * mean(post)) : 0.72;
  const tiny = isTinyModel(route && (route.model || route.slug));
  const hard = taskIR && (taskIR.difficulty > 0.55 || taskIR.verificationNeed > 0.7);
  if (tiny && hard) return Math.max(0.15, p - 0.18);
  return p;
}

function diversePair(routes) {
  const pool = (routes || []).filter((r) => r && r.slug);
  if (pool.length < 2) return null;
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i];
      const b = pool[j];
      const famBonus = modelFamily(a.slug) === modelFamily(b.slug) ? 0 : 1;
      const score = famBonus * 2 - (costOf(a) + costOf(b)) / 20;
      if (score > bestScore) {
        bestScore = score;
        best = [a, b];
      }
    }
  }
  return best;
}

export function candidatePolicies(routes, taskIR) {
  const usable = (routes || []).filter((r) => r && r.slug && r.capable !== false && !r.luxury);
  const cheap = usable.filter((r) => isTinyModel(r.slug) || r.workhorse).sort((a, b) => costOf(a) - costOf(b));
  const strong = usable.filter((r) => !isTinyModel(r.slug)).sort((a, b) => successOf(b, taskIR) - successOf(a, taskIR));
  const primary = cheap[0] || usable[0];
  const out = [];
  if (primary) {
    out.push({
      id: "P-reflex",
      mode: "reflex",
      primary: primary.slug,
      challenger: cheap[1] ? cheap[1].slug : null,
      verifier: null,
      success: successOf(primary, taskIR) * (taskIR && taskIR.difficulty < 0.35 ? 1 : 0.82),
      cost: costOf(primary) * 1.08,
      latency: latencyOf(primary) * 1.05,
      routes: [primary.slug, cheap[1] && cheap[1].slug].filter(Boolean)
    });
  }
  const pair = diversePair(cheap.length >= 2 ? cheap : usable);
  if (pair) {
    out.push({
      id: "P-blend",
      mode: "blend",
      primary: pair[0].slug,
      challenger: pair[1].slug,
      verifier: null,
      success: 1 - (1 - successOf(pair[0], taskIR)) * (1 - successOf(pair[1], taskIR) * 0.55),
      cost: costOf(pair[0]) + costOf(pair[1]) * 0.25,
      latency: Math.max(latencyOf(pair[0]), latencyOf(pair[1]) * 0.4),
      routes: [pair[0].slug, pair[1].slug]
    });
  }
  if (pair && taskIR && taskIR.verificationNeed > 0.45) {
    const verifier = strong.find((r) => r.slug !== pair[0].slug && r.slug !== pair[1].slug) || strong[0] || pair[1];
    out.push({
      id: "P-verified",
      mode: "verified",
      primary: pair[0].slug,
      challenger: pair[1].slug,
      verifier: verifier && verifier.slug,
      success: Math.min(0.99, 1 - (1 - successOf(pair[0], taskIR)) * 0.35),
      cost: costOf(pair[0]) + costOf(pair[1]) * 0.3 + (verifier ? costOf(verifier) * 0.2 : 0),
      latency: Math.max(latencyOf(pair[0]), latencyOf(pair[1])) * 1.15,
      routes: [pair[0].slug, pair[1].slug, verifier && verifier.slug].filter(Boolean)
    });
  }
  if (taskIR && (taskIR.agenticDepth > 0.4 || taskIR.decomposition > 0.6) && strong[0]) {
    const worker = cheap.find((r) => r.slug !== strong[0].slug) || strong[1] || strong[0];
    const verifier = strong.find((r) => r.slug !== strong[0].slug && r.slug !== (worker && worker.slug)) || worker;
    out.push({
      id: "P-conductor",
      mode: "conductor",
      primary: strong[0].slug,
      challenger: worker && worker.slug,
      verifier: verifier && verifier.slug,
      success: Math.min(0.99, successOf(strong[0], taskIR) + 0.08),
      cost: costOf(strong[0]) * 0.4 + (worker ? costOf(worker) : 0) + (verifier ? costOf(verifier) * 0.25 : 0),
      latency: latencyOf(strong[0]) * 1.8,
      routes: [strong[0].slug, worker && worker.slug, verifier && verifier.slug].filter(Boolean)
    });
  }
  if (strong[0]) {
    out.push({
      id: "P-rescue",
      mode: "rescue",
      primary: strong[0].slug,
      challenger: null,
      verifier: null,
      success: Math.min(0.995, successOf(strong[0], taskIR) + 0.04),
      cost: costOf(strong[0]) * 1.4,
      latency: latencyOf(strong[0]) * 1.3,
      routes: [strong[0].slug]
    });
  }
  return out;
}

export function pareto(policies) {
  const list = (policies || []).slice();
  return list.filter((a) => !list.some((b) =>
    b !== a
    && b.success >= a.success
    && b.cost <= a.cost
    && b.latency <= a.latency
    && (b.success > a.success || b.cost < a.cost || b.latency < a.latency)
  ));
}

export function pickPolicy(policies, preference = 70, taskIR = null) {
  const front = pareto(policies);
  if (!front.length) return null;
  const w = Math.max(0, Math.min(1, Number(preference) / 100));
  const easy = taskIR && taskIR.difficulty < 0.32 && taskIR.verificationNeed < 0.3 && !taskIR.tools.required;
  let best = null;
  let bestScore = -Infinity;
  for (const p of front) {
    if (easy && p.mode === "rescue") continue;
    if (easy && p.mode === "conductor") continue;
    const s = (1 - w) * p.success * 10 - w * p.cost - 0.0004 * p.latency;
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return best || front[0];
}

export function explainPolicy(policy, taskIR, routes) {
  if (!policy) return null;
  const bySlug = new Map((routes || []).map((r) => [r.slug, r]));
  const primary = bySlug.get(policy.primary);
  return {
    task: taskIR && taskIR.task,
    taskConfidence: taskIR && taskIR.confidence,
    mode: policy.mode,
    policy: policy.id,
    primary: policy.primary,
    challenger: policy.challenger,
    verifier: policy.verifier,
    expectedSuccess: policy.success,
    expectedCost: policy.cost,
    expectedLatencyMs: policy.latency,
    primaryHealth: primary && primary.posterior ? summarize(primary.posterior) : null
  };
}

export function shadowDecide({ routes, taskIR, preference }) {
  const policies = candidatePolicies(routes, taskIR);
  const front = pareto(policies);
  const picked = pickPolicy(front, preference, taskIR);
  return {
    version: 2,
    taskIR: taskIR && {
      task: taskIR.task,
      confidence: taskIR.confidence,
      difficulty: taskIR.difficulty,
      verificationNeed: taskIR.verificationNeed,
      agenticDepth: taskIR.agenticDepth,
      contextTokens: taskIR.contextTokens
    },
    picked,
    frontier: front,
    rejected: policies.filter((p) => !front.includes(p)).map((p) => p.id),
    explain: explainPolicy(picked, taskIR, routes)
  };
}
