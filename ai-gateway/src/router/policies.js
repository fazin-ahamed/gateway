// Execution policies for Router V2. The unit of routing is a policy, not a
// model: Reflex / Blend / Verified / Conductor / Rescue. Dominated policies
// are dropped before selection.

import { isTinyModel, modelFamily, normalizeModelId } from "./identity.js";
import { lcb, mean, summarize } from "./posterior.js";

export const MODES = ["reflex", "blend", "verified", "conductor", "rescue"];

function costOf(route) {
  // A route with a known cost keeps it verbatim — including exactly 0 for a
  // free model. Only a genuinely unknown cost falls back to the 0.5 placeholder.
  if (route && route.costKnown) {
    const n = Number(route.cost);
    return Number.isFinite(n) && n >= 0 ? n : 0.5;
  }
  const n = Number(route && route.cost);
  return Number.isFinite(n) && n > 0 ? n : 0.5;
}

function costKnownOf(route) {
  return !!(route && route.costKnown);
}

function latencyOf(route) {
  const n = Number(route && (route.latencyEma || route.p50Ms || route.avgMs));
  return Number.isFinite(n) && n > 0 ? n : 800;
}

function latencyKnownOf(route) {
  const n = Number(route && (route.latencyEma || route.p50Ms || route.avgMs));
  return Number.isFinite(n) && n > 0;
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

// Operational identity of a route: the route key (model|provider|transport|
// slug) is what execution and telemetry must use, not the public slug, since
// two routes can share a slug across providers with different price/health.
function ref(route) {
  if (!route) return null;
  return { slug: route.slug, routeId: route.routeId ?? null, routeKey: route.key || null };
}

// Luxury is a soft economic prior, not a capability failure: an expensive
// flagship can be the right answer for a hard, high-verification task. Its
// cost already discourages it; add a mild extra multiplier so a cheaper equal
// wins ties, without excluding it from the frontier.
function economicCost(route) {
  const base = costOf(route);
  return route && route.luxury ? base * 1.5 : base;
}

export function candidatePolicies(routes, taskIR) {
  const usable = (routes || []).filter((r) => r && r.slug && r.hardEligible === true);
  const cheap = usable.filter((r) => (isTinyModel(r.slug) || r.workhorse) && !r.luxury).sort((a, b) => economicCost(a) - economicCost(b));
  const strong = usable.filter((r) => !isTinyModel(r.slug)).sort((a, b) => successOf(b, taskIR) - successOf(a, taskIR));
  const primary = cheap[0] || usable[0];
  const out = [];
  if (primary) {
    out.push({
      id: "P-reflex",
      mode: "reflex",
      primary: primary.slug,
      primaryRef: ref(primary),
      challenger: cheap[1] ? cheap[1].slug : null,
      challengerRef: cheap[1] ? ref(cheap[1]) : null,
      verifier: null,
      verifierRef: null,
      success: successOf(primary, taskIR) * (taskIR && taskIR.difficulty < 0.35 ? 1 : 0.82),
      cost: economicCost(primary) * 1.08,
      latency: latencyOf(primary) * 1.05,
      routes: [primary.slug, cheap[1] && cheap[1].slug].filter(Boolean),
      routeRefs: [ref(primary), cheap[1] && ref(cheap[1])].filter(Boolean)
    });
  }
  const pair = diversePair(cheap.length >= 2 ? cheap : usable);
  if (pair) {
    out.push({
      id: "P-blend",
      mode: "blend",
      primary: pair[0].slug,
      primaryRef: ref(pair[0]),
      challenger: pair[1].slug,
      challengerRef: ref(pair[1]),
      verifier: null,
      verifierRef: null,
      success: 1 - (1 - successOf(pair[0], taskIR)) * (1 - successOf(pair[1], taskIR) * 0.55),
      cost: economicCost(pair[0]) + economicCost(pair[1]) * 0.25,
      latency: Math.max(latencyOf(pair[0]), latencyOf(pair[1]) * 0.4),
      routes: [pair[0].slug, pair[1].slug],
      routeRefs: [ref(pair[0]), ref(pair[1])]
    });
  }
  if (pair && taskIR && taskIR.verificationNeed > 0.45) {
    const verifier = strong.find((r) => r.key !== pair[0].key && r.key !== pair[1].key) || strong[0] || pair[1];
    out.push({
      id: "P-verified",
      mode: "verified",
      primary: pair[0].slug,
      primaryRef: ref(pair[0]),
      challenger: pair[1].slug,
      challengerRef: ref(pair[1]),
      verifier: verifier && verifier.slug,
      verifierRef: ref(verifier),
      success: Math.min(0.99, 1 - (1 - successOf(pair[0], taskIR)) * 0.35),
      cost: economicCost(pair[0]) + economicCost(pair[1]) * 0.3 + (verifier ? economicCost(verifier) * 0.2 : 0),
      latency: Math.max(latencyOf(pair[0]), latencyOf(pair[1])) * 1.15,
      routes: [pair[0].slug, pair[1].slug, verifier && verifier.slug].filter(Boolean),
      routeRefs: [ref(pair[0]), ref(pair[1]), verifier && ref(verifier)].filter(Boolean)
    });
  }
  if (taskIR && (taskIR.agenticDepth > 0.4 || taskIR.decomposition > 0.6) && strong[0]) {
    const worker = cheap.find((r) => r.key !== strong[0].key) || strong[1] || strong[0];
    const verifier = strong.find((r) => r.key !== strong[0].key && r.key !== (worker && worker.key)) || worker;
    out.push({
      id: "P-conductor",
      mode: "conductor",
      primary: strong[0].slug,
      primaryRef: ref(strong[0]),
      challenger: worker && worker.slug,
      challengerRef: ref(worker),
      verifier: verifier && verifier.slug,
      verifierRef: ref(verifier),
      success: Math.min(0.99, successOf(strong[0], taskIR) + 0.08),
      cost: economicCost(strong[0]) * 0.4 + (worker ? economicCost(worker) : 0) + (verifier ? economicCost(verifier) * 0.25 : 0),
      latency: latencyOf(strong[0]) * 1.8,
      routes: [strong[0].slug, worker && worker.slug, verifier && verifier.slug].filter(Boolean),
      routeRefs: [ref(strong[0]), worker && ref(worker), verifier && ref(verifier)].filter(Boolean)
    });
  }
  if (strong[0]) {
    out.push({
      id: "P-rescue",
      mode: "rescue",
      primary: strong[0].slug,
      primaryRef: ref(strong[0]),
      challenger: null,
      challengerRef: null,
      verifier: null,
      verifierRef: null,
      success: Math.min(0.995, successOf(strong[0], taskIR) + 0.04),
      cost: economicCost(strong[0]) * 1.4,
      latency: latencyOf(strong[0]) * 1.3,
      routes: [strong[0].slug],
      routeRefs: [ref(strong[0])]
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
  const easy = taskIR && taskIR.difficulty < 0.32 && taskIR.verificationNeed < 0.3 && !(taskIR.tools && taskIR.tools.required);
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
  const byKey = new Map((routes || []).map((r) => [r.key, r]));
  const primary = policy.primaryRef && byKey.get(policy.primaryRef.routeKey);
  return {
    task: taskIR && taskIR.task,
    taskConfidence: taskIR && taskIR.confidence,
    mode: policy.mode,
    policy: policy.id,
    primary: policy.primary,
    primaryRoute: policy.primaryRef,
    challenger: policy.challenger,
    challengerRoute: policy.challengerRef,
    verifier: policy.verifier,
    verifierRoute: policy.verifierRef,
    // "expectedSuccess" is an operational-reliability estimate (will the route
    // return a usable completion), NOT answer-quality. The UI must not label it
    // "success"/quality. costKnown/latencyKnown flag placeholder values so the
    // UI can mark an unmeasured default instead of showing it as observed.
    expectedSuccess: policy.success,
    reliabilityKind: "operational",
    expectedCost: policy.cost,
    costKnown: costKnownOf(primary),
    expectedLatencyMs: policy.latency,
    latencyKnown: latencyKnownOf(primary),
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
