// Independent V2 candidate universe.
//
// V1 scores a slug-level list (trajectory health, quality-prior need, HORIZON
// workhorse filters). V2 must not inherit that list: it reads enabled
// model_routes + provider/key availability + catalog capabilities + prices +
// router_stats posteriors, then applies its own TaskIR gates.
//
// Live execution is still V1. This module only builds the world V2 would
// choose from, so a V1 bug cannot silently empty V2's pool.

import { isTinyModel, normalizeModelId, routeKey } from "./identity.js";
import { seedBeta } from "./posterior.js";
import { compileTaskIR } from "./task-ir.js";
import { shadowDecide } from "./policies.js";

export function posteriorFromStats(row) {
  const seed = seedBeta("route");
  if (!row)
    return { ...seed, updatedAt: 0, kind: "route" };
  return {
    kind: "route",
    alpha: Number(row.success_alpha) || seed.alpha,
    beta: Number(row.failure_beta) || seed.beta,
    updatedAt: Date.parse(row.updated_at) || 0
  };
}

function costFromPrice(row) {
  if (!row)
    return 0.5;
  const prompt = Number(row.prompt_per_1m) || 0;
  const completion = Number(row.completion_per_1m) || 0;
  const n = prompt + completion;
  return Number.isFinite(n) && n > 0 ? n : 0.5;
}

function capabilitiesOf(entry) {
  if (!entry)
    return { context: 0, output: 0, vision: false, tools: false, unknown: true };
  const ctx = Number(entry.limit && entry.limit.context) || 0;
  const output = Number(entry.limit && entry.limit.output) || 0;
  const input = entry.modalities && Array.isArray(entry.modalities.input) ? entry.modalities.input : null;
  const vision = input ? input.some((m) => String(m).toLowerCase() === "image") : false;
  return { context: ctx, output, vision, tools: entry.toolCall === false ? false : true, unknown: false };
}

const LUXURY = /(gpt-6-astra|\bastra\b|claude-fable|fable-5|mythos|gpt-6(?!.*mini)|opus-5|claude-opus-5)/;
const WORKHORSE = /(glm-5|glm-4\.6|kimi|moonshot|deepseek|qwen3|minimax|grok-4|laguna|agnes|muse-spark)/;

export function isLuxurySlug(id) {
  return LUXURY.test(String(id || "").toLowerCase());
}

export function isWorkhorseSlug(id) {
  return WORKHORSE.test(String(id || "").toLowerCase());
}

// TaskIR-native capability gate. Does not consult V1 quality/need or
// trajectory ok_rate — those are V1's worldview.
export function v2Capable(caps, taskIR) {
  const tokens = Number(taskIR && taskIR.contextTokens) || 0;
  const wantsVision = !!(taskIR && taskIR.modalities && taskIR.modalities.includes("image"));
  const wantsTools = !!(taskIR && taskIR.tools && taskIR.tools.required);
  const ctxOk = caps.unknown ? tokens < 32000 : (!caps.context || tokens <= Math.floor(caps.context * 0.9));
  const visionOk = !wantsVision || (!caps.unknown && caps.vision);
  const toolsOk = !wantsTools || caps.tools || caps.unknown;
  let reason = "";
  if (!ctxOk) reason = "context";
  else if (!visionOk) reason = "vision";
  else if (!toolsOk) reason = "tools";
  return { capable: ctxOk && visionOk && toolsOk, reason, ctxOk, visionOk, toolsOk };
}

