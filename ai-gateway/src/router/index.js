// Router V2 shadow path. Never selects live traffic unless ROUTER_V2=live.
// Default is shadow: compute the policy, attach it, leave V1 in control.

import { compileTaskIR } from "./task-ir.js";
import { normalizeModelId, routeKey } from "./identity.js";
import { observe, seedBeta, summarize } from "./posterior.js";
import { shadowDecide } from "./policies.js";

export const ROUTER_V2_MODE = () => {
  const raw = String(process.env.ROUTER_V2 || "shadow").toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return "off";
  if (raw === "live" || raw === "1" || raw === "true") return "live";
  return "shadow";
};

function posteriorFromCandidate(cand) {
  const n = Number(cand && cand.samples) || 0;
  const ok = Number(cand && cand.okRate);
  const seed = seedBeta("route");
  if (n <= 0 || !Number.isFinite(ok))
    return { ...seed, updatedAt: 0 };
  const success = Math.max(0, Math.round(ok * n));
  const fail = Math.max(0, n - success);
  return { alpha: seed.alpha + success, beta: seed.beta + fail, updatedAt: Date.now() };
}

export function routesFromV1Candidates(candidates) {
  return (candidates || []).map((c) => ({
    slug: c.slug,
    model: normalizeModelId(c.slug),
    cost: Number(c.cost) || 0.5,
    avgMs: Number(c.avgMs) || 0,
    p50Ms: Number(c.avgMs) || 0,
    capable: c.capable !== false,
    workhorse: !!c.workhorse,
    luxury: !!c.luxury,
    tiny: !!c.tiny,
    eligible: !!c.eligible,
    posterior: posteriorFromCandidate(c),
    key: routeKey({ slug: c.slug, upstream_model: c.slug })
  }));
}

export function shadowFromV1({ payload, candidates, preference }) {
  if (ROUTER_V2_MODE() === "off") return null;
  const taskIR = compileTaskIR(payload || {});
  const routes = routesFromV1Candidates(candidates);
  const decision = shadowDecide({
    routes,
    taskIR,
    preference: preference == null ? 70 : preference
  });
  return {
    ...decision,
    mode: ROUTER_V2_MODE()
  };
}

export {
  compileTaskIR,
  normalizeModelId,
  routeKey,
  observe,
  summarize,
  seedBeta
};
