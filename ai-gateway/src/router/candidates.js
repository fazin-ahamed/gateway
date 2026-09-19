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
import { age, seedBeta, samples as posteriorSamples } from "./posterior.js";
import { compileTaskIR } from "./task-ir.js";
import { shadowDecide } from "./policies.js";

// A task-specific route posterior only overrides the global one once it has
// its own evidence; below this it is noise and the global posterior is the
// better prior.
const TASK_POSTERIOR_MATURE = 5;
// cost_ema is trusted as the real per-request cost once the route has enough
// observations; below this fall back to the priced estimate.
const COST_EMA_MATURE = 5;
// A known catalog entry with no advertised context window is treated as this
// conservative ceiling rather than unlimited.
const UNKNOWN_CONTEXT_FALLBACK = 32000;

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

// Global route posterior is the prior; the task-specific posterior takes over
// once it has independent evidence. This is the whole point of the per-task
// router_stats rows — route 12 may be excellent on code:debug and mediocre on
// vision:reasoning, and the router should learn that.
export function effectivePosterior(globalStats, taskStats, at = Date.now()) {
  // Age at read time: an untouched route decays toward its prior instead of
  // staying frozen at its last observation. posterior.observe() already ages
  // on write, but a route that stops receiving traffic is only re-aged here.
  const global = age(posteriorFromStats(globalStats), at);
  if (!taskStats)
    return global;
  const taskRaw = posteriorFromStats(taskStats);
  if (posteriorSamples(taskRaw) >= TASK_POSTERIOR_MATURE)
    return age(taskRaw, at);
  return global;
}

// Real expected per-request cost, not the sum of two $/1M rates. Prefers a
// mature cost_ema, then a per-request actual price, then actual/list token
// rates evaluated against the TaskIR token estimate.
export function estimateCost(row, taskIR) {
  const ema = Number(row && row.stats && row.stats.cost_ema);
  if (Number.isFinite(ema) && ema >= 0 && posteriorSamples(posteriorFromStats(row.stats)) >= COST_EMA_MATURE)
    return { cost: ema, known: true };
  const price = row && row.price;
  if (price) {
    if (String(price.actual_mode) === "per_request" && Number.isFinite(Number(price.actual_per_request)) && Number(price.actual_per_request) >= 0)
      return { cost: Number(price.actual_per_request), known: true };
    const promptRate = Number(price.actual_prompt_per_1m) || Number(price.prompt_per_1m) || 0;
    const complRate = Number(price.actual_completion_per_1m) || Number(price.completion_per_1m) || 0;
    // A price row exists, so rates of 0 are a real "this route is free", not
    // "unknown". Only the total absence of a price row is unknown.
    const inTok = Number(taskIR && taskIR.contextTokens) || 0;
    const outTok = Number(taskIR && taskIR.expectedOutputTokens) || 0;
    const est = (inTok / 1e6) * promptRate + (outTok / 1e6) * complRate;
    return { cost: est, known: true };
  }
  return { cost: 0.5, known: false };
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

// TaskIR-native capability gate. Fail-closed: a hard requirement (tools,
// context, output, vision) with no catalog/overlay evidence is NOT assumed
// satisfied. A missing context window uses a conservative ceiling, never
// infinity, and the output limit is checked against the expected output.
export function v2Capable(caps, taskIR) {
  const tokens = Number(taskIR && taskIR.contextTokens) || 0;
  const wantsVision = !!(taskIR && taskIR.modalities && taskIR.modalities.includes("image"));
  const wantsTools = !!(taskIR && taskIR.tools && taskIR.tools.required);
  const ctxLimit = caps.unknown ? UNKNOWN_CONTEXT_FALLBACK : (caps.context > 0 ? caps.context : UNKNOWN_CONTEXT_FALLBACK);
  const ctxOk = tokens <= Math.floor(ctxLimit * 0.9);
  const visionOk = !wantsVision || (!caps.unknown && caps.vision);
  // Unknown capability fails closed on a hard requirement.
  const wantOut = Number(taskIR && (taskIR.requiredOutputTokens ?? taskIR.expectedOutputTokens)) || 0;
  const toolsOk = !wantsTools || (!caps.unknown && caps.tools);
  // Output limit only gates when the route actually advertises one.
  const outOk = !(caps.output > 0) || wantOut === 0 || wantOut <= caps.output;
  let reason = "";
  if (!ctxOk) reason = "context";
  else if (!visionOk) reason = "vision";
  else if (!toolsOk) reason = "tools";
  else if (!outOk) reason = "output";
  return { capable: ctxOk && visionOk && toolsOk && outOk, reason, ctxOk, visionOk, toolsOk, outOk };
}

export function shapeV2Route(row, taskIR) {
  const slug = String(row.slug || "");
  const caps = capabilitiesOf(row.entry);
  const gate = v2Capable(caps, taskIR);
  const enabledKeyCount = Number(row.key_count) || 0;
  // Live execution has per-key circuit breakers; usable keys, not merely
  // enabled ones, decide whether a credential is actually available.
  const usableKeyCount = row.usable_key_count == null ? enabledKeyCount : Number(row.usable_key_count) || 0;
  const hasCredential = usableKeyCount > 0;
  const circuit = !!row.circuitOpen;
  const luxury = isLuxurySlug(slug);
  // Luxury is an economic prior, NOT a capability failure. An expensive
  // flagship can be exactly what a hard, high-verification task needs, so it
  // stays hard-eligible and is discouraged by cost/budget in scoring instead.
  const eligible = gate.capable && hasCredential && !circuit;
  let reason = gate.reason;
  if (!reason && !hasCredential) reason = enabledKeyCount > 0 ? "keys circuit-open" : "no key";
  if (!reason && circuit) reason = "circuit open";
  const posterior = effectivePosterior(row.stats, row.taskStats);
  const costEst = estimateCost(row, taskIR);
  const latencyEma = Number(row.stats && row.stats.latency_ema) || 0;
  const rk = routeKey({
    slug,
    upstream_model: row.upstream_model || slug,
    provider_id: row.provider_id,
    transport: row.transport || row.fmt
  });
  return {
    slug,
    model: normalizeModelId(row.upstream_model || slug),
    routeId: row.route_id ?? row.id ?? null,
    providerId: row.provider_id ?? null,
    transport: String(row.transport || row.fmt || "direct"),
    cost: costEst.cost,
    costKnown: costEst.known,
    avgMs: latencyEma,
    latencyEma,
    latencyKnown: latencyEma > 0,
    capable: gate.capable,
    workhorse: isWorkhorseSlug(slug),
    luxury,
    tiny: isTinyModel(slug),
    eligible,
    hardEligible: eligible,
    enabledKeyCount,
    usableKeyCount,
    hasCredential,
    circuitOpen: circuit,
    outputLimit: caps.output || 0,
    contextLimit: caps.unknown ? 0 : caps.context,
    reason,
    posterior,
    key: rk
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
      routeKey: r.key,
      eligible: r.eligible,
      reason: r.reason,
      luxury: r.luxury
    }))
  };
}