export function shapeV2Route(row, taskIR) {
  const slug = String(row.slug || "");
  const caps = capabilitiesOf(row.entry);
  const gate = v2Capable(caps, taskIR);
  const hasCredential = Number(row.key_count) > 0;
  const circuit = !!row.circuitOpen;
  const luxury = isLuxurySlug(slug);
  const eligible = gate.capable && hasCredential && !circuit && !luxury;
  let reason = gate.reason;
  if (!reason && !hasCredential) reason = "no key";
  if (!reason && circuit) reason = "circuit open";
  if (!reason && luxury) reason = "luxury";
  const posterior = posteriorFromStats(row.stats);
  return {
    slug,
    model: normalizeModelId(row.upstream_model || slug),
    routeId: row.route_id ?? row.id ?? null,
    providerId: row.provider_id ?? null,
    transport: String(row.transport || row.fmt || "direct"),
    cost: costFromPrice(row.price),
    avgMs: Number(row.stats && row.stats.latency_ema) || 0,
    p50Ms: Number(row.stats && row.stats.latency_ema) || 0,
    capable: gate.capable,
    workhorse: isWorkhorseSlug(slug),
    luxury,
    tiny: isTinyModel(slug),
    eligible,
    hardEligible: eligible,
    hasCredential,
    circuitOpen: circuit,
    reason,
    posterior,
    key: routeKey({
      slug,
      upstream_model: row.upstream_model || slug,
      provider_id: row.provider_id,
      transport: row.transport || row.fmt
    })
  };
}

export function buildV2Universe(rows, payload) {
  const taskIR = compileTaskIR(payload || {});
  const routes = (rows || []).map((row) => shapeV2Route(row, taskIR));
  return { taskIR, routes };
}

export function shadowFromUniverse({ payload, rows, routes, preference }) {
  const built = routes ? { taskIR: compileTaskIR(payload || {}), routes } : buildV2Universe(rows, payload);
  const decision = shadowDecide({
    routes: built.routes,
    taskIR: built.taskIR,
    preference: preference == null ? 70 : preference
  });
  return {
    ...decision,
    universe: built.routes.map((r) => ({
      slug: r.slug,
      routeId: r.routeId,
      eligible: r.eligible,
      reason: r.reason,
      key: r.key
    }))
  };
}

export async function loadV2World(c, { payload, allowed = null, excluded = [], catalogById = null, overlay = new Map(), circuitOpen = () => false, lookupPrice = async () => null } = {}) {
  const rows = await c.env.DB.prepare(
    `SELECT mr.id, mr.slug, mr.upstream_model, mr.rank, mr.provider_id, p.fmt, p.transport,
            (SELECT COUNT(*) FROM provider_keys pk WHERE pk.provider_id=p.id AND pk.enabled=1) AS key_count
     FROM model_routes mr
     JOIN providers p ON p.id=mr.provider_id
     WHERE mr.enabled=1 AND p.enabled=1 AND p.healthy=1`
  ).all();
  const statsRows = await c.env.DB.prepare(
    "SELECT scope_id, success_alpha, failure_beta, latency_ema, cost_ema, updated_at FROM router_stats WHERE scope='route' AND task_type=''"
  ).all();
  const statsByScope = new Map();
  for (const s of statsRows.results || [])
    statsByScope.set(String(s.scope_id), s);

  const allow = allowed ? new Set(allowed) : null;
  const skip = new Set((excluded || []).map((s) => String(s)));
  skip.add("auto");
  const world = [];
  for (const r of rows.results || []) {
    if (skip.has(r.slug))
      continue;
    if (allow && !allow.has(r.slug))
      continue;
    const entry = overlay.get(r.slug) || matchEntry(catalogById, r.slug);
    const price = await lookupPrice(r.slug, r.provider_id);
    const circuit = !!(circuitOpen("route", r.id) || circuitOpen("provider", r.provider_id));
    world.push({
      id: r.id,
      route_id: r.id,
      slug: r.slug,
      upstream_model: r.upstream_model,
      provider_id: r.provider_id,
      fmt: r.fmt,
      transport: r.transport,
      key_count: r.key_count,
      entry,
      price,
      stats: statsByScope.get("route:" + r.id) || null,
      circuitOpen: circuit
    });
  }
  return buildV2Universe(world, payload);
}
function matchEntry(byId, slug) {
  if (!byId || typeof byId.get !== "function")
    return null;
  const want = String(slug || "");
  if (byId.has(want))
    return byId.get(want);
  const lower = want.toLowerCase();
  for (const [id, entry] of byId) {
    if (String(id).toLowerCase() === lower)
      return entry;
  }
  const bare = want.includes("/") ? want.slice(want.lastIndexOf("/") + 1).toLowerCase() : lower;
  for (const [id, entry] of byId) {
    const s = String(id).toLowerCase();
    if (s === bare || s.endsWith("/" + bare))
      return entry;
  }
  return null;
}