// Resolve capability entry preferring the actual upstream model, so a public
// slug that differs from upstream_model does not silently become an
// unknown-capability route.
function resolveEntry(row, overlay, catalogById) {
  const upstream = row.upstream_model || "";
  const slug = row.slug || "";
  return (
    overlay.get(slug) ||
    overlay.get(upstream) ||
    matchEntry(catalogById, upstream) ||
    matchEntry(catalogById, slug) ||
    null
  );
}

export async function loadV2World(c, {
  payload,
  allowed = null,
  excluded = [],
  catalogById = null,
  overlay = new Map(),
  circuitOpen = () => false,
  keyCircuitOpen = null,
  priceResolver = () => null
} = {}) {
  const taskIR = compileTaskIR(payload || {});
  const rows = await c.env.DB.prepare(
    `SELECT mr.id, mr.slug, mr.upstream_model, mr.rank, mr.provider_id, p.fmt, p.transport
     FROM model_routes mr
     JOIN providers p ON p.id=mr.provider_id
     WHERE mr.enabled=1 AND p.enabled=1 AND p.healthy=1`
  ).all();
  // One query for keys, one for stats — no per-route round-trips.
  const keyRows = await c.env.DB.prepare(
    "SELECT id, provider_id FROM provider_keys WHERE enabled=1"
  ).all();
  const enabledKeysByProvider = new Map();
  const usableKeysByProvider = new Map();
  for (const k of keyRows.results || []) {
    const pid = k.provider_id;
    enabledKeysByProvider.set(pid, (enabledKeysByProvider.get(pid) || 0) + 1);
    const dead = keyCircuitOpen ? keyCircuitOpen(k.id) : false;
    if (!dead)
      usableKeysByProvider.set(pid, (usableKeysByProvider.get(pid) || 0) + 1);
  }
  // Task-specific rows are written under scope='route_task'; the global prior
  // under scope='route'. Both must be read here or effectivePosterior never
  // sees task evidence. Split by scope, not task_type: a global row has an
  // empty task_type, a task row carries this request's task.
  const statsRows = await c.env.DB.prepare(
    "SELECT scope, scope_id, task_type, success_alpha, failure_beta, latency_ema, cost_ema, updated_at FROM router_stats WHERE (scope='route' AND task_type='') OR (scope='route_task' AND task_type=?)"
  ).bind(taskIR.task || "").all();
  const globalStats = new Map();
  const taskStats = new Map();
  for (const s of statsRows.results || []) {
    if (s.scope === "route_task")
      taskStats.set(String(s.scope_id), s);
    else
      globalStats.set(String(s.scope_id), s);
  }

  const allow = allowed ? new Set(allowed) : null;
  const skip = new Set((excluded || []).map((s) => String(s)));
  skip.add("auto");
  const world = [];
  for (const r of rows.results || []) {
    if (skip.has(r.slug))
      continue;
    if (allow && !allow.has(r.slug))
      continue;
    const entry = resolveEntry(r, overlay, catalogById);
    const scope = "route:" + r.id;
    world.push({
      id: r.id,
      route_id: r.id,
      slug: r.slug,
      upstream_model: r.upstream_model,
      provider_id: r.provider_id,
      fmt: r.fmt,
      transport: r.transport,
      key_count: enabledKeysByProvider.get(r.provider_id) || 0,
      usable_key_count: usableKeysByProvider.get(r.provider_id) || 0,
      entry,
      price: priceResolver(r.slug, r.provider_id),
      stats: globalStats.get(scope) || null,
      taskStats: taskStats.get(scope) || null,
      circuitOpen: !!(circuitOpen("route", r.id) || circuitOpen("provider", r.provider_id))
    });
  }
  return buildV2Universe(world, payload);
}

function matchEntry(byId, slug) {
  if (!byId || typeof byId.get !== "function")
    return null;
  const want = String(slug || "");
  if (!want)
    return null;
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
