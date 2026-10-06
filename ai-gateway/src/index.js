import { LOGIN_HTML } from "./login.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { PLAYGROUND_HTML } from "./playground.js";
import { callZaiBrowser, callZaiMinted, callZaiWeb, diagnoseZai, isZaiBrowserFormat, isZaiMintedFormat, isZaiWebFormat, modelCatalogEntry, validateZaiWebKey, withRotatedToken, ZaiWebError } from "./zaiweb.js";
import { zaiWaf } from "./zai-waf.js";
import { zaiSessionPoolStatus } from "./zai-session-pool.js";
import { peekDeviceTokens, appendDeviceTokens } from "./zai-tokens.js";
import { zaiCaptchaCacheStatus } from "./zai-captcha-cache.js";
import { planHorizon, renderHorizonState, isTinySlug, usableContextWindow } from "./horizon.js";
import { shadowFromV1, shadowV2, loadV2World, ROUTER_V2_MODE, shouldShadow } from "./router/index.js";
import { compileTaskIR } from "./router/task-ir.js";
import { seedBeta, lcb as betaLcb, observe as betaObserve } from "./router/posterior.js";
import { deriveToolValidFromToolCalls, emitQualityObservations, loadQualityShadow, rebuildQualityStats } from "./router/quality.js";
import { seedModelRegistry, backfillQualityCanonicalIds, loadAliasIndex, resolveCanonicalModel } from "./router/model-registry.js";
import { normalizeTerminalFinishReason } from "../../server/tool-loop-guard.mjs";
import { applyToolRepairPolicyToPayload } from "./tool-repair.js";
import { parseProxyImport } from "./proxy-parse.js";
import { exportVeyDataset } from "./export/vey-serve.js";
import { migrateReflexPosteriors, observePosterior } from "./reflex/posteriors.js";
import { contextLimit, outputLimit, buildCapabilityEnvelope, autoModelEntry, resolveRouteCapabilities } from "./router/capability-envelope.js";
import { contextBucket, deadlineFor, chooseBackup, wouldHedge } from "./router/latency-governor.js";
import { validateRequest as validateDecisionRequest } from "./decision/types.js";
import { startRequestSummary, finishRequestSummary } from "./console/request-ledger.js";
import { callSystemOne, mapSystemOneResponse, isSystemOneFormat, systemOnePath, joinDecisionUrl } from "./decision/providers/systemone.js";
var app = new Hono();
var registrySeededDbs = new WeakSet();
var registrySeedInflight = new WeakMap();
// Idempotent, once per distinct DB handle: the known Z.AI canonical mappings
// must exist for resolveCanonicalModel to resolve x-preview-l/GLM-5.3-Flash etc.
// INSERT OR IGNORE never clobbers operator-authored aliases; failure is logged
// but never blocks serving (unresolved identity falls back to "raw:<upstream>").
// Keyed on the DB handle (not a process global) so a second DB — every test's
// fresh in-memory DB — is seeded independently instead of reusing the first.
async function ensureRegistrySeed(c) {
  const db = c && c.env && c.env.DB;
  if (!db || registrySeededDbs.has(db)) return;
  let inflight = registrySeedInflight.get(db);
  if (!inflight) {
    inflight = seedModelRegistry(c)
      .catch((e) => { blog("registry seed failed: " + String(e && e.message || e)); })
      .then(() => ensureRouteCapabilityColumns(db))
      .then(() => { registrySeededDbs.add(db); })
      .catch((e) => { blog("route capability migration failed: " + String(e && e.message || e)); })
      .finally(() => { registrySeedInflight.delete(db); });
    registrySeedInflight.set(db, inflight);
  }
  await inflight;
}
app.use("/*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  await ensureRegistrySeed(c);
  await next();
});
app.use("/v1/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "x-api-key", "x-request-id", "x-gateway-cache", "x-gateway-cache-ttl", "x-zai-captcha"],
  exposeHeaders: ["x-request-id", "x-gateway-cache", "x-gateway-used-usd", "x-gateway-used-tokens", "x-gateway-route", "x-gateway-attempts", "x-gateway-model", "x-gateway-horizon"]
}));
var encoder = new TextEncoder();
var LOG_BUFFER_MAX = 500;
var logBuffer = [];
function blog(line) {
  const text = String(line);
  console.log(text);
  logBuffer.push({ t: nowIso(), m: text.slice(0, 1000) });
  if (logBuffer.length > LOG_BUFFER_MAX)
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
}
async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(str));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function stableJson(value) {
  if (Array.isArray(value))
    return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}
function cacheablePromptLength(payload) {
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
  let n = 0;
  for (const m of msgs) {
    if (!m)
      continue;
    if (typeof m.content === "string")
      n += m.content.length;
    else if (Array.isArray(m.content))
      for (const part of m.content)
        if (part && typeof part.text === "string")
          n += part.text.length;
  }
  return n;
}
var CACHE_MIN_PROMPT_CHARS = 16;
var CACHE_MAX_PROBE_TOKENS = 8;
function isCacheableRequest(payload, isStream, mode) {
  if (mode !== "true" && mode !== "refresh" && mode !== "loose")
    return false;
  if (!payload)
    return false;
  // Determinism must be explicit. A missing temperature means "provider
  // default", which is not the same as 0, so serving a previous answer would
  // be wrong; only an explicit 0 is cache-safe in normal mode. Loose mode
  // stays an operator opt-in for near-deterministic traffic.
  const temp = payload.temperature;
  const explicitDeterministic = temp !== void 0 && temp !== null && Number(temp) === 0;
  if (mode !== "loose" && !explicitDeterministic)
    return false;
  if (payload.top_p != null && Number(payload.top_p) !== 1)
    return false;
  if (payload.seed != null && !Number.isFinite(Number(payload.seed)))
    return false;
  if (payload.n != null && Number(payload.n) !== 1)
    return false;
  if (hasImageContent(payload))
    return false;
  if (cacheablePromptLength(payload) < CACHE_MIN_PROMPT_CHARS)
    return false;
  if (payload.max_tokens != null && Number(payload.max_tokens) > 0 && Number(payload.max_tokens) <= CACHE_MAX_PROBE_TOKENS)
    return false;
  // Tool/function/search/action turns are not cache-safe: a replayed
  // tool_calls payload can re-execute side effects on the client.
  if (payload.tools || payload.functions || payload.function_call || payload.tool_choice)
    return false;
  if (payload.web_search || payload.web_search_options)
    return false;
  return true;
}
function hasAccumulatedToolCalls(buf) {
  if (!Array.isArray(buf))
    return false;
  for (const tc of buf) {
    if (tc && (tc.id || (tc.function && (tc.function.name || tc.function.arguments))))
      return true;
  }
  return false;
}
function isRetryableTransportError(err) {
  const code = String(err && (err.code || (err.cause && err.cause.code)) || "");
  const msg = String(err && err.message || err || "");
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ECONNABORTED|UND_ERR_SOCKET|UND_ERR_CONNECT|UND_ERR_HEADERS_TIMEOUT)$/i.test(code)
    || /ECONNRESET|UND_ERR_SOCKET|ETIMEDOUT|ECONNREFUSED|socket connection was closed|fetch failed/i.test(msg);
}
function sseUpstreamDisconnect(message) {
  // Priority-zero stream continuity contract: an interrupted stream must
  // terminate with a RECOGNIZED terminal and nothing else on the client wire.
  //
  // The raw upstream exception is never emitted as an SSE data frame: it can
  // carry relay URLs, credentials or internal hostnames, and a client that
  // surfaces it leaks them. Clients key retries off finish_reason, so the
  // terminal chunk alone carries the signal. finish_reason "length" is the
  // OpenAI-recognized non-success terminal — it tells clients the turn did
  // NOT complete cleanly and can be retried. Never "stop": that reads as a
  // successful completion and suppresses retries.
  return "data: " + JSON.stringify({
    id: "gen-interrupted",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "unknown",
    choices: [{ index: 0, delta: {}, finish_reason: "length" }]
  }) + String.fromCharCode(10) + String.fromCharCode(10) + "data: [DONE]" + String.fromCharCode(10) + String.fromCharCode(10);
}
function closeSseGracefully(controller, enc, err) {
  if (!controller)
    return;
  try {
    controller.enqueue(enc.encode(sseUpstreamDisconnect(err && err.message || err)));
  } catch {
  }
  try {
    controller.close();
  } catch {
  }
}
function synthesizeStreamCompletion(chunks) {
  return "data: " + chunks.join("\n\ndata: ") + "\n\ndata: [DONE]\n\n";
}
async function serveCachedCompletion(c, { cached, key, slug, payload, started, state }) {
  const isStream = !!payload.stream;
  if (isStream) {
    try {
      const obj = JSON.parse(cached.response_body);
      const msg = obj && obj.choices && obj.choices[0] && obj.choices[0].message;
      const content = msg && (typeof msg.content === "string" ? msg.content : "") || "";
      const toolCalls = msg && msg.tool_calls;
      const usage = obj.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
      const chunk1 = { id: "cache-" + Date.now(), object: "chat.completion.chunk", created: 0, model: slug, choices: [{ index: 0, delta: { role: "assistant", ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] };
      const chunk2 = { id: "cache-" + Date.now(), object: "chat.completion.chunk", created: 0, model: slug, choices: [{ index: 0, delta: { content } }] };
      const cachedFr = normalizeTerminalFinishReason(
        obj.choices && obj.choices[0] && obj.choices[0].finish_reason,
        !!(toolCalls && toolCalls.length),
        true
      );
      const chunk3 = { id: "cache-" + Date.now(), object: "chat.completion.chunk", created: 0, model: slug, choices: [{ index: 0, delta: {}, ...(cachedFr !== null ? { finish_reason: cachedFr } : {}) }], usage };
      const sse = synthesizeStreamCompletion([JSON.stringify(chunk1), JSON.stringify(chunk2), JSON.stringify(chunk3)]);
      const hdrs = clientResponseHeaders(new Headers(), true);
      hdrs["x-gateway-cache"] = state || "HIT";
      return new Response(sse, { status: 200, headers: hdrs });
    } catch {
      // fall through to non-stream rendering
    }
  }
  const hdrs = clientResponseHeaders(new Headers({ "content-type": "application/json; charset=utf-8" }), false);
  hdrs["x-gateway-cache"] = state || "HIT";
  return new Response(cached.response_body, { status: 200, headers: hdrs });
}
async function responseCacheKey(key, slug, payload) {
  const p = payload || {};
  const trimmed = {
    v: 4,
    messages: p.messages ?? p.input ?? [],
    temperature: p.temperature ?? null,
    max_tokens: p.max_tokens ?? null,
    top_p: p.top_p ?? null,
    stop: p.stop ?? null,
    seed: p.seed ?? null,
    response_format: p.response_format ?? null,
    tools: p.tools ?? null,
    tool_choice: p.tool_choice ?? null,
    functions: p.functions ?? null,
    function_call: p.function_call ?? null,
    reasoning: p.reasoning ?? null,
    reasoning_effort: p.reasoning_effort ?? null,
    presence_penalty: p.presence_penalty ?? null,
    frequency_penalty: p.frequency_penalty ?? null,
    logit_bias: p.logit_bias ?? null,
    parallel_tool_calls: p.parallel_tool_calls ?? null,
    modalities: p.modalities ?? null
  };
  return "rc:c4:" + await sha256hex(String(key.key_id) + "\n" + String(slug) + "\n" + stableJson(trimmed));
}
function isCacheableResponse(text) {
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || body.error || !Array.isArray(body.choices))
      return false;
    for (const ch of body.choices) {
      const msg = ch && ch.message;
      if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length)
        return false;
      if (ch && ch.finish_reason === "tool_calls")
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
function cacheTtlSeconds(c) {
  const requested = Number(c.req.header("x-gateway-cache-ttl") || 3600);
  return Number.isFinite(requested) ? Math.max(60, Math.min(86400, Math.floor(requested))) : 3600;
}
function cacheExpiry(ttl) {
  return new Date(Date.now() + ttl * 1e3).toISOString().replace(".000", "");
}
var RESPONSE_CACHE_LEASE_MS = 12e4;
var RESPONSE_CACHE_WAIT_MS = 15e3;
function cacheLeaseExpiry() {
  return new Date(Date.now() + RESPONSE_CACHE_LEASE_MS).toISOString().replace(".000", "");
}
function cacheCoalesceDelayMs(attempt) {
  return Math.min(800, 75 * 2 ** Math.min(4, Math.max(0, attempt)));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function acquireResponseCacheLease(c, cacheKey) {
  const leaseId = uuid();
  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO response_cache_locks (cache_key, lease_id, expires_at) VALUES (?,?,?)
       ON CONFLICT(cache_key) DO UPDATE SET lease_id=excluded.lease_id, expires_at=excluded.expires_at
       WHERE response_cache_locks.expires_at<=?`
    ).bind(cacheKey, leaseId, cacheLeaseExpiry(), nowIso()).run();
    return Number(result && result.meta && result.meta.changes || 0) === 1 ? { acquired: true, leaseId } : { acquired: false, unavailable: false };
  } catch {
    return { acquired: false, unavailable: true };
  }
}
async function releaseResponseCacheLease(c, cacheKey, leaseId) {
  if (!leaseId)
    return;
  try {
    await c.env.DB.prepare("DELETE FROM response_cache_locks WHERE cache_key=? AND lease_id=?").bind(cacheKey, leaseId).run();
  } catch {
  }
}
function genSessionToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const x of b)
    s += x.toString(16).padStart(2, "0");
  return "v1." + s;
}
function genKey() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const x of b)
    s += x.toString(16).padStart(2, "0");
  return "sk-" + s;
}
function uuid() {
  return crypto.randomUUID();
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(".000", "");
}
function bearerFrom(c) {
  const a = c.req.header("authorization");
  if (a && a.toLowerCase().startsWith("bearer "))
    return a.slice(7).trim();
  return c.req.header("x-api-key") || null;
}
function isOverBudget(key) {
  return key.budget_mode === "usd" ? key.used_usd >= key.budget_limit : key.used_tokens >= key.budget_limit;
}
function normalizeRequestLimit(value) {
  if (value === void 0 || value === null || value === "")
    return null;
  const n = Number(value);
  if (n === 0)
    return null;
  if (!Number.isInteger(n) || n < 1)
    throw new Error("request_limit_per_minute must be a positive integer or 0 for unlimited");
  return n;
}
function normalizeKeyExpiry(value, nowMs = Date.now()) {
  const text = String(value == null ? "" : value).trim();
  if (!text)
    return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new Error("expires_at must be a valid ISO timestamp with timezone");
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms))
    throw new Error("expires_at must be a valid ISO timestamp with timezone");
  if (ms <= nowMs)
    throw new Error("expires_at must be in the future");
  return new Date(ms).toISOString().replace(".000", "");
}
function isKeyExpired(key, at = nowIso()) {
  return !!(key && key.expires_at && String(key.expires_at) <= at);
}
var MODEL_LIMIT_KINDS = ["requests", "tokens", "usd"];
var MODEL_LIMIT_PERIODS = ["minute", "day", "week", "month"];
var GATEWAY_TZ = "Asia/Dubai";
var GATEWAY_TZ_OFFSET_MIN = 240; // GST = UTC+4, fixed (no DST)
function gatewayLocalDate(now = /* @__PURE__ */ new Date()) {
  return new Date(now.getTime() + GATEWAY_TZ_OFFSET_MIN * 60000);
}
function periodBucket(period, now = /* @__PURE__ */ new Date()) {
  const local = gatewayLocalDate(now);
  const iso = local.toISOString();
  if (period === "minute")
    return iso.slice(0, 16);
  if (period === "week") {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  if (period === "month")
    return iso.slice(0, 7);
  return iso.slice(0, 10);
}
async function enforceModelLimits(c, slug) {
  const limits = await c.env.DB.prepare("SELECT kind, period, limit_value FROM model_limits WHERE slug=?").bind(slug).all();
  if (!limits.results || !limits.results.length)
    return null;
  for (const lim of limits.results) {
    const cap = Number(lim.limit_value) || 0;
    if (cap <= 0)
      continue;
    const kind = lim.kind;
    if (kind === "requests" && lim.period === "minute") {
      const now = /* @__PURE__ */ new Date();
      const bucket = periodBucket("minute", now);
      const expiresAt = new Date(now.getTime() + 2 * 60 * 1e3).toISOString().replace(".000", "");
      const row = await c.env.DB.prepare(
        `INSERT INTO model_rate_windows (slug, bucket, request_count, expires_at) VALUES (?,?,1,?)
         ON CONFLICT(slug,bucket) DO UPDATE SET request_count=request_count+1
         RETURNING request_count`
      ).bind(slug, bucket, expiresAt).first();
      if (Number(row && row.request_count) > cap)
        return c.json({ error: { message: 'Model "' + slug + '" is rate limited (' + cap + " req/min). Retry shortly.", type: "model_rate_limited" } }, 429, { "retry-after": String(60 - now.getUTCSeconds()) });
      continue;
    }
    const used = await periodUsage(c, slug, kind, lim.period);
    if (used >= cap)
      return c.json({ error: { message: 'Model "' + slug + '" hit its ' + kind + " limit for this " + lim.period + " (" + Math.round(used * 10000) / 10000 + " / " + cap + "). Resets " + lim.period + "ly at midnight GST.", type: "model_budget_exceeded" } }, 429);
  }
  return null;
}
// UTC instant of the period start in Dubai local time (caps reset at
// Dubai midnight, weeks Monday GST, months on the 1st GST).
function periodStartUtcIso(period, now = /* @__PURE__ */ new Date()) {
  const local = gatewayLocalDate(now);
  let y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
  if (period === "week")
    d -= (local.getUTCDay() + 6) % 7;
  if (period === "month")
    d = 1;
  return new Date(Date.UTC(y, m, d) - GATEWAY_TZ_OFFSET_MIN * 60000).toISOString();
}
// Live usage for a slug/kind/period straight from per-request trajectories,
// so caps count everything captured this period - including spend from
// before the limit was set. Cache hits are free and excluded.
async function periodUsage(c, slug, kind, period) {
  const start = periodStartUtcIso(period);
  if (kind === "requests") {
    const row = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM trajectories WHERE slug=? AND created_at>=? AND cache_state IS NULL"
    ).bind(slug, start).first();
    return Number(row && row.n) || 0;
  }
  const col = kind === "tokens" ? "total_tokens" : "cost_usd";
  const row = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(" + col + "),0) AS v FROM trajectories WHERE slug=? AND created_at>=? AND cache_state IS NULL"
  ).bind(slug, start).first();
  return Number(row && row.v) || 0;
}
async function recordModelUsage(c, slug, tokens, costUsd) {
  if (!slug)
    return;
  const now = /* @__PURE__ */ new Date();
  const entries = [["tokens", tokens || 0], ["usd", costUsd || 0]];
  for (const [kind, value] of entries) {
    if (!(value > 0))
      continue;
    const bucket = periodBucket("day", now);
    try {
      await c.env.DB.prepare(
        `INSERT INTO model_usage (slug, kind, bucket, value) VALUES (?,?,?,?)
         ON CONFLICT(slug,kind,bucket) DO UPDATE SET value=value+excluded.value`
      ).bind(slug, kind, bucket, value).run();
    } catch (e) {
      blog("MODEL_USAGE record failed: " + String(e.message || e));
    }
  }
}
async function modelLimitStatus(c) {
  const rows = await c.env.DB.prepare(
    "SELECT slug, kind, period, limit_value FROM model_limits ORDER BY slug, period, kind"
  ).all();
  const out = [];
  for (const row of rows.results || []) {
    const used = await periodUsage(c, row.slug, row.kind, row.period);
    const limit = Number(row.limit_value) || 0;
    out.push({
      slug: String(row.slug),
      kind: String(row.kind),
      period: String(row.period),
      limit,
      used,
      remaining: Math.max(0, limit - used)
    });
  }
  return out;
}

async function enforceRequestLimit(c, key) {
  const limit = normalizeRequestLimit(key.request_limit_per_minute);
  if (!limit)
    return null;
  const now = /* @__PURE__ */ new Date();
  const bucket = now.toISOString().slice(0, 16);
  const expiresAt = new Date(now.getTime() + 2 * 60 * 1e3).toISOString().replace(".000", "");
  const row = await c.env.DB.prepare(
    `INSERT INTO api_key_rate_windows (key_id, bucket, request_count, expires_at) VALUES (?,?,1,?)
     ON CONFLICT(key_id,bucket) DO UPDATE SET request_count=request_count+1
     RETURNING request_count`
  ).bind(key.key_id, bucket, expiresAt).first();
  if (Number(row && row.request_count) > limit) {
    return c.json({ error: { message: "Request rate limit exceeded. Retry in the next minute.", type: "rate_limit_exceeded" } }, 429, { "retry-after": String(60 - now.getUTCSeconds()) });
  }
  return null;
}
function fmt(n) {
  return Number(n).toLocaleString(void 0, { maximumFractionDigits: 6 });
}
function bytesToB64url(bytes) {
  let s = "";
  for (const b of bytes)
    s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlToBytes(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const s = atob(b64);
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}
async function providerCryptoKey(env, legacyAdminKey = false) {
  const secret = legacyAdminKey ? env.ADMIN_TOKEN : env.PROVIDER_CRYPTO_KEY || env.ADMIN_TOKEN;
  if (!secret)
    throw new Error("provider encryption unavailable");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode("provider-key-v1:" + secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function sealProviderKey(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await providerCryptoKey(env), encoder.encode(value));
  return "enc:v1:" + bytesToB64url(iv) + "." + bytesToB64url(new Uint8Array(ct));
}
async function openProviderKey(env, value, legacyAdminKey = false) {
  const parts = String(value).split(":");
  if (parts.length !== 3 || parts[0] !== "enc" || parts[1] !== "v1")
    throw new Error("invalid provider key envelope");
  const pair = parts[2].split(".");
  if (pair.length !== 2)
    throw new Error("invalid provider key envelope");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlToBytes(pair[0]) }, await providerCryptoKey(env, legacyAdminKey), b64urlToBytes(pair[1]));
  return new TextDecoder().decode(plain);
}
// ---- Provider keys: multiple per provider with rotation ----
var KEY_STRATEGIES = ["round_robin", "failover", "random"];
var rrCounters = new Map();
async function openProviderEnvelope(c, env2, stored, rowId) {
  if (String(stored).startsWith("enc:v1:")) {
    try {
      return await openProviderKey(env2, stored);
    } catch (e) {
      if (!env2.PROVIDER_CRYPTO_KEY || !env2.ADMIN_TOKEN)
        throw e;
      const legacyPlain = await openProviderKey(env2, stored, true);
      await c.env.DB.prepare("UPDATE provider_keys SET api_key=? WHERE id=?").bind(await sealProviderKey(env2, legacyPlain), rowId).run();
      return legacyPlain;
    }
  }
  const plain = String(stored);
  await c.env.DB.prepare("UPDATE provider_keys SET api_key=? WHERE id=?").bind(await sealProviderKey(env2, plain), rowId).run();
  return plain;
}
async function providerKeys(c, providerId) {
  try {
    const rows = await c.env.DB.prepare("SELECT id, api_key, label FROM provider_keys WHERE provider_id=? AND enabled=1 ORDER BY id").bind(providerId).all();
    const out = [];
    for (const r of rows.results || []) {
      if (!r.api_key)
        continue;
      try {
        out.push({ keyId: r.id, label: r.label || "key-" + r.id, key: await openProviderEnvelope(c, c.env, r.api_key, r.id) });
      } catch (e) {
        blog("PROVIDER_KEY unavailable provider=" + providerId + " row=" + r.id + ": " + String(e.message || e));
      }
    }
    return out;
  } catch {
    return [];
  }
}
// Returns an ORDERED preference list, never a single key: the caller walks it
// so a dead credential falls through to the next one instead of failing the
// request. round_robin rotates which key leads; random shuffles; failover
// keeps declaration order.
function orderKeys(keys, strategy, providerId) {
  if (!keys.length)
    return [];
  if (strategy === "random") {
    const shuffled = keys.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
  if (strategy === "round_robin") {
    const n = rrCounters.get(providerId) || 0;
    rrCounters.set(providerId, n + 1);
    const start = n % keys.length;
    return keys.slice(start).concat(keys.slice(0, start));
  }
  return keys.slice(); // failover: all keys in configured order
}
// Rewrites one provider secret in place. Used when an upstream hands back a
// rotated session credential (chat.z.ai) so the stored key never goes stale.
async function updateProviderKeySecret(c, keyRowId, value) {
  try {
    const sealed = await sealProviderKey(c.env, value);
    await c.env.DB.prepare("UPDATE provider_keys SET api_key=? WHERE id=?").bind(sealed, keyRowId).run();
    blog("PROVIDER_KEY rotated row=" + keyRowId);
  } catch (e) {
    blog("PROVIDER_KEY rotate failed row=" + keyRowId + ": " + String(e.message || e));
  }
}
async function providerKey(c, id) {
  const keys = await providerKeys(c, id);
  if (!keys.length)
    return null;
  let strategy = "round_robin";
  try {
    const row = await c.env.DB.prepare("SELECT key_strategy FROM providers WHERE id=?").bind(id).first();
    if (row && row.key_strategy)
      strategy = String(row.key_strategy);
  } catch {
  }
  const ordered = orderKeys(keys, strategy, id);
  return ordered.length ? ordered[0].key : null;
}
function adminToken(c) {
  const a = c.req.header("authorization");
  if (a && a.toLowerCase().startsWith("bearer "))
    return a.slice(7).trim();
  const ck = c.req.header("cookie") || "";
  const m = ck.match(/(?:^|;\s*)gw_adm=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
async function isAdmin(c) {
  const t = adminToken(c);
  if (!t)
    return false;
  if (t.startsWith("v1.")) {
    const h2 = await sha256hex(t);
    const row2 = await c.env.DB.prepare("SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires_at>?").bind(h2, nowIso()).first();
    return !!row2;
  }
  const h = await sha256hex(t);
  if (c.env.ADMIN_TOKEN && await sha256hex(c.env.ADMIN_TOKEN) === h)
    return true;
  const row = await c.env.DB.prepare("SELECT 1 FROM admin_tokens WHERE token_hash=?").bind(h).first();
  return !!row;
}
async function checkAdminPassword(password, env) {
  const secret = env && env.ADMIN_TOKEN || (typeof ADMIN_TOKEN !== "undefined" ? ADMIN_TOKEN : null);
  if (!password || !secret)
    return false;
  return await sha256hex(password) === await sha256hex(secret);
}
async function allowAdminLoginAttempt(c) {
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const ipHash = await sha256hex("admin-login:" + ip);
  const cutoff = new Date(Date.now() - 15 * 60 * 1e3).toISOString();
  await c.env.DB.prepare("DELETE FROM admin_login_attempts WHERE created_at < ?").bind(cutoff).run();
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM admin_login_attempts WHERE ip_hash=? AND created_at >= ?").bind(ipHash, cutoff).first();
  if (Number(row && row.n || 0) >= 8)
    return false;
  await c.env.DB.prepare("INSERT INTO admin_login_attempts (ip_hash, created_at) VALUES (?,?)").bind(ipHash, nowIso()).run();
  return true;
}
async function requireAdmin(c) {
  if (!await isAdmin(c))
    return c.json({ error: { message: "Admin authentication required", type: "auth_error" } }, 401);
  return null;
}
app.get("/", (c) => c.json({
  service: "ai-gateway",
  note: "OpenAI-compatible API. Endpoints: /v1/models, /v1/chat/completions, /health."
}));
app.get("/health", (c) => c.json({ ok: true }));
app.get("/v1/models", async (c) => {
  const auth = await authClient(c);
  if (auth instanceof Response)
    return auth;
  const { key } = auth;
  const allowed = await allowedSlugs(c, key);
  if (!allowed.length)
    return c.json({ object: "list", data: [] });
  // Only advertise slugs that can actually be served right now: a slug whose
  // providers are all disabled or all marked down would 503 on use, which is
  // exactly the "client picked a model that fails" trap.
  const routes = await c.env.DB.prepare(
    "SELECT mr.id AS route_id, mr.slug, mr.provider_id, mr.upstream_model, mr.model_kind, mr.wire_format, mr.context_limit_override, mr.output_limit_override, p.fmt FROM model_routes mr JOIN providers p ON p.id=mr.provider_id WHERE mr.enabled=1 AND p.enabled=1 AND p.healthy=1 AND mr.slug IN (" + allowed.map(() => "?").join(",") + ") ORDER BY mr.slug, mr.rank"
  ).bind(...allowed).all();
  const live = [];
  const liveSlugs = new Set();
  const decisionSlugs = new Map();
  for (const r of routes.results || []) {
    if (circuitOpen("route:" + String(r.route_id)))
      continue;
    // A decision model is a real model, advertised on its own endpoint, and
    // it is never part of the chat capability envelope or the Auto pool.
    if (effectiveModelKind(r) === "decision") {
      if (!decisionSlugs.has(r.slug))
        decisionSlugs.set(r.slug, { route_id: r.route_id, upstream_model: r.upstream_model, wire_format: r.wire_format, fmt: r.fmt });
      continue;
    }
    live.push(r);
    liveSlugs.add(r.slug);
  }
  const data = [];
  // Computed for every chat slug, not only when Auto is on: clients discover
  // models here, and a slug with no advertised output ceiling reads as
  // "output limit 0" to them.
  if (!modelsDevCache.catalog)
    await fetchModelsDevCatalog().catch(() => {});
  const catalog = modelsDevCache.catalog;
  const byId = catalog ? flattenModelsDevCatalog(catalog) : null;
  const canonicalByRoute = await canonicalLimitsForRoutes(c, live);
  const cfg = await autoSettings(c);
  if (cfg.enabled && live.length) {
    const envelope = buildCapabilityEnvelope(live.map((r) => {
      const entry = capabilityEntryForRoute(r, byId, canonicalByRoute.get(r.route_id));
      const caps = entryCapabilities(entry);
      return {
        providerId: r.provider_id,
        context: contextLimit(caps),
        output: caps.output,
        tools: !!caps.tools,
        vision: !!caps.vision,
        reasoning: !!(entry && entry.reasoning)
      };
    }));
    data.push(autoModelEntry(envelope));
  }
  const chatBySlug = new Map();
  for (const route of live)
    if (!chatBySlug.has(route.slug))
      chatBySlug.set(route.slug, route);
  for (const [slug, route] of [...chatBySlug.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
    const entry = capabilityEntryForRoute(route, byId, canonicalByRoute.get(route.route_id));
    const caps = entryCapabilities(entry);
    data.push({
      id: slug,
      object: "model",
      created: 0,
      owned_by: "gateway",
      model_kind: "chat",
      endpoint: "/v1/chat/completions",
      context_window: contextLimit(caps),
      max_output_tokens: outputLimit(caps),
      capabilities: {
        streaming: true,
        tools: !!caps.tools,
        vision: !!caps.vision,
        reasoning: !!(entry && entry.reasoning)
      }
    });
  }
  for (const [slug, info] of [...decisionSlugs.entries()].sort())
    data.push({
      id: slug,
      object: "model",
      created: 0,
      owned_by: "gateway",
      model_kind: "decision",
      protocol: String(info.wire_format || info.fmt || "systemone"),
      endpoint: "/v1/systemone",
      upstream_model: info.upstream_model,
      capabilities: { choice: true, score: true, noul: true }
    });
  return c.json({ object: "list", data });
});
app.get("/status", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const provs = await c.env.DB.prepare("SELECT * FROM providers ORDER BY priority").all();
  const status = [];
  for (const p of provs.results || []) {
    // A disabled provider is out of rotation on purpose: do not probe it (that
    // costs an upstream call and a key decrypt per poll) and do not decrypt its
    // key. It still appears, so the console can explain why it is dark.
    const row = {
      id: p.id,
      name: p.name,
      base_url: p.base_url,
      priority: p.priority,
      fmt: p.fmt,
      enabled: p.enabled === void 0 ? true : !!p.enabled,
      healthy_flag: !!p.healthy,
      last_status: p.last_status,
      ok: false,
      error: null
    };
    if (!row.enabled) {
      row.error = "disabled (out of rotation)";
      status.push(row);
      continue;
    }
    const key = await providerKey(c, p.id);
    let ok = false, code = null, err = null;
    if (!key) {
      err = "no key configured (PROVIDER_" + p.id + "_KEY)";
    } else {
      try {
        const r = await fetch(p.base_url + "/models", {
          headers: { Authorization: "Bearer " + key },
          signal: AbortSignal.timeout(5000)
        });
        code = r.status;
        ok = r.ok;
      } catch (e) {
        err = String(e.message || e);
      }
    }
    row.last_status = code;
    row.ok = ok;
    row.error = err;
    status.push(row);
  }
  const routes = await c.env.DB.prepare(
    "SELECT mr.slug, mr.rank, mr.upstream_model, mr.enabled, p.name AS provider, p.healthy, p.enabled AS provider_enabled FROM model_routes mr JOIN providers p ON p.id=mr.provider_id ORDER BY mr.slug, mr.rank"
  ).all();
  return c.json({ providers: status, routes: routes.results || [] });
});
app.post("/v1/chat/completions", async (c) => {
  await ensureUpstreamDispatcher();
  const auth = await authClient(c);
  if (auth instanceof Response)
    return auth;
  return runChatCompletion(c, auth.key, false);
});
app.post("/admin/playground/completions", async (c) => {
  await ensureUpstreamDispatcher();
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  return runChatCompletion(c, null, true);
});
// ---------------------------------------------------------------------------
// Client console: a separate product at /console. The admin UI stays the
// operator cockpit; this surface belongs to API-key holders. Sessions are an
// HttpOnly cookie exchanged once for the key, which the browser never stores.
const CONSOLE_COOKIE = "gw_client";
const CONSOLE_SESSION_HOURS = 24;

async function consoleSessionFromCookie(c) {
  const raw = c.req.header("cookie") || "";
  const m = raw.match(/(?:^|;\\s*)gw_client=([^;]+)/);
  if (!m) return null;
  const h = await sha256hex(decodeURIComponent(m[1]));
  try {
    const row = await c.env.DB.prepare(
      "SELECT s.key_id, s.expires_at FROM console_sessions s WHERE s.token_hash=? AND s.expires_at>?"
    ).bind(h, nowIso()).first();
    if (!row) return null;
    const key = await c.env.DB.prepare("SELECT key_id, name, account_id FROM api_keys WHERE key_id=? AND active=1").bind(row.key_id).first();
    if (key) {
      // Which account this key belongs to: it is either owned by one (the key
      // carries account_id) or it IS the account's own key in the legacy 1:1
      // shape, where console_accounts.key_id is the key itself.
      let accountId = key.account_id || null;
      if (!accountId) {
        const own = await c.env.DB.prepare("SELECT key_id FROM console_accounts WHERE key_id=?").bind(key.key_id).first();
        if (own) accountId = key.key_id;
      }
      return { keyId: key.key_id, name: key.name, accountId };
    }
    const account = await c.env.DB.prepare("SELECT key_id, username FROM console_accounts WHERE key_id=?").bind(row.key_id).first();
    if (account)
      return { keyId: null, name: account.username, accountId: account.key_id };
    return null;
  } catch (e) {
    console.warn("[gateway] console session read failed: " + String(e && e.message || e));
    return null;
  }
}

async function requireConsoleSession(c) {
  const sess = await consoleSessionFromCookie(c);
  if (!sess)
    return { denied: c.json({ error: { message: "Sign in with an API key to use the console.", type: "auth_error" } }, 401) };
  return { sess };
}

app.post("/console/auth", async (c) => {
  let b;
  try { b = await c.req.json(); } catch { b = {}; }
  await ensureConsoleAuthColumn(c.env.DB);
  const offered = String((b && b.api_key) || "");
  const username = String((b && b.username) || "").trim();
  const password = String((b && b.password) || "");

  // Returning users sign in with the account they set up: username + password,
  // no key. An invite-created account has no backing key yet; the session
  // still belongs to the account, and keys come later from the console.
  if (!offered && username && password) {
    const account = await c.env.DB.prepare("SELECT key_id, username, password_hash FROM console_accounts WHERE username=?").bind(username).first();
    if (!account || await sha256hex(password) !== account.password_hash)
      return c.json({ error: { message: "That username or password was not accepted.", type: "auth_error" } }, 401);
    const acctKey = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(account.key_id).first();
    if (acctKey) {
      if (await isSharedPoolKey(c, account.key_id))
        return c.json({ error: { message: "The shared pool key cannot sign in to the console.", type: "auth_error" } }, 403);
      if (!acctKey.active || isKeyExpired(acctKey))
        return c.json({ error: { message: "The key behind this account is no longer active.", type: "auth_error" } }, 401);
      return issueConsoleSession(c, acctKey);
    }
    return issueAccountSession(c, account);
  }

  // First contact is by key. A key with account auth off signs straight in;
  // otherwise it either has no account yet (setup) or must present one.
  if (!offered.startsWith("sk-"))
    return c.json({ error: { message: "Enter your API key, or sign in with your username and password.", type: "auth_error" } }, 401);
  const key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(offered).first();
  if (!key || !key.active || isKeyExpired(key))
    return c.json({ error: { message: "That key was not accepted.", type: "auth_error" } }, 401);
  // The shared pool key is meant to be handed around for /v1 use; it must never
  // grant a console session or an account.
  if (await isSharedPoolKey(c, key.key_id))
    return c.json({ error: { message: "The shared pool key cannot sign in to the console.", type: "auth_error" } }, 403);
  if (isOverBudget(key))
    return c.json({ error: { message: "Key budget exceeded.", type: "budget_exceeded" } }, 429);
  // A key minted by an account belongs to that account, so presenting it must
  // not hand over a console session on its own: a service key would then expose
  // every other key the account holds. It resolves to the account and asks for
  // that account's credentials, the same shape a legacy key already has.
  if (key.account_id) {
    const owner = await c.env.DB.prepare("SELECT key_id, username, password_hash FROM console_accounts WHERE key_id=?").bind(key.account_id).first();
    if (owner) {
      if (!username || !password)
        return c.json({ account: true, username: owner.username });
      if (username !== owner.username || await sha256hex(password) !== owner.password_hash)
        return c.json({ error: { message: "That username or password was not accepted.", type: "auth_error" } }, 401);
      return issueAccountSession(c, owner);
    }
  }
  if (Number(key.console_auth) === 0)
    return issueConsoleSession(c, key);
  const account = await c.env.DB.prepare("SELECT username, password_hash FROM console_accounts WHERE key_id=?").bind(key.key_id).first();
  if (!account)
    return c.json({ setup: true });
  if (!username || !password)
    return c.json({ account: true, username: account.username });
  if (username !== account.username || await sha256hex(password) !== account.password_hash)
    return c.json({ error: { message: "That username or password was not accepted.", type: "auth_error" } }, 401);
  return issueConsoleSession(c, key);
});

app.post("/console/account", async (c) => {
  let b;
  try { b = await c.req.json(); } catch { b = {}; }
  const offered = String(b.api_key || "");
  const username = String(b.username || "").trim();
  const password = String(b.password || "");
  if (!offered.startsWith("sk-") || username.length < 3 || password.length < 8)
    return c.json({ error: { message: "Choose a username of 3 or more characters and a password of 8 or more.", type: "invalid_request_error" } }, 400);
  const key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=? AND active=1").bind(offered).first();
  if (!key) return c.json({ error: { message: "That key was not accepted.", type: "auth_error" } }, 401);
  if (await isSharedPoolKey(c, key.key_id))
    return c.json({ error: { message: "The shared pool key cannot have a console account.", type: "invalid_request_error" } }, 403);
  const existing = await c.env.DB.prepare("SELECT key_id FROM console_accounts WHERE key_id=?").bind(key.key_id).first();
  if (existing) return c.json({ error: { message: "This key already has an account.", type: "invalid_request_error" } }, 409);
  try {
    await c.env.DB.prepare("INSERT INTO console_accounts (key_id, username, password_hash, created_at) VALUES (?,?,?,?)").bind(key.key_id, username, await sha256hex(password), nowIso()).run();
  } catch {
    return c.json({ error: { message: "That username is already taken.", type: "invalid_request_error" } }, 409);
  }
  return issueConsoleSession(c, key);
});
// console_account_tokens is new; existing host databases add it lazily. Same
// idempotent shape as the other console migrations, keyed per DB handle.
var accountTokensMigrated = new WeakSet();
async function ensureAccountTokensTable(db) {
  if (!db || accountTokensMigrated.has(db)) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS console_account_tokens (token_hash TEXT PRIMARY KEY, key_id TEXT NOT NULL, purpose TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, budget_mode TEXT, budget_limit REAL, tier_ids TEXT)"
  ).run();
  const tokenCols = await db.prepare("PRAGMA table_info(console_account_tokens)").all();
  const tokenNames = new Set((tokenCols.results || []).map((r) => r.name));
  if (!tokenNames.has("budget_mode"))
    await db.prepare("ALTER TABLE console_account_tokens ADD COLUMN budget_mode TEXT").run();
  if (!tokenNames.has("budget_limit"))
    await db.prepare("ALTER TABLE console_account_tokens ADD COLUMN budget_limit REAL").run();
  if (!tokenNames.has("tier_ids"))
    await db.prepare("ALTER TABLE console_account_tokens ADD COLUMN tier_ids TEXT").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_account_tokens_key ON console_account_tokens(key_id, purpose)").run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS console_account_tiers (key_id TEXT NOT NULL REFERENCES console_accounts(key_id) ON DELETE CASCADE, tier_id INTEGER NOT NULL REFERENCES model_tiers(id) ON DELETE CASCADE, PRIMARY KEY (key_id, tier_id))"
  ).run();
  const cols = await db.prepare("PRAGMA table_info(console_accounts)").all();
  const names = new Set((cols.results || []).map((r) => r.name));
  if (!names.has("budget_mode"))
    await db.prepare("ALTER TABLE console_accounts ADD COLUMN budget_mode TEXT NOT NULL DEFAULT 'usd'").run();
  if (!names.has("budget_limit"))
    await db.prepare("ALTER TABLE console_accounts ADD COLUMN budget_limit REAL").run();
  if (!names.has("used_usd"))
    await db.prepare("ALTER TABLE console_accounts ADD COLUMN used_usd REAL NOT NULL DEFAULT 0").run();
  if (!names.has("used_tokens"))
    await db.prepare("ALTER TABLE console_accounts ADD COLUMN used_tokens INTEGER NOT NULL DEFAULT 0").run();
  const keyCols = await db.prepare("PRAGMA table_info(api_keys)").all();
  const keyNames = new Set((keyCols.results || []).map((r) => r.name));
  if (!keyNames.has("account_id"))
    await db.prepare("ALTER TABLE api_keys ADD COLUMN account_id TEXT REFERENCES console_accounts(key_id) ON DELETE CASCADE").run();
  accountTokensMigrated.add(db);
}

// A reset or invite token authorizes one credential change. The plaintext is
// returned exactly once, at creation, so the operator can copy it to the user;
// only its hash is stored. Redemption marks the row used, which makes a copied
// link die after one use and lets the operator see whether it was taken.
const RESET_TOKEN_HOURS = 24;
async function issueAccountToken(c, keyId, purpose, extra) {
  const raw = "rst_" + uuid() + uuid().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_HOURS * 3600000).toISOString();
  const payload = extra || {};
  await c.env.DB.prepare(
    "INSERT INTO console_account_tokens (token_hash, key_id, purpose, created_at, expires_at, budget_mode, budget_limit, tier_ids) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(await sha256hex(raw), keyId, purpose, nowIso(), expiresAt, payload.budget_mode || null, payload.budget_limit == null ? null : payload.budget_limit, payload.tier_ids || null).run();
  return { token: raw, expires_at: expiresAt };
}

// Redeem a token: it must exist, be unused, and not be expired. A used or
// expired token is reported the same way as an unknown one so a stale link
// reveals nothing about which state it is in. Returns the owning key.
async function redeemAccountToken(c, raw) {
  if (typeof raw !== "string" || !raw.startsWith("rst_")) return null;
  const row = await c.env.DB.prepare(
    "SELECT key_id, purpose, used_at, expires_at, budget_mode, budget_limit, tier_ids FROM console_account_tokens WHERE token_hash=?"
  ).bind(await sha256hex(raw)).first();
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

// Public: set or reset credentials from a link. A reset link belongs to a key
// that already has an account and replaces its password; an invite link
// creates the account. Both issue a console session, so the user lands inside
// the console without a second sign-in.
app.post("/console/redeem-api", async (c) => {
  await ensureAccountTokensTable(c.env.DB);
  let b;
  try { b = await c.req.json(); } catch { b = {}; }
  const raw = String((b && b.token) || "");
  const username = String((b && b.username) || "").trim();
  const password = String((b && b.password) || "");
  const info = await redeemAccountToken(c, raw);
  if (!info)
    return c.json({ error: { message: "This link is not valid or has expired.", type: "auth_error" } }, 401);
  if (username.length < 3 || password.length < 8)
    return c.json({ error: { message: "Choose a username of 3 or more characters and a password of 8 or more.", type: "invalid_request_error" } }, 400);
  if (info.purpose === "invite" && String(info.key_id).startsWith("acct_")) {
    const existing = await c.env.DB.prepare("SELECT key_id FROM console_accounts WHERE key_id=?").bind(info.key_id).first();
    if (existing)
      return c.json({ error: { message: "This invite was already used.", type: "invalid_request_error" } }, 409);
    try {
      await c.env.DB.prepare(
        "INSERT INTO console_accounts (key_id, username, password_hash, created_at, budget_mode, budget_limit) VALUES (?,?,?,?,?,?)"
      ).bind(info.key_id, username, await sha256hex(password), nowIso(), info.budget_mode || "usd", info.budget_limit).run();
    } catch {
      return c.json({ error: { message: "That username is already taken.", type: "invalid_request_error" } }, 409);
    }
    for (const tierId of String(info.tier_ids || "").split(",").filter(Boolean))
      await c.env.DB.prepare("INSERT OR IGNORE INTO console_account_tiers (key_id, tier_id) VALUES (?,?)").bind(info.key_id, Number(tierId)).run();
    await c.env.DB.prepare("UPDATE console_account_tokens SET used_at=? WHERE token_hash=?").bind(nowIso(), await sha256hex(raw)).run();
    return issueAccountSession(c, { key_id: info.key_id });
  }
  const key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(info.key_id).first();
  if (!key || !key.active || isKeyExpired(key))
    return c.json({ error: { message: "The key behind this account is no longer active.", type: "auth_error" } }, 401);
  if (await isSharedPoolKey(c, key.key_id))
    return c.json({ error: { message: "The shared pool key cannot have a console account.", type: "invalid_request_error" } }, 403);
  if (info.purpose === "reset") {
    await c.env.DB.prepare(
      "UPDATE console_accounts SET password_hash=? WHERE key_id=?"
    ).bind(await sha256hex(password), key.key_id).run();
  } else {
    const existing = await c.env.DB.prepare("SELECT key_id FROM console_accounts WHERE key_id=?").bind(key.key_id).first();
    if (existing)
      return c.json({ error: { message: "This key already has an account.", type: "invalid_request_error" } }, 409);
    try {
      await c.env.DB.prepare(
        "INSERT INTO console_accounts (key_id, username, password_hash, created_at) VALUES (?,?,?,?)"
      ).bind(key.key_id, username, await sha256hex(password), nowIso()).run();
    } catch {
      return c.json({ error: { message: "That username is already taken.", type: "invalid_request_error" } }, 409);
    }
  }
  await c.env.DB.prepare("UPDATE console_account_tokens SET used_at=? WHERE token_hash=?").bind(nowIso(), await sha256hex(raw)).run();
  await c.env.DB.prepare("DELETE FROM console_sessions WHERE key_id=?").bind(key.key_id).run();
  return issueConsoleSession(c, key);
});

// Public probe: tells the sign-in page what a link is for (existing account to
// reset, or a fresh invite) so it renders the right form. Nothing about the
// key beyond that is exposed.
app.get("/console/redeem-api", async (c) => {
  await ensureAccountTokensTable(c.env.DB);
  const raw = String(c.req.query("token") || "");
  const info = await redeemAccountToken(c, raw);
  if (!info)
    return c.json({ valid: false });
  const account = await c.env.DB.prepare("SELECT username FROM console_accounts WHERE key_id=?").bind(info.key_id).first();
  return c.json({ valid: true, purpose: info.purpose, has_account: !!account, username: account ? account.username : "" });
});

async function issueConsoleSession(c, key) {
  return issueSessionCookie(c, key.key_id);
}

// An invite-created account has no api_keys row. The session stores the
// account id in console_sessions.key_id; the cookie reader tells the two
// apart by looking the row up in console_accounts when no key exists.
async function issueAccountSession(c, account) {
  return issueSessionCookie(c, account.key_id);
}

async function issueSessionCookie(c, ownerId) {
  const session = "v1." + uuid() + uuid().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + CONSOLE_SESSION_HOURS * 3600000).toISOString();
  await c.env.DB.prepare("DELETE FROM console_sessions WHERE expires_at <= ?").bind(nowIso()).run();
  await c.env.DB.prepare("INSERT INTO console_sessions (token_hash, key_id, expires_at, created_at) VALUES (?,?,?,?)").bind(await sha256hex(session), ownerId, expiresAt, nowIso()).run();
  c.header("Set-Cookie", CONSOLE_COOKIE + "=" + encodeURIComponent(session) + "; Path=/console; Max-Age=" + (CONSOLE_SESSION_HOURS * 3600) + "; SameSite=Lax; HttpOnly");
  return c.json({ ok: true });
}

async function ensureConsoleAuthColumn(db) {
  if (!db || ensureConsoleAuthColumn.done) return;
  try {
    const cols = await db.prepare("PRAGMA table_info(api_keys)").all();
    const names = new Set((cols.results || []).map((r) => r.name));
    if (!names.has("console_auth"))
      await db.prepare("ALTER TABLE api_keys ADD COLUMN console_auth INTEGER NOT NULL DEFAULT 1").run();
    if (!names.has("response_cache"))
      await db.prepare("ALTER TABLE api_keys ADD COLUMN response_cache INTEGER NOT NULL DEFAULT 1").run();
    ensureConsoleAuthColumn.done = true;
  } catch {}
}

// Routes created before per-route clamps existed have no override columns.
// NULL is the meaningful default — it means "inherit the canonical limit" — so
// the columns are added without a value rather than a zero, which would read
// as "this transport can produce nothing".
var routeCapabilityMigrated = new WeakSet();
async function ensureRouteCapabilityColumns(db) {
  if (!db || routeCapabilityMigrated.has(db)) return;
  // No try/catch: a failure must propagate so the caller does not record this
  // database as migrated. Swallowing it would make every later request skip
  // the retry and keep selecting columns that were never added.
  const cols = await db.prepare("PRAGMA table_info(model_routes)").all();
  const names = new Set((cols.results || []).map((r) => r.name));
  if (!names.has("context_limit_override"))
    await db.prepare("ALTER TABLE model_routes ADD COLUMN context_limit_override INTEGER").run();
  if (!names.has("output_limit_override"))
    await db.prepare("ALTER TABLE model_routes ADD COLUMN output_limit_override INTEGER").run();
  if (!names.has("capability_overrides_json"))
    await db.prepare("ALTER TABLE model_routes ADD COLUMN capability_overrides_json TEXT NOT NULL DEFAULT '{}'").run();
  routeCapabilityMigrated.add(db);
}

// null inherits the canonical limit. A positive number clamps this route.
// false rejects the write: zero and negatives are not limits, and a non-number
// is a client error rather than a silent inherit.
function routeLimitOverride(value) {
  if (value == null || value === "")
    return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0)
    return false;
  return Math.floor(n);
}

app.post("/console/logout", async (c) => {
  const raw = c.req.header("cookie") || "";
  const m = raw.match(/(?:^|;\\s*)gw_client=([^;]+)/);
  if (m) {
    try {
      await c.env.DB.prepare("DELETE FROM console_sessions WHERE token_hash=?").bind(await sha256hex(decodeURIComponent(m[1]))).run();
    } catch {}
  }
  const cookie = CONSOLE_COOKIE + "=; Path=/console; Max-Age=0; SameSite=Lax; HttpOnly";
  c.header("Set-Cookie", cookie);
  return c.json({ ok: true });
});

app.post("/console/playground/completions", async (c) => {
  await ensureUpstreamDispatcher();
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  const key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=? AND active=1").bind(sess.keyId).first();
  if (!key)
    return c.json({ error: { message: "The API key for this session no longer exists.", type: "auth_error" } }, 401);
  return runChatCompletion(c, key, false);
});
app.post("/console/playground/systemone", async (c) => {
  await ensureUpstreamDispatcher();
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  const key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=? AND active=1").bind(sess.keyId).first();
  if (!key)
    return c.json({ error: { message: "The API key for this session no longer exists.", type: "auth_error" } }, 401);
  return runSystemOneDecision(c, key);
});

app.get("/console/api/me", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  return c.json({ key: { key_id: sess.keyId, name: sess.name } });
});
app.get("/console/api/keys", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  if (!sess.accountId) return c.json({ keys: [], account: null });
  const account = await c.env.DB.prepare(
    "SELECT username, budget_mode, budget_limit, used_usd, used_tokens FROM console_accounts WHERE key_id=?"
  ).bind(sess.accountId).first();
  const tiers = await c.env.DB.prepare(
    "SELECT mt.id, mt.name FROM console_account_tiers cat JOIN model_tiers mt ON mt.id=cat.tier_id WHERE cat.key_id=? ORDER BY mt.name"
  ).bind(sess.accountId).all();
  const keys = await c.env.DB.prepare(
    "SELECT key_id, name, active, used_usd, used_tokens, request_count, created_at FROM api_keys WHERE account_id=? OR key_id=? ORDER BY created_at DESC"
  ).bind(sess.accountId, sess.accountId).all();
  const keyRows = keys.results || [];
  // The cap that actually binds, matching /console/api/limits: an account cap
  // when one is set, otherwise the account's own key's cap in the legacy shape.
  let capMode = account ? String(account.budget_mode || "usd") : "usd";
  let capLimit = account && account.budget_limit != null ? Number(account.budget_limit) : null;
  let capScope = "account";
  if (capLimit == null) {
    const own = await c.env.DB.prepare("SELECT budget_mode, budget_limit FROM api_keys WHERE key_id=?").bind(sess.accountId).first();
    if (own && own.budget_limit != null && Number(own.budget_limit) > 0) {
      capMode = String(own.budget_mode || capMode);
      capLimit = Number(own.budget_limit);
      capScope = "key";
    }
  }
  return c.json({
    account: account ? {
      username: account.username,
      budget_mode: capMode,
      budget_limit: capLimit,
      budget_scope: capScope,
      used_usd: Number(account.used_usd) || 0,
      used_tokens: Number(account.used_tokens) || 0,
      tiers: (tiers.results || []).map((t) => ({ id: t.id, name: t.name }))
    } : null,
    keys: keyRows.map((k) => ({
      key_id: k.key_id, name: k.name, active: !!k.active,
      // The account's own key in the legacy 1:1 shape: it predates account
      // ownership, cannot be recreated if deleted, and is flagged so the page
      // can say so.
      own: k.key_id === sess.accountId,
      used_usd: Number(k.used_usd) || 0, used_tokens: Number(k.used_tokens) || 0,
      request_count: Number(k.request_count) || 0, created_at: k.created_at
    }))
  });
});

app.post("/console/api/keys", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  if (!sess.accountId)
    return c.json({ error: { message: "This session has no account to add keys to.", type: "invalid_request_error" } }, 403);
  let body;
  try { body = await c.req.json(); } catch { body = {}; }
  const name = String((body && body.name) || "").trim().slice(0, 120);
  if (!name) return c.json({ error: { message: "Give the key a name." } }, 400);
  const account = await c.env.DB.prepare("SELECT budget_mode, budget_limit FROM console_accounts WHERE key_id=?").bind(sess.accountId).first();
  if (!account) return c.json({ error: { message: "account not found" } }, 404);
  // This key's own spending cap, if the account holder wants one below the
  // account's. The account cap still applies on top, so a higher per-key value
  // is harmless; it just never binds.
  let keyLimit;
  if (body && body.budget_limit != null && body.budget_limit !== "") {
    const n = Number(body.budget_limit);
    if (!Number.isFinite(n) || n <= 0)
      return c.json({ error: { message: "budget_limit must be positive, or blank for no per-key cap" } }, 400);
    keyLimit = n;
  } else {
    keyLimit = Number(account.budget_limit) > 0 ? Number(account.budget_limit) : 1e12;
  }
  const count = await c.env.DB.prepare("SELECT COUNT(*) n FROM api_keys WHERE account_id=?").bind(sess.accountId).first();
  if (Number(count && count.n) >= 25)
    return c.json({ error: { message: "This account already has 25 keys." } }, 409);
  const keyId = genKey();
  const now = nowIso();
  await c.env.DB.prepare(
    "INSERT INTO api_keys (key_id, name, budget_mode, budget_limit, account_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(keyId, name, account.budget_mode || "usd", keyLimit, sess.accountId, now, now).run();
  const tiers = await c.env.DB.prepare("SELECT tier_id FROM console_account_tiers WHERE key_id=?").bind(sess.accountId).all();
  for (const row of tiers.results || [])
    await c.env.DB.prepare("INSERT OR IGNORE INTO api_key_model_tiers (key_id, tier_id) VALUES (?,?)").bind(keyId, row.tier_id).run();
  return c.json({ key_id: keyId, key: keyId, name, budget_mode: account.budget_mode || "usd", budget_limit: keyLimit }, 201);
});

app.post("/console/api/keys/:id/active", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  const owned = await ownedAccountKey(c, sess, c.req.param("id"));
  if (!owned) return c.json({ error: { message: "key not found" } }, 404);
  let body;
  try { body = await c.req.json(); } catch { body = {}; }
  await c.env.DB.prepare("UPDATE api_keys SET active=?, updated_at=? WHERE key_id=?").bind(body.active ? 1 : 0, nowIso(), owned.key_id).run();
  return c.json({ key_id: owned.key_id, active: !!body.active });
});

app.delete("/console/api/keys/:id", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  const owned = await ownedAccountKey(c, sess, c.req.param("id"));
  if (!owned) return c.json({ error: { message: "key not found" } }, 404);
  // The legacy own key is the account's identity for sign-in by key. Deleting
  // it is allowed but the account keeps working by username, so it is not
  // blocked: the page warns before it gets here.
  await c.env.DB.prepare("DELETE FROM api_key_model_tiers WHERE key_id=?").bind(owned.key_id).run();
  await c.env.DB.prepare("DELETE FROM api_keys WHERE key_id=?").bind(owned.key_id).run();
  return c.json({ deleted: owned.key_id });
});

// A key the session may manage: owned by the account, or the account's own key
// in the legacy 1:1 shape.
async function ownedAccountKey(c, sess, keyId) {
  if (!sess.accountId) return null;
  return c.env.DB.prepare("SELECT key_id FROM api_keys WHERE key_id=? AND (account_id=? OR key_id=?)")
    .bind(keyId, sess.accountId, sess.accountId).first();
}
// The keys a console session may read usage for. An account sees every key it
// owns plus its own legacy key, narrowed by ?key_id when the user filters to
// one. A plain key session sees only itself.
async function sessionKeyScope(c, sess) {
  const wanted = String(c.req.query("key_id") || "");
  if (sess.accountId) {
    const rows = await c.env.DB.prepare("SELECT key_id FROM api_keys WHERE account_id=? OR key_id=?").bind(sess.accountId, sess.accountId).all();
    const owned = (rows.results || []).map((r) => r.key_id);
    if (wanted) return owned.includes(wanted) ? [wanted] : [];
    return owned;
  }
  return sess.keyId ? [sess.keyId] : [];
}

function keyScopeClause(ids) {
  if (!ids.length) return { sql: " AND 1=0", binds: [] };
  return { sql: " AND key_id IN (" + ids.map(() => "?").join(",") + ")", binds: ids };
}



// One overview of real usage for the signed-in key. No fake savings, no
// invented percentiles: p95 TTFT is computed from rows that carry a ttft.
app.get("/console/api/overview", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 7));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const priorSince = new Date(Date.now() - 2 * days * 86400000).toISOString();

  // The ledger is the customer truth: one row per request, chat and decision
  // alike, written whether or not trajectory capture is enabled.
  const scopeIds = await sessionKeyScope(c, sess);
  const totals = await c.env.DB.prepare(
    "SELECT COUNT(*) requests, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok_requests, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(cost_usd),0) spend_usd FROM request_summaries WHERE created_at>=?" + keyScopeClause(scopeIds).sql
  ).bind(since, ...keyScopeClause(scopeIds).binds).first();
  const prior = await c.env.DB.prepare(
    "SELECT COUNT(*) requests, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(cost_usd),0) spend_usd FROM request_summaries WHERE created_at>=? AND created_at<?" + keyScopeClause(scopeIds).sql
  ).bind(priorSince, since, ...keyScopeClause(scopeIds).binds).first();

  const ttftRows = await c.env.DB.prepare(
    "SELECT ttft_ms FROM request_summaries WHERE created_at>=? AND ttft_ms IS NOT NULL" + keyScopeClause(scopeIds).sql
  ).bind(since, ...keyScopeClause(scopeIds).binds).all();
  const ttfts = (ttftRows.results || []).map((r) => Number(r.ttft_ms)).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const p95 = ttfts.length ? ttfts[Math.min(ttfts.length - 1, Math.ceil(ttfts.length * 0.95) - 1)] : null;

  const seriesRows = await c.env.DB.prepare(
    "SELECT substr(created_at,1,10) day, COUNT(*) requests, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(cost_usd),0) spend_usd FROM request_summaries WHERE created_at>=?" + keyScopeClause(scopeIds).sql + " GROUP BY substr(created_at,1,10) ORDER BY day"
  ).bind(since, ...keyScopeClause(scopeIds).binds).all();
  const byDay = new Map((seriesRows.results || []).map((r) => [r.day, r]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const row = byDay.get(day);
    series.push({
      day,
      requests: row ? Number(row.requests) || 0 : 0,
      tokens: row ? Number(row.tokens) || 0 : 0,
      spend_usd: row ? Number(row.spend_usd) || 0 : 0,
      p95_ttft_ms: null
    });
  }

  const recentRows = await c.env.DB.prepare(
    "SELECT request_id, created_at, public_slug, model_kind, status, http_status, ttft_ms, latency_ms, total_tokens, cost_usd FROM request_summaries WHERE 1=1" + keyScopeClause(scopeIds).sql + " ORDER BY created_at DESC LIMIT 25"
  ).bind(...keyScopeClause(scopeIds).binds).all();
  const recent = (recentRows.results || []).map((r) => ({
    id: String(r.request_id),
    created_at: String(r.created_at),
    slug: String(r.public_slug || ""),
    model_kind: String(r.model_kind || "chat"),
    status: String(r.status || ""),
    http_status: r.http_status == null ? null : Number(r.http_status),
    latency_ms: r.latency_ms == null ? null : Number(r.latency_ms),
    ttft_ms: r.ttft_ms == null ? null : Number(r.ttft_ms),
    tokens: Number(r.total_tokens) || 0,
    cost_usd: Number(r.cost_usd) || 0
  }));

  return c.json({
    window: { days },
    totals: {
      requests: Number(totals && totals.requests) || 0,
      ok_requests: totals && totals.ok_requests != null ? Number(totals.ok_requests) : null,
      tokens: Number(totals && totals.tokens) || 0,
      spend_usd: Number(totals && totals.spend_usd) || 0,
      p95_ttft_ms: p95
    },
    prior_totals: prior && Number(prior.requests) > 0 ? {
      requests: Number(prior.requests) || 0,
      tokens: Number(prior.tokens) || 0,
      spend_usd: Number(prior.spend_usd) || 0
    } : null,
    series,
    recent
  });
});

// Hourly activity for the signed-in key. Daily buckets hide a burst that
// lands inside one day; the chart needs the hours those requests actually
// happened in. Zero hours stay out so a quiet week does not draw a flat line.
app.get("/console/api/activity", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  const hours = Math.min(24 * 30, Math.max(1, Number(c.req.query("hours")) || 24 * 7));
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const scopeIds = await sessionKeyScope(c, sess);
  const scope = keyScopeClause(scopeIds);
  const rows = await c.env.DB.prepare(
    "SELECT substr(created_at,1,13) bucket, COUNT(*) requests, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok, SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END) fail, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(cost_usd),0) spend_usd FROM request_summaries WHERE created_at>=?" + scope.sql + " GROUP BY substr(created_at,1,13) ORDER BY bucket"
  ).bind(since, ...scope.binds).all();
  const points = (rows.results || []).map((r) => ({
    hour: String(r.bucket) + ":00:00Z",
    requests: Number(r.requests) || 0,
    ok: Number(r.ok) || 0,
    fail: Number(r.fail) || 0,
    tokens: Number(r.tokens) || 0,
    spend_usd: Number(r.spend_usd) || 0
  }));
  const totals = points.reduce((a, p) => ({
    requests: a.requests + p.requests,
    ok: a.ok + p.ok,
    fail: a.fail + p.fail,
    tokens: a.tokens + p.tokens,
    spend_usd: a.spend_usd + p.spend_usd
  }), { requests: 0, ok: 0, fail: 0, tokens: 0, spend_usd: 0 });
  return c.json({ window: { hours }, totals, points });
});

// The signed-in account's budget and rate limit. An account session reports
// the account cap; a plain key session reports that key's own limits.
app.get("/console/api/limits", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  if (sess.accountId) {
    const account = await c.env.DB.prepare(
      "SELECT username, budget_mode, budget_limit, used_usd, used_tokens FROM console_accounts WHERE key_id=?"
    ).bind(sess.accountId).first();
    if (!account)
      return c.json({ error: { message: "This account no longer exists.", type: "auth_error" } }, 401);
    const owned = await c.env.DB.prepare("SELECT key_id FROM api_keys WHERE account_id=? OR key_id=?").bind(sess.accountId, sess.accountId).all();
    const ownedIds = (owned.results || []).map((r) => r.key_id);
    // The effective cap. A legacy account (the 1:1 shape) carries no cap of
    // its own; the limit that actually binds is its key's, so report that
    // rather than claiming the account is uncapped.
    let mode = String(account.budget_mode || "usd");
    let limit = account.budget_limit == null ? null : Number(account.budget_limit);
    let scopeNote = "account";
    if (limit == null && ownedIds.length) {
      const own = await c.env.DB.prepare(
        "SELECT budget_mode, budget_limit FROM api_keys WHERE key_id=?"
      ).bind(ownedIds.includes(sess.accountId) ? sess.accountId : ownedIds[0]).first();
      if (own && own.budget_limit != null && Number(own.budget_limit) > 0) {
        mode = String(own.budget_mode || mode);
        limit = Number(own.budget_limit);
        scopeNote = "key";
      }
    }
    const used = mode === "usd" ? Number(account.used_usd) || 0 : Number(account.used_tokens) || 0;
    return c.json({
      name: String(account.username || ""),
      active: true,
      expires_at: null,
      budget: {
        mode,
        limit: limit == null ? 0 : limit,
        uncapped: limit == null,
        used,
        remaining: limit == null ? null : Math.max(0, limit - used),
        request_count: 0
      },
      rate: { per_minute: 0, used_this_minute: 0 },
      keys: ownedIds.length,
      budget_scope: scopeNote,
      models: await modelLimitStatus(c)
    });
  }
  const key = await c.env.DB.prepare(
    "SELECT name, budget_mode, budget_limit, used_tokens, used_usd, request_count, request_limit_per_minute, expires_at, active FROM api_keys WHERE key_id=?"
  ).bind(sess.keyId).first();
  if (!key)
    return c.json({ error: { message: "The API key for this session no longer exists.", type: "auth_error" } }, 401);
  const now = new Date();
  const bucket = now.toISOString().slice(0, 16);
  const window = await c.env.DB.prepare(
    "SELECT request_count FROM api_key_rate_windows WHERE key_id=? AND bucket=?"
  ).bind(sess.keyId, bucket).first();
  const mode = String(key.budget_mode || "usd");
  const used = mode === "usd" ? Number(key.used_usd) || 0 : Number(key.used_tokens) || 0;
  const limit = Number(key.budget_limit) || 0;
  return c.json({
    name: String(key.name || ""),
    active: !!key.active,
    expires_at: key.expires_at || null,
    budget: {
      mode,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      request_count: Number(key.request_count) || 0
    },
    rate: {
      per_minute: key.request_limit_per_minute == null ? 0 : Number(key.request_limit_per_minute),
      used_this_minute: window ? Number(window.request_count) || 0 : 0
    },
    models: await modelLimitStatus(c)
  });
});

// The shared pool is a single api_key any operator designates for communal use.
// Every signed-in console user sees its remaining budget as a top-bar event pill
// and can copy its key from there, since the whole point of a pool is shared use.
app.get("/console/api/pool", async (c) => {
  const { denied } = await requireConsoleSession(c);
  if (denied) return denied;
  return c.json({ pool: await sharedPoolStatus(c) });
});

async function sharedPoolStatus(c) {
  const keyId = await settingValue(c, "shared_pool_key", "");
  if (!keyId) return null;
  const key = await c.env.DB.prepare(
    "SELECT key_id, name, budget_mode, budget_limit, used_tokens, used_usd, request_count, active FROM api_keys WHERE key_id=?"
  ).bind(keyId).first();
  if (!key) return null;
  const mode = String(key.budget_mode || "usd");
  const used = mode === "usd" ? Number(key.used_usd) || 0 : Number(key.used_tokens) || 0;
  const limit = Number(key.budget_limit) || 0;
  return {
    key_id: String(key.key_id),
    name: String(key.name || "Shared pool"),
    mode,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    request_count: Number(key.request_count) || 0,
    active: !!key.active
  };
}

// True when keyId is the currently designated shared pool. Used to keep the
// communal /v1 key out of the console: it can never sign in or hold an account.
async function isSharedPoolKey(c, keyId) {
  if (!keyId) return false;
  const poolId = await settingValue(c, "shared_pool_key", "");
  return !!poolId && String(poolId) === String(keyId);
}

// The response cache as THIS key experiences it. Each key controls its own
// caching: turning it off stops the gateway serving cached completions for this
// key only, never for anyone else. Stats are scoped to the key too.
app.get("/console/api/settings", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  await ensureConsoleAuthColumn(c.env.DB);
  const keyRow = await c.env.DB.prepare("SELECT response_cache FROM api_keys WHERE key_id=?").bind(sess.keyId).first();
  const enabled = !keyRow || Number(keyRow.response_cache) !== 0;
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) entries, COALESCE(SUM(hits),0) hits, COALESCE(SUM(source_cost_usd * hits),0) saved_usd, COALESCE(SUM(source_tokens * hits),0) saved_tokens FROM response_cache WHERE key_id=?"
  ).bind(sess.keyId).first();
  return c.json({
    response_cache: {
      enabled,
      entries: Number(row && row.entries) || 0,
      hits: Number(row && row.hits) || 0,
      saved_usd: Number(row && row.saved_usd) || 0,
      saved_tokens: Number(row && row.saved_tokens) || 0
    }
  });
});

app.post("/console/api/settings", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }
  if (body.response_cache !== "on" && body.response_cache !== "off")
    return c.json({ error: { message: "response_cache must be on or off", type: "invalid_request_error" } }, 400);
  await ensureConsoleAuthColumn(c.env.DB);
  await c.env.DB.prepare("UPDATE api_keys SET response_cache=?, updated_at=? WHERE key_id=?")
    .bind(body.response_cache === "on" ? 1 : 0, nowIso(), sess.keyId).run();
  return c.json({ response_cache: { enabled: body.response_cache === "on" } });
});

// Filterable request list. Filters compose; every value is validated so a bad
// query parameter cannot poison the SQL.
app.get("/console/api/requests", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  const q = c.req.query();
  const kind = ["chat", "decision"].includes(String(q.kind || "")) ? String(q.kind) : null;
  const status = ["ok", "fail", "cancelled"].includes(String(q.status || "")) ? String(q.status) : null;
  const slug = String(q.model || "").trim().slice(0, 160) || null;
  const search = String(q.request_id || "").trim().slice(0, 160) || null;
  const days = Math.min(90, Math.max(1, Number(q.days) || 7));
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const scopeIds = await sessionKeyScope(c, sess);
  const scope = keyScopeClause(scopeIds);
  let sql = "SELECT request_id, created_at, public_slug, model_kind, status, http_status, stream, ttft_ms, latency_ms, prompt_tokens, completion_tokens, total_tokens, cost_usd, attempts, cache_state FROM request_summaries WHERE created_at>=?" + scope.sql;
  const binds = [since, ...scope.binds];
  if (kind) { sql += " AND model_kind=?"; binds.push(kind); }
  if (status) { sql += " AND status=?"; binds.push(status); }
  if (slug) { sql += " AND public_slug=?"; binds.push(slug); }
  if (search) { sql += " AND request_id LIKE ?"; binds.push("%" + search + "%"); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  binds.push(limit);
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({
    requests: (rows.results || []).map((r) => ({
      id: String(r.request_id),
      created_at: String(r.created_at),
      slug: String(r.public_slug || ""),
      model_kind: String(r.model_kind || "chat"),
      status: String(r.status || ""),
      http_status: r.http_status == null ? null : Number(r.http_status),
      stream: !!r.stream,
      ttft_ms: r.ttft_ms == null ? null : Number(r.ttft_ms),
      latency_ms: r.latency_ms == null ? null : Number(r.latency_ms),
      prompt_tokens: Number(r.prompt_tokens) || 0,
      completion_tokens: Number(r.completion_tokens) || 0,
      total_tokens: Number(r.total_tokens) || 0,
      cost_usd: Number(r.cost_usd) || 0,
      attempts: Number(r.attempts) || 0,
      cache_state: r.cache_state || null
    }))
  });
});

// Usage aggregation by model, the same window the Overview uses. Success rate
// is real here because the ledger records terminal status per request.
app.get("/console/api/usage", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 7));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const scopeIds = await sessionKeyScope(c, sess);
  const scope = keyScopeClause(scopeIds);
  const byModel = await c.env.DB.prepare(
    "SELECT public_slug, model_kind, COUNT(*) requests, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(cost_usd),0) spend FROM request_summaries WHERE created_at>=?" + scope.sql + " GROUP BY public_slug, model_kind ORDER BY requests DESC"
  ).bind(since, ...scope.binds).all();

  const lat = await c.env.DB.prepare(
    "SELECT public_slug, model_kind, ttft_ms FROM request_summaries WHERE created_at>=? AND ttft_ms IS NOT NULL" + scope.sql
  ).bind(since, ...scope.binds).all();
  const latBy = new Map();
  for (const r of lat.results || []) {
    const k = r.public_slug + "|" + r.model_kind;
    if (!latBy.has(k)) latBy.set(k, []);
    latBy.get(k).push(Number(r.ttft_ms));
  }

  const models = (byModel.results || []).map((r) => {
    const k = r.public_slug + "|" + r.model_kind;
    const ts = (latBy.get(k) || []).sort((a, b) => a - b);
    const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.ceil(arr.length * p) - 1)] : null;
    return {
      slug: String(r.public_slug),
      model_kind: String(r.model_kind),
      requests: Number(r.requests) || 0,
      ok: r.ok == null ? 0 : Number(r.ok),
      tokens: Number(r.tokens) || 0,
      spend_usd: Number(r.spend) || 0,
      p50_ttft_ms: pct(ts, 0.5),
      p95_ttft_ms: pct(ts, 0.95)
    };
  });
  return c.json({ window: { days }, models });
});

// The models the signed-in key may call, with the honest Auto envelope and
// per-model pricing — the same data /v1/models exposes, shaped for the table.
app.get("/console/api/models", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  let key = sess.keyId ? await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(sess.keyId).first() : null;
  if (!key && sess.accountId)
    key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE account_id=? AND active=1 ORDER BY created_at LIMIT 1").bind(sess.accountId).first();
  if (!key)
    return c.json({ data: [] });
  const allowed = await allowedSlugs(c, key);
  if (!allowed.length)
    return c.json({ data: [] });
  const routes = await c.env.DB.prepare(
    "SELECT mr.id AS route_id, mr.slug, mr.provider_id, mr.upstream_model, mr.model_kind, mr.wire_format, mr.context_limit_override, mr.output_limit_override, p.fmt FROM model_routes mr JOIN providers p ON p.id=mr.provider_id WHERE mr.enabled=1 AND p.enabled=1 AND p.healthy=1 AND mr.slug IN (" + allowed.map(() => "?").join(",") + ") ORDER BY mr.slug, mr.rank"
  ).bind(...allowed).all();
  const live = [];
  const decisionSlugs = new Map();
  for (const r of routes.results || []) {
    if (circuitOpen("route:" + String(r.route_id)))
      continue;
    if (String(r.model_kind || "chat") === "decision") {
      if (!decisionSlugs.has(r.slug))
        decisionSlugs.set(r.slug, r);
      continue;
    }
    live.push(r);
  }
  const cfg = await autoSettings(c);
  if (!modelsDevCache.catalog)
    await fetchModelsDevCatalog().catch(() => {});
  const byId = modelsDevCache.catalog ? flattenModelsDevCatalog(modelsDevCache.catalog) : null;
  const prices = await c.env.DB.prepare("SELECT slug, prompt_per_1m, completion_per_1m, actual_mode, actual_per_request FROM prices").all();
  const priceBySlug = new Map((prices.results || []).map((p) => [p.slug, p]));
  // Real per-model reliability over the last 7 days, from this key's own
  // ledger. No invented numbers: a slug with no recent traffic reports null,
  // and the console renders "no recent requests" rather than a fake 100%.
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const scopeIds = await sessionKeyScope(c, sess);
  const scope = keyScopeClause(scopeIds);
  const healthRows = await c.env.DB.prepare(
    "SELECT public_slug, COUNT(*) n, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok FROM request_summaries WHERE created_at>=?" + scope.sql + " GROUP BY public_slug"
  ).bind(since, ...scope.binds).all();
  const healthBySlug = new Map((healthRows.results || []).map((r) => [String(r.public_slug), { n: Number(r.n) || 0, ok: Number(r.ok) || 0 }]));

  const data = [];
  const canonicalByRoute = await canonicalLimitsForRoutes(c, live);
  if (cfg.enabled && live.length) {
    const envelope = buildCapabilityEnvelope(live.map((r) => {
      const entry = capabilityEntryForRoute(r, byId, canonicalByRoute.get(r.route_id));
      const caps = entryCapabilities(entry);
      return {
        providerId: r.provider_id,
        context: contextLimit(caps),
        output: caps.output,
        tools: !!caps.tools,
        vision: !!caps.vision,
        reasoning: !!(entry && entry.reasoning)
      };
    }));
    const pr = priceBySlug.get("auto");
    data.push({
      id: "auto",
      model_kind: "chat",
      endpoint: "/v1/chat/completions",
      context_window: envelope.context_window,
      max_output_tokens: envelope.max_output_tokens,
      tools: envelope.capabilities.tools,
      vision: envelope.capabilities.vision,
      reasoning: envelope.capabilities.reasoning,
      routing: envelope.routing,
      prompt_per_1m: pr ? Number(pr.prompt_per_1m) : null,
      completion_per_1m: pr ? Number(pr.completion_per_1m) : null,
      per_request: null
    });
  }
  const chatSlugs = new Set(live.map((r) => r.slug));
  for (const slug of [...chatSlugs].sort()) {
    const r = live.find((x) => x.slug === slug);
    const entry = capabilityEntryForRoute(r, byId, canonicalByRoute.get(r.route_id));
    const caps = entryCapabilities(entry);
    const pr = priceBySlug.get(slug);
    const mdIn = entry && Number.isFinite(entry.prompt_per_1m) ? Number(entry.prompt_per_1m) : null;
    const mdOut = entry && Number.isFinite(entry.completion_per_1m) ? Number(entry.completion_per_1m) : null;
    const hasMd = !!(mdIn || mdOut);
    data.push({
      id: slug,
      model_kind: "chat",
      endpoint: "/v1/chat/completions",
      context_window: contextLimit(caps),
      max_output_tokens: outputLimit(caps),
      tools: !!caps.tools,
      vision: !!caps.vision,
      reasoning: !!(entry && entry.reasoning),
      routing: null,
      prompt_per_1m: hasMd ? mdIn : (pr ? Number(pr.prompt_per_1m) : null),
      completion_per_1m: hasMd ? mdOut : (pr ? Number(pr.completion_per_1m) : null),
      per_request: hasMd ? null : (pr && String(pr.actual_mode) === "per_request" ? Number(pr.actual_per_request) : null),
      price_source: hasMd ? "models.dev" : (pr ? "gateway" : null),
      name: entry && entry.name || null,
      knowledge: entry && (entry.knowledge || entry.release_date) || null,
      uptime: healthBySlug.has(slug) ? healthBySlug.get(slug).ok / healthBySlug.get(slug).n : null,
      samples: healthBySlug.has(slug) ? healthBySlug.get(slug).n : 0
    });
  }
  for (const [slug, r] of [...decisionSlugs.entries()].sort()) {
    const pr = priceBySlug.get(slug);
    data.push({
      id: slug,
      model_kind: "decision",
      protocol: String(r.wire_format || r.fmt || "systemone"),
      endpoint: "/v1/systemone",
      routing: null,
      prompt_per_1m: null,
      completion_per_1m: null,
      per_request: pr && String(pr.actual_mode) === "per_request" ? Number(pr.actual_per_request) : (pr ? Number(pr.prompt_per_1m) : null),
      uptime: healthBySlug.has(slug) ? healthBySlug.get(slug).ok / healthBySlug.get(slug).n : null,
      samples: healthBySlug.has(slug) ? healthBySlug.get(slug).n : 0
    });
  }
  return c.json({ data });
});

// Request drill-down for the drawer. Body-free facts only: status, timings,
// tokens, cost. No provider names, no route ids, no raw upstream errors.
app.get("/console/api/requests/:id", async (c) => {
  const { denied, sess } = await requireConsoleSession(c);
  if (denied) return denied;
  const id = String(c.req.param("id"));
  const scopeIds = await sessionKeyScope(c, sess);
  const scope = keyScopeClause(scopeIds);
  const r = await c.env.DB.prepare(
    "SELECT request_id, created_at, public_slug, model_kind, status, http_status, stream, headers_ms, ttft_ms, latency_ms, prompt_tokens, completion_tokens, cost_usd, attempts, cache_state, client_app, request_headers FROM request_summaries WHERE request_id=?" + scope.sql
  ).bind(id, ...scope.binds).first();
  if (!r)
    return c.json({ error: { message: "Request not found.", type: "not_found" } }, 404);
  return c.json({
    id: String(r.request_id),
    created_at: String(r.created_at),
    slug: String(r.public_slug || ""),
    model_kind: String(r.model_kind || "chat"),
    status: String(r.status || ""),
    http_status: r.http_status == null ? null : Number(r.http_status),
    stream: !!r.stream,
    headers_ms: r.headers_ms == null ? null : Number(r.headers_ms),
    ttft_ms: r.ttft_ms == null ? null : Number(r.ttft_ms),
    latency_ms: r.latency_ms == null ? null : Number(r.latency_ms),
    prompt_tokens: Number(r.prompt_tokens) || 0,
    completion_tokens: Number(r.completion_tokens) || 0,
    cost_usd: Number(r.cost_usd) || 0,
    attempts: Number(r.attempts) || 0,
    cache_state: r.cache_state || null,
    client_app: r.client_app || null,
    headers: (() => { try { return JSON.parse(r.request_headers || "{}"); } catch { return {}; } })(),
    prompt: await cachedPrompt(c, r.request_id, r.cache_state)
  });
});
async function cachedPrompt(c, requestId, cacheState) {
  if (!cacheState) return null;
  try {
    const row = await c.env.DB.prepare("SELECT request_json FROM trajectories WHERE id=?").bind(String(requestId)).first();
    const body = row && row.request_json ? JSON.parse(row.request_json) : null;
    const message = body && Array.isArray(body.messages) ? body.messages.find((m) => m && m.role === "user") : null;
    const text = message && typeof message.content === "string" ? message.content : "";
    return text ? text.slice(0, 4000) : null;
  } catch {
    return null;
  }
}

// POST /v1/systemone — decision models, reached through the same auth, route
// ranking, key rotation, circuit breakers and limits as every other model.
// A decision model is never a chat model: the two endpoints refuse each other.
// The decision inference path, shared by the API-key surface and the console
// playground. `key` is null for the admin playground, exactly like chat.
async function runSystemOneDecision(c, key, options) {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }
  const problem = validateDecisionRequest(body);
  if (problem)
    return c.json({ error: { message: problem, type: "invalid_request_error" } }, 400);
  const slug = String(body.model || "");
  if (!slug)
    return c.json({ error: { message: "model is required", type: "invalid_request_error" } }, 400);
  const requestId = c.req.header("x-request-id") || uuid();
  const started = Date.now();
  await startRequestSummary(c.env.DB, { requestId, keyId: key && key.key_id || null, modelKind: "decision", publicSlug: slug, stream: false, headers: c.req.header() });
  if (key && !await slugAllowed(c, key, slug)) {
    await finishRequestSummary(c.env.DB, requestId, { status: "fail", httpStatus: 403, attempts: 0 });
    return c.json({ error: { message: "Model \"" + slug + "\" is not enabled for this key", type: "model_not_allowed" } }, 403);
  }

  const routes = await c.env.DB.prepare(
    "SELECT mr.*, p.name AS provider_name, p.healthy, p.enabled AS provider_enabled, p.fmt, p.base_url, p.transport, p.proxy_url, p.extra_headers, p.key_strategy FROM model_routes mr JOIN providers p ON p.id=mr.provider_id WHERE mr.slug=? AND mr.enabled=1 AND p.enabled=1 AND p.healthy=1 ORDER BY mr.rank"
  ).bind(slug).all();
  const candidates = (routes.results || []).filter((r) => effectiveModelKind(r) === "decision");
  if (!candidates.length) {
    const chatOnly = (routes.results || []).length > 0;
    await finishRequestSummary(c.env.DB, requestId, { status: "fail", httpStatus: chatOnly ? 400 : 503, attempts: 0 });
    return c.json({
      error: {
        message: chatOnly
          ? "This model is a chat model and answers /v1/chat/completions, not the decision API."
          : "No healthy decision route for \"" + slug + "\"",
        type: chatOnly ? "model_endpoint_mismatch" : "no_route"
      }
    }, chatOnly ? 400 : 503);
  }

  let lastReason = "no decision route answered";
  let lastStatus = 0;
  let lastProviderMessage = "";
  for (const route of candidates) {
    const circuit = circuitKey(route);
    if (circuitOpen(circuit) || circuitOpen("provider", route.provider_id)) {
      lastReason = "circuit open";
      continue;
    }
    const keys = await providerKeys(c, route.provider_id);
    if (!keys.length) {
      lastReason = "provider has no key";
      continue;
    }
    let extraHeaders = {};
    try {
      extraHeaders = JSON.parse(route.extra_headers || "{}") || {};
    } catch {
      extraHeaders = {};
    }
    // Send through the SAME egress the chat path uses. A raw global fetch here
    // skips the undici dispatcher (custom CA/keepalive) and the provider's
    // proxy transport, so on a host where direct egress is blocked the request
    // silently never leaves — the "it isn't even sending" symptom. Direct/auto
    // ride upstreamFetch; a proxy provider tunnels through its egress helper.
    const transport = routeTransport(route, c.env);
    const decisionFetch = transport === "proxy"
      ? async (url, init) => {
          const proxy = route.proxy_url || (await resolveActiveEgress(c) || {}).url;
          if (!proxy) throw new Error("proxy transport but no egress configured");
          const sep = proxy.includes("?") ? "&" : "?";
          return fetch(proxy + sep + "url=" + encodeURIComponent(url), { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
        }
      : (url, init) => upstreamFetch(c, url, init);
    const attemptUrl = joinDecisionUrl(providerBaseFor(route, route), decisionPathFor(route, route));
    blog("REQ id=" + requestId + " decision -> " + attemptUrl + " transport=" + transport);
    for (const k of orderKeys(keys, route.key_strategy || "round_robin", route.provider_id)) {
      const res = await callSystemOne({
        base: providerBaseFor(route, route),
        path: decisionPathFor(route, route),
        model: route.upstream_model,
        state: body.state,
        questions: body.questions,
        apiKey: k.key,
        headers: extraHeaders,
        fetchImpl: decisionFetch,
        timeoutMs: Number(c.env.DECISION_TIMEOUT_MS) || 20000
      });
      if (res.ok) {
        circuitRecordOk("provider", route.provider_id);
        circuitRecordOk("route", route.id);
        circuitRecordOk("key", k.keyId);
        const answers = mapSystemOneResponse({ json: res.json, questions: body.questions });
        await recordModelUsage(c, slug, 0, 0);
        const decPrice = await lookupPriceRow(c, slug, 0);
        const decCost = decPrice && String(decPrice.actual_mode) === "per_request" ? Number(decPrice.actual_per_request) || 0 : 0;
        await finishRequestSummary(c.env.DB, requestId, { status: "ok", httpStatus: res.http, ttftMs: Date.now() - started, latencyMs: Date.now() - started, costUsd: decCost, attempts: 1 });
        blog("TRACE id=" + requestId + " decision provider=" + route.provider_name + " model=" + route.upstream_model + " ms=" + (Date.now() - started));
        const decisionBody = {
          model: slug,
          upstream_model: route.upstream_model,
          answers,
          source: "remote",
          latency_ms: Date.now() - started
        };
        // The chat-endpoint bridge asks for an OpenAI envelope so a chat-SDK
        // client parses the reply; the answers ride inside choices[0].message
        // as JSON, identical data, plus the native fields for direct callers.
        if ((options && options.envelope) === "openai") {
          return c.json({
            id: "chatcmpl-decision-" + requestId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: slug,
            choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(decisionBody) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            ...decisionBody
          });
        }
        return c.json(decisionBody);
      }
      lastReason = res.reason || "decision provider failed";
      if (res.http) lastStatus = res.http;
      if (res.providerMessage) lastProviderMessage = res.providerMessage;
      blog("FWD FAIL decision provider=" + route.provider_name + " -> " + lastReason);
    }
  }
  // Surface what actually happened. An upstream 4xx means the request WAS sent
  // and the provider rejected it (usually a wrong base_url or endpoint_path),
  // so return that status and message instead of a blanket "did not answer" —
  // otherwise a 404 from a misconfigured route looks like the gateway never
  // tried. 5xx and unreachable stay 502 (a transient provider fault).
  const clientStatus = lastStatus >= 400 && lastStatus < 500 ? lastStatus : 502;
  const detail = lastProviderMessage ? " (" + lastProviderMessage + ")" : "";
  const message = lastStatus
    ? "The decision model at this route returned HTTP " + lastStatus + detail + ". Check the provider base URL and endpoint path."
    : "The decision model could not be reached (" + lastReason + "). Check the provider base URL, key, and health.";
  await recordTrajectory(c, { id: requestId, keyId: key && key.key_id || null, keyName: key && key.name || null, slug, stream: false, requestJson: JSON.stringify({ model: slug, state: body.state, questions: Object.keys(body.questions) }), steps: [], status: "fail", httpStatus: clientStatus, attempts: candidates.length, latencyMs: Date.now() - started, error: lastReason });
  await finishRequestSummary(c.env.DB, requestId, { status: "fail", httpStatus: clientStatus, latencyMs: Date.now() - started, attempts: candidates.length });
  return c.json({ error: { message, type: "decision_unavailable" } }, clientStatus);
}
app.post("/v1/systemone", async (c) => {
  await ensureUpstreamDispatcher();
  const auth = await authClient(c);
  if (auth instanceof Response)
    return auth;
  return runSystemOneDecision(c, auth.key);
});
app.post("/admin/playground/systemone", async (c) => {
  await ensureUpstreamDispatcher();
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  return runSystemOneDecision(c, null);
});
// A route's wire format wins over the provider default, so one provider can
// host a chat model and a decision model without becoming two providers.
function effectiveFormat(route, provider) {
  return String((route && route.wire_format) || (provider && provider.fmt) || "openai");
}
function effectiveModelKind(route) {
  return String((route && route.model_kind) || "chat");
}
function decisionPathFor(route, provider) {
  if (route && route.endpoint_path) {
    const p = String(route.endpoint_path);
    return p.startsWith("/") ? p : "/" + p;
  }
  return "/v1/systemone";
}

async function runChatCompletion(c, key, isAdminPlayground) {
  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body" } }, 400);
  }
  // Snapshot the caller's request before any gateway mutation (auto-harness,
  // tool-repair). Telemetry and task classification must describe what the
  // user asked for, not what the gateway injected.
  const originalPayload = structuredClone(payload);
  let slug = payload.model;
  let autoDecision = null;
  if (String(slug).toLowerCase() === AUTO_SLUG) {
    autoDecision = await pickAutoModel(c, payload, key);
    if (!autoDecision) {
      const cfg = await autoSettings(c);
      const msg = cfg.enabled
        ? 'No healthy routed models available for auto routing'
        : 'Auto routing is disabled. Enable it in the Auto tab or pick a specific model.';
      return c.json({ error: { message: msg, type: cfg.enabled ? "no_route" : "auto_disabled" } }, cfg.enabled ? 503 : 400);
    }
    slug = autoDecision.slug;
    payload = applyAutoHarness({ ...payload, model: slug }, autoDecision);
    const hz = autoDecision.horizon;
    blog("AUTO picked " + slug + " speed=" + ((hz && hz.speed) || "-") + " role=" + ((hz && hz.role) || "-") + " mvc=" + Number(hz && hz.mvc || 0).toFixed(2) + " quality=" + (autoDecision.quality || 0).toFixed(2) + " cost=" + autoDecision.cost.toFixed(3) + " need=" + (autoDecision.need || 0).toFixed(2) + (autoDecision.fallback ? " fallback" : "") + (autoDecision.queue && autoDecision.queue.length ? " queue=" + autoDecision.queue.join(",") : ""));
  }
  // Tool repair guidance is injected only after auto-routing has scored the
  // original request, so safety instructions never inflate task complexity.
  payload = applyToolRepairPolicyToPayload(payload);
  const requestId = c.req.header("x-request-id") || uuid();
  const started = Date.now();
  const isStream = !!payload.stream;
  const traj = trajectorySeed(c, payload, key, slug || "unknown", isStream, requestId);
  if (autoDecision)
    await recordRouterDecision(c, requestId, autoDecision);
  if (autoDecision)
    traj.steps.push({ provider: "horizon", rank: 0, ok: true, picked: slug, costPer1M: autoDecision.cost, quality: autoDecision.quality, fallback: !!autoDecision.fallback, speed: autoDecision.horizon && autoDecision.horizon.speed, role: autoDecision.horizon && autoDecision.horizon.role, queue: autoDecision.queue || [] });
  if (!slug) {
    await recordTrajectory(c, { ...traj, status: "fail", httpStatus: 400, attempts: 0, latencyMs: Date.now() - started, error: "model is required" });
    await finishRequestSummary(c.env.DB, requestId, { status: "fail", httpStatus: 400, attempts: 0, latencyMs: Date.now() - started });
    return c.json({ error: { message: "model is required" } }, 400);
  }
  // A decision model answers /v1/systemone, never a chat completion. BUT many
  // clients speak only the chat endpoint, so a SystemOne-shaped body — {state,
  // questions}, no messages — is bridged through the real decision pipeline and
  // answered in an OpenAI envelope instead of being refused. A body that is
  // actually chat (messages present) is still refused before any upstream call:
  // a decision model must never be asked to generate assistant prose.
  if (String(slug).toLowerCase() !== AUTO_SLUG) {
    const kindRow = await c.env.DB.prepare(
      "SELECT model_kind FROM model_routes WHERE slug=? AND enabled=1 AND COALESCE(model_kind,'chat')<>'chat' LIMIT 1"
    ).bind(slug).first();
    if (kindRow) {
      if (payload && !Array.isArray(payload.messages) && payload.state && payload.questions && typeof payload.questions === "object") {
        return runSystemOneDecision(c, key, { envelope: "openai" });
      }
      await recordTrajectory(c, { ...traj, status: "fail", httpStatus: 400, attempts: 0, latencyMs: Date.now() - started, error: "model_endpoint_mismatch" });
      return c.json({ error: { message: "This model uses the decision inference API at /v1/systemone and cannot answer chat completions. Post {model, state, questions} to this endpoint to use it from a chat client.", type: "model_endpoint_mismatch" } }, 400);
    }
  }
  await startRequestSummary(c.env.DB, { requestId, keyId: key && key.key_id || null, modelKind: "chat", publicSlug: slug, stream: isStream });
  if (!isAdminPlayground && !autoDecision && slug !== AUTO_SLUG && !await slugAllowed(c, key, slug)) {
    await recordTrajectory(c, { ...traj, status: "fail", httpStatus: 403, attempts: 0, latencyMs: Date.now() - started, error: "model not enabled for this key" });
    await finishRequestSummary(c.env.DB, requestId, { status: "fail", httpStatus: 403, attempts: 0, latencyMs: Date.now() - started });
    return c.json({ error: { message: 'Model "' + slug + '" is not enabled for this key', type: "model_not_allowed" } }, 403);
  }
  const slugQueue = [];
  const seenSlug = new Set();
  for (const s of [slug, ...((autoDecision && autoDecision.queue) || [])]) {
    if (!s || seenSlug.has(s)) continue;
    seenSlug.add(s);
    slugQueue.push(s);
  }
  const combined = [];
  for (const s of slugQueue) {
    const rows = await c.env.DB.prepare(
      "SELECT mr.*, p.base_url, p.name AS provider_name, p.healthy, p.enabled, p.fmt, p.proxy_url, p.transport, p.extra_headers FROM model_routes mr JOIN providers p ON p.id=mr.provider_id WHERE mr.slug=? AND mr.enabled=1 AND p.enabled=1 AND p.healthy=1 AND COALESCE(mr.model_kind, 'chat')='chat' ORDER BY mr.rank"
    ).bind(s).all();
    for (const r of rows.results || [])
      combined.push({ ...r, public_slug: s });
  }
  const routes = { results: combined };
  if (!routes.results.length) {
    const disabled = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM model_routes mr JOIN providers p ON p.id=mr.provider_id WHERE mr.slug=? AND mr.enabled=1 AND p.enabled=0"
    ).bind(slug).first();
    const why = Number(disabled && disabled.n) > 0 ? "provider disabled" : "no healthy route";
    await recordTrajectory(c, { ...traj, status: "fail", httpStatus: 503, attempts: 0, latencyMs: Date.now() - started, error: why });
    return c.json({
      error: {
        message: Number(disabled && disabled.n) > 0
          ? 'No enabled provider for model "' + slug + '": its provider is disabled in the console.'
          : 'No healthy route for model "' + slug + '"',
        type: Number(disabled && disabled.n) > 0 ? "provider_disabled" : "no_route"
      }
    }, 503);
  }
  const modelDenied = await enforceModelLimits(c, slug);
  if (modelDenied) {
    await recordTrajectory(c, { ...traj, status: "fail", httpStatus: 429, attempts: 0, latencyMs: Date.now() - started, error: "model limit exceeded" });
    return modelDenied;
  }
  const cacheModeHeader = String(c.req.header("x-gateway-cache") || "true").toLowerCase();
  // Per-key: a key that turned its response cache off in the console never serves
  // or writes cached completions, regardless of any other key's choice.
  const keyCacheOn = !key || Number(key.response_cache) !== 0;
  const cacheSetting = keyCacheOn ? cacheModeHeader : "off";
  const cacheMode = (cacheSetting === "off" || cacheSetting === "false" || cacheSetting === "0") ? "off" : cacheSetting;
  const cacheable = !!key && !autoDecision && isCacheableRequest(payload, isStream, cacheMode);
  const cacheKey = cacheable ? await responseCacheKey(key, slug, payload) : null;
  blog("REQ id=" + requestId + " model=" + slug + " stream=" + isStream + " cache=" + cacheMode + (cacheKey ? "" : "-skip") + " key=" + (key ? key.name : "admin-playground"));
  if (cacheKey && cacheMode !== "refresh") {
    const cached = await lookupResponseCache(c, cacheKey);
    if (cached) {
      blog("TRACE id=" + requestId + " cache=HIT ms=" + (Date.now() - started));
      await recordTrajectory(c, { ...traj, status: "ok", httpStatus: 200, cacheState: "HIT", latencyMs: Date.now() - started, totalTokens: cached.source_tokens || 0, costUsd: cached.source_cost_usd || 0, responseJson: cached.response_body });
      await finishRequestSummary(c.env.DB, requestId, { status: "ok", httpStatus: 200, cacheState: "HIT", latencyMs: Date.now() - started, totalTokens: Number(cached.source_tokens) || 0, costUsd: Number(cached.source_cost_usd) || 0 });
      return serveCachedCompletion(c, { cached, key, slug, payload, started, state: "HIT" });
    }
  }
  let cacheLeaseId = null;
  if (cacheKey && cacheMode === "true") {
    const deadline = Date.now() + RESPONSE_CACHE_WAIT_MS;
    let attempt = 0;
    while (Date.now() < deadline) {
      const lease = await acquireResponseCacheLease(c, cacheKey);
      if (lease.acquired) {
        cacheLeaseId = lease.leaseId;
        break;
      }
      if (lease.unavailable)
        break;
      await sleep(cacheCoalesceDelayMs(attempt++));
      const cached = await lookupResponseCache(c, cacheKey);
      if (cached) {
        blog("TRACE id=" + requestId + " cache=COALESCED ms=" + (Date.now() - started));
        await recordTrajectory(c, { ...traj, status: "ok", httpStatus: 200, cacheState: "COALESCED", latencyMs: Date.now() - started, totalTokens: cached.source_tokens || 0, costUsd: cached.source_cost_usd || 0, responseJson: cached.response_body });
        await finishRequestSummary(c.env.DB, requestId, { status: "ok", httpStatus: 200, cacheState: "COALESCED", latencyMs: Date.now() - started, totalTokens: Number(cached.source_tokens) || 0, costUsd: Number(cached.source_cost_usd) || 0 });
        return serveCachedCompletion(c, { cached, key, slug, payload, started, state: "COALESCED" });
      }
    }
  }
  if (isStream)
    payload.stream_options = { ...payload.stream_options || {}, include_usage: true };
  try {
    let lastErr = null;
    let lastErrStatus = null;
    let lastRetryAfter = null;
    let attempts = 0;
    // Label every request from the canonical Router V2 TaskIR (not just auto
    // traffic), so explicit-model calls also train route-task statistics.
    // Compile from the ORIGINAL request: auto-harness and tool-repair inject
    // gateway-authored text into `payload`, and classifying that instead of
    // the caller's request would poison route-task statistics.
    let attemptTaskType = "";
    try { attemptTaskType = (compileTaskIR(originalPayload) || {}).task || ""; } catch {}
    let realAttemptSeq = 0;
    let previousRealRouteId = null;
    let shadowRecorded = false;
    for (const route of routes.results) {
      if (autoDecision && !shadowRecorded) {
        shadowRecorded = true;
        await recordLatencyShadow(c, requestId, route, autoDecision, attemptTaskType, routes.results);
      }
      const liveSlug = route.public_slug || slug;
      if (payload.model !== liveSlug)
        payload = { ...payload, model: liveSlug };
      const routeCircuit = circuitKey(route);
      if (circuitOpen(routeCircuit) || circuitOpen("provider", route.provider_id)) {
        blog("ROUTE skip provider=" + route.provider_name + " circuit-open");
        traj.steps.push({ provider: route.provider_name, rank: route.rank, error: "circuit open", ms: 0, slug: liveSlug });
        lastErr = "upstream circuit open";
        attempts++;
        continue;
      }
      const stepStart = Date.now();
      const baseStep = { provider: route.provider_name, rank: route.rank, slug: liveSlug };
      let strategy = "round_robin";
      try {
        const prow = await c.env.DB.prepare("SELECT key_strategy FROM providers WHERE id=?").bind(route.provider_id).first();
        if (prow && prow.key_strategy)
          strategy = String(prow.key_strategy);
      } catch {
      }
      const allKeys = await providerKeys(c, route.provider_id);
      if (!allKeys.length) {
        lastErr = "provider " + route.provider_name + " has no key";
        traj.steps.push({ ...baseStep, error: "no key", ms: Date.now() - stepStart });
        attempts++;
        continue;
      }
      const orderedKeys = orderKeys(allKeys, strategy, route.provider_id);
      // Circuits are keyed per credential: a dead key is quarantined without
      // taking the provider out of rotation for its healthy siblings.
      keyLoop: for (const k of orderedKeys) {
        if (circuitOpen("key", k.keyId)) {
          blog("ROUTE skip provider=" + route.provider_id + " key=" + k.label + " circuit-open");
          traj.steps.push({ ...baseStep, error: "key circuit open", ms: 0 });
          attempts++;
          continue keyLoop;
        }
        // Three in-place attempts for transport / 5xx / opaque relay errors;
        // then the next credential, then the next route.
        for (let transportAttempt = 0; transportAttempt < SAME_KEY_ATTEMPTS; transportAttempt++) {
        const _attStart = Date.now();
        const _attStartIso = nowIso();
        const _attemptIndex = ++realAttemptSeq;
        const _fallbackFrom = (previousRealRouteId != null && previousRealRouteId !== route.id) ? previousRealRouteId : null;
        previousRealRouteId = route.id;
        const _att = { recorded: false, success: 0, status: null, why: null, errKind: null, headers: null, ttft: null, prompt: 0, completion: 0, cost: null };
        try {
          // Stable Z.AI session/browser identity must be server-controlled and
          // credential-specific. Never derive pool identity from JWT claims.
          const attemptRoute = isZaiWebFormat(route.fmt)
            ? { ...route, zai_session_key: "provider:" + route.provider_id + ":key:" + k.keyId }
            : route;
          const res = await forwardToProvider(c, attemptRoute, k.key, payload, isStream, requestId);
          const up = res.response;
          _att.headers = Date.now() - _attStart;
          _att.status = up.status;
          // chat.z.ai retires its session cookie as it issues a new one; keep
          // the stored secret current so the route survives past the rotation.
          if (res.recovered && res.recovered !== k.key && k.keyId)
            await updateProviderKeySecret(c, k.keyId, withRotatedToken(k.key, res.recovered));
          await c.env.DB.prepare("UPDATE providers SET last_status=?, last_checked=? WHERE id=?").bind(up.status, nowIso(), route.provider_id).run();
          if (!up.ok || !up.body) {
            const txt = await up.text();
            const why = classifyUpstreamFailure(txt);
            _att.why = why;
            blog("FWD FAIL " + route.provider_name + " key=" + k.label + " -> HTTP " + up.status + " [" + why + "] " + String(txt).slice(0, 300));
            // Credential-scoped faults quarantine the key, never the provider.
            if (why === "auth") {
              circuitRecordFail("key", k.keyId, { expiresHintMs: 900 });
              if (orderedKeys.indexOf(k) < orderedKeys.length - 1) {
                attempts++;
                continue keyLoop;
              }
              break;
            }
            if (why === "rate_limit") {
              circuitRecordFail("key", k.keyId, { expiresHintMs: 60 });
              if (orderedKeys.indexOf(k) < orderedKeys.length - 1) {
                attempts++;
                continue keyLoop;
              }
              break;
            }
            if (why === "model" || why === "tool_schema" || why === "request_size") {
              if (why === "model") circuitRecordFail("route", route.id);
              attempts++;
              break;
            }
            // 4xx (except 408) and opaque Relbackend 400s are not provider-health.
            circuitRecordFailure(routeCircuit, { status: up.status, kind: why });
            lastErr = "provider " + route.provider_name + " -> HTTP " + up.status + " [" + why + "]";
            lastErrStatus = up.status;
            attempts++;
            if (shouldRetryHttp(transportAttempt, up.status, why)) {
              blog("FWD RETRY " + route.provider_name + " key=" + k.label + " HTTP " + up.status + " [" + why + "] attempt=" + (transportAttempt + 1));
              continue;
            }
            break; // next key/route
          }
          if (!isStream) {
            const txt = await up.text();
            const usage = res.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
            const costUsd = await computeCost(c, liveSlug, usage, route.provider_id);
            const clientTxt = sanitizeClientResponse(txt, liveSlug);
            if (isGenericUpstreamErrorResponse(clientTxt)) {
              _att.why = "malformed";
              blog("FWD MALFORMED " + route.provider_name + " -> " + String(txt).slice(0, 300));
              lastErr = "malformed upstream completion envelope";
              circuitRecordFail("route", route.id);
              traj.steps.push({ ...baseStep, http: up.status, error: "malformed envelope", ms: Date.now() - stepStart });
              attempts++;
              break;
            }
            _att.success = 1; _att.prompt = Number(usage.prompt_tokens) || 0; _att.completion = Number(usage.completion_tokens) || 0; _att.cost = costUsd;
            // Answer-quality evidence (NOT operational success): did the model
            // emit structurally valid tool calls? NULL when none were emitted —
            // a plain-text 200 is not quality evidence and must not train the
            // quality channel. An unparseable success envelope is an operational
            // concern, likewise left as no-evidence here.
            try {
              const _respObj = JSON.parse(clientTxt);
              _att.tool_valid = deriveToolValidFromToolCalls(_respObj && _respObj.choices && _respObj.choices[0] && _respObj.choices[0].message && _respObj.choices[0].message.tool_calls);
            } catch {
            }
            await recordUsage(c, key, { ...usage, cost_usd: costUsd });
            await recordModelUsage(c, liveSlug, usage.total_tokens, costUsd);
            if (cacheKey && isCacheableResponse(clientTxt)) {
              await storeResponseCache(c, {
                cacheKey,
                keyId: key.key_id,
                slug: liveSlug,
                responseBody: clientTxt,
                sourceCostUsd: costUsd,
                sourceTokens: usage.total_tokens,
                ttl: cacheTtlSeconds(c)
              });
            }
            const hdrs = clientResponseHeaders(up.headers, false);
            hdrs["x-request-id"] = requestId;
            hdrs["x-gateway-route"] = String(route.rank);
            hdrs["x-gateway-attempts"] = String(attempts + 1);
            hdrs["x-gateway-model"] = liveSlug;
            if (autoDecision && autoDecision.horizon)
              hdrs["x-gateway-horizon"] = String(autoDecision.horizon.speed || "") + "/" + String(autoDecision.horizon.role || "");
            if (cacheKey)
              hdrs["x-gateway-cache"] = cacheMode === "refresh" ? "REFRESH" : "MISS";
            blog("TRACE id=" + requestId + " ok provider=" + route.provider_name + " model=" + liveSlug + " key=" + k.label + " rank=" + route.rank + " status=" + up.status + " ms=" + (Date.now() - started) + " tokens=" + usage.total_tokens + " cost=" + costUsd);
            circuitRecordOk("provider", route.provider_id);
            circuitRecordOk("route", route.id);
            circuitRecordOk("key", k.keyId);
            traj.steps.push({ ...baseStep, http: up.status, ok: true, key: k.label, ms: Date.now() - stepStart });
            await recordTrajectory(c, { ...traj, slug: liveSlug, status: "ok", httpStatus: up.status, provider: route.provider_name, rank: route.rank, attempts: attempts + 1, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens, costUsd, latencyMs: Date.now() - started, cacheState: cacheKey ? (cacheMode === "refresh" ? "REFRESH" : "MISS") : null, responseJson: clientTxt });
            await finishRequestSummary(c.env.DB, requestId, { status: "ok", httpStatus: up.status, cacheState: cacheKey ? (cacheMode === "refresh" ? "REFRESH" : "MISS") : null, headersMs: _att.headers, latencyMs: Date.now() - _attStart, promptTokens: Number(usage.prompt_tokens) || 0, completionTokens: Number(usage.completion_tokens) || 0, totalTokens: Number(usage.total_tokens) || 0, costUsd, attempts: attempts + 1 });
            if (autoDecision)
              await finishLatencyShadow(c, requestId, { headersMs: _att.headers, ttftMs: null, finishedMs: Date.now() - _attStart, cancelled: false });
            return new Response(clientTxt, { status: up.status, headers: hdrs });
          }
          circuitRecordOk("provider", route.provider_id);
          circuitRecordOk("route", route.id);
          circuitRecordOk("key", k.keyId);
          blog("TRACE id=" + requestId + " stream provider=" + route.provider_name + " model=" + liveSlug + " key=" + k.label + " rank=" + route.rank);
          traj.steps.push({ ...baseStep, http: up.status, ok: true, key: k.label, ms: Date.now() - stepStart, streaming: true });
          _att.recorded = true;
          const _streamAttemptId = await recordRouteAttempt(c, { request_id: requestId, parent_slug: slug, route_id: route.id, provider_id: route.provider_id, provider_key_id: k.keyId, public_slug: liveSlug, upstream_model: route.upstream_model, transport: route.transport || route.fmt, task_type: attemptTaskType, attempt_index: _attemptIndex, key_attempt_index: transportAttempt, started_at: _attStartIso, finished_at: nowIso(), latency_ms: Date.now() - _attStart, headers_ms: _att.headers, ttft_ms: null, success: 1, health_impact: 0, http_status: up.status, fallback_from_route_id: _fallbackFrom, deferPosterior: true, ...shadowAttemptFields(autoDecision) });
          const horizonHdrs = { "x-gateway-model": liveSlug };
          if (autoDecision && autoDecision.horizon)
            horizonHdrs["x-gateway-horizon"] = String(autoDecision.horizon.speed || "") + "/" + String(autoDecision.horizon.role || "");
          const result = await handleStream(c, up, key, liveSlug, route, requestId, payload, started, res.usage, { traj: { ...traj, slug: liveSlug }, attempts: attempts + 1, cacheKey, cacheTtlSeconds: cacheTtlSeconds(c), gatewayHeaders: horizonHdrs, attemptId: _streamAttemptId, attemptStart: _attStart, attemptTaskType, headersMs: _att.headers });
          return result;
        } catch (e) {
          // Adapter diagnostics stay internal; only gateway-owned errors cross
          // the public API boundary.
          _att.status = (e && e.status) || 0;
          _att.errKind = (e && e.code) || "transport";
          if (e instanceof ZaiWebError) {
            // Credential faults quarantine the key; provider faults hit the
            // keyed provider breaker. Route faults hit the route.
            if (e.status === 401 || e.status === 403) {
              circuitRecordFail("key", k.keyId, { expiresHintMs: 900 });
              attempts++;
              continue keyLoop;
            }
            if (e.status === 429) {
              circuitRecordFail("key", k.keyId, { expiresHintMs: 60 });
              attempts++;
              continue keyLoop;
            }
            if (e.status === 404) {
              circuitRecordFail("route", route.id);
              attempts++;
              break;
            }
            if (e.status >= 500)
              circuitRecordFailure(routeCircuit, { status: e.status, kind: e.code });
            if (Number(e.retryAfterSec) > 0)
              lastRetryAfter = Math.max(Number(lastRetryAfter) || 0, Math.ceil(Number(e.retryAfterSec)));
            blog("FWD ZAI " + route.provider_name + " -> " + e.status + " " + e.code + " " + e.message);
            traj.steps.push({ ...baseStep, error: e.code, key: k.label, http: e.status, ms: Date.now() - stepStart });
            if (e.status < 500) {
              const pub = publicProviderError(e);
              await recordTrajectory(c, { ...traj, status: "fail", httpStatus: pub.status, provider: route.provider_name, rank: route.rank, attempts: attempts + 1, latencyMs: Date.now() - started, error: e.code + ": " + e.message });
              await finishRequestSummary(c.env.DB, requestId, { status: "fail", httpStatus: pub.status, attempts: attempts + 1, latencyMs: Date.now() - started });
              return c.json({ error: pub.error }, pub.status, { "x-gateway-attempts": String(attempts + 1) });
            }
            attempts++;
            lastErr = "provider " + route.provider_name + " -> " + e.code;
            lastErrStatus = e.status === 504 ? 504 : 503;
            if (shouldRetryHttp(transportAttempt, e.status, e.code)) {
              blog("FWD RETRY " + route.provider_name + " key=" + k.label + " zai HTTP " + e.status + " attempt=" + (transportAttempt + 1));
              continue;
            }
            break;
          }
          circuitRecordFailure(routeCircuit, { status: (e && e.status) || 0, kind: "unknown" });
          blog("FWD CATCH " + route.provider_name + " key=" + k.label + " -> " + String(e && e.message || e) + (e && e.code ? " [" + e.code + "]" : "") + (c.__egressFailure ? " egress=" + c.__egressFailure : ""));
          lastErr = "upstream transport error";
          if (e && e.status)
            lastErrStatus = e.status;
          traj.steps.push({ ...baseStep, error: String(e.message || e).slice(0, 300), key: k.label, ms: Date.now() - stepStart });
          attempts++;
          if (shouldRetrySameKey(transportAttempt, e)) {
            blog("FWD RETRY " + route.provider_name + " key=" + k.label + " pre-header transport error");
            continue;
          }
        } finally {
          if (!_att.recorded) {
            // A proxy-egress failure (the helper's X-Egress-Proxy dial failed,
            // NOT chat.z.ai) must not train route/model health. Attribute it to
            // the proxy pool, invalidate the sticky pick, and record the attempt
            // with health_impact=0.
            const egressCls = c.__egressFailure;
            let cls;
            if (egressCls && !_att.success) {
              cls = { failure_class: "egress_failure", health_impact: 0 };
              await noteEgressFailure(c, egressCls);
            } else {
              cls = _att.success ? null : classifyAttempt(_att.status, _att.why, _att.errKind);
            }
            c.__egressFailure = null;
            await recordRouteAttempt(c, { request_id: requestId, parent_slug: slug, route_id: route.id, provider_id: route.provider_id, provider_key_id: k.keyId, public_slug: liveSlug, upstream_model: route.upstream_model, transport: route.transport || route.fmt, task_type: attemptTaskType, attempt_index: _attemptIndex, key_attempt_index: transportAttempt, started_at: _attStartIso, finished_at: nowIso(), latency_ms: Date.now() - _attStart, headers_ms: _att.headers, ttft_ms: null, success: _att.success, health_impact: _att.success ? 1 : cls.health_impact, http_status: _att.status, failure_class: _att.success ? "success" : cls.failure_class, failure_code: _att.success ? null : (egressCls ? "egress:" + egressCls : (_att.why || _att.errKind || null)), prompt_tokens: _att.prompt, completion_tokens: _att.completion, actual_cost_usd: _att.cost, fallback_from_route_id: _fallbackFrom, tool_valid: _att.tool_valid ?? null, deferPosterior: false, ...(_att.success ? shadowAttemptFields(autoDecision) : {}) });
          }
        }
        }
      }
    }
    if (autoDecision && shadowRecorded)
      await finishLatencyShadow(c, requestId, { headersMs: null, ttftMs: null, finishedMs: Date.now() - started, cancelled: false });
    blog("TRACE id=" + requestId + " fail attempts=" + attempts + " ms=" + (Date.now() - started) + " err=" + String(lastErr || "no routes"));
    const finalStatus = lastErrStatus || 503;
    await recordTrajectory(c, { ...traj, status: "fail", httpStatus: finalStatus, attempts, latencyMs: Date.now() - started, cacheState: cacheKey ? "MISS" : null, error: lastErr || "no healthy route succeeded" });
    await finishRequestSummary(c.env.DB, requestId, { status: "fail", httpStatus: finalStatus, attempts, latencyMs: Date.now() - started, cacheState: cacheKey ? "MISS" : null });
    const errBody = lastErrStatus === 504
      ? { error: { message: "The selected model did not respond in time. Please retry.", type: "upstream_error", code: "upstream_timeout" } }
      : genericUpstreamError();
    const finalHeaders = { "x-gateway-attempts": String(attempts || routes.results.length) };
    if (Number(lastRetryAfter) > 0) finalHeaders["retry-after"] = String(lastRetryAfter);
    return c.json(errBody, finalStatus, finalHeaders);
  } finally {
    await releaseResponseCacheLease(c, cacheKey, cacheLeaseId);
  }
}
// Private reasoning is a per-generation, per-model artifact — never valid
// conversational state to feed back into a (possibly different) provider. A
// client that echoes assistant `reasoning_content`/`thinking` from an earlier
// turn would otherwise ship another model's stale scratch work upstream, which
// at large context is tens of thousands of contaminating tokens. Strip these
// fields from HISTORICAL assistant messages before forwarding; keep content +
// tool_calls (the real conversation state). The Z.AI shim already folds to
// content+tool_calls, so this covers the generic OpenAI/OCI/Koyeb/Anthropic
// paths. Returns the same payload object when nothing needed stripping.
var REASONING_FIELDS = ["reasoning_content", "reasoning", "thinking", "analysis", "thinking_blocks", "reasoning_details"];
function stripHistoricalReasoning(payload) {
  const msgs = payload && Array.isArray(payload.messages) ? payload.messages : null;
  if (!msgs) return payload;
  let dirty = false;
  const cleaned = msgs.map((m) => {
    if (!m || m.role !== "assistant") return m;
    let hit = false;
    for (const f of REASONING_FIELDS) if (f in Object(m)) { hit = true; break; }
    if (!hit) return m;
    dirty = true;
    const copy = { ...m };
    for (const f of REASONING_FIELDS) delete copy[f];
    return copy;
  });
  if (!dirty) return payload;
  return { ...payload, messages: cleaned };
}
async function forwardToProvider(c, route, apiKey, payload, isStream, requestId) {
  const fmt2 = (route.fmt || "openai").toLowerCase();
  // Auto proxy-pool: resolve the sticky egress once per request for Z.AI
  // routes (the only traffic that goes through the uTLS helper). Cached and
  // sticky, so warmup/auth/captcha/completion/delete share one identity.
  if (isZaiMintedFormat(fmt2) || isZaiBrowserFormat(fmt2) || isZaiWebFormat(fmt2)) {
    try { c.zaiEgress = await resolveActiveEgress(c); } catch { c.zaiEgress = null; }
  }
  if (isZaiMintedFormat(fmt2)) {
    if (route.transport && route.transport !== "auto" && route.transport !== "direct")
      throw new ZaiWebError(400, 'Z.AI minted routes must use direct transport (transport="' + route.transport + '").', "zai_transport");
    blog("FWD zaiminted model=" + (route.upstream_model || (payload && payload.model)));
    return callZaiMinted(c, route, apiKey, payload, isStream, (url, init) => upstreamFetch(c, url, init));
  }
  if (isZaiBrowserFormat(fmt2)) {
    if (route.transport && route.transport !== "auto" && route.transport !== "direct")
      throw new ZaiWebError(400, 'Z.AI browser routes must use direct transport (transport="' + route.transport + '"); the browser runs on the gateway host.', "zai_transport");
    blog("FWD zaibrowser model=" + (route.upstream_model || (payload && payload.model)));
    return callZaiBrowser(c, route, apiKey, payload, isStream);
  }
  // Z.ai consumer web chat is signed-HTTP only: it talks to chat.z.ai with a
  // session JWT, not to a base_url. Relays would strip the session, so it is
  // clamped to direct egress rather than silently failing through a tunnel.
  if (isZaiWebFormat(fmt2)) {
    if (route.transport && route.transport !== "auto" && route.transport !== "direct")
      throw new ZaiWebError(400, 'Z.ai web-chat routes must use direct transport (transport="' + route.transport + '").', "zai_transport");
    blog("FWD zaiweb model=" + (route.upstream_model || (payload && payload.model)));
    return callZaiWeb(c, route, apiKey, payload, isStream, (url, init) => upstreamFetch(c, url, init));
  }
  // Non-Z.AI paths forward the caller's messages to the provider; scrub any
  // stale cross-model private reasoning first (the Z.AI shim already strips it).
  // A provider that genuinely needs its own opaque reasoning artifact for
  // continuation opts out EXPLICITLY via route.preserve_reasoning — the default
  // cross-model path never carries another model's hidden reasoning.
  if (!route.preserve_reasoning)
    payload = stripHistoricalReasoning(payload);
  const transport = routeTransport(route, c.env);
  if (transport === "oci" && route.proxy_url) {
    blog("FWD proxy_url present len=" + route.proxy_url.length);
    const reqBody = JSON.stringify({ ...payload, model: route.upstream_model });
    const target = fmt2 === "anthropic" ? route.base_url + "/messages" : route.base_url + "/chat/completions";
    const headers = withExtraHeaders(fmt2 === "anthropic" ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION } : { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, route);
    return fetchViaProxy(c, route.proxy_url, target, "POST", headers, reqBody);
  }
  if (transport === "koyeb") {
    blog("FWD koyeb provider=" + route.provider_name);
    return fetchViaKoyeb(c, route, apiKey, payload, isStream, requestId);
  }
  blog("FWD DIRECT; route keys=" + Object.keys(route).join(",") + " proxy_url=" + route.proxy_url);
  if (fmt2 === "anthropic")
    return forwardAnthropic(c, route, apiKey, payload);
  return forwardOpenAI(c, route, apiKey, payload);
}
var PROXY_TIMEOUT_MS = 20000;
// undici (Node's fetch) kills responses whose headers take >300s and has a
// small default body timeout; slow large-context generations surface as
// "socket connection was closed unexpectedly". Raise the ceilings.
var upstreamDispatcherReady = false;
async function ensureUpstreamDispatcher() {
  if (upstreamDispatcherReady)
    return;
  upstreamDispatcherReady = true;
  try {
    const undici = await import("undici").catch(() => null);
    if (undici && undici.setGlobalDispatcher && undici.Agent) {
      undici.setGlobalDispatcher(new undici.Agent({
        headersTimeout: 600000,
        bodyTimeout: 0,
        connectTimeout: 30000
      }));
    }
  } catch (e) {
    blog("UPSTREAM dispatcher setup failed: " + String(e.message || e));
  }
}
// Direct upstream calls: big-context agentic turns (100KB+ bodies) legitimately
// take minutes to process before the first byte. The timeout covers ONLY the
// window until response headers arrive — once the upstream starts streaming,
// the body is unbounded so long generations are never cut mid-stream. Tune via
// env UPSTREAM_TIMEOUT_MS (default 10 min).
var UPSTREAM_TIMEOUT_MS = 600000;
function upstreamFetch(c, url, init) {
  const ctrl = new AbortController();
  // A per-call timeoutMs overrides the default generation ceiling. Session
  // bootstrap (warm/guest/auth) is a quick handshake and must fail fast; only
  // the completion stream deserves the long UPSTREAM_TIMEOUT_MS window.
  const opts = { ...init };
  const override = Number(opts.timeoutMs);
  delete opts.timeoutMs;
  const ms = Number.isFinite(override) && override > 0 ? override : (Number(c && c.env && c.env.UPSTREAM_TIMEOUT_MS) || UPSTREAM_TIMEOUT_MS);
  // Compose, do not replace, a caller-supplied signal: the session layer arms
  // its own deadline that must cover response-BODY consumption (this timer
  // only guards time-to-headers). Both can abort the underlying fetch.
  const signal = opts.signal
    ? (typeof AbortSignal.any === "function" ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal)
    : ctrl.signal;
  delete opts.signal;
  let timer = null;
  const clear = () => clearTimeout(timer);
  try {
    const p = fetch(url, { ...opts, signal });
    // Arm the abort AFTER fetch() is issued; clear the moment headers land.
    timer = setTimeout(() => ctrl.abort(), ms);
    return p.then((r) => { clear(); return r; }).catch((e) => {
      if (e && e.name === "AbortError") {
        const err = new Error("upstream did not respond within " + ms + "ms");
        err.status = 504;
        err.code = "upstream_timeout";
        throw err;
      }
      throw e;
    }).finally(clear);
  } catch (e) {
    clear();
    throw e;
  }
}
async function fetchViaProxy(c, proxyUrl, targetUrl, method, headers, body) {
  const sep = proxyUrl.includes("?") ? "&" : "?";
  const fwd = proxyUrl + sep + "url=" + encodeURIComponent(targetUrl);
  const fwdHeaders = { ...headers };
  delete fwdHeaders["host"];
  delete fwdHeaders["content-length"];
  delete fwdHeaders["connection"];
  delete fwdHeaders["transfer-encoding"];
  const ctrl = new AbortController();
  // Header-window cap like upstreamFetch: slow big-context first bytes get
  // their minutes; once headers land the body streams unbounded.
  const ms = Math.max(PROXY_TIMEOUT_MS, Number(c && c.env && c.env.UPSTREAM_TIMEOUT_MS) || UPSTREAM_TIMEOUT_MS);
  let timer = null;
  const clear = () => { if (timer) clearTimeout(timer); };
  try {
    const p = fetch(fwd, {
      method: method || "POST",
      headers: fwdHeaders,
      body: body || void 0,
      signal: ctrl.signal
    });
    timer = setTimeout(() => ctrl.abort(), ms);
    const r = await p.then((resp) => { clear(); return resp; });
    let usage = null;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      try {
        const txt = await r.clone().text();
        const p2 = JSON.parse(txt);
        if (p2 && p2.usage)
          usage = usageFrom(p2);
      } catch {
      }
    }
    return { response: r, usage };
  } catch (e) {
    if (e && e.name === "AbortError") {
      const err = new Error("proxy did not respond within " + ms + "ms");
      err.status = 504;
      err.code = "upstream_timeout";
      throw err;
    }
    throw e;
  } finally {
    clear();
  }
}
var KOYEB_TUNNEL_VERSION = 1;
var KOYEB_CONNECT_TIMEOUT_MS = 30000;
var KOYEB_MAX_NONSTREAM_BYTES = 16777216;
function koyebCfg(env) {
  return {
    backend: String(env && env.RELAY_BACKEND || "koyeb").toLowerCase(),
    url: String(env && env.KOYEB_RELAY_URL || ""),
    secret: String(env && env.KOYEB_RELAY_SECRET || "")
  };
}
var PROVIDER_FORMATS = ["openai", "anthropic", "zaiweb", "zaiwebbrowser", "zaiminted"];
function normalizeProviderFormat(value, fallback) {
  const fmt2 = String(value == null ? "" : value).trim().toLowerCase();
  if (!fmt2)
    return fallback || "openai";
  if (!PROVIDER_FORMATS.includes(fmt2))
    throw new Error("fmt must be one of " + PROVIDER_FORMATS.join(", "));
  return fmt2;
}
function routeTransport(route, env) {
  const explicit = String(route.transport || "auto").toLowerCase();
  if (explicit === "direct")
    return "direct";
  if (explicit === "koyeb" || explicit === "oci") {
    if (explicit === "oci" && !route.proxy_url)
      return "direct";
    if (explicit === "koyeb") {
      const cfg = koyebCfg(env);
      if (!cfg.url || !cfg.secret)
        return route.proxy_url ? "oci" : "direct";
    }
    return explicit;
  }
  if (!route.proxy_url)
    return "direct";
  const cfg = koyebCfg(env);
  if (cfg.backend === "oci")
    return "oci";
  if (!cfg.url || !cfg.secret)
    return "oci";
  return "koyeb";
}
function transportLabel(transport) {
  return transport === "direct" ? "DIRECT" : transport === "koyeb" ? "via-koyeb" : "via-proxy";
}
function normalizeTransport(value) {
  const t = String(value == null ? "auto" : value).toLowerCase();
  if (t === "auto" || t === "direct" || t === "koyeb" || t === "oci")
    return t;
  throw new Error("transport must be auto, direct, koyeb, or oci");
}
var EXTRA_HEADER_FORBIDDEN = ["authorization", "x-api-key", "content-type", "content-length", "host", "connection", "transfer-encoding", "cookie", "set-cookie", "proxy-authenticate", "proxy-authorization", "keep-alive", "upgrade", "te", "trailer"];
function normalizeExtraHeaders(value) {
  let obj = {};
  if (value == null || value === "")
    return "{}";
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{")) {
      try {
        obj = JSON.parse(text);
      } catch {
        throw new Error("extra_headers must be valid JSON or Name: value lines");
      }
    } else {
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#"))
          continue;
        const i = t.indexOf(":");
        if (i < 1)
          throw new Error("extra_headers line needs Name: value (" + t.slice(0, 40) + ")");
        obj[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
    }
  } else if (typeof value === "object") {
    obj = value;
  } else {
    throw new Error("extra_headers must be an object or Name: value lines");
  }
  const out = {};
  const names = Object.keys(obj);
  if (names.length > 16)
    throw new Error("extra_headers allows at most 16 headers");
  for (const raw of names) {
    const name = String(raw).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name) || name.length > 64)
      throw new Error("bad extra header name: " + name.slice(0, 40));
    if (EXTRA_HEADER_FORBIDDEN.includes(name.toLowerCase()))
      throw new Error("extra header not allowed: " + name);
    const val = String(obj[raw] == null ? "" : obj[raw]);
    if (val.length > 512)
      throw new Error("extra header value too long: " + name);
    out[name] = val;
  }
  return JSON.stringify(out);
}
function providerExtraHeaders(route) {
  try {
    const raw = route && route.extra_headers;
    if (!raw)
      return {};
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== "object")
      return {};
    const out = {};
    for (const k of Object.keys(obj)) {
      if (!EXTRA_HEADER_FORBIDDEN.includes(String(k).toLowerCase()))
        out[k] = String(obj[k]);
    }
    return out;
  } catch {
    return {};
  }
}
function withExtraHeaders(headers, route) {
  const out = { ...headers };
  const extra = providerExtraHeaders(route);
  for (const k of Object.keys(extra)) {
    if (["content-type", "authorization", "x-api-key"].includes(k.toLowerCase()))
      continue;
    out[k] = extra[k];
  }
  return out;
}
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function sha256hexBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function koyebConnect(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          ws.close();
        } catch {
        }
        reject(new Error("connect timeout"));
      }
    }, timeoutMs);
    ws.addEventListener("open", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(ws);
      }
    });
    ws.addEventListener("error", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error("connect failed"));
      }
    });
  });
}
async function koyebExchange(c, opts) {
  const cfg = koyebCfg(c.env);
  const bodyHash = await sha256hexBytes(opts.body);
  const timestamp = String(Date.now());
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  let nonce = "";
  for (const b of nonceBytes)
    nonce += b.toString(16).padStart(2, "0");
  const canonical = ["v1", timestamp, nonce, opts.requestId, opts.provider, opts.method, opts.path, "", bodyHash].join("\n");
  const signature = await hmacHex(cfg.secret, canonical);
  let ws = null;
  let attempt = 0;
  const t0 = Date.now();
  for (; ;) {
    try {
      ws = await koyebConnect(cfg.url, KOYEB_CONNECT_TIMEOUT_MS);
      break;
    } catch (e) {
      if (++attempt >= 3)
        throw new Error("koyeb relay unreachable: " + String(e && e.message || e));
      await sleep(500 * attempt + Math.floor(Math.random() * 250 * attempt));
    }
  }
  const connectMs = Date.now() - t0;
  try {
    ws.binaryType = "arraybuffer";
    const queue = [];
    let waiter = null;
    let tunnelClosed = false;
    ws.addEventListener("message", (ev) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.resolve(ev.data);
      } else {
        queue.push(ev.data);
      }
    });
    ws.addEventListener("close", () => {
      tunnelClosed = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.reject(new Error("koyeb tunnel closed"));
      }
    });
    const nextFrame = () => {
      if (queue.length)
        return Promise.resolve(queue.shift());
      if (tunnelClosed)
        return Promise.reject(new Error("koyeb tunnel closed"));
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    };
    ws.send(JSON.stringify({ type: "open", version: KOYEB_TUNNEL_VERSION, requestId: opts.requestId, provider: opts.provider, method: opts.method, path: opts.path, query: "", headers: opts.headers, bodySha256: bodyHash, bodyLen: opts.body.length, timestamp, nonce, signature }));
    for (let off = 0; off < opts.body.length; off += 65536)
      ws.send(opts.body.slice(off, off + 65536));
    ws.send(JSON.stringify({ type: "request_end", requestId: opts.requestId }));
    let status = 0;
    let respHeaders = {};
    let firstByteAt = 0;
    let streamController = null;
    let stream = null;
    if (opts.isStream) {
      stream = new ReadableStream({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          try {
            ws.close();
          } catch {
          }
        }
      });
    }
    const chunks = [];
    let received = 0;
    let prematureEof = false;
    for (; ;) {
      const msg = await nextFrame();
      if (typeof msg === "string") {
        let frame = null;
        try {
          frame = JSON.parse(msg);
        } catch {
          throw new Error("koyeb relay sent malformed frame");
        }
        if (frame.type === "accepted")
          continue;
        if (frame.type === "response") {
          status = Number(frame.status) || 0;
          if (frame.headers && typeof frame.headers === "object")
            respHeaders = frame.headers;
          continue;
        }
        if (frame.type === "response_end") {
          if (frame.prematureEof)
            prematureEof = true;
          break;
        }
        if (frame.type === "error")
          throw new Error("koyeb relay: " + String(frame.code || "error") + ": " + String(frame.message || "unknown"));
      }
      const bytes = new Uint8Array(msg);
      if (!firstByteAt)
        firstByteAt = Date.now();
      if (opts.isStream) {
        try {
          streamController.enqueue(bytes);
        } catch {
          break;
        }
      } else {
        received += bytes.length;
        if (received > KOYEB_MAX_NONSTREAM_BYTES) {
          try {
            ws.close();
          } catch {
          }
          throw new Error("koyeb response exceeded size limit");
        }
        chunks.push(bytes);
      }
    }
    try {
      ws.close();
    } catch {
    }
    if (opts.isStream && streamController) {
      // The relay tunnel is closed. The reader must see done or it parks
      // forever waiting for a frame that will never arrive.
      try {
        streamController.close();
      } catch {
      }
    }
    let body = null;
    if (!opts.isStream) {
      body = new Uint8Array(received);
      let at = 0;
      for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.length;
      }
    }
    return { status, headers: respHeaders, stream, bytes: body, connectMs, ttfbMs: firstByteAt ? firstByteAt - t0 : 0, prematureEof };
  } catch (e) {
    try {
      ws.close();
    } catch {
    }
    if (opts.isStream && streamController) {
      // The tunnel failed mid-stream. The reader must see the stream end or
      // it parks forever waiting for a frame that will never arrive. Error
      // it so the downstream pump runs its own terminal path.
      try {
        streamController.error(e);
      } catch {
      }
    }
    throw e;
  }
}
function toAnthropicImageBlock(p){
  const u=p&&p.image_url&&p.image_url.url||'';
  if(!u) return null;
  if(u.indexOf('data:')===0){
    const m=u.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
    if(m&&m[3]) return {type:'image',source:{type:'base64',media_type:m[1]||'image/png',data:m[3]}};
    return null;
  }
  return {type:'image',source:{type:'url',url:u}};
}
function toAnthropicUserParts(content){
  const arr=typeof content==='string'?[{type:'text',text:content}]:(content||[]);
  const out=[];
  for(const b of arr){
    if(!b) continue;
    if(typeof b==='string'){ out.push({type:'text',text:b}); continue; }
    if(b.type==='image_url'){ const img=toAnthropicImageBlock(b); if(img) out.push(img); continue; }
    if(b.type==='image'&&b.source){ out.push({type:'image',source:b.source}); continue; }
    // Drop provider-specific parts (audio/files): Anthropic would 400 and
    // text+images carry the ask; images are gated to vision models upstream.
    if(b.type==='text'&&typeof b.text==='string'){ out.push({type:'text',text:b.text}); continue; }
    continue;
  }
  return out;
}
function toAnthropicTools(tools){
  const arr=Array.isArray(tools)?tools:[];
  const out=[];
  for(const t of arr){
    const fn=t&&(t.type==='function'?t.function:t);
    if(!fn||!fn.name) continue;
    out.push({name:fn.name,description:fn.description||'',input_schema:fn.parameters&&typeof fn.parameters==='object'?fn.parameters:{type:'object',properties:{}}});
  }
  return out.length?out:null;
}
function toAnthropicToolChoice(choice){
  if(choice==null||choice==='auto') return null;
  if(choice==='none') return {type:'none'};
  if(choice==='required') return {type:'any'};
  if(typeof choice==='object'){
    if(choice.type==='function'&&choice.function&&choice.function.name) return {type:'tool',name:choice.function.name};
    if(choice.type==='tool'&&choice.name) return {type:'tool',name:choice.name};
  }
  return null;
}
function anthropicRequestBody(route, payload) {
  const sysMsgs=toAnthropicMessages(payload.messages || [], payload.system);
  const maxTokens = payload.max_tokens || 1024;
  const tools=toAnthropicTools(payload.tools);
  const toolChoice=toAnthropicToolChoice(payload.tool_choice);
  return {
    model: route.upstream_model,
    messages: sysMsgs.msgs,
    max_tokens: maxTokens,
    ...sysMsgs.system ? { system: sysMsgs.system } : {},
    ...payload.temperature != null ? { temperature: payload.temperature } : {},
    ...payload.top_p != null ? { top_p: payload.top_p } : {},
    ...payload.stop ? { stop_sequences: Array.isArray(payload.stop) ? payload.stop : [payload.stop] } : {},
    ...tools ? { tools: tools } : {},
    ...toolChoice ? { tool_choice: toolChoice } : {},
    ...payload.stream ? { stream: true } : {}
  };
}
async function fetchViaKoyeb(c, route, apiKey, payload, isStream, requestId) {
  const fmt2 = (route.fmt || "openai").toLowerCase();
  const provider = String(route.provider_name || "").toLowerCase();
  let basePath = "";
  try {
    basePath = new URL(route.base_url).pathname.replace(/\/+$/, "");
  } catch {
    basePath = "";
  }
  const targetPath = basePath + (fmt2 === "anthropic" ? "/messages" : "/chat/completions");
  const headers = withExtraHeaders(fmt2 === "anthropic" ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION } : { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, route);
  const reqBody = fmt2 === "anthropic" ? JSON.stringify(anthropicRequestBody(route, payload)) : JSON.stringify({ ...payload, model: route.upstream_model });
  const res = await koyebExchange(c, { provider, method: "POST", path: targetPath, headers, body: encoder.encode(reqBody), isStream, requestId });
  const upHeaders = { "content-type": res.headers["content-type"] || (isStream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8") };
  if (res.headers["retry-after"])
    upHeaders["retry-after"] = res.headers["retry-after"];
  if (fmt2 === "anthropic") {
    if (isStream) {
      const wrapped = wrapAnthropicStream(new Response(res.stream, { headers: upHeaders }), route.upstream_model);
      return { response: wrapped, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 } };
    }
    const txt = new TextDecoder().decode(res.bytes);
    try {
      const oai = fromAnthropic(JSON.parse(txt), route.upstream_model);
      return { response: new Response(JSON.stringify(oai), { status: res.status, headers: { "content-type": "application/json" } }), usage: oai.usage };
    } catch {
    }
    return { response: new Response(res.bytes, { status: res.status, headers: upHeaders }), usage: null };
  }
  const up = new Response(isStream ? res.stream : res.bytes, { status: res.status, headers: upHeaders });
  if (res.prematureEof) Object.defineProperty(up, "prematureEof", { value: true, enumerable: false });
  let usage = null;
  if (!isStream && res.bytes) {
    try {
      const p = JSON.parse(new TextDecoder().decode(res.bytes));
      if (p && p.usage)
        usage = usageFrom(p);
    } catch {
    }
  }
  return { response: up, usage };
}
async function forwardOpenAI(c, route, apiKey, payload) {
  const up = await upstreamFetch(c, route.base_url + "/chat/completions", {
    method: "POST",
    headers: withExtraHeaders({
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
      ...c.env.UPSTREAM_HTTP_REFERER ? { "HTTP-Referer": c.env.UPSTREAM_HTTP_REFERER } : {},
      ...c.env.UPSTREAM_APP_TITLE ? { "X-Title": c.env.UPSTREAM_APP_TITLE } : {}
    }, route),
    body: JSON.stringify({ ...payload, model: route.upstream_model })
  });
  let usage = null;
  if (up.ok && up.body) {
    const ct = up.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
    } else {
      const txt = await up.clone().text();
      try {
        const p = JSON.parse(txt);
        if (p.usage)
          usage = usageFrom(p);
      } catch {
      }
    }
  }
  return { response: up, usage };
}
var ANTHROPIC_VERSION = "2023-06-01";
function toAnthropicMessages(messages, fallbackSystem) {
  const msgs = [];
  let system = fallbackSystem;
  for (const m of messages) {
    if(!m) continue;
    if (m.role === "system"||m.role==="developer") {
      const text=typeof m.content==='string'?m.content:JSON.stringify(m.content==null?'':m.content);
      system=system?system+'\n\n'+text:text;
      continue;
    }
    if (m.role === "assistant") {
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content || []).filter((b) => b && (b.type === "text" || b.type === "image"));
      const calls=Array.isArray(m.tool_calls)?m.tool_calls:[];
      for(const tc of calls){
        let input={};
        try{ input=JSON.parse(tc.function&&tc.function.arguments||'{}'); }catch(e){ input={}; }
        blocks.push({type:'tool_use',id:tc.id||('toolu_'+Math.random().toString(36).slice(2)),name:(tc.function&&tc.function.name)||'tool',input:input});
      }
      msgs.push({ role: "assistant", content: blocks });
      continue;
    }
    if (m.role === "tool") {
      const cid=m.tool_call_id||m.id||'';
      const ctext=typeof m.content==='string'?m.content:JSON.stringify(m.content==null?'':m.content);
      msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: cid, content: ctext }] });
      continue;
    }
    msgs.push({ role: m.role, content: toAnthropicUserParts(m.content) });
  }
  return { system, msgs };
}
function fromAnthropic(body, model) {
  const blocks = body.content || [];
  const text = blocks.map((b) => b.type === "text" ? b.text : "").join("");
  const toolCalls = blocks.filter((b) => b && b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input == null ? {} : b.input) } }));
  let stop = body.stop_reason === "max_tokens" ? "length" : body.stop_reason === "tool_use" ? "tool_calls" : body.stop_reason === "end_turn" ? "stop" : body.stop_reason || "stop";
  if (toolCalls.length) stop = "tool_calls";
  return {
    id: body.id || "cmpl-anthropic",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text, ...toolCalls.length ? { tool_calls: toolCalls } : {} }, finish_reason: stop }],
    usage: {
      prompt_tokens: body.usage ? body.usage.input_tokens : 0,
      completion_tokens: body.usage ? body.usage.output_tokens : 0,
      total_tokens: body.usage ? body.usage.input_tokens + body.usage.output_tokens : 0,
      cost_usd: 0
    }
  };
}
function fromAnthropicStreamChunk(obj, model) {
  if (obj.type === "content_block_delta" && obj.delta && obj.delta.type === "text_delta") {
    return {
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { content: obj.delta.text } }]
    };
  }
  if (obj.type === "message_start") {
    const chunk = {
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { role: "assistant" } }]
    };
    // Anthropic reports input tokens up front; propagate them so gateway
    // usage/cost accounting doesn't lose the prompt side on streams.
    const mu = obj.message && obj.message.usage;
    if (mu && (mu.input_tokens || mu.output_tokens)) {
      chunk.usage = {
        prompt_tokens: mu.input_tokens || 0,
        completion_tokens: mu.output_tokens || 0,
        total_tokens: (mu.input_tokens || 0) + (mu.output_tokens || 0),
        cost_usd: 0
      };
    }
    return chunk;
  }
  if (obj.type === "message_delta" && obj.usage) {
    const sr = obj.delta && obj.delta.stop_reason;
    const fr = sr === "tool_use" ? "tool_calls" : sr === "max_tokens" ? "length" : sr === "end_turn" || sr === "stop_sequence" ? "stop" : null;
    return {
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: {}, ...fr ? { finish_reason: fr } : {} }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: obj.usage.output_tokens || 0,
        total_tokens: obj.usage.output_tokens || 0,
        cost_usd: 0
      }
    };
  }
  if(obj.type==="content_block_start"&&obj.content_block&&obj.content_block.type==="tool_use"){
    return {id:"x",object:"chat.completion.chunk",created:0,model:model,choices:[{index:0,delta:{tool_calls:[{index:obj.index||0,id:obj.content_block.id,function:{name:obj.content_block.name,arguments:""}}]}}]};
  }
  if(obj.type==="content_block_delta"&&obj.delta&&obj.delta.type==="input_json_delta"){
    return {id:"x",object:"chat.completion.chunk",created:0,model:model,choices:[{index:0,delta:{tool_calls:[{index:obj.index||0,function:{arguments:obj.delta.partial_json||""}}]}}]};
  }
  if(obj.type==="message_delta"&&obj.delta&&obj.delta.stop_reason==="tool_use"){
    return {id:"x",object:"chat.completion.chunk",created:0,model:model,choices:[{index:0,delta:{},finish_reason:"tool_calls"}]};
  }
  if (obj.type === "message_stop")
    return null;
  return { id: "x", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: {} }] };
}
async function forwardAnthropic(c, route, apiKey, payload) {
  const reqBody = anthropicRequestBody(route, payload);
  const up = await upstreamFetch(c, route.base_url + "/messages", {
    method: "POST",
    headers: withExtraHeaders({
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      ...c.env.UPSTREAM_APP_TITLE ? { "anthropic-title": c.env.UPSTREAM_APP_TITLE } : {}
    }, route),
    body: JSON.stringify(reqBody)
  });
  if (up.ok && up.body) {
    const ct = up.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      const wrapped = wrapAnthropicStream(up, route.upstream_model);
      return { response: wrapped, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 } };
    }
    const txt = await up.text();
    try {
      const p = JSON.parse(txt);
      const oai = fromAnthropic(p, route.upstream_model);
      return { response: new Response(JSON.stringify(oai), { status: up.status, headers: { "content-type": "application/json" } }), usage: oai.usage };
    } catch {
    }
  }
  return { response: up, usage: null };
}
function wrapAnthropicStream(upReq, model) {
  const reader = upReq.body.getReader();
  const dec = new TextDecoder();
  return new Response(new ReadableStream({
    async start(controller) {
      let buf = "";
      let finishSeen = false;
      let sawMessageStop = false; // upstream sent message_stop: the protocol COMPLETED
      const enc = encoder;
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done)
            break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:"))
              continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]")
              continue;
            let obj;
            try {
              obj = JSON.parse(data);
            } catch {
              continue;
            }
            if (obj && obj.type === "message_stop")
              sawMessageStop = true;
            const chunk = fromAnthropicStreamChunk(obj, model);
            if (!chunk)
              continue;
            if (chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason)
              finishSeen = true;
            controller.enqueue(enc.encode("data: " + JSON.stringify(chunk) + "\n\n"));
          }
        }
        // No stop_reason-bearing message_delta arrived. Two very different
        // cases:
        //  - sawMessageStop: the Anthropic protocol COMPLETED (message_stop)
        //    but the stop_reason-bearing message_delta was missing — a known
        //    upstream quirk. The turn finished cleanly; synthesize "stop" so
        //    OpenAI clients do not hard-fail with "stream closed before a
        //    finish_reason".
        //  - no message_stop: the upstream EOF'd mid-flight — a truncated
        //    stream. Synthesize finish_reason "length", the recognized
        //    non-success terminal, so clients retry instead of reading the
        //    turn as cleanly completed. Never stamp a clean stop here.
        if (!finishSeen) {
          const finishChunk = {
            id: "gen-anthropic",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: sawMessageStop ? "stop" : "length" }]
          };
          controller.enqueue(enc.encode("data: " + JSON.stringify(finishChunk) + "\n\n"));
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        closeSseGracefully(controller, enc, e);
      }
    }
  }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}
async function handleStream(c, upReq, key, slug, route, requestId, payload, started, usageHint, extra) {
  const reader = upReq.body.getReader();
  const dec = new TextDecoder();
  const enc = encoder;
  let controllerRef = null;
  let clientCancelled = false;
  let buf = "";
  let streamError = null;
  let firstTokenAt = null;
  let lastUsage = usageHint || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
  let malformedSseSent = false;
  let sawUpstreamError = false; // a forwarded upstream frame carried `error`
  let contentBuf = "";
  let reasoningBuf = "";
  let toolCallsBuf = [];
  const keepAlive = ((promise) => {
    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === "function")
      ctx.waitUntil(promise);
  });
  const persistOnce = (async () => {
    const costUsd = await computeCost(c, slug, lastUsage, route.provider_id);
    await recordUsage(c, key, { ...lastUsage, cost_usd: costUsd });
    await recordModelUsage(c, slug, lastUsage.total_tokens, costUsd);
    // Terminal outcome, computed once and shared by the route_attempts patch
    // and the trajectory dual-write so both telemetry systems agree.
    const outcome = streamTerminalOutcome({ clientCancelled, streamError, finishSeen });
    // Answer-quality evidence for the streamed attempt: structural validity of
    // the tool calls accumulated across chunks. NULL when none were emitted.
    const _streamToolValid = deriveToolValidFromToolCalls(toolCallsBuf);
    if (extra && extra.attemptId) {
      const attLatency = Date.now() - (extra.attemptStart || started);
      const hi = outcome.health_impact;
      const ttft = firstTokenAt ? (firstTokenAt - (extra.attemptStart || started)) : null;
      try {
        await c.env.DB.prepare("UPDATE route_attempts SET success=?, failure_class=?, health_impact=?, ttft_ms=COALESCE(?, ttft_ms), latency_ms=?, prompt_tokens=?, completion_tokens=?, actual_cost_usd=?, finished_at=?, tool_valid=? WHERE id=?").bind(outcome.success, outcome.failure_class, hi, ttft, attLatency, Number(lastUsage.prompt_tokens) || 0, Number(lastUsage.completion_tokens) || 0, costUsd, nowIso(), _streamToolValid, extra.attemptId).run();
        await finishLatencyShadow(c, requestId, { headersMs: extra.headersMs, ttftMs: ttft, finishedMs: attLatency, cancelled: clientCancelled });
        await finishRequestSummary(c.env.DB, requestId, { status: clientCancelled ? "cancelled" : (outcome.success ? "ok" : "fail"), httpStatus: outcome.http_status, headersMs: extra.headersMs ?? null, ttftMs: ttft, latencyMs: attLatency, promptTokens: Number(lastUsage.prompt_tokens) || 0, completionTokens: Number(lastUsage.completion_tokens) || 0, totalTokens: Number(lastUsage.total_tokens) || 0, costUsd, attempts: extra.attempts || 1 });
      } catch (e) {
        blog("route_attempt stream patch failed: " + String(e.message || e));
      }
      // Quality channel, separate from the operational posterior above: fires
      // only when the terminal outcome carries real answer evidence (valid or
      // invalid tool calls). A bare completed stream with no tool calls emits
      // nothing. Idempotent per (request, attempt, signal, source).
      await emitQualityObservations(c, extra.attemptId, { request_id: requestId, success: outcome.success ? 1 : 0, route_id: route.id, provider_id: route.provider_id, public_slug: slug, upstream_model: route.upstream_model, task_type: extra.attemptTaskType || "", tool_valid: _streamToolValid });
      // Posterior deferred at handoff; observe the real terminal outcome once,
      // and never for a client cancel.
      if (outcome.observe) {
        try {
          const scopeId = "route:" + (route.id ?? "?");
          await updateRouterStat(c, "route", scopeId, "", outcome.success === 1, attLatency, costUsd);
          if (extra.attemptTaskType)
            await updateRouterStat(c, "route_task", scopeId, extra.attemptTaskType, outcome.success === 1, attLatency, costUsd);
          await observeReflex(c, route.id, extra.attemptTaskType || "", outcome.success === 1, attLatency, costUsd);
        } catch (e) {
          blog("route_attempt stream posterior failed: " + String(e.message || e));
        }
      }
    }
    if (extra && extra.traj) {
      const msg = {
        role: "assistant",
        content: contentBuf || null,
        ...(reasoningBuf ? { reasoning_content: reasoningBuf } : {}),
        ...(toolCallsBuf.length ? { tool_calls: toolCallsBuf } : {})
      };
      await recordTrajectory(c, {
        ...extra.traj,
        status: outcome.trajectory_status,
        httpStatus: outcome.http_status,
        provider: route.provider_name,
        rank: route.rank,
        attempts: extra.attempts || 1,
        promptTokens: lastUsage.prompt_tokens,
        completionTokens: lastUsage.completion_tokens,
        totalTokens: lastUsage.total_tokens,
        costUsd,
        latencyMs: Date.now() - started,
        error: streamError || (outcome.success ? null : outcome.failure_class),
        responseJson: (contentBuf || reasoningBuf || toolCallsBuf.length) ? JSON.stringify({ choices: [{ message: msg }], usage: lastUsage }) : null
      });
      if (outcome.failure_class === "success" && extra.cacheKey && (contentBuf || toolCallsBuf.length)) {
        const replayFr = normalizeTerminalFinishReason("stop", hasAccumulatedToolCalls(toolCallsBuf), !!(contentBuf || reasoningBuf));
        const replayBody = JSON.stringify({ id: "cached-" + requestId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: extra.traj.slug, choices: [{ index: 0, message: msg, finish_reason: replayFr !== null ? replayFr : undefined }], usage: lastUsage });
        await storeResponseCache(c, {
          cacheKey: extra.cacheKey,
          keyId: extra.traj.keyId || "admin",
          slug: extra.traj.slug,
          responseBody: replayBody,
          sourceCostUsd: costUsd,
          sourceTokens: lastUsage.total_tokens,
          ttl: extra.cacheTtlSeconds || 3600
        });
      }
    }
  });
  const safeEnqueue = ((text) => {
    if (clientCancelled || !controllerRef)
      return;
    try {
      controllerRef.enqueue(enc.encode(text));
    } catch {
      clientCancelled = true;
    }
  });
  let finishSeen = false; // a forwarded chunk carried a real finish_reason
  let protocolDoneSeen = false; // the upstream sent an explicit [DONE]
  let truncatedEof = false; // relay closed the tunnel on a non-EOF body read
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          // The relay closed the tunnel. A premature upstream EOF (anything
          // other than io.EOF on the relay's body read) is surfaced as
          // prematureEof on the handle; record it but still terminate with a
          // recognized terminal chunk below, never a raw error SSE frame.
          if (upReq && upReq.prematureEof)
            truncatedEof = true;
          break;
        }
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf(String.fromCharCode(10))) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:"))
            continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            protocolDoneSeen = true;
            continue;
          }
          try {
            const obj = JSON.parse(data);
            if (obj && typeof obj === "object" && obj.error)
              sawUpstreamError = true; // forwarded failure frame: never stamp a clean stop below
            const u = usageFrom(obj);
            if (u && (u.total_tokens || u.completion_tokens || u.prompt_tokens))
              lastUsage = u;
            const choices = obj && Array.isArray(obj.choices) ? obj.choices : null;
            // Usage-only shell (choices: []) — captures usage already; a bare
            // "choices: []" chunk crashes strict OpenAI clients (choices[0]).
            if (choices && choices.length === 0) {
              // still let final usage flow on the synthesized finish chunk
              continue;
            }
            const fr = choices && choices[0] && choices[0].finish_reason;
            if (fr) {
              const sawTools = hasAccumulatedToolCalls(toolCallsBuf);
              const fixed = normalizeTerminalFinishReason(fr, sawTools, true);
              if (fixed !== fr)
                choices[0].finish_reason = fixed;
              finishSeen = true;
            }
            const dc = choices && choices[0] && choices[0].delta;
            if (dc) {
              const rc = dc.reasoning_content ?? dc.reasoning ?? dc.thinking;
              const hasContent = typeof dc.content === "string" && dc.content.length > 0;
              const hasReasoning = typeof rc === "string" && rc.length > 0;
              const hasToolDelta = Array.isArray(dc.tool_calls) && dc.tool_calls.length > 0;
              if (firstTokenAt === null && (hasContent || hasReasoning || hasToolDelta))
                firstTokenAt = Date.now();
              if (typeof dc.content === "string" && contentBuf.length < TRAJ_BODY_CAP)
                contentBuf += dc.content;
              if (typeof rc === "string" && reasoningBuf.length < TRAJ_BODY_CAP)
                reasoningBuf += rc;
              if (Array.isArray(dc.tool_calls)) {
                for (const tc of dc.tool_calls) {
                  if (!tc || typeof tc.index !== "number")
                    continue;
                  const slot = toolCallsBuf[tc.index] || (toolCallsBuf[tc.index] = { id: tc.id || null, type: "function", function: { name: "", arguments: "" } });
                  if (tc.id)
                    slot.id = tc.id;
                  if (tc.function && tc.function.name)
                    slot.function.name += tc.function.name;
                  if (tc.function && typeof tc.function.arguments === "string")
                    slot.function.arguments += tc.function.arguments;
                }
              }
            }
            if (obj && obj.model && slug)
              obj.model = slug;
            sanitizeClientObject(obj);
            const chunkJson = JSON.stringify(obj);
            safeEnqueue("data: " + chunkJson + "\n\n");
          } catch {
            if (!malformedSseSent) {
              malformedSseSent = true;
              streamError = "malformed upstream SSE payload";
              const safeError = JSON.stringify(genericUpstreamError());
              safeEnqueue("data: " + safeError + "\n\n");
            }
          }
        }
      }
      if (!clientCancelled) {
        if (!finishSeen) {
          // A stream that forwarded an upstream error frame (or malformed
          // SSE, or a relay tunnel closed on a non-EOF body read) did not
          // complete cleanly: the synthesized terminal must be a non-success
          // finish ("length"), never a clean "stop".
          // Bytes received prove nothing about completion. Only an explicit
          // [DONE] with no transport fault is a clean end; a raw EOF after
          // some text is a truncation and must read as "length".
          const cleanProtocolEnd = protocolDoneSeen && !sawUpstreamError && !malformedSseSent && !truncatedEof;
          const finishReason = normalizeTerminalFinishReason(
            null,
            hasAccumulatedToolCalls(toolCallsBuf),
            cleanProtocolEnd
          );
          const finishChunk = {
            id: "gen-" + requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: slug,
            choices: [{ index: 0, delta: {}, ...(finishReason !== null ? { finish_reason: finishReason } : {}) }]
          };
          const hasUsage = lastUsage && (lastUsage.total_tokens || lastUsage.completion_tokens);
          if (hasUsage)
            finishChunk.usage = {
              prompt_tokens: lastUsage.prompt_tokens || 0,
              completion_tokens: lastUsage.completion_tokens || 0,
              total_tokens: lastUsage.total_tokens || 0
            };
          safeEnqueue("data: " + JSON.stringify(finishChunk) + "\n\n");
        }
        safeEnqueue("data: [DONE]\n\n");
        try {
          controllerRef.close();
        } catch {
        }
      }
    } catch (e) {
      streamError = String(e && e.message || e).slice(0, 4e3);
      blog("Stream error id=" + requestId + " " + streamError);
      if (!clientCancelled)
        closeSseGracefully(controllerRef, enc, e);
    } finally {
      await persistOnce();
    }
  });
  const reader2 = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      const work = pump();
      keepAlive(work.catch((e) => blog("Stream background error=" + String(e && e.message || e))));
    },
    cancel(reason) {
      clientCancelled = true;
      // Stop the upstream generation so we do not keep paying for tokens the
      // client abandoned.
      try { reader.cancel(reason).catch(() => {}); } catch {}
      blog("Stream client cancelled id=" + requestId + " reason=" + String(reason || "unknown").slice(0, 160));
    }
  });
  const hdrs = clientResponseHeaders(upReq.headers, true);
  hdrs["content-type"] = "text/event-stream; charset=utf-8";
  hdrs["cache-control"] = "no-cache, no-store";
  hdrs["connection"] = "keep-alive";
  hdrs["x-request-id"] = requestId;
  if (extra && extra.gatewayHeaders) {
    for (const [k, v] of Object.entries(extra.gatewayHeaders))
      if (v) hdrs[k] = v;
  }
  return new Response(reader2, { status: upReq.status, headers: hdrs });
}
function usageFrom(obj) {
  const u = obj && obj.usage;
  if (!u)
    return null;
  return {
    prompt_tokens: Number(u.prompt_tokens) || 0,
    completion_tokens: Number(u.completion_tokens) || 0,
    total_tokens: Number(u.total_tokens) || (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0),
    cost_usd: Number(u.cost) || 0
  };
}
var MODELS_DEV_API = "https://models.dev/api.json";
function flattenModelsDevCatalog(catalog) {
  const byId = new Map();
  if (!catalog || typeof catalog !== "object")
    return byId;
  for (const provider of Object.values(catalog)) {
    const models = provider && provider.models;
    if (!models || typeof models !== "object")
      continue;
    for (const [key, model] of Object.entries(models)) {
      const id = String((model && model.id) || key || "").trim();
      if (!id)
        continue;
      const cost = model && model.cost;
      const input = Number(cost && cost.input);
      const output = Number(cost && cost.output);
      if (!Number.isFinite(input) && !Number.isFinite(output))
        continue;
      const entry = {
        id,
        prompt_per_1m: Number.isFinite(input) ? input : 0,
        completion_per_1m: Number.isFinite(output) ? output : 0,
        reasoning: !!(model && model.reasoning),
        // Preserve an explicit `tool_call: false` from the catalog; dropping
        // it would make incapable models look eligible for tool traffic.
        ...model && "tool_call" in Object(model) ? { toolCall: model.tool_call } : {},
        attachment: !!(model && model.attachment),
        modalities: model && model.modalities || null,
        limit: model && model.limit || null,
        name: model && model.name ? String(model.name) : null,
        knowledge: model && model.knowledge ? String(model.knowledge) : null,
        release_date: model && model.release_date ? String(model.release_date) : null,
        vision: !!(model && (model.attachment || (model.modalities && Array.isArray(model.modalities.input) && model.modalities.input.includes("image"))))
      };
      if (!byId.has(id) || provider && provider.id && id.startsWith(provider.id + "/"))
        byId.set(id, entry);
      const slash = id.lastIndexOf("/");
      if (slash >= 0) {
        const bare = id.slice(slash + 1);
        if (bare && !byId.has(bare))
          byId.set(bare, entry);
      }
    }
  }
  return byId;
}
function matchModelsDevPrice(byId, slug) {
  const want = String(slug || "").trim();
  if (!want || !byId || !byId.size)
    return null;
  if (byId.has(want))
    return byId.get(want);
  const lower = want.toLowerCase();
  for (const [id, entry] of byId) {
    if (id.toLowerCase() === lower)
      return entry;
  }
  const bareLower = want.includes("/") ? want.slice(want.lastIndexOf("/") + 1).toLowerCase() : want.toLowerCase();
  for (const [id, entry] of byId) {
    if (id.toLowerCase() === bareLower || id.toLowerCase().endsWith("/" + bareLower))
      return entry;
  }
  return null;
}
// ---- Circuit breaker (CLOSED → OPEN → HALF_OPEN) ----
//
// State is keyed by kind + id, not by provider name alone:
//   key:<providerKeyId>   credential quarantine (401/403, hard 429)
//   route:<routeId>       route penalty (model-not-found, malformed)
//   provider:<providerId> provider breaker, only for correlated 5xx/network
//
// Only 5xx and transport/network failures count toward the provider breaker.
// Caller-side faults (auth on the caller's key, bad tool schema, oversized
// context) never touch provider health: the provider is up, the request was
// not servable.
var CIRCUIT_FAILURE_THRESHOLD = 3;
var CIRCUIT_BASE_COOLDOWN_MS = 30000;
var CIRCUIT_MAX_COOLDOWN_MS = 10 * 60000;
var CIRCUIT_WINDOW_MS = 60000;
var circuitState = new Map();
// Accepts three shapes:
//   toKey("provider", 7)            → "provider:7"
//   toKey({ id: 41, provider_id })  → "route:41"
//   toKey("p") / toKey("route:41")  → the string itself
function toKey(kindOrKey, id) {
  if (id !== undefined && id !== null && typeof kindOrKey !== "object")
    return String(kindOrKey) + ":" + String(id);
  if (kindOrKey && typeof kindOrKey === "object") {
    if (kindOrKey.id != null)
      return "route:" + String(kindOrKey.id);
    if (kindOrKey.provider_id != null)
      return "provider:" + String(kindOrKey.provider_id);
  }
  return String(kindOrKey);
}
function circuitKey(kindOrRoute, id) {
  return toKey(kindOrRoute, id);
}

function circuitOpen(kindOrKey, id) {
  const s = circuitState.get(toKey(kindOrKey, id));
  if (!s)
    return false;
  const now = Date.now();
  if (s.openUntil && now < s.openUntil)
    return true;
  if (s.openUntil && now >= s.openUntil) {
    // OPEN → HALF_OPEN: exactly one in-flight probe may try the provider.
    if (s.probeUsed) {
      // A probe that failed into a class the audit gate FILTERS (relay 400s,
      // caller-side 4xx) never reaches recordFailOn, so nothing would ever
      // re-open or release the probe lock. Without a bound, probeUsed stays
      // true forever and the breaker is deadlocked open by a single filtered
      // probe failure. Release the lock after one base cooldown so the next
      // request probes again: the probe window is bounded even when its
      // outcome was classified as not-provider-health.
      if (s.probeAt && now - s.probeAt < CIRCUIT_BASE_COOLDOWN_MS)
        return true;
      s.probeUsed = false;
      s.halfOpen = false;
    }
    s.probeUsed = true;
    s.probeAt = now;
    s.halfOpen = true;
    return false;
  }
  return false;
}
// Classification gate: a failure only reaches the breaker kind the audit
// assigned it to. Caller/request faults, credential faults, quota and
// model-route faults never open the provider-wide breaker. Two call shapes:
//   circuitRecordFailure(circuitName, { status, kind })   — already-built key
//   circuitRecordFailure(kind, id, { status, kind })      — explicit kind+id
function circuitRecordFailure(a, b, c) {
  const f = (c !== undefined ? c : b) || {};
  const key = c !== undefined ? toKey(a, b) : toKey(a);
  const status = Number(f.status) || 0;
  const fkind = String(f.kind || "unknown");
  if (["auth", "rate_limit", "model", "tool_schema", "request_size", "relay"].includes(fkind))
    return;
  if (/(auth|credential|captcha|tokens?|rate|quota|model|tool|vision|request|unsupported|relay|browser_unavailable|model_unavailable|fallback_failed)/i.test(fkind))
    return;
  if (status >= 400 && status < 500 && status !== 408)
    return;
  recordFailOn(key);
}
function __resetCircuitState() {
  circuitState.clear();
}
// Read-only view of every circuit, for the console and the auto router.
function circuitSnapshot() {
  const out = [];
  const now = Date.now();
  for (const [key, s] of circuitState) {
    const sep = key.indexOf(":");
    out.push({
      key,
      kind: sep >= 0 ? key.slice(0, sep) : key,
      id: sep >= 0 ? key.slice(sep + 1) : "",
      fails: s.fails || 0,
      open: !!(s.openUntil && now < s.openUntil),
      halfOpen: !!s.halfOpen,
      openUntil: s.openUntil || null,
      cooldownMs: s.cooldownMs || null,
      consecutiveOpens: s.consecutiveOpens || 0
    });
  }
  return out;
}
function circuitRecordOk(kind, id) {
  const s = circuitState.get(toKey(kind, id));
  if (s) {
    s.fails = 0;
    s.firstFail = 0;
    s.openUntil = 0;
    s.halfOpen = false;
    s.probeUsed = false;
    s.consecutiveOpens = 0;
  }
}
function recordFailOn(key, { expiresHintMs } = {}) {
  const now = Date.now();
  const s = circuitState.get(key) || { fails: 0, firstFail: 0, openUntil: 0, consecutiveOpens: 0, probeUsed: false, halfOpen: false };
  // A HALF_OPEN probe that fails re-opens immediately with an escalated
  // cooldown. Without this, the probe's single failure sat below the 3-strike
  // threshold while probeUsed stayed true, deadlocking the breaker OPEN
  // forever: no further probe was ever allowed, and only a success (which
  // needed a probe) could clear it.
  if (s.halfOpen && s.probeUsed) {
    const n = Math.max(1, s.consecutiveOpens || 1);
    const expo = Math.min(CIRCUIT_MAX_COOLDOWN_MS, CIRCUIT_BASE_COOLDOWN_MS * Math.pow(2, n));
    const jitter = Math.floor(Math.random() * Math.floor(expo * 0.2));
    const cooldown = expiresHintMs ? Math.max(1000, Math.min(CIRCUIT_MAX_COOLDOWN_MS, expiresHintMs * 1000)) : expo + jitter;
    s.openUntil = now + cooldown;
    s.openedAt = now;
    s.cooldownMs = cooldown;
    s.probeUsed = false;
    s.halfOpen = false;
    s.fails = 0;
    s.firstFail = 0;
    s.consecutiveOpens = n + 1;
    circuitState.set(key, s);
    return;
  }
  // Rolling window: failures older than the window do not accumulate.
  if (!s.firstFail || now - s.firstFail > CIRCUIT_WINDOW_MS) {
    s.firstFail = now;
    s.fails = 0;
  }
  s.fails++;
  if (s.fails >= CIRCUIT_FAILURE_THRESHOLD) {
    const n = s.consecutiveOpens || 0;
    const expo = Math.min(CIRCUIT_MAX_COOLDOWN_MS, CIRCUIT_BASE_COOLDOWN_MS * Math.pow(2, n));
    const jitter = Math.floor(Math.random() * Math.floor(expo * 0.2));
    const cooldown = expiresHintMs ? Math.max(1000, Math.min(CIRCUIT_MAX_COOLDOWN_MS, expiresHintMs * 1000)) : expo + jitter;
    s.openUntil = now + cooldown;
    s.openedAt = now;
    s.cooldownMs = cooldown;
    s.probeUsed = false;
    s.halfOpen = false;
    s.fails = 0;
    s.firstFail = 0;
    s.consecutiveOpens = n + 1;
  }
  circuitState.set(key, s);
}
function circuitRecordFail(kind, id, opts) {
  recordFailOn(toKey(kind, id), opts || {});
}
// Legacy 2-arg shape used by tests and a few call sites:
//   circuitRecord("p", false) / circuitRecord(routeKey, true)
function circuitRecord(kindOrKey, ok) {
  if (ok)
    circuitRecordOk(kindOrKey);
  else
    circuitRecordFail(kindOrKey);
}
var AUTO_SLUG = "auto";
var routerHealthCache = { at: 0, rows: [] };
function __resetRouterHealthCache() { routerHealthCache = { at: 0, rows: [] }; }
async function routerHealth(c) {
  const now = Date.now();
  if (now - routerHealthCache.at < 30000)
    return routerHealthCache.rows;
  try {
    const rows = await c.env.DB.prepare(
      `SELECT slug,
              COUNT(*) AS n,
              AVG(CASE WHEN status='ok' THEN 1.0 ELSE 0.0 END) AS ok_rate,
              AVG(latency_ms) AS avg_ms
       FROM (SELECT slug, status, latency_ms, created_at FROM trajectories WHERE created_at >= ? AND status IN ('ok', 'fail'))
       GROUP BY slug`
    ).bind(new Date(now - 24 * 3600000).toISOString()).all();
    // Fold in the latest integrity verdict: a slug whose only route failed
    // verification is not a model the router should prefer, and a relay is not
    // a model at all. Kept as a penalty rather than an exclusion so an operator
    // can still reach the slug deliberately.
    const probes = await c.env.DB.prepare(
      `SELECT slug, verdict FROM provider_probe_runs
       WHERE id IN (SELECT MAX(id) FROM provider_probe_runs GROUP BY slug, provider_id)`
    ).all();
    const penaltyBySlug = new Map();
    for (const row of probes.results || []) {
      const worst = row.verdict === "MULTI-MODEL RELAY" || row.verdict === "TOKENIZER MISMATCH" || row.verdict === "STACK LEAK" ? 0.35
        : row.verdict === "CONSISTENT WITH CLAIM" ? 1
          : 0.85;
      const current = penaltyBySlug.get(row.slug);
      if (current === void 0 || worst < current)
        penaltyBySlug.set(row.slug, worst);
    }
    const merged = (rows.results || []).map((row) => {
      const factor = penaltyBySlug.has(row.slug) ? penaltyBySlug.get(row.slug) : 1;
      return factor === 1 ? row : { ...row, ok_rate: Number(row.ok_rate) * factor, probe_penalty: factor };
    });
    routerHealthCache = { at: now, rows: merged };
  } catch {
    routerHealthCache = { at: now, rows: [] };
  }
  return routerHealthCache.rows;
}
function promptComplexity(payload) {
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
  // Live conversation = user + assistant turns. System/developer boilerplate
  // (agent harnesses attach tens of KB to every request) never signals
  // difficulty, so it stays out of both the keyword ask and the size score.
  const isBoilerplate = (m) => m && (m.role === "system" || m.role === "developer");
  const live = msgs.filter((m) => !isBoilerplate(m));
  const a = analyzeRequest({ ...payload, messages: live });
  // Live ask: latest user turn text only.
  let lastUserText = "";
  for (const m of live) {
    if (!m || m.role !== "user")
      continue;
    if (typeof m.content === "string")
      lastUserText = m.content;
    else if (Array.isArray(m.content))
      lastUserText = m.content.map((p) => p && typeof p.text === "string" ? p.text : "").filter(Boolean).join(" ");
  }
  const ask = lastUserText.toLowerCase();
  let score = 0;
  // Context size dominates and is absolute: a one-word ask over a 200k-token
  // context must still clear a large-window quality floor.
  const tokens = a.estInputTokens;
  if (tokens > 100000)
    score += 4;
  else if (tokens > 40000)
    score += 3;
  else if (tokens > 12000)
    score += 2;
  else if (tokens > 4000)
    score += 1;
  else if (tokens > 800)
    score += 0.5;
  // Images are capability-bound like tools: each pushes toward stronger
  // vision models (capped so screenshots alone can't pin need at max).
  if (a.imageCount)
    score += Math.min(3, a.imageCount);
  // Tools are always present for agents; the per-request signal is zero —
  // capability gating in pickAutoModel does the heavy lifting. (A flat +0.5
  // here is what made "hi with tools attached" look harder than "hi".)
  const hasTools = !!(payload.tools || payload.functions);
  const heavyWords = ["refactor", "architecture", "optimize", "debug", "migrate", "implement", "algorithm", "prove", "derive", "theorem", "race condition", "memory leak", "regression", "benchmark", "stack trace", "root cause"];
  const midWords = ["write", "explain", "summarize", "compare", "convert", "review", "fix", "why", "how", "difference"];
  for (const w of heavyWords)
    if (ask.includes(w))
      score += 1.5;
  for (const w of midWords)
    if (ask.includes(w))
      score += 0.5;
  const askWords = ask.split(/\s+/).filter(Boolean).length;
  // Short-ask discount only for small plain-text chats: never let
  // "summarize this" over a huge context, image, or tool request look easy.
  if (askWords > 0 && askWords < 4 && tokens < 4000 && !a.imageCount && !hasTools)
    score = Math.min(score, 0);
  const turns = msgs.filter((m) => m && m.role === "user").length;
  if (turns >= 6)
    score += 1;
  else if (turns >= 3)
    score += 0.5;
  return { score, chars: a.textChars, words: askWords, estInputTokens: tokens, images: a.imageCount };
}
function isLuxuryFlagship(id) {
  // Models this gateway does not operate. Auto must never prefer them when
  // the operator's own routes can serve the request.
  return /(gpt-6-astra|\bastra\b|claude-fable|fable-5|mythos|gpt-6(?!.*mini)|opus-5|claude-opus-5)/.test(String(id || "").toLowerCase());
}
function isWorkhorse(id) {
  // The operator's cheap 2026 pool (from live routes): GLM-5, DeepSeek V4,
  // MiniMax, Qwen3.8, Grok 4.6, Laguna, Agnes. These rival Astra-class
  // coding/agents at a fraction of the price.
  return /(glm-5|glm-4\.6|kimi|moonshot|deepseek|qwen3|minimax|grok-4|laguna|agnes|muse-spark)/.test(String(id || "").toLowerCase());
}
function qualityPrior(entry, slug) {
  const id = String((entry && entry.id) || slug || "").toLowerCase();
  const reasoning = !!(entry && entry.reasoning);
  const ctx = Number(entry && entry.limit && entry.limit.context) || 0;
  let q = 1;
  if (isLuxuryFlagship(id))
    q = 3.1;
  else if (/(glm-5(?!.*flash)|deepseek-v4-pro|grok-4\.6|kimi-k3|kimi-k2\.6)/.test(id))
    q = 4.8;
  else if (/(minimax-m3|qwen3\.8|qwen3-max|deepseek-v4(?!.*flash)|kimi-k2|glm-4\.6)/.test(id))
    q = 4.4;
  else if (/(glm-5\.3-flash|glm-5-flash|deepseek-v4-flash|qwen3|laguna-s|agnes-3|kimi)/.test(id))
    q = 3.8;
  else if (/(laguna-xs|muse-spark)/.test(id))
    q = 2.8;
  else {
    q = 1.4;
    if (reasoning) q += 1.2;
    if (ctx >= 400000) q += 1;
    else if (ctx >= 128000) q += 0.5;
    if (/(flash|lite|mini|small|air|nano|tiny|instant|xs)/.test(id)) q -= 0.3;
    if (/(pro|max|ultra|thinking|reasoning)/.test(id)) q += 0.5;
  }
  return Math.max(0.25, Math.min(6, q));
}
function textOfMessage(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content))
    return m.content.map((p) => p && typeof p.text === "string" ? p.text : "").filter(Boolean).join(" ");
  return "";
}
function buildWorldModel(payload) {
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
  const live = msgs.filter((m) => m && m.role !== "system" && m.role !== "developer");
  let lastUser = "";
  for (const m of live) {
    if (m.role === "user") lastUser = textOfMessage(m);
  }
  const blob = live.map(textOfMessage).join("\n");
  const files = [...new Set((blob.match(/(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,8}/gi) || [])).values()].slice(0, 8);
  const urls = [...new Set((blob.match(/https?:\/\/[^\s)]+/gi) || [])).values()].slice(0, 6);
  const tools = Array.isArray(payload && payload.tools) ? payload.tools.map((t) => (t && t.function && t.function.name) || t.name).filter(Boolean).slice(0, 8) : [];
  const nums = [...new Set((lastUser.match(/\b\d+(?:\.\d+)?\b/g) || [])).values()].slice(0, 8);
  const goal = lastUser.replace(/\s+/g, " ").trim().slice(0, 280);
  return {
    goal: goal || "(none)",
    files, urls, tools, nums,
    turns: live.filter((m) => m.role === "user").length,
    images: (payload && promptComplexity(payload).images) || 0
  };
}
function renderWorldState(world, decision) {
  const lines = [
    "You are running behind the gateway auto-router. Stay inside the current task.",
    "WORLD STATE:",
    "- goal: " + world.goal,
    "- turns: " + world.turns,
    world.files.length ? "- files: " + world.files.join(", ") : "",
    world.urls.length ? "- urls: " + world.urls.join(", ") : "",
    world.tools.length ? "- tools: " + world.tools.join(", ") : "",
    world.nums.length ? "- numbers: " + world.nums.join(", ") : "",
    decision ? "- routed: " + decision.slug + " (need " + Number(decision.need || 0).toFixed(2) + ", window-fit " + (decision.ctxOk === false ? "tight" : "ok") + ")" : "",
    "Rules: keep a running model of entities and constraints. Prefer acting over restating. If context was compacted, trust this block over forgotten turns."
  ];
  return lines.filter(Boolean).join("\n");
}
function compactMessages(messages, maxChars) {
  const msgs = Array.isArray(messages) ? messages.slice() : [];
  let total = 0;
  for (const m of msgs) total += textOfMessage(m).length;
  if (total <= maxChars) return msgs;
  const keepTail = [];
  let users = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && (m.role === "system" || m.role === "developer")) continue;
    keepTail.unshift(m);
    if (m && m.role === "tool") continue;
    if (m && Array.isArray(m.tool_calls) && m.tool_calls.length) continue;
    if (m && m.role === "user") users++;
    if (users >= 3) break;
  }
  const keepSet = new Set(keepTail);
  // Never orphan a tool result from its tool_call, or vice versa.
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || keepSet.has(m)) continue;
    if (m.role === "tool" && i > 0 && Array.isArray(msgs[i - 1] && msgs[i - 1].tool_calls) && msgs[i - 1].tool_calls.length) {
      keepSet.add(msgs[i - 1]);
      keepSet.add(m);
    }
    if (Array.isArray(m.tool_calls) && m.tool_calls.length && i + 1 < msgs.length && msgs[i + 1] && msgs[i + 1].role === "tool") {
      keepSet.add(m);
      keepSet.add(msgs[i + 1]);
    }
  }
  const older = msgs.filter((m) => m && m.role !== "system" && m.role !== "developer" && !keepSet.has(m));
  if (!older.length) return msgs;
  const blob = older.map(textOfMessage).join("\n");
  const files = [...new Set((blob.match(/(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,8}/gi) || [])).values()].slice(0, 16);
  const urls = [...new Set((blob.match(/https?:\/\/[^\s)]+/gi) || [])).values()].slice(0, 8);
  const nums = [...new Set((blob.match(/\b\d+(?:\.\d+)?\b/g) || [])).values()].slice(0, 12);
  const facts = [];
  if (files.length) facts.push("files: " + files.join(", "));
  if (urls.length) facts.push("urls: " + urls.join(", "));
  if (nums.length) facts.push("numbers: " + nums.join(", "));
  const digest = older.map((m) => {
    const t = textOfMessage(m).replace(/\s+/g, " ").trim();
    if (m.role === "tool" || (m.tool_calls && m.tool_calls.length))
      return (m.role || "?") + ": " + t.slice(0, 800);
    return (m.role || "?") + ": " + t.slice(0, 280);
  }).join("\n").slice(0, 6000);
  const out = [];
  for (const m of msgs) {
    if (m && (m.role === "system" || m.role === "developer")) out.push(m);
  }
  const header = facts.length ? "PRESERVED:\n" + facts.join("\n") + "\n\n" : "";
  out.push({ role: "system", content: header + "COMPACTED PRIOR TURNS:\n" + digest });
  for (const m of msgs) {
    if (keepSet.has(m)) out.push(m);
  }
  return out;
}
function applyAutoHarness(payload, decision) {
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages.slice() : [];
  const horizon = decision && decision.horizon;
  const state = horizon ? renderHorizonState(horizon) : renderWorldState(buildWorldModel(payload), decision);
  const window = Number(decision && decision.context) || Number(horizon && horizon.context) || 128000;
  const output = Number(decision && decision.output) || Number(horizon && horizon.output) || 0;
  const tight = !!(horizon && horizon.compact);
  const usable = usableContextWindow(window, output, payload && payload.max_tokens);
  const budgetChars = Math.max(tight ? 8000 : 16000, Math.floor((usable || window * 0.55) * (tight ? 0.55 : 0.75) * 4));
  const compacted = compactMessages(msgs.filter((m) => !(m && m.role === "system" && /WORLD STATE:|TASKIR:|^ROLE: /.test(String(m.content || "")))), budgetChars);
  compacted.unshift({ role: "system", content: state });
  return { ...payload, messages: compacted };
}
// Request shape analysis for routing: text size, image payloads, tool
// definitions. Token counts are heuristics (~4 chars/token, ~1 token/KB of
// image bytes + 500/image) — order-of-magnitude, for routing only.
function analyzeRequest(payload) {
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
  let textChars = 0;
  let imageCount = 0;
  let imageBytes = 0;
  const addPart = (part) => {
    if (!part)
      return;
    if (typeof part === "string") {
      textChars += part.length;
      return;
    }
    if (typeof part.text === "string")
      textChars += part.text.length;
    if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
      imageCount++;
      const u = part.image_url.url;
      if (u.indexOf("data:") === 0) {
        const comma = u.indexOf(",");
        const b64 = comma >= 0 ? u.length - comma - 1 : u.length;
        if (b64 > 0)
          imageBytes += Math.floor(b64 * 3 / 4);
      }
    }
  };
  for (const m of msgs) {
    if (!m)
      continue;
    const content = m.content;
    if (typeof content === "string")
      textChars += content.length;
    else if (Array.isArray(content))
      for (const part of content) addPart(part);
    else if (content && typeof content === "object")
      addPart(content);
    if (m.tool_calls) {
      try {
        textChars += JSON.stringify(m.tool_calls).length;
      } catch {
      }
    }
  }
  let toolChars = 0;
  try {
    const t = (payload && (payload.tools || payload.functions)) || null;
    if (t)
      toolChars += JSON.stringify(t).length;
  } catch {
  }
  if (payload && typeof payload.system === "string")
    textChars += payload.system.length;
  const estInputTokens = Math.ceil(textChars / 4) + Math.ceil(toolChars / 4) + imageCount * 500 + Math.ceil(imageBytes / 1500);
  return { textChars, toolChars, imageCount, imageBytes, estInputTokens };
}
function hasImageContent(payload) {
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
  for (const m of msgs) {
    const content = m && m.content;
    if (!content)
      continue;
    const parts = typeof content === "string" ? [] : Array.isArray(content) ? content : [content];
    for (const p of parts) {
      if (p && (p.type === "image_url" || p.type === "image"))
        return true;
    }
  }
  return false;
}

// One capability lookup for the router and the model list. Identity and the
// native ceilings come from the canonical registry: a reseller slug that
// models.dev has never heard of still inherits its model's real limits.
// The catalog only fills what the registry doesn't record — vision, tools,
// modalities — and a Z.AI consumer route uses its local table for those,
// since it has no models.dev row at all.
function capabilityEntryForRoute(route, catalogById, canonical) {
  let entry = null;
  if (route && isZaiWebFormat(route.fmt))
    entry = modelCatalogEntry(route.upstream_model, route.fmt) || null;
  if (!entry)
    entry = catalogById && route ? matchModelsDevPrice(catalogById, route.slug) : null;
  return applyRouteCapability(entry, route, canonical);
}

// The canonical model sets the ceiling. The catalog is supplemental and only
// fills a limit the registry doesn't have. The route may deliver less than
// either, never more. A route with no catalog row and no canonical row still
// carries its own clamp, so a measured transport ceiling is never lost.
function applyRouteCapability(entry, route, canonical) {
  const caps = resolveRouteCapabilities({
    canonical: {
      context_limit: positiveOrNull(canonical && canonical.context_limit) ?? (entry && entry.limit && entry.limit.context),
      output_limit: positiveOrNull(canonical && canonical.output_limit) ?? (entry && entry.limit && entry.limit.output)
    },
    route
  });
  if (caps.context == null && caps.output == null)
    return entry;
  const base = entry || { limit: {} };
  return {
    ...base,
    limit: {
      ...(base.limit || {}),
      context: caps.context != null ? caps.context : (base.limit && base.limit.context),
      output: caps.output != null ? caps.output : (base.limit && base.limit.output)
    }
  };
}

function positiveOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Native ceilings for a batch of routes, keyed by route id. A route whose
// slug or upstream model resolves to a canonical model inherits that model's
// limits even when no catalog has ever heard of the public slug. A miss is
// simply absent from the map, and the catalog remains the fallback.
async function canonicalLimitsForRoutes(c, routes) {
  const out = new Map();
  const list = routes || [];
  if (!list.length || !c || !c.env || !c.env.DB)
    return out;
  try {
    const index = await loadAliasIndex(c);
    const wanted = new Set();
    const resolved = [];
    for (const r of list) {
      const hit = resolveCanonicalModel(index, {
        providerId: r.provider_id, publicSlug: r.slug, upstreamModel: r.upstream_model
      });
      if (hit && hit.canonicalModelId) {
        resolved.push([r.route_id, hit.canonicalModelId]);
        wanted.add(hit.canonicalModelId);
      }
    }
    if (!wanted.size)
      return out;
    const ids = [...wanted];
    const rows = await c.env.DB.prepare(
      "SELECT id, context_limit, output_limit FROM canonical_models WHERE id IN (" + ids.map(() => "?").join(",") + ")"
    ).bind(...ids).all();
    const byId = new Map((rows.results || []).map((row) => [row.id, row]));
    for (const [routeId, canonicalId] of resolved) {
      const row = byId.get(canonicalId);
      if (row)
        out.set(routeId, { context_limit: row.context_limit, output_limit: row.output_limit });
    }
  } catch {}
  return out;
}

// Capability gate from the models.dev catalog entry. Unknown models are
// conservative on auto: no assumed vision/tools, and a 32k context ceiling.
// Known models: only an explicit toolCall=false blocks tools.
function entryCapabilities(entry) {
  if (!entry)
    return { context: 0, output: 0, vision: false, tools: false, unknown: true };
  const ctx = Number(entry.limit && entry.limit.context) || 0;
  const output = Number(entry.limit && entry.limit.output) || 0;
  const input = entry.modalities && Array.isArray(entry.modalities.input) ? entry.modalities.input : null;
  const vision = input ? input.some((m) => String(m).toLowerCase() === "image") : false;
  return { context: ctx, output, vision, tools: entry.toolCall === false ? false : true, unknown: false };
}
async function autoSettings(c) {
  const enabled = (await settingValue(c, "auto_enabled", "on")) !== "off";
  const pref = Math.min(100, Math.max(0, Number(await settingValue(c, "auto_preference", "70")) || 70));
  const excluded = splitModelSlugs(await settingValue(c, "auto_excluded", ""));
  let overrides = {};
  try {
    overrides = JSON.parse(await settingValue(c, "auto_overrides", "{}")) || {};
  } catch {
    overrides = {};
  }
  return { enabled, preference: pref, excluded, overrides };
}
// Interactive/reflex latency budget. A route slower than this is dropped from
// the easy-request pool unless nothing faster is eligible.
var REFLEX_LATENCY_SLA_MS = 30000;
// Soft priors, not hard filters: a proven workhorse gets a small edge and a
// tiny model is discouraged on hard work, but neither decides pool membership.
// All hard-eligible routes compete in the optimizer.
var WORKHORSE_PRIOR_BONUS = 0.5;
var TINY_HARD_TASK_PENALTY = 2;
// Bayesian reliability floor. A route with real evidence whose lower-confidence
// bound sits below this is degraded and cannot be a primary.
var ROUTE_RELIABILITY_FLOOR = 0.6;
// Turn a slug-level health aggregate into a Bayesian reliability read. A fresh
// route (no evidence) rides the optimistic Beta(8,2) prior so cold starts route;
// once failures accumulate the lower-confidence bound drops it. This is why 0/2
// reads DEGRADED instead of the old "no data therefore healthy".
function routeReliability(h) {
  const seed = seedBeta("route");
  const n = Math.max(0, Number(h && h.n) || 0);
  const ok = Number(h && h.ok_rate);
  if (!n || !Number.isFinite(ok)) {
    const bound2 = betaLcb(seed);
    return { lcb: bound2, mean: seed.alpha / (seed.alpha + seed.beta), n: 0, band: "unproven" };
  }
  const success = Math.max(0, Math.min(n, n * ok));
  const state = { alpha: seed.alpha + success, beta: seed.beta + (n - success) };
  const bound = betaLcb(state);
  const band = bound >= 0.8 ? "healthy" : bound >= ROUTE_RELIABILITY_FLOOR ? "probation" : "degraded";
  return { lcb: bound, mean: state.alpha / (state.alpha + state.beta), n, band };
}
// Easy-request selection: maximize reliability, then subtract latency and cost.
// A fast, reliable route beats a cheaper one that is slow or flaky. Routes over
// the interactive SLA are excluded unless the whole pool is over it.
function reflexPick(list) {
  const pool0 = (list || []).filter(Boolean);
  if (!pool0.length)
    return null;
  const underSla = pool0.filter((x) => (Number(x.avgMs) || 0) <= REFLEX_LATENCY_SLA_MS);
  const pool = underSla.length ? underSla : pool0;
  const maxCost = Math.max(...pool.map((x) => Number(x.cost) || 0), 1e-9);
  let best = null, bestScore = -Infinity;
  for (const cand of pool) {
    const relTerm = (Number.isFinite(cand.lcb) ? cand.lcb : 0.8) * 5;
    const latPenalty = Math.min(3, (Number(cand.avgMs) || 0) / 1000 / 10);
    const costPenalty = Math.pow((Number(cand.cost) || 0) / maxCost, 2) * 1.5;
    const wobbling = cand.wob || 0;
    const s = relTerm - latPenalty - costPenalty - wobbling;
    if (s > bestScore) {
      bestScore = s;
      best = cand;
    }
  }
  return best;
}
async function pickAutoModel(c, payload, key) {
  const cfg = await autoSettings(c);
  if (!cfg.enabled)
    return null;
  if (!modelsDevCache.catalog)
    await fetchModelsDevCatalog().catch(() => {});
  const catalog = modelsDevCache.catalog;
  const byId = catalog ? flattenModelsDevCatalog(catalog) : null;
  const routes = await c.env.DB.prepare(
    `SELECT mr.slug,
            COALESCE((SELECT MAX(p2.healthy) FROM model_routes mr2 JOIN providers p2 ON p2.id=mr2.provider_id WHERE mr2.slug=mr.slug AND mr2.enabled=1 AND p2.enabled=1 AND COALESCE(mr2.model_kind,'chat')='chat'),0) AS healthy,
            (SELECT GROUP_CONCAT(mr3.id) FROM model_routes mr3 JOIN providers p3 ON p3.id=mr3.provider_id WHERE mr3.slug=mr.slug AND mr3.enabled=1 AND p3.enabled=1 AND p3.healthy=1 AND COALESCE(mr3.model_kind,'chat')='chat') AS route_ids
     FROM model_routes mr WHERE mr.enabled=1 AND COALESCE(mr.model_kind,'chat')='chat' GROUP BY mr.slug`
  ).all();
  let enabled = (routes.results || []).filter((r) => r.slug !== AUTO_SLUG && Number(r.healthy) === 1 && !cfg.excluded.includes(r.slug));
  if (key) {
    const allowed = new Set(await allowedSlugs(c, key));
    enabled = enabled.filter((r) => allowed.has(r.slug));
  }
  if (!enabled.length)
    return null;
  const routes2 = await c.env.DB.prepare(
    `SELECT mr.slug, p.fmt, MIN(mr.upstream_model) AS upstream_model
     FROM model_routes mr JOIN providers p ON p.id=mr.provider_id
     WHERE mr.enabled=1 AND p.enabled=1 AND COALESCE(mr.model_kind,'chat')='chat' GROUP BY mr.slug`
  ).all();
  const overlay = new Map();
  for (const r of routes2.results || []) {
    if (!isZaiWebFormat(r.fmt))
      continue;
    const local = modelCatalogEntry(r.upstream_model, r.fmt);
    // Local capability row keyed by the public slug: models.dev carries no
    // chat.z.ai consumer entries, so without this the router would treat the
    // route as unknown (permissive) instead of gating tools/vision/context.
    if (local)
      overlay.set(r.slug, local);
  }
  const health = await routerHealth(c);
  const healthBySlug = new Map(health.map((h) => [h.slug, h]));
  const cx = promptComplexity(payload);
  const score = cx.score;
  // Complexity is unbounded; compress it into the quality-prior scale
  // (priors land between ~0.5 and ~5). need in [1, 6].
  const reqTokens = cx.estInputTokens || 0;
  const reqImages = cx.images || 0;
  const requestedOut = Math.max(0, Number(payload.max_completion_tokens ?? payload.max_tokens) || 0);
  const hasTools = !!(payload.tools || payload.functions);
  let need = Math.min(6, 1 + Math.max(0, score) / 2.2);
  if (hasTools)
    need = Math.min(6, Math.max(need, 2.6));
  if (reqImages)
    need = Math.min(6, Math.max(need, 2.4));
  const candidates = [];
  for (const r of enabled) {
    const entry = overlay.get(r.slug) || capabilityEntryForRoute({ slug: r.slug }, byId);
    const mult = Number(cfg.overrides[r.slug]);
    let q = qualityPrior(entry, r.slug);
    if (Number.isFinite(mult) && mult > 0)
      q *= Math.min(3, mult);
    const caps = entryCapabilities(entry);
    const ctxOk = reqTokens <= Math.floor(contextLimit(caps) * 0.9);
    const ctxTight = !!(caps.context && reqTokens > caps.context * 0.55);
    const visionOk = reqImages === 0 || (!caps.unknown && caps.vision);
    const toolsOk = !hasTools || caps.tools || caps.unknown;
    const outOk = requestedOut === 0 || (!caps.unknown && caps.output > 0 && requestedOut <= caps.output);
    const capable = ctxOk && outOk && visionOk && toolsOk;
    // Runtime health is route-scoped: one model route cannot poison siblings
    // that happen to share the same provider.
    const routeIds = String(r.route_ids || "").split(",").map((s) => s.trim()).filter(Boolean);
    let openCount = 0;
    let wob = 0;
    for (const id of routeIds) {
      const key = "route:" + id;
      if (circuitOpen(key))
        openCount++;
      else {
        const cs = circuitState.get(key);
        if (cs && cs.fails > 0)
          wob = Math.max(wob, cs.fails >= 2 ? 1.2 : 0.5);
      }
    }
    const allOpen = routeIds.length > 0 && openCount >= routeIds.length;
    const h = healthBySlug.get(r.slug);
    const okRate = h ? Number(h.ok_rate) : 1;
    const rel = routeReliability(h);
    // Reliability floor: once a route has real evidence (>=2 attempts) and its
    // lower-confidence bound sits below the floor it is degraded and cannot be a
    // primary. Fresh routes ride the prior; the circuit breaker owns transient
    // single failures. This drops a 50%/10 or 0/2 route that V1 used to accept.
    const relOk = !(rel.n >= 2 && rel.lcb < ROUTE_RELIABILITY_FLOOR);
    const qualityOk = q + 0.8 >= need;
    const eligible = capable && !allOpen && qualityOk && relOk;
    let reason = "";
    if (!ctxOk) reason = "context";
    else if (!visionOk) reason = "vision";
    else if (!toolsOk) reason = "tools";
    else if (!outOk) reason = "output";
    else if (allOpen) reason = "circuit open";
    else if (!qualityOk) reason = "quality low";
    else if (!relOk) reason = "degraded";
    const rawCost = entry ? Number(entry.prompt_per_1m) + Number(entry.completion_per_1m) : 0.5;
    const cost = Number.isFinite(rawCost) ? rawCost : 0.5;
    const rawMs = h ? Number(h.avg_ms) : 0;
    candidates.push({ slug: r.slug, routeIds: routeIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)), cost, quality: q, okRate, avgMs: Number.isFinite(rawMs) ? rawMs : 0, eligible, hardEligible: eligible, samples: h ? Number(h.n) : 0, lcb: rel.lcb, relBand: relOk ? rel.band : "degraded", reason, capable, ctxOk, visionOk, toolsOk, wob, ctxTight, context: caps.context || 0, output: caps.output || 0, unknown: !!caps.unknown, luxury: isLuxuryFlagship(r.slug), workhorse: isWorkhorse(r.slug), tiny: isTinySlug(r.slug) });
  }
  // Every hard-eligible route competes. Workhorse/tiny are soft priors applied
  // in scoring below, never a hard membership filter, so a fast reliable
  // non-workhorse route can win an easy request.
  const eligibleList = candidates.filter((x) => x.eligible);
  let picked;
  if (!eligibleList.length) {
    picked = null;
  } else if (need <= 2.1) {
    picked = reflexPick(eligibleList);
  } else {
    const maxCost = Math.max(...eligibleList.map((x) => x.cost), 1e-9);
    const maxMs = Math.max(...eligibleList.map((x) => x.avgMs || 0), 1);
    const rawW = cfg.preference / 100;
    const hardShift = need >= 4.2 ? 0.2 : 0;
    const w = Math.max(0, Math.min(1, rawW - hardShift));
    let bestScore = -Infinity;
    for (const cand of eligibleList) {
      const reliability = cand.samples >= 3 ? cand.okRate : 1;
      const relPenalty = (1 - reliability) * 6;
      const slowPenalty = (cand.avgMs || 0) / maxMs * 2;
      const wobbling = cand.wob || 0;
      const overkill = cand.quality >= 5 && cand.quality > need + 1.2 ? (cand.quality - need - 1.2) * 0.7 : 0;
      const tight = cand.ctxTight ? 1.35 : 0;
      const costTerm = Math.pow(cand.cost / maxCost, 2) * 6;
      const workhorseBonus = cand.workhorse ? WORKHORSE_PRIOR_BONUS : 0;
      const tinyHard = cand.tiny && need >= 2.5 ? TINY_HARD_TASK_PENALTY : 0;
      const s = (1 - w) * cand.quality - w * costTerm - relPenalty - slowPenalty - wobbling - overkill - tight + workhorseBonus - tinyHard;
      if (s > bestScore) {
        bestScore = s;
        picked = cand;
      }
    }
  }
  if (!picked)
    return null;
  const horizon = planHorizon({
    payload,
    candidates,
    picked,
    need,
    reqTokens,
    cx: { score, estInputTokens: reqTokens, images: reqImages }
  });
  const horizonSlug = horizon && horizon.slug;
  const horizonOk = horizonSlug && candidates.some((c) => c.slug === horizonSlug && c.eligible);
  const slug = horizonOk ? horizonSlug : picked.slug;
  const chosen = candidates.find((x) => x.slug === slug && x.eligible) || picked;
  let v2 = null;
  // In shadow mode this block is pure telemetry, so ROUTER_V2_SHADOW_SAMPLE can
  // dial it down (and ROUTER_V2=off skips it entirely). In live mode the world
  // is the decision, so it always runs.
  const v2mode = ROUTER_V2_MODE();
  const useV2 = shouldShadow();
  if (useV2) {
    try {
      const allowed = key ? await allowedSlugs(c, key) : null;
      const priceResolver = await buildPriceResolver(c);
      const world = await loadV2World(c, {
        payload,
        allowed,
        excluded: cfg.excluded,
        catalogById: byId,
        overlay,
        circuitOpen,
        keyCircuitOpen: (keyId) => circuitOpen("key", keyId),
        priceResolver
      });
      v2 = shadowV2({ payload, routes: world.routes, preference: cfg.preference });
      // Shadow-only answer-quality block, attached AFTER selection math so it can
      // never influence candidatePolicies ordering. Primary route is resolved by
      // primaryRoute.routeId (or routeKey), NEVER by public slug — two providers
      // can expose the same public slug with different upstreams/identities.
      // Quality identity prefers the canonical model id from the registry,
      // falling back to "raw:<upstream>" when unresolved.
      if (v2 && v2.explain && world && Array.isArray(world.routes)) {
        const _pr = v2.explain.primaryRoute || null;
        const _qRoute = (_pr && _pr.routeId != null && world.routes.find((r) => r.routeId === _pr.routeId))
          || (_pr && _pr.routeKey && world.routes.find((r) => r.key === _pr.routeKey))
          || world.routes.find((r) => r.slug === v2.explain.primary)
          || world.routes.find((r) => r.slug === v2.primary)
          || null;
        const _qIdentity = _qRoute
          ? (_qRoute.canonicalModelId || ("raw:" + (_qRoute.upstream_model || _qRoute.slug)))
          : null;
        if (_qIdentity) {
          const _qTask = v2.taskIR ? String(v2.taskIR.task || "") : "";
          v2.explain.quality = {
            identity: _qIdentity,
            task: _qTask,
            stats: await loadQualityShadow(c, _qIdentity, _qTask)
          };
        }
      }
    } catch (e) {
      blog("AUTO v2 shadow failed: " + String(e && e.message || e).slice(0, 200));
    }
  }
  // Router V2 live selection. The V2 world names its pick by route id, never by
  // public slug: two providers can expose the same slug with different
  // upstreams, so a slug match could serve the route V2 did not choose. The
  // constraint-first pick is preferred (it gates on reliability and quality);
  // the operational pick is the fallback, and V1's pick stands if neither
  // resolves to a candidate that is actually eligible here.
  let v2Chosen = null;
  if (v2mode === "live" && v2) {
    const qaId = v2.shadow && v2.shadow.quality_aware_pick ? v2.shadow.quality_aware_pick.routeId : null;
    const opId = v2.picked && v2.picked.primaryRef ? v2.picked.primaryRef.routeId : null;
    for (const wantId of [qaId, opId]) {
      if (wantId == null)
        continue;
      const hit = candidates.find((c) => c.eligible && (c.routeIds || []).includes(Number(wantId)));
      if (hit) { v2Chosen = hit; break; }
    }
  }
  if (v2Chosen) {
    const v2slug = v2Chosen.slug;
    const v2HorizonOk = horizonSlug && candidates.some((c) => c.slug === horizonSlug && c.eligible);
    // Horizon still plans the queue, but it may not override the V2 pick onto a
    // route V2 rejected; it only refines when it lands on another eligible one.
    return { ...v2Chosen, candidates, need, complexity: score, preference: cfg.preference, estInputTokens: reqTokens, images: reqImages, context: v2Chosen.context || 0, output: v2Chosen.output || 0, horizon, queue: (horizon && horizon.queue) || [], v2, v2_served: true, served_slug: v2slug, served_route_id: (v2Chosen.routeIds || [])[0] || null, v2_horizon_eligible: !!v2HorizonOk };
  }
  return { ...chosen, candidates, need, complexity: score, preference: cfg.preference, estInputTokens: reqTokens, images: reqImages, context: chosen.context || picked.context || 0, output: chosen.output || picked.output || 0, horizon, queue: (horizon && horizon.queue) || [], v2 };
}
// Three in-place attempts on the same credential, then the next key/route.
// Host/config 503s cannot recover on retry: Chromium missing a display,
// a model the account cannot see, a dead session, a bad transport.
var SAME_KEY_ATTEMPTS = 3;
// Fatal config errors shouldn't retry, but transient zai_browser page load hiccups can self-heal on retry.
// zai_completion 500s are Z.AI payload/TLS rejects; retrying burns another single-use CAPTCHA.
var NON_RETRYABLE_KINDS = /browser_unavailable|model_unavailable|credentials|captcha|transport|tokens|fallback_failed|zai_model\b|zai_completion|zai_unreachable|zai_stream_error/;
function shouldRetrySameKey(transportAttempt, err) {
  return transportAttempt < SAME_KEY_ATTEMPTS - 1 && isRetryableTransportError(err);
}
function shouldRetryHttp(transportAttempt, status, why) {
  if (transportAttempt >= SAME_KEY_ATTEMPTS - 1)
    return false;
  const kind = String(why || "");
  if (NON_RETRYABLE_KINDS.test(kind))
    return false;
  const code = Number(status) || 0;
  if (code === 408 || code >= 500)
    return true;
  return kind === "relay" || kind === "unknown" || kind === "zai_browser";
}
var MODELS_DEV_CACHE_MS = 3600000;
var modelsDevCache = { at: 0, catalog: null };
async function fetchModelsDevCatalog() {
  const now = Date.now();
  if (modelsDevCache.catalog && now - modelsDevCache.at < MODELS_DEV_CACHE_MS)
    return modelsDevCache.catalog;
  // Auto must never hang a chat request on the catalog fetch: 12s cap, and
  // pickAutoModel already tolerates a missing catalog (price-blind priors).
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(MODELS_DEV_API, { headers: { accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok)
      throw new Error("models.dev HTTP " + r.status);
    const catalog = await r.json();
    modelsDevCache = { at: now, catalog };
    return catalog;
  } finally {
    clearTimeout(t);
  }
}
function __setModelsDevCache(catalog) { modelsDevCache = { at: catalog ? Date.now() : 0, catalog: catalog || null }; }
function numOrNull(value) {
  if (value === void 0 || value === null || value === "")
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
async function ensurePriceColumns(db) {
  if (!db || typeof db.exec !== "function")
    return;
  if (ensurePriceColumns.done)
    return;
  try {
    const cols = await db.prepare("PRAGMA table_info(prices)").all();
    const list = Array.isArray(cols) ? cols : (cols && cols.results) || [];
    const names = new Set(list.map((c) => c.name));
    const add = [
      ["actual_prompt_per_1m", "ALTER TABLE prices ADD COLUMN actual_prompt_per_1m REAL"],
      ["actual_completion_per_1m", "ALTER TABLE prices ADD COLUMN actual_completion_per_1m REAL"],
      ["cache_read_per_1m", "ALTER TABLE prices ADD COLUMN cache_read_per_1m REAL"],
      ["cache_write_per_1m", "ALTER TABLE prices ADD COLUMN cache_write_per_1m REAL"],
      ["actual_mode", "ALTER TABLE prices ADD COLUMN actual_mode TEXT"],
      ["actual_per_request", "ALTER TABLE prices ADD COLUMN actual_per_request REAL"]
    ];
    for (const [name, sql] of add) {
      if (!names.has(name))
        db.exec(sql);
    }
    ensurePriceColumns.done = true;
  } catch {
  }
}
async function ensureSummaryColumns(db) {
  if (!db || ensureSummaryColumns.done) return;
  try {
    const cols = await db.prepare("PRAGMA table_info(request_summaries)").all();
    const names = new Set((cols.results || []).map((r) => r.name));
    if (!names.has("client_app")) await db.prepare("ALTER TABLE request_summaries ADD COLUMN client_app TEXT").run();
    if (!names.has("request_headers")) await db.prepare("ALTER TABLE request_summaries ADD COLUMN request_headers TEXT").run();
    ensureSummaryColumns.done = true;
  } catch {}
}
function priceFromRow(row) {
  const equivalentPrompt = Number(row && row.prompt_per_1m) || 0;
  const equivalentCompletion = Number(row && row.completion_per_1m) || 0;
  const actualPrompt = numOrNull(row && row.actual_prompt_per_1m);
  const actualCompletion = numOrNull(row && row.actual_completion_per_1m);
  const actualMode = (row && row.actual_mode) === "per_request" ? "per_request" : "per_1m";
  return {
    equivalentPrompt,
    equivalentCompletion,
    actualPrompt: actualPrompt == null ? equivalentPrompt : actualPrompt,
    actualCompletion: actualCompletion == null ? equivalentCompletion : actualCompletion,
    cacheRead: numOrNull(row && row.cache_read_per_1m),
    cacheWrite: numOrNull(row && row.cache_write_per_1m),
    actualMode,
    actualPerRequest: numOrNull(row && row.actual_per_request) || 0
  };
}
function costFromRates(usage, promptRate, completionRate, cacheReadRate, cacheWriteRate) {
  const prompt = Number(usage && usage.prompt_tokens) || 0;
  const completion = Number(usage && usage.completion_tokens) || 0;
  const cached = Math.max(0, Math.min(prompt, Number(usage && (usage.cached_tokens || usage.cache_read_tokens || usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)) || 0));
  const cacheWrite = Math.max(0, Number(usage && (usage.cache_write_tokens || usage.prompt_tokens_details && usage.prompt_tokens_details.cache_write_tokens)) || 0);
  const uncached = Math.max(0, prompt - cached);
  const readRate = cacheReadRate == null ? promptRate : cacheReadRate;
  const writeRate = cacheWriteRate == null ? 0 : cacheWriteRate;
  return uncached / 1e6 * promptRate + cached / 1e6 * readRate + cacheWrite / 1e6 * writeRate + completion / 1e6 * completionRate;
}
var pricesSchema = { checked: false, providerId: false };
async function pricesHasProvider(c) {
  if (pricesSchema.checked)
    return pricesSchema.providerId;
  try {
    const cols = await c.env.DB.prepare("PRAGMA table_info(prices)").all();
    const list = Array.isArray(cols) ? cols : (cols && cols.results) || [];
    pricesSchema.providerId = list.some((x) => x.name === "provider_id");
  } catch {
  }
  pricesSchema.checked = true;
  return pricesSchema.providerId;
}
function __resetPricesSchema() {
  pricesSchema.checked = false;
  pricesSchema.providerId = false;
}
var PRICE_COLS = "prompt_per_1m, completion_per_1m, actual_prompt_per_1m, actual_completion_per_1m, cache_read_per_1m, cache_write_per_1m, actual_mode, actual_per_request";
async function lookupPriceRow(c, slug, providerId) {
  if (!slug)
    return null;
  const pid = Number(providerId) || 0;
  const tries = [];
  if (await pricesHasProvider(c)) {
    // Provider-specific price wins; the provider_id=0 row is the slug default.
    // No arbitrary cross-provider fallback: an unpriced provider bills 0 or
    // the models.dev estimate, never another provider's rate.
    if (pid)
      tries.push(["SELECT " + PRICE_COLS + " FROM prices WHERE slug=? AND provider_id=?", [slug, pid]]);
    tries.push(["SELECT " + PRICE_COLS + " FROM prices WHERE slug=? AND provider_id=0", [slug]]);
  } else {
    tries.push(["SELECT " + PRICE_COLS + " FROM prices WHERE slug=?", [slug]]);
    tries.push(["SELECT prompt_per_1m, completion_per_1m FROM prices WHERE slug=?", [slug]]);
  }
  for (const [sql, args] of tries) {
    try {
      const row = await c.env.DB.prepare(sql).bind(...args).first();
      if (row)
        return row;
    } catch {
    }
  }
  return null;
}
// One query for every price row, then an in-memory (slug,providerId) resolver
// with the same provider-specific-then-default fallback as lookupPriceRow.
// V2's shadow world would otherwise do one price query per route on every
// Auto request while pickAutoModel blocks on it.
async function buildPriceResolver(c) {
  const hasProvider = await pricesHasProvider(c);
  const cols = hasProvider ? PRICE_COLS + ", provider_id, slug" : PRICE_COLS + ", slug";
  let rows = [];
  try {
    const r = await c.env.DB.prepare("SELECT " + cols + " FROM prices").all();
    rows = r.results || [];
  } catch {
    try {
      const r = await c.env.DB.prepare("SELECT prompt_per_1m, completion_per_1m, slug FROM prices").all();
      rows = r.results || [];
    } catch {
      rows = [];
    }
  }
  const byKey = new Map();
  for (const row of rows) {
    const pid = hasProvider ? (Number(row.provider_id) || 0) : 0;
    byKey.set(row.slug + "|" + pid, row);
  }
  return (slug, providerId) => {
    if (!slug)
      return null;
    const pid = Number(providerId) || 0;
    if (hasProvider && pid && byKey.has(slug + "|" + pid))
      return byKey.get(slug + "|" + pid);
    return byKey.get(slug + "|0") || null;
  };
}
async function computeCost(c, slug, usage, providerId) {
  const pt = Number(usage && usage.cost_usd) || 0;
  if (pt > 0)
    return pt;
  const row = await lookupPriceRow(c, slug, providerId);
  if (row) {
    const rates = priceFromRow(row);
    if (rates.actualMode === "per_request")
      return rates.actualPerRequest;
    return costFromRates(usage, rates.actualPrompt, rates.actualCompletion, rates.cacheRead, rates.cacheWrite);
  }
  const catalog = modelsDevCache.catalog;
  if (!catalog) {
    fetchModelsDevCatalog().catch((e) => blog("MODELS_DEV warm failed: " + String(e.message || e)));
    return 0;
  }
  const hit = matchModelsDevPrice(flattenModelsDevCatalog(catalog), slug);
  if (hit)
    return costFromRates(usage, hit.prompt_per_1m, hit.completion_per_1m, null, null);
  return 0;
}
async function lookupResponseCache(c, cacheKey) {
  try {
    const row = await c.env.DB.prepare(
      "SELECT response_body, source_cost_usd, source_tokens FROM response_cache WHERE cache_key=? AND expires_at>?"
    ).bind(cacheKey, nowIso()).first();
    if (!row)
      return null;
    await c.env.DB.prepare("UPDATE response_cache SET hits=hits+1 WHERE cache_key=?").bind(cacheKey).run();
    return row;
  } catch (e) {
    blog("RESPONSE_CACHE lookup unavailable");
    return null;
  }
}
async function storeResponseCache(c, entry) {
  try {
    await c.env.DB.prepare(
      `INSERT OR REPLACE INTO response_cache (cache_key, key_id, slug, response_body, source_cost_usd, source_tokens, hits, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(entry.cacheKey, entry.keyId, entry.slug, entry.responseBody, entry.sourceCostUsd || 0, entry.sourceTokens || 0, 0, nowIso(), cacheExpiry(entry.ttl)).run();
  } catch (e) {
    blog("RESPONSE_CACHE store unavailable");
  }
}
// Which account a request's spend belongs to. An account-owned key carries
// account_id; in the legacy 1:1 shape the account's own key IS the account
// row's key_id and api_keys.account_id is NULL, so both spellings must reach
// the same debit or that account's spend stays frozen at zero while its key
// counter grows — exactly the "key says I spent, usage says nothing" gap.
function spendAccountId(key) {
  return (key && (key.account_id || key.key_id)) || null;
}
async function recordUsage(c, key, usage) {
  if (!key || !key.key_id)
    return;
  await c.env.DB.prepare(
    "UPDATE api_keys SET used_tokens=used_tokens+?, used_usd=used_usd+?, request_count=request_count+1, updated_at=? WHERE key_id=?"
  ).bind(usage.total_tokens, usage.cost_usd || 0, nowIso(), key.key_id).run();
  // Debit the account only when this key actually belongs to one. spendAccountId
  // falls back to the key's own id in the legacy shape; the console_accounts
  // row is the authority on whether that id names an account.
  const acctId = spendAccountId(key);

  if (acctId) {
    const owner = await c.env.DB.prepare("SELECT key_id FROM console_accounts WHERE key_id=?").bind(acctId).first();
    if (owner)
      await c.env.DB.prepare(
        "UPDATE console_accounts SET used_tokens=used_tokens+?, used_usd=used_usd+? WHERE key_id=?"
      ).bind(usage.total_tokens, usage.cost_usd || 0, acctId).run();
  }
}

// ---- Trajectory capture (RL / SFT) ----
var TRAJ_BODY_CAP = 524288;
async function settingValue(c, key, dflt) {
  try {
    const row = await c.env.DB.prepare("SELECT value FROM gateway_settings WHERE key=?").bind(key).first();
    return row && row.value != null ? String(row.value) : dflt;
  } catch {
    return dflt;
  }
}
async function trajectoriesEnabled(c) {
  return (await settingValue(c, "trajectory_capture", "on")) !== "off";
}
function capBody(text) {
  const s = typeof text === "string" ? text : JSON.stringify(text ?? "");
  return s.length > TRAJ_BODY_CAP ? s.slice(0, TRAJ_BODY_CAP) : s;
}
async function recordTrajectory(c, t) {
  try {
    if (!await trajectoriesEnabled(c))
      return;
    await c.env.DB.prepare(
      `INSERT OR REPLACE INTO trajectories
       (id, created_at, key_id, key_name, slug, stream, cache_state, status, http_status, provider, rank, attempts,
        prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, error, steps_json, request_json, response_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      t.id, nowIso(), t.keyId || null, t.keyName || null, t.slug, t.stream ? 1 : 0,
      t.cacheState || null, t.status, t.httpStatus ?? null, t.provider || null,
      t.rank ?? null, t.attempts || 0, t.promptTokens || 0, t.completionTokens || 0,
      t.totalTokens || 0, t.costUsd || 0, t.latencyMs || 0, t.error ? String(t.error).slice(0, 2000) : null,
      JSON.stringify(t.steps || []), t.requestJson ? capBody(t.requestJson) : null,
      t.responseJson ? capBody(t.responseJson) : null
    ).run();
  } catch (e) {
    blog("TRAJECTORY record failed: " + String(e.message || e));
  }
}
// Canonical attempt outcome. health_impact=1 marks operational failures the
// route posterior should learn from; capability/caller/policy/credential
// failures are excluded so an unsupported-vision request or a dead key never
// makes a route look unreliable.
function classifyAttempt(status, why, errKind) {
  const s = Number(status) || 0;
  const w = String(why || errKind || "").toLowerCase();
  const op = (cls) => ({ failure_class: cls, health_impact: 1 });
  const noimp = (cls) => ({ failure_class: cls, health_impact: 0 });
  if (w === "model" || /model_unavailable|unknown model|not found/.test(w))
    return noimp("model_unavailable");
  if (w === "tool_schema" || /\btool\b|vision|capability|unsupported/.test(w))
    return noimp("capability");
  if (w === "request_size" || /context|too.?large|request_size/.test(w))
    return noimp("caller");
  if (/captcha|credentials|browser_unavailable|config/.test(w))
    return noimp("capability");
  if (w === "auth")
    return noimp("auth");
  if (w === "rate_limit")
    return noimp("rate_limit");
  // Operational classes matched on the known `why` BEFORE any status fallback,
  // so a Relbackend opaque-upstream 400 (why="relay") is bad_upstream_response
  // (health_impact=1), not a caller 400.
  if (w === "relay" || /relay|bad_upstream|malformed|stream_error/.test(w))
    return op("bad_upstream_response");
  if (/timeout|timed out/.test(w))
    return op("timeout");
  if (/reset|econnreset|socket|connect/.test(w))
    return op("connect");
  if (/waf/.test(w))
    return op("waf");
  // Status-only fallbacks.
  if (s === 401 || s === 403)
    return noimp("auth");
  if (s === 429)
    return noimp("rate_limit");
  if (s === 408 || s === 504)
    return op("timeout");
  if (s === 400 || s === 404 || s === 422)
    return noimp("caller");
  if (s >= 500 || s === 0)
    return op("upstream_5xx");
  return op("upstream_5xx");
}
// Single source of truth for a stream's terminal outcome, consumed by BOTH
// telemetry systems (route_attempts + router_stats posterior, and the legacy
// trajectories dual-write) so they can never disagree about the same stream.
// Precedence: a client cancel wins over everything (the user abandoned the
// stream — not a route failure, never trains the posterior, and must not move
// V1 health); then a hard stream error; then a stream that closed without a
// finish_reason (operationally incomplete — a partial body is not a win); else
// success. `observe` gates the Beta posterior; `health_impact` mirrors it.
function streamTerminalOutcome({ clientCancelled, streamError, finishSeen }) {
  if (clientCancelled)
    return { success: 0, failure_class: "cancelled", observe: false, health_impact: 0, trajectory_status: "cancelled", http_status: 499 };
  if (streamError)
    return { success: 0, failure_class: "stream_error", observe: true, health_impact: 1, trajectory_status: "fail", http_status: 500 };
  if (!finishSeen)
    return { success: 0, failure_class: "stream_incomplete", observe: true, health_impact: 1, trajectory_status: "fail", http_status: 500 };
  return { success: 1, failure_class: "success", observe: true, health_impact: 1, trajectory_status: "ok", http_status: 200 };
}
var routerStatLocks = new Map();
function withRouterStatLock(lockKey, fn) {
  const prev = routerStatLocks.get(lockKey) || Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(() => {}, () => {});
  routerStatLocks.set(lockKey, settled);
  // Drop the settled tail so the map does not retain a resolved promise per
  // key forever; only clear it if no newer observation has queued behind us.
  settled.finally(() => {
    if (routerStatLocks.get(lockKey) === settled)
      routerStatLocks.delete(lockKey);
  });
  return next;
}
// Persisted Beta(alpha,beta) posterior per scope, updated only by operational
// outcomes. Time-decayed via the same observe() the shadow router uses. The
// read-modify-write is serialized per (scope|scope_id|task_type) so concurrent
// requests cannot lose an observation. router_stats is a derived cache;
// route_attempts is the immutable source of truth if a rebuild is ever needed.
async function updateRouterStat(c, scope, scopeId, taskType, success, latencyMs, costUsd) {
  const tt = taskType || "";
  return withRouterStatLock(scope + "|" + scopeId + "|" + tt, async () => {
    try {
      const row = await c.env.DB.prepare("SELECT success_alpha, failure_beta, latency_ema, cost_ema, updated_at FROM router_stats WHERE scope=? AND scope_id=? AND task_type=?").bind(scope, scopeId, tt).first();
      const seed = seedBeta("route");
      const prev = row
        ? { alpha: Number(row.success_alpha) || seed.alpha, beta: Number(row.failure_beta) || seed.beta, updatedAt: Date.parse(row.updated_at) || Date.now(), kind: "route" }
        : { ...seed, updatedAt: Date.now(), kind: "route" };
      const next = betaObserve(prev, !!success);
      const lat = Number(latencyMs);
      const cost = Number(costUsd);
      const emaL = row && row.latency_ema != null && Number.isFinite(lat) ? 0.8 * Number(row.latency_ema) + 0.2 * lat : (Number.isFinite(lat) ? lat : (row ? row.latency_ema : null));
      const emaC = row && row.cost_ema != null && Number.isFinite(cost) ? 0.8 * Number(row.cost_ema) + 0.2 * cost : (Number.isFinite(cost) ? cost : (row ? row.cost_ema : null));
      await c.env.DB.prepare("INSERT INTO router_stats (scope, scope_id, task_type, success_alpha, failure_beta, latency_ema, cost_ema, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scope, scope_id, task_type) DO UPDATE SET success_alpha=excluded.success_alpha, failure_beta=excluded.failure_beta, latency_ema=excluded.latency_ema, cost_ema=excluded.cost_ema, updated_at=excluded.updated_at").bind(scope, scopeId, tt, next.alpha, next.beta, emaL == null ? null : emaL, emaC == null ? null : emaC, nowIso()).run();
    } catch (e) {
      blog("router_stats update failed: " + String(e.message || e));
    }
  });
}

// ReflexCore sees the same operational outcomes router_stats does: one sample
// per route, plus one per route x task type when the attempt carried one.
// A client cancel never reaches here. Failure to record never blocks serving.
async function observeReflex(c, routeId, taskType, success, latencyMs, costUsd) {
  try {
    await migrateReflexPosteriors(c.env.DB);
    const scopeId = "route:" + (routeId ?? "?");
    await observePosterior(c.env.DB, "route", scopeId, "", { success, latencyMs, costUsd });
    if (taskType)
      await observePosterior(c.env.DB, "route", scopeId, taskType, { success, latencyMs, costUsd });
  } catch (e) {
    blog("reflex posterior failed: " + String(e.message || e));
  }
}
// Flatten the Router V2 shadow decision into the nullable route_attempts
// columns. Only the final serving attempt of an auto-routed request carries
// these, so the experiment ("how often would quality change the choice?") is
// recorded exactly once per request. Nulls everywhere else.
function shadowAttemptFields(autoDecision) {
  const sh = autoDecision && autoDecision.v2 && autoDecision.v2.shadow;
  if (!sh) return {};
  const opRoute = sh.operational_only_pick || {};
  const qaPick = sh.quality_aware_pick || null;
  const floors = sh.floors || {};
  return {
    v2_operational_route_id: opRoute.routeId ?? null,
    v2_quality_route_id: qaPick ? (qaPick.routeId ?? null) : null,
    v2_quality_changed: sh.changed ? 1 : 0,
    v2_quality_state: String(sh.quality_state || (qaPick ? "cold" : "none")),
    v2_quality_reason: String(sh.quality_reason || "no shadow decision"),
    v2_reliability_floor: floors.reliability != null ? Number(floors.reliability) : null,
    v2_quality_floor: floors.quality != null ? Number(floors.quality) : null,
    // 1 when V2 actually chose this request, so a live rollout can be measured
    // against the shadow-only baseline without reading the served route back
    // out of the attempt chain.
    v2_served: autoDecision && autoDecision.v2_served ? 1 : 0
  };
}
// One row per real upstream attempt. Body-free. Returns the row id (for a
// later streaming metric patch) or null. Updates the route posterior only for
// operational outcomes (success, or failure with health_impact).
async function recordRouteAttempt(c, a) {
  try {
    const r = await c.env.DB.prepare(
      `INSERT INTO route_attempts
       (request_id, parent_slug, route_id, provider_id, provider_key_id, public_slug, upstream_model, transport, task_type,
        attempt_index, key_attempt_index, started_at, finished_at, success, health_impact, http_status, failure_class, failure_code,
        ttft_ms, headers_ms, latency_ms, prompt_tokens, completion_tokens, estimated_cost_usd, actual_cost_usd, fallback_from_route_id, rescue_used,
        tool_valid, tool_success, verification_score,
        v2_operational_route_id, v2_quality_route_id, v2_quality_changed, v2_quality_state, v2_quality_reason,
        v2_reliability_floor, v2_quality_floor)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      a.request_id, a.parent_slug ?? null, a.route_id ?? null, a.provider_id ?? null, a.provider_key_id ?? null,
      a.public_slug, a.upstream_model ?? null, a.transport ?? null, a.task_type ?? "",
      a.attempt_index ?? 0, a.key_attempt_index ?? 0, a.started_at, a.finished_at ?? nowIso(),
      a.success ? 1 : 0, a.health_impact ? 1 : 0, a.http_status ?? null, a.failure_class ?? null, a.failure_code ?? null,
      a.ttft_ms ?? null, a.headers_ms ?? null, a.latency_ms ?? null, a.prompt_tokens ?? 0, a.completion_tokens ?? 0,
      a.estimated_cost_usd ?? null, a.actual_cost_usd ?? null, a.fallback_from_route_id ?? null, a.rescue_used ? 1 : 0,
      a.tool_valid ?? null, a.tool_success ?? null, a.verification_score ?? null,
      a.v2_operational_route_id ?? null, a.v2_quality_route_id ?? null, a.v2_quality_changed ?? null,
      a.v2_quality_state ?? null, a.v2_quality_reason ?? null,
      a.v2_reliability_floor ?? null, a.v2_quality_floor ?? null
    ).run();
    if ((a.success || a.health_impact) && !a.deferPosterior) {
      const ok = !!a.success;
      const scopeId = "route:" + (a.route_id ?? "?");
      await updateRouterStat(c, "route", scopeId, "", ok, a.latency_ms, a.actual_cost_usd);
      if (a.task_type)
        await updateRouterStat(c, "route_task", scopeId, a.task_type, ok, a.latency_ms, a.actual_cost_usd);
      await observeReflex(c, a.route_id, a.task_type, ok, a.latency_ms, a.actual_cost_usd);
    }
    // Quality observations are a separate channel from the operational
    // posterior: only attempts carrying real answer evidence emit anything,
    // and a bare 200 emits nothing (see router/quality.js). Idempotent per
    // (request, attempt, signal, source) via the table's UNIQUE constraint.
    if (r && r.meta && r.meta.last_row_id)
      await emitQualityObservations(c, r.meta.last_row_id, a);
    return (r && r.meta && r.meta.last_row_id) || null;
  } catch (e) {
    blog("route_attempt record failed: " + String(e.message || e));
    return null;
  }
}

// One row per auto decision, written once, before any upstream attempt. The
// candidate set is exactly what the policy scored, rejected routes included,
// so a later Vey export reads history instead of rebuilding it from today's
// route table. Body-free: counts and route ids only, never the prompt.
// Explicit-model requests write nothing. A failure here never blocks serving.
function decisionSnapshot(decision) {
  const list = Array.isArray(decision && decision.candidates) ? decision.candidates : [];
  // V1 chooses a slug. The serving loop picks the route later, so naming
  // routeIds[0] as the selected action would record a route the policy never
  // chose. route_ids stays on the candidate so the episode can still show
  // which routes existed; the attempts carry the ones that were tried.
  const task = decision.v2 && decision.v2.taskIR && decision.v2.taskIR.task;
  // Name the policy that actually chose, not the one that usually chooses: a
  // V2-served request recorded as router-v1 would make the export lie about
  // which policy produced the episode.
  const servedV2 = !!decision.v2_served;
  return {
    policyName: servedV2 ? "router-v2" : "router-v1",
    policyVersion: servedV2 ? "router-v2@live" : "router-v1@live",
    taskType: task || null,
    taskIrVersion: task ? "taskir-v1" : null,
    context: {
      context_tokens: Number(decision.estInputTokens) || 0,
      images: Number(decision.images) || 0,
      need: decision.need != null ? Number(decision.need) : null,
      complexity: decision.complexity != null ? Number(decision.complexity) : null
    },
    candidates: list.map((x) => ({
      action_id: "slug:" + x.slug,
      slug: x.slug,
      route_ids: Array.isArray(x.routeIds) ? x.routeIds.slice() : [],
      eligible: !!x.eligible,
      reason: x.reason || null,
      quality: x.quality,
      cost: x.cost,
      avg_ms: x.avgMs,
      ok_rate: x.okRate,
      samples: x.samples,
      context: x.context || 0,
      output: x.output || 0
    })),
    selectedAction: "slug:" + decision.slug
  };
}
async function recordRouterDecision(c, requestId, decision) {
  if (!decision || !requestId)
    return false;
  try {
    const snap = decisionSnapshot(decision);
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO router_decisions
       (request_id, policy_name, policy_version, task_type, task_ir_version, context_features_json, candidate_set_json, selected_action_id, propensity, exploration, decision_type, created_at)
       VALUES (?,?,?,?,?,?,?,?,NULL,0,'deterministic',?)`
    ).bind(
      requestId, snap.policyName, snap.policyVersion, snap.taskType, snap.taskIrVersion,
      JSON.stringify(snap.context), JSON.stringify(snap.candidates), snap.selectedAction, nowIso()
    ).run();
    return true;
  } catch (e) {
    blog("router_decision record failed: " + String(e.message || e));
    return false;
  }
}

// One shadow row per auto request, written when the first real route is tried
// and filled in when that attempt ends. INSERT OR IGNORE keeps retries and
// fallbacks from adding a second row. It reads and writes; it never calls out.
async function recordLatencyShadow(c, requestId, primary, decision, taskType, routes) {
  if (!decision || !requestId || !primary)
    return false;
  try {
    const bucket = contextBucket(decision.estInputTokens);
    const samples = await ttftSamples(c, primary, taskType, bucket);
    const deadline = deadlineFor({ taskType, samples });
    const providerOf = new Map((routes || []).map((r) => [r.id, r.provider_id]));
    const backup = chooseBackup(
      { routeId: primary.id, providerId: primary.provider_id, quality: decision.quality },
      (decision.candidates || []).filter((x) => x.eligible).flatMap((x) =>
        (x.routeIds || []).map((id) => ({
          routeId: id, providerId: providerOf.get(id) ?? null, slug: x.slug, eligible: true,
          quality: x.quality, expectedTtftMs: x.avgMs
        }))
      )
    );
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO latency_shadow_decisions
       (request_id, primary_route_id, primary_provider_id, primary_slug, backup_route_id, backup_provider_id, backup_slug, task_type, context_bucket, deadline_ms, baseline_ms, baseline_samples, deadline_source, hedge_possible, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      requestId, primary.id, primary.provider_id, primary.public_slug || decision.slug,
      backup ? backup.routeId : null, backup ? backup.providerId : null, backup ? backup.slug : null,
      taskType || null, bucket, deadline.deadlineMs, deadline.baselineMs, deadline.samples, deadline.source,
      backup ? 1 : 0, nowIso()
    ).run();
    return true;
  } catch (e) {
    blog("latency shadow record failed: " + String(e.message || e));
    return false;
  }
}
async function ttftSamples(c, primary, taskType, bucket) {
  const out = [];
  try {
    const rows = await c.env.DB.prepare(
      "SELECT task_type, AVG(ttft_ms) avg, COUNT(*) n FROM route_attempts WHERE route_id=? AND ttft_ms IS NOT NULL AND headers_ms > 0 GROUP BY task_type"
    ).bind(primary.id).all();
    let routeN = 0;
    let routeSum = 0;
    for (const r of rows.results || []) {
      const n = Number(r.n) || 0;
      routeN += n;
      routeSum += (Number(r.avg) || 0) * n;
      if (r.task_type === taskType)
        out.push({ key: "route-task", ttftMs: Number(r.avg), n });
    }
    if (routeN)
      out.push({ key: "route", ttftMs: routeSum / routeN, n: routeN });
  } catch {
  }
  void bucket;
  return out;
}
async function finishLatencyShadow(c, requestId, { headersMs, ttftMs, finishedMs, cancelled }) {
  if (!requestId)
    return;
  try {
    const row = await c.env.DB.prepare(
      "SELECT deadline_ms FROM latency_shadow_decisions WHERE request_id=?"
    ).bind(requestId).first();
    if (!row)
      return;
    const late = wouldHedge({ deadlineMs: row.deadline_ms, ttftMs, finishedMs, cancelled });
    await c.env.DB.prepare(
      "UPDATE latency_shadow_decisions SET observed_headers_ms=?, observed_ttft_ms=?, would_hedge=?, finished_at=? WHERE request_id=? AND finished_at IS NULL"
    ).bind(headersMs ?? null, ttftMs ?? null, late ? 1 : 0, nowIso(), requestId).run();
  } catch (e) {
    blog("latency shadow finish failed: " + String(e.message || e));
  }
}
function trajectorySeed(c, payload, key, slug, isStream, requestId) {
  return {
    id: requestId,
    keyId: key && key.key_id || null,
    keyName: key && key.name || null,
    slug,
    stream: isStream,
    requestJson: JSON.stringify(sanitizeRequest(payload)),
    steps: []
  };
}

function sanitizeRequest(payload) {
  if (!payload || typeof payload !== "object")
    return payload;
  const out = { ...payload };
  for (const k of Object.keys(out)) {
    if (/key|token|secret|authorization|api[_-]?key/i.test(k))
      delete out[k];
  }
  if (typeof out.messages === "string")
    out.messages = "[omitted]";
  return out;
}
function sanitizeUpstreamResponse(text) {
  if (!text)
    return text;
  let s = String(text);
  s = s.replace(/https?:\/\/[^\s"'<>\\\]]+/gi, "[redacted-url]");
  s = s.replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, "[redacted-host]");
  s = s.replace(/\b(?:via-proxy|via-koyeb|DIRECT)\b/g, "[redacted-transport]");
  s = s.replace(/\bprovider\s+[^\s]+/gi, "upstream");
  return s;
}
function genericUpstreamError() {
  return { error: { message: "The selected model is currently experiencing an outage. Please retry later.", type: "upstream_error" } };
}
function publicProviderError(err) {
  const code = String(err && err.code || "");
  if (code === "zai_tools_unsupported") {
    return { status: 400, error: { message: "Tools are not supported by the selected model.", type: "invalid_request_error", code: "unsupported_tools" } };
  }
  if (code === "zai_vision_unsupported") {
    return { status: 400, error: { message: "Image input is not supported by the selected model.", type: "invalid_request_error", code: "unsupported_image_input" } };
  }
  if (code === "zai_captcha") {
    return { status: 503, error: { message: "This route needs a fresh captcha proof. Send one per request, or use a transport that acquires it automatically.", type: "unsupported_feature", code: "captcha_required" } };
  }
  if (code === "zai_tokens" || code === "zai_captcha_config" || code === "zai_http_fallback_failed") {
    return { status: 503, error: { message: "The selected route is temporarily unavailable. Please retry later or use another enabled route.", type: "service_unavailable", code: "route_unavailable" } };
  }
  if (code === "zai_credentials" || code === "zai_browser_unavailable" || code === "zai_model" || code === "zai_model_unavailable") {
    return { status: 503, error: { message: "The selected model is not available on this route right now.", type: "model_unavailable", code: "model_unavailable" } };
  }
  if (code === "zai_waf") {
    return { status: 503, error: { message: "The upstream edge challenged this request. Please retry shortly.", type: "service_busy", code: "upstream_challenged" } };
  }
  if (code === "zai_no_prompt") {
    return { status: 400, error: { message: "At least one user message is required.", type: "invalid_request_error", code: "empty_prompt" } };
  }
  if (Number(err && err.status) === 504) {
    return { status: 504, error: { message: "The selected model did not respond in time. Please retry.", type: "upstream_error", code: "upstream_timeout" } };
  }
  return { status: 503, error: genericUpstreamError().error };
}
// Codes whose failures belong to the caller's request, not provider health:
// they may reach the client and never open a provider breaker.
function isPublicRequestProviderError(err) {
  const code = String(err && err.code || "");
  return code === "zai_tools_unsupported" || code === "zai_vision_unsupported" || code === "zai_no_prompt" ||
    code === "zai_captcha" || code === "zai_tokens" || code === "zai_captcha_config" || code === "zai_http_fallback_failed";
}
function isGenericUpstreamErrorResponse(text) {
  try {
    return JSON.parse(text)?.error?.type === "upstream_error";
  } catch {
    return false;
  }
}
function classifyUpstreamFailure(body) {
  const text = String(body || "").toLowerCase();
  if (/bad (body|url|scheme)|key-mismatch|proxy error|upstream timeout/.test(text))
    return "relay";
  // Relbackend and similar wrappers collapse real upstream failures into a
  // generic {"error":{"type":"upstream_error"}} 400. That is not proof the
  // provider is down, and it is worth a same-key retry.
  if (/"type"\s*:\s*"upstream_error"|upstream_error/.test(text) && !/model.+(not found|invalid)/.test(text))
    return "relay";
  if (/api[ _-]?key|authorization|unauthenticated|forbidden|invalid credential/.test(text))
    return "auth";
  if (/rate.?limit|too many requests|quota/.test(text))
    return "rate_limit";
  if (/model.+(not found|invalid)|unknown model/.test(text))
    return "model";
  if (/tool|function.{0,80}(schema|invalid|unsupported)/.test(text))
    return "tool_schema";
  if (/context|prompt.{0,80}(long|large)|token.{0,80}(limit|large)/.test(text))
    return "request_size";
  return "unknown";
}
function safeSseData(line) {
  return "data: " + JSON.stringify(genericUpstreamError()) + "\n\n";
}
var LEAK_FIELDS = [
  "service_tier",
  "service_provider",
  "service_model",
  "provider",
  "providers",
  "system_fingerprint",
  "x_gw",
  "upstream",
  "upstream_model",
  "real_model",
  "channel",
  "distributor",
  "gateway",
  "backend",
  "source",
  "request_id",
  "served_by",
  "route_id",
  "worker",
  "region",
  "datacenter",
  "metal"
];
var LEAK_FIELD_RE = /^(service_|provider|upstream|backend|channel|distributor|gateway|source|request_id|served_by|route_id|region|datacenter|real_|internal|debug)/i;
function sanitizeClientObject(obj) {
  if (!obj || typeof obj !== "object")
    return obj;
  if (obj.error && typeof obj.error === "object") {
    obj.error = genericUpstreamError().error;
  }
  for (const k of Object.keys(obj)) {
    if (LEAK_FIELDS.includes(k.toLowerCase()) || LEAK_FIELD_RE.test(k))
      delete obj[k];
  }
  return obj;
}
function sanitizeClientResponse(text, publicSlug) {
  if (!text)
    return text;
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    return JSON.stringify(genericUpstreamError());
  }
  if (obj && typeof obj === "object") {
    if (!Array.isArray(obj.choices))
      return JSON.stringify(genericUpstreamError());
    if (publicSlug && "model" in obj)
      obj.model = publicSlug;
    sanitizeClientObject(obj);
    return JSON.stringify(obj);
  }
  return sanitizeUpstreamResponse(text);
}
async function authClient(c) {
  const token = bearerFrom(c);
  if (!token || !token.startsWith("sk-")) {
    return c.json({ error: { message: "Missing or invalid API key. Use Authorization: Bearer sk-...", type: "auth_error" } }, 401);
  }
  const key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(token).first();
  if (!key)
    return c.json({ error: { message: "Unknown API key", type: "auth_error" } }, 401);
  if (!key.active)
    return c.json({ error: { message: "API key is deactivated", type: "auth_error" } }, 403);
  if (isKeyExpired(key))
    return c.json({ error: { message: "API key has expired", type: "key_expired" } }, 403);
  if (isOverBudget(key)) {
    const unit = key.budget_mode === "usd" ? "USD" : "tokens";
    return c.json({
      error: { message: `Key budget exceeded (${unit}). Used ${fmt(key.budget_mode === "usd" ? key.used_usd : key.used_tokens)} / ${fmt(key.budget_limit)} ${unit}.`, type: "budget_exceeded" }
    }, 429);
  }
  // The account cap, resolved by real ownership: account_id when the key is
  // owned, the key's own id when it IS the account's key in the legacy shape.
  // The console_accounts row is the authority; without one, no cap applies.
  const capAccountId = spendAccountId(key);
  if (capAccountId) {
    const account = await c.env.DB.prepare("SELECT budget_mode, budget_limit, used_usd, used_tokens FROM console_accounts WHERE key_id=?").bind(capAccountId).first();
    if (account && account.budget_limit != null) {
      const spent = account.budget_mode === "tokens" ? Number(account.used_tokens) || 0 : Number(account.used_usd) || 0;
      if (spent >= Number(account.budget_limit))
        return c.json({ error: { message: "Account spend limit reached.", type: "budget_exceeded" } }, 429);
    }
  }


  const rateDenied = await enforceRequestLimit(c, key);
  if (rateDenied)
    return rateDenied;
  return { key };
}
function splitModelSlugs(value) {
  return String(value || "").split(",").map((slug) => slug.trim()).filter(Boolean);
}
function normalizeTierModels(value) {
  const models = [...new Set(splitModelSlugs(value))];
  if (!models.length)
    throw new Error("a tier must contain at least one public model slug");
  if (models.length > 100 || models.some((slug) => slug.length > 160))
    throw new Error("tier model list is too large");
  return models.join(",");
}
function normalizeTierIds(value) {
  const raw2 = value == null || value === "" ? [] : Array.isArray(value) ? value : String(value).split(",");
  const ids = [...new Set(raw2.map((id) => Number(id)))];
  if (ids.some((id) => !Number.isInteger(id) || id < 1))
    throw new Error("tier_ids must contain positive integer IDs");
  return ids;
}
async function validateTierIds(c, ids) {
  if (!ids.length)
    return;
  const rows = await c.env.DB.prepare("SELECT id FROM model_tiers WHERE id IN (" + ids.map(() => "?").join(",") + ")").bind(...ids).all();
  if ((rows.results || []).length !== ids.length)
    throw new Error("one or more model tiers do not exist");
}
async function setKeyTierIds(c, keyId, ids) {
  await validateTierIds(c, ids);
  await c.env.DB.prepare("DELETE FROM api_key_model_tiers WHERE key_id=?").bind(keyId).run();
  for (const tierId of ids)
    await c.env.DB.prepare("INSERT INTO api_key_model_tiers (key_id, tier_id) VALUES (?,?)").bind(keyId, tierId).run();
}
function effectiveModelSlugs(key, tiers, enabledSlugs) {
  const enabled = new Set(enabledSlugs || []);
  const explicit = splitModelSlugs(key && key.allowed_models);
  const tierModels = (tiers || []).flatMap((tier) => splitModelSlugs(tier && tier.models));
  const grants = !explicit.length && !tierModels.length ? [...enabled] : [...explicit, ...tierModels];
  const excluded = new Set(splitModelSlugs(key && key.excluded_models));
  return [...new Set(grants)].filter((slug) => enabled.has(slug) && !excluded.has(slug)).sort();
}
async function allowedSlugs(c, key) {
  const all = await c.env.DB.prepare("SELECT slug FROM model_routes WHERE enabled=1").all();
  const tiers = await c.env.DB.prepare(
    `SELECT mt.models FROM model_tiers mt
     JOIN api_key_model_tiers akmt ON akmt.tier_id=mt.id
     WHERE akmt.key_id=? ORDER BY mt.name`
  ).bind(key.key_id).all();
  return effectiveModelSlugs(key, tiers.results || [], (all.results || []).map((row) => row.slug));
}
async function slugAllowed(c, key, slug) {
  const allowed = await allowedSlugs(c, key);
  return allowed.includes(slug);
}
app.post("/admin/keys", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const name = String(body.name || "unnamed").slice(0, 120);
  const budget_mode = body.budget_mode === "usd" ? "usd" : "tokens";
  const budget_limit = Number(body.budget_limit);
  if (!Number.isFinite(budget_limit) || budget_limit <= 0)
    return c.json({ error: { message: "budget_limit must be positive" } }, 400);
  let request_limit_per_minute;
  try {
    request_limit_per_minute = normalizeRequestLimit(body.request_limit_per_minute);
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  let expires_at;
  try {
    expires_at = normalizeKeyExpiry(body.expires_at);
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  let allowed_models = null;
  if (body.allowed_models && Array.isArray(body.allowed_models))
    allowed_models = body.allowed_models.join(",");
  else if (body.allowed_models)
    allowed_models = String(body.allowed_models);
  const excluded_models = splitModelSlugs(body.excluded_models).join(",") || null;
  let tierIds;
  try {
    tierIds = normalizeTierIds(body.tier_ids);
    await validateTierIds(c, tierIds);
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  const keyId = genKey();
  await c.env.DB.prepare(
    "INSERT INTO api_keys (key_id, name, budget_mode, budget_limit, request_limit_per_minute, expires_at, allowed_models, excluded_models, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).bind(keyId, name, budget_mode, budget_limit, request_limit_per_minute, expires_at, allowed_models, excluded_models, nowIso(), nowIso()).run();
  await setKeyTierIds(c, keyId, tierIds);
  return c.json({ key_id: keyId, key: keyId, name, budget_mode, budget_limit, request_limit_per_minute, expires_at, allowed_models, excluded_models, tier_ids: tierIds, note: "Send as: Authorization: *** " + keyId }, 201);
});
app.get("/admin/keys", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare(
    `SELECT k.key_id, k.name, k.budget_mode, k.budget_limit, k.used_tokens, k.used_usd, k.request_count, k.request_limit_per_minute, k.expires_at, k.active, k.allowed_models, k.excluded_models, k.account_id, k.created_at, k.updated_at,
      COALESCE((SELECT GROUP_CONCAT(akmt.tier_id, ',') FROM api_key_model_tiers akmt WHERE akmt.key_id=k.key_id), '') AS tier_ids,
      COALESCE((SELECT GROUP_CONCAT(mt.name, ' \xB7 ') FROM api_key_model_tiers akmt JOIN model_tiers mt ON mt.id=akmt.tier_id WHERE akmt.key_id=k.key_id), '') AS tier_names
     FROM api_keys k ORDER BY k.created_at DESC`
  ).all();
  return c.json({ keys: rows.results || [] });
});
app.get("/admin/shared-pool", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const keyId = await settingValue(c, "shared_pool_key", "");
  if (!keyId) return c.json({ key_id: null, pool: null });
  const pool = await c.env.DB.prepare(
    "SELECT key_id, name, budget_mode, budget_limit, used_tokens, used_usd, request_count, active FROM api_keys WHERE key_id=?"
  ).bind(keyId).first();
  return c.json({ key_id: pool ? keyId : null, pool: pool || null });
});
app.put("/admin/shared-pool", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: { message: "Invalid JSON" } }, 400); }
  const keyId = body && body.key_id ? String(body.key_id) : "";
  if (keyId) {
    const key = await c.env.DB.prepare("SELECT key_id FROM api_keys WHERE key_id=?").bind(keyId).first();
    if (!key) return c.json({ error: { message: "key not found" } }, 404);
    // The pool key is communal: its secret gets handed around for /v1 use, so it
    // must not hold console access. Drop any existing account and live sessions.
    await c.env.DB.prepare("DELETE FROM console_sessions WHERE key_id=?").bind(keyId).run();
    await c.env.DB.prepare("DELETE FROM console_accounts WHERE key_id=?").bind(keyId).run();
  }
  await c.env.DB.prepare(
    "INSERT INTO gateway_settings (key, value, updated_at) VALUES ('shared_pool_key', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
  ).bind(keyId, nowIso()).run();
  return c.json({ key_id: keyId || null });
});
app.get("/admin/keys/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = c.req.param("id");
  const key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(id).first();
  if (!key)
    return c.json({ error: { message: "key not found" } }, 404);
  const tiers = await c.env.DB.prepare("SELECT mt.id, mt.name, mt.models FROM api_key_model_tiers akmt JOIN model_tiers mt ON mt.id=akmt.tier_id WHERE akmt.key_id=? ORDER BY mt.name").bind(id).all();
  return c.json({ key, tiers: tiers.results || [] });
});
app.patch("/admin/keys/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(id).first();
  if (!existing)
    return c.json({ error: { message: "key not found" } }, 404);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const sets = [];
  const binds = [];
  if (body.name !== void 0) {
    const name = String(body.name).trim().slice(0, 120);
    if (!name)
      return c.json({ error: { message: "name is required" } }, 400);
    sets.push("name=?");
    binds.push(name);
  }
  if (body.budget_mode !== void 0) {
    sets.push("budget_mode=?");
    binds.push(body.budget_mode === "usd" ? "usd" : "tokens");
  }
  if (body.budget_limit !== void 0) {
    const n = Number(body.budget_limit);
    if (!Number.isFinite(n) || n <= 0)
      return c.json({ error: { message: "budget_limit must be positive" } }, 400);
    sets.push("budget_limit=?");
    binds.push(n);
  }
  if (body.allowed_models !== void 0) {
    const models = Array.isArray(body.allowed_models) ? body.allowed_models.join(",") : String(body.allowed_models || "").trim();
    sets.push("allowed_models=?");
    binds.push(models || null);
  }
  if (body.request_limit_per_minute !== void 0) {
    try {
      sets.push("request_limit_per_minute=?");
      binds.push(normalizeRequestLimit(body.request_limit_per_minute));
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  if (body.expires_at !== void 0) {
    try {
      sets.push("expires_at=?");
      binds.push(normalizeKeyExpiry(body.expires_at));
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  if (body.excluded_models !== void 0) {
    sets.push("excluded_models=?");
    binds.push(splitModelSlugs(body.excluded_models).join(",") || null);
  }
  let tierIds = null;
  if (body.tier_ids !== void 0) {
    try {
      tierIds = normalizeTierIds(body.tier_ids);
      await validateTierIds(c, tierIds);
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  if (body.active !== void 0) {
    sets.push("active=?");
    binds.push(body.active ? 1 : 0);
  }
  if (!sets.length && tierIds === null)
    return c.json({ error: { message: "no editable fields supplied" } }, 400);
  if (sets.length) {
    sets.push("updated_at=?");
    binds.push(nowIso(), id);
    await c.env.DB.prepare("UPDATE api_keys SET " + sets.join(", ") + " WHERE key_id=?").bind(...binds).run();
  }
  if (tierIds !== null)
    await setKeyTierIds(c, id, tierIds);
  const key = await c.env.DB.prepare("SELECT key_id, name, budget_mode, budget_limit, used_tokens, used_usd, request_count, request_limit_per_minute, expires_at, active, allowed_models, excluded_models, created_at, updated_at FROM api_keys WHERE key_id=?").bind(id).first();
  const tiers = await c.env.DB.prepare("SELECT mt.id, mt.name, mt.models FROM api_key_model_tiers akmt JOIN model_tiers mt ON mt.id=akmt.tier_id WHERE akmt.key_id=? ORDER BY mt.name").bind(id).all();
  return c.json({ key, tiers: tiers.results || [] });
});
async function setActive(c, id, active) {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(id).first();
  if (!key)
    return c.json({ error: { message: "key not found" } }, 404);
  await c.env.DB.prepare("UPDATE api_keys SET active=?, updated_at=? WHERE key_id=?").bind(active ? 1 : 0, nowIso(), id).run();
  return c.json({ key_id: id, active: !!active });
}
app.post("/admin/keys/:id/deactivate", (c) => setActive(c, c.req.param("id"), 0));
app.post("/admin/keys/:id/activate", (c) => setActive(c, c.req.param("id"), 1));
app.delete("/admin/keys/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM console_account_tokens WHERE key_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM api_keys WHERE key_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM response_cache WHERE key_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM api_key_rate_windows WHERE key_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM console_sessions WHERE key_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM console_accounts WHERE key_id=?").bind(id).run();
  // If this key was the shared pool, retire the designation too.
  if (await isSharedPoolKey(c, id))
    await c.env.DB.prepare("UPDATE gateway_settings SET value='', updated_at=? WHERE key='shared_pool_key'").bind(nowIso()).run();
  return c.json({ deleted: id });
});
// The account roster: one row per console_accounts join api_keys, with the
// key's limits and tier assignment in the same payload so the operator can
// manage credentials and access from one place instead of joining tabs.
app.get("/admin/accounts", async (c) => {
  await ensureAccountTokensTable(c.env.DB);
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const rows = await c.env.DB.prepare(
    `SELECT ca.key_id, ca.username, ca.created_at AS account_created,
       ca.budget_mode, ca.budget_limit, ca.used_usd, ca.used_tokens,
       (SELECT COUNT(*) FROM api_keys ak WHERE ak.account_id=ca.key_id) AS key_count,
       COALESCE((SELECT GROUP_CONCAT(mt.name, ' \xB7 ') FROM console_account_tiers cat JOIN model_tiers mt ON mt.id=cat.tier_id WHERE cat.key_id=ca.key_id), '') AS tier_names
     FROM console_accounts ca
     ORDER BY ca.username`
  ).all();
  const tokens = await c.env.DB.prepare(
    "SELECT token_hash, key_id, purpose, created_at, expires_at, used_at FROM console_account_tokens ORDER BY created_at DESC"
  ).all();
  return c.json({ accounts: rows.results || [], tokens: tokens.results || [] });
});

// Operator credit book: how much remains for every allocation the gateway
// enforces, in one read. Accounts (the customers) and standalone keys each get
// their own row; the grand totals add the remaining amounts so an operator can
// answer "how much is left in total" without a spreadsheet. Uncapped rows
// contribute usage to the used totals but never to the remaining totals,
// because an infinite cap has no meaningful remainder to add.
app.get("/admin/credits", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const accounts = await c.env.DB.prepare(
    "SELECT ca.key_id, ca.username, ca.budget_mode, ca.budget_limit, ca.used_usd, ca.used_tokens FROM console_accounts ca ORDER BY ca.username"
  ).all();
  const keys = await c.env.DB.prepare(
    "SELECT k.key_id, k.name, k.budget_mode, k.budget_limit, k.used_usd, k.used_tokens, k.active, k.account_id FROM api_keys k ORDER BY k.name"
  ).all();
  const quotaOf = (budget) => {
    const mode = String(budget.budget_mode || "usd");
    const used = mode === "usd" ? Number(budget.used_usd) || 0 : Number(budget.used_tokens) || 0;
    const raw = budget.budget_limit == null ? null : Number(budget.budget_limit);
    // api_keys.budget_limit is NOT NULL with 0 as the legacy no-cap marker;
    // console_accounts uses real NULL. Either shape normalizes to total null,
    // and available must derive from the SAME normalized total so an uncapped
    // row reads total/available null, never a fake zero-remaining.
    const total = Number.isFinite(raw) && raw > 0 ? raw : null;
    return {
      kind: mode === "tokens" ? "tokens" : "usd",
      total,
      used,
      available: total == null ? null : Math.max(0, total - used)
    };
  };
  const rows = [];
  for (const a of accounts.results || []) {
    const q = quotaOf(a);
    rows.push({ kind: "account", id: a.key_id, name: a.username, quota: q });
  }
  for (const k of keys.results || []) {
    const q = quotaOf(k);
    rows.push({
      kind: "key",
      id: k.key_id,
      name: k.name,
      active: k.active === 1,
      owned_by_account: k.account_id ? String(k.account_id) : null,
      quota: q
    });
  }
  const total = { usd: { used: 0, available: 0 }, tokens: { used: 0, available: 0 } };
  for (const r of rows) {
    const bucket = r.quota.kind === "tokens" ? total.tokens : total.usd;
    bucket.used += r.quota.used;
    bucket.available += r.quota.available || 0;
  }
  return c.json({ rows, total });
});
// Create the customer and hand back one link. Registered before the
// /admin/accounts/:id routes so Hono does not treat "accounts" as an id.
app.post("/admin/accounts", async (c) => {
  await ensureAccountTokensTable(c.env.DB);
  const denied = await requireAdmin(c);
  if (denied) return denied;
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: { message: "Invalid JSON" } }, 400); }
  const budget_mode = body.budget_mode === "tokens" ? "tokens" : "usd";
  const budget_limit = body.budget_limit == null || body.budget_limit === "" ? null : Number(body.budget_limit);
  if (budget_limit != null && (!Number.isFinite(budget_limit) || budget_limit <= 0))
    return c.json({ error: { message: "budget_limit must be positive, or blank for no cap" } }, 400);
  let tierIds;
  try { tierIds = normalizeTierIds(body.tier_ids); await validateTierIds(c, tierIds); }
  catch (e) { return c.json({ error: { message: e.message } }, 400); }
  const id = "acct_" + uuid().replace(/-/g, "");
  const issued = await issueAccountToken(c, id, "invite", { budget_mode, budget_limit, tier_ids: tierIds.join(",") });
  return c.json({ account_id: id, url: redeemUrl(c, issued.token), token: issued.token, expires_at: issued.expires_at, budget_mode, budget_limit, tier_ids: tierIds }, 201);
});


// Issue a reset link for an existing account. The plaintext token comes back
// exactly once; the operator copies it to the user. Any prior pending reset
// for the same key is revoked first so only the newest link is live.
app.post("/admin/accounts/:id/reset-link", async (c) => {
  await ensureAccountTokensTable(c.env.DB);
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const account = await c.env.DB.prepare("SELECT key_id FROM console_accounts WHERE key_id=?").bind(id).first();
  if (!account) return c.json({ error: { message: "This key has no account to reset." } }, 404);
  await c.env.DB.prepare(
    "DELETE FROM console_account_tokens WHERE key_id=? AND purpose='reset' AND used_at IS NULL"
  ).bind(id).run();
  const issued = await issueAccountToken(c, id, "reset");
  return c.json({ url: redeemUrl(c, issued.token), token: issued.token, expires_at: issued.expires_at }, 201);
});



// Change the cap or the model tiers an account's keys inherit.
app.patch("/admin/accounts/:id", async (c) => {
  await ensureAccountTokensTable(c.env.DB);
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const account = await c.env.DB.prepare("SELECT key_id FROM console_accounts WHERE key_id=?").bind(id).first();
  if (!account) return c.json({ error: { message: "account not found" } }, 404);
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: { message: "Invalid JSON" } }, 400); }
  if (body.budget_mode !== void 0 || body.budget_limit !== void 0) {
    const mode = body.budget_mode === "tokens" ? "tokens" : "usd";
    const limit = body.budget_limit == null || body.budget_limit === "" ? null : Number(body.budget_limit);
    if (limit != null && (!Number.isFinite(limit) || limit <= 0))
      return c.json({ error: { message: "budget_limit must be positive, or blank for no cap" } }, 400);
    await c.env.DB.prepare("UPDATE console_accounts SET budget_mode=?, budget_limit=? WHERE key_id=?").bind(mode, limit, id).run();
  }
  if (body.tier_ids !== void 0) {
    let tierIds;
    try { tierIds = normalizeTierIds(body.tier_ids); await validateTierIds(c, tierIds); }
    catch (e) { return c.json({ error: { message: e.message } }, 400); }
    await c.env.DB.prepare("DELETE FROM console_account_tiers WHERE key_id=?").bind(id).run();
    for (const tierId of tierIds)
      await c.env.DB.prepare("INSERT INTO console_account_tiers (key_id, tier_id) VALUES (?,?)").bind(id, tierId).run();
  }
  return c.json({ key_id: id });
});

// Issue an account-creation link for a key that has no account yet. The
// recipient sets up their own username and password without the operator
// ever seeing or handing out the raw API key.
app.post("/admin/accounts/:id/invite-link", async (c) => {
  await ensureAccountTokensTable(c.env.DB);
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const key = await c.env.DB.prepare("SELECT key_id, name FROM api_keys WHERE key_id=?").bind(id).first();
  if (!key) return c.json({ error: { message: "key not found" } }, 404);
  const existing = await c.env.DB.prepare("SELECT key_id FROM console_accounts WHERE key_id=?").bind(id).first();
  if (existing) return c.json({ error: { message: "This key already has an account." } }, 409);
  await c.env.DB.prepare(
    "DELETE FROM console_account_tokens WHERE key_id=? AND purpose='invite' AND used_at IS NULL"
  ).bind(id).run();
  const issued = await issueAccountToken(c, id, "invite");
  return c.json({ url: redeemUrl(c, issued.token), token: issued.token, expires_at: issued.expires_at }, 201);
});

// Revoke a pending token. Only unused, unexpired tokens matter, but revoking
// any row is safe and keeps the list honest.
app.delete("/admin/account-tokens/:hash", async (c) => {
  await ensureAccountTokensTable(c.env.DB);
  const denied = await requireAdmin(c);
  if (denied) return denied;
  // The admin UI lists hashes, but a caller may hold the raw token; hash a
  // plaintext rst_ value so both spellings delete the same row.
  const param = c.req.param("hash");
  const hash = param.startsWith("rst_") ? await sha256hex(param) : param;
  await c.env.DB.prepare("DELETE FROM console_account_tokens WHERE token_hash=?").bind(hash).run();
  return c.json({ deleted: hash });
});

function redeemUrl(c, token) {
  const origin = new URL(c.req.url).origin;
  return origin + "/console/redeem?token=" + encodeURIComponent(token);
}
app.get("/admin/model-tiers", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare(
    `SELECT mt.*, (SELECT COUNT(*) FROM api_key_model_tiers akmt WHERE akmt.tier_id=mt.id) AS key_count
     FROM model_tiers mt ORDER BY mt.name`
  ).all();
  return c.json({ tiers: rows.results || [] });
});
app.post("/admin/model-tiers", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const name = String(body.name || "").trim().slice(0, 120);
  if (!name)
    return c.json({ error: { message: "tier name is required" } }, 400);
  let models;
  try {
    models = normalizeTierModels(body.models);
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  try {
    const row = await c.env.DB.prepare("INSERT INTO model_tiers (name, models, created_at, updated_at) VALUES (?,?,?,?) RETURNING id, name, models, created_at, updated_at").bind(name, models, nowIso(), nowIso()).first();
    return c.json({ tier: row }, 201);
  } catch {
    return c.json({ error: { message: "tier name already exists" } }, 409);
  }
});
app.patch("/admin/model-tiers/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1)
    return c.json({ error: { message: "invalid tier id" } }, 400);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const sets = [];
  const binds = [];
  if (body.name !== void 0) {
    const name = String(body.name || "").trim().slice(0, 120);
    if (!name)
      return c.json({ error: { message: "tier name is required" } }, 400);
    sets.push("name=?");
    binds.push(name);
  }
  if (body.models !== void 0) {
    try {
      sets.push("models=?");
      binds.push(normalizeTierModels(body.models));
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  if (!sets.length)
    return c.json({ error: { message: "no editable fields supplied" } }, 400);
  try {
    sets.push("updated_at=?");
    binds.push(nowIso(), id);
    await c.env.DB.prepare("UPDATE model_tiers SET " + sets.join(", ") + " WHERE id=?").bind(...binds).run();
  } catch {
    return c.json({ error: { message: "tier name already exists" } }, 409);
  }
  const tier = await c.env.DB.prepare("SELECT * FROM model_tiers WHERE id=?").bind(id).first();
  if (!tier)
    return c.json({ error: { message: "tier not found" } }, 404);
  return c.json({ tier });
});
app.delete("/admin/model-tiers/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1)
    return c.json({ error: { message: "invalid tier id" } }, 400);
  await c.env.DB.prepare("DELETE FROM api_key_model_tiers WHERE tier_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM model_tiers WHERE id=?").bind(id).run();
  return c.json({ deleted: id });
});
app.get("/admin/providers", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.base_url, p.priority, p.healthy, p.enabled, p.last_status, p.last_checked, p.notes, p.fmt, p.proxy_url, p.transport, p.extra_headers, p.key_strategy,
            (SELECT COUNT(*) FROM provider_keys pk WHERE pk.provider_id=p.id AND pk.enabled=1) AS key_count
     FROM providers p ORDER BY p.priority`
  ).all();
  return c.json({ providers: rows.results || [] });
});
app.get("/admin/providers/:id/keys", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  const rows = await c.env.DB.prepare("SELECT id, label, enabled, created_at FROM provider_keys WHERE provider_id=? ORDER BY id").bind(id).all();
  return c.json({ keys: rows.results || [] });
});
app.post("/admin/providers/:id/keys", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  let b;
  try { b = await c.req.json(); } catch { return c.json({ error: { message: "Invalid JSON" } }, 400); }
  if (!b.api_key)
    return c.json({ error: { message: "api_key required" } }, 400);
  const sealed = await sealProviderKey(c.env, String(b.api_key));
  const r = await c.env.DB.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?) RETURNING id").bind(id, sealed, b.label || null, nowIso()).all();
  const kid = r.results && r.results[0] && r.results[0].id;
  return c.json({ id: kid, label: b.label || null }, 201);
});
app.delete("/admin/providers/:id/keys/:keyId", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  const keyId = Number(c.req.param("keyId"));
  const remaining = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM provider_keys WHERE provider_id=? AND enabled=1 AND id<>?").bind(id, keyId).first();
  if (Number(remaining && remaining.n) < 1)
    return c.json({ error: { message: "cannot remove the last enabled key" } }, 400);
  await c.env.DB.prepare("DELETE FROM provider_keys WHERE id=? AND provider_id=?").bind(keyId, id).run();
  return c.json({ ok: true });
});
app.get("/admin/proxy-health", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare("SELECT id, name, base_url, proxy_url, transport, enabled FROM providers").all();
  const out = [];
  const koyebHealthUrl = String(c.env.KOYEB_RELAY_URL || "").replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").replace(/\/tunnel\/?$/, "/healthz");
  for (const p of rows.results || []) {
    // Same rule as /status: a disabled provider is out of rotation, so do not
    // spend a probe on it. It stays in the response so the console can list it.
    if (p.enabled === 0 || p.enabled === false) {
      out.push({ id: p.id, name: p.name, enabled: false, transport: String(p.transport || "auto"), proxy: false, reason: "disabled (out of rotation)" });
      continue;
    }
    const transport = routeTransport(p, c.env);
    if (transport === "koyeb") {
      if (!koyebHealthUrl) {
        out.push({ id: p.id, name: p.name, transport, proxy: false, reason: "KOYEB_RELAY_URL not configured" });
        continue;
      }
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8e3);
        const r = await fetch(koyebHealthUrl, { method: "GET", signal: ctrl.signal });
        clearTimeout(t);
        out.push({ id: p.id, name: p.name, transport, proxy: true, relay: "koyeb", relay_reachable: r.ok, relay_status: r.status });
      } catch (e) {
        out.push({ id: p.id, name: p.name, transport, proxy: false, relay: "koyeb", reason: String(e && e.message || e) });
      }
      continue;
    }
    if (transport === "direct" || !p.proxy_url) {
      out.push({ id: p.id, name: p.name, transport, proxy: false, reason: transport === "direct" ? "direct" : "no proxy_url" });
      continue;
    }
    try {
      const testUrl = p.proxy_url + (p.proxy_url.includes("?") ? "&" : "?") + "url=" + encodeURIComponent(p.base_url + "/models");
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8e3);
      const r = await fetch(testUrl, { method: "GET", signal: ctrl.signal });
      clearTimeout(t);
      let postStatus = null, postErr = null;
      try {
        const pt = new AbortController();
        const pt2 = setTimeout(() => pt.abort(), 8e3);
        const pr = await fetch(testUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: pt.signal });
        clearTimeout(pt2);
        postStatus = pr.status;
      } catch (e2) {
        postErr = String(e2 && e2.message || e2);
      }
      out.push({ id: p.id, name: p.name, transport, proxy: true, relay: "oci", upstream_status: r.status, post_status: postStatus, post_err: postErr });
    } catch (e) {
      out.push({ id: p.id, name: p.name, transport, proxy: false, relay: "oci", reason: String(e && e.message || e) });
    }
  }
  return c.json({ health: out });
});
// One-click provider setups. Each preset fills provider fields and, when the
// upstream offers a standard family, seeds routes so a new provider is usable
// from the console without hand-copying slugs and model ids.
var PROVIDER_PRESETS = [
  {
    id: "zai-minted",
    label: "Z.AI web chat — recommended (pure HTTP)",
    summary: "GLM-Free-API-style pure HTTP transport: pre-minted Aliyun proofs, throwaway chat UUIDs, session cleanup, vision upload, tools and search. No browser or OS packages on the serving host.",
    fmt: "zaiminted",
    name: "Z.AI web chat (pure HTTP)",
    base_url: "https://chat.z.ai",
    transport: "direct",
    credential_hint: 'Paste {"token":"<chat.z.ai localStorage token>"} — captcha is minted automatically',
    credential_format: "provider_credential",
    routes: [
      { slug: "z-ai/glm-5.3-flash", upstream_model: "glm-5.3-flash" },
      { slug: "z-ai/glm-5.3", upstream_model: "glm-5.3" }
    ]
  },
  {
    id: "zai-browser",
    label: "Z.AI web chat — browser fallback",
    summary: "Fallback/debug transport. Drives the real chat.z.ai page in Chromium when the pure-HTTP proof path is unavailable. More resource-heavy and less reliable on restricted hosts.",
    fmt: "zaiwebbrowser",
    name: "Z.AI web chat (browser)",
    base_url: "https://chat.z.ai",
    transport: "direct",
    credential_hint: 'Paste {"token":"<chat.z.ai localStorage token>"} — no captcha needed',
    credential_format: "provider_credential",
    routes: [
      { slug: "z-ai/glm-5.3-flash", upstream_model: "glm-5.3-flash" },
      { slug: "z-ai/glm-5.3", upstream_model: "glm-5.3" }
    ]
  },
  {
    id: "zai-web",
    label: "Z.AI web chat (chat.z.ai, no API key)",
    summary: "Manual pure-HTTP debug path. Same reference wire as the recommended transport, but the caller supplies a fresh captcha_verify_param per completion. Gateway-emulated tools remain supported.",
    fmt: "zaiweb",
    name: "Z.AI web chat",
    base_url: "https://chat.z.ai",
    transport: "direct",
    credential_hint: 'Paste {"token":"<chat.z.ai localStorage token>"} — the captcha proof changes every completion, so send it per request as the x-zai-captcha header',
    credential_format: "provider_credential",
    routes: [
      { slug: "z-ai/glm-5.3-flash", upstream_model: "glm-5.3-flash" },
      { slug: "z-ai/glm-5.3", upstream_model: "glm-5.3" }
    ]
  },
  {
    id: "zai-api",
    label: "Z.AI API key (api.z.ai)",
    summary: "Standard GLM API on an API key, OpenAI-compatible, tools supported.",
    fmt: "openai",
    name: "Z.AI API",
    base_url: "https://api.z.ai/api/paas/v4",
    transport: "auto",
    credential_hint: "Paste the API key from z.ai/manage-apikey.",
    credential_format: "api_key",
    routes: [
      { slug: "z-ai/glm-4.6", upstream_model: "glm-4.6" },
      { slug: "z-ai/glm-4.5", upstream_model: "glm-4.5" }
    ]
  },
  {
    id: "charm-hyper",
    label: "Charm Hyper — OpenAI-compatible (hyper.charm.land/v1)",
    summary: "Coding-focused inference from Charm. OpenAI-compatible chat completions; key from hyper.charm.land. Seeds GLM, DeepSeek, Kimi, and Qwen picks.",
    fmt: "openai",
    name: "Charm Hyper",
    base_url: "https://hyper.charm.land/v1",
    transport: "auto",
    credential_hint: "Paste the API key from your hyper.charm.land account.",
    credential_format: "api_key",
    routes: [
      { slug: "hyper/glm-5.3", upstream_model: "glm-5.3" },
      { slug: "hyper/glm-5.3-flash", upstream_model: "glm-5.3-flash" },
      { slug: "hyper/deepseek-v4.1-flash", upstream_model: "deepseek-v4.1-flash" },
      { slug: "hyper/kimi-k3", upstream_model: "kimi-k3" },
      { slug: "hyper/qwen3.8-max", upstream_model: "qwen3.8-max" }
    ]
  }
];
function providerPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.id === String(id || "")) || null;
}
async function seedProviderRoutes(c, pid, routes) {
  const created = [];
  const skipped = [];
  for (const route of routes || []) {
    const slug = String(route && route.slug || "").trim();
    const upstream = String(route && route.upstream_model || "").trim();
    if (!slug || !upstream)
      continue;
    const existing = await c.env.DB.prepare("SELECT id FROM model_routes WHERE slug=? AND enabled=1 LIMIT 1").bind(slug).first();
    if (existing) {
      skipped.push(slug);
      continue;
    }
    const next = await c.env.DB.prepare("SELECT COALESCE(MAX(rank),-1)+1 AS next FROM model_routes WHERE slug=?").bind(slug).first();
    await c.env.DB.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,?,1)").bind(slug, pid, upstream, Number(next && next.next) || 0).run();
    created.push(slug);
  }
  return { created, skipped };
}
// Creates a provider, its routes, and optionally its credential in one call so
// the console's "add provider" can apply a preset without a second pass.
async function createProviderFromPreset(c, body) {
  const preset = providerPreset(body.preset);
  if (!preset)
    return c.json({ error: { message: 'unknown preset "' + String(body.preset || "") + '"' } }, 400);
  const name = String(body.name || preset.name).trim();
  const baseUrl = String(body.base_url || preset.base_url).trim();
  if (!name || !baseUrl)
    return c.json({ error: { message: "preset needs a name and base_url" } }, 400);
  const fmt2 = body.fmt ? normalizeProviderFormat(body.fmt, preset.fmt) : preset.fmt;
  let transport = preset.transport || "auto";
  try {
    transport = normalizeTransport(body.transport || transport);
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  let extraHeaders = "{}";
  try {
    extraHeaders = normalizeExtraHeaders(body.extra_headers);
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  const sealed = body.api_key ? await sealProviderKey(c.env, String(body.api_key)) : null;
  const info = await c.env.DB.prepare(
    "INSERT INTO providers (name, base_url, priority, healthy, notes, fmt, proxy_url, transport, extra_headers, api_key, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id"
  ).bind(name, baseUrl, Number(body.priority) || 0, 1, body.notes || null, fmt2, body.proxy_url || null, transport, extraHeaders, sealed, "round_robin", nowIso()).all();
  const pid = info.results && info.results[0] && info.results[0].id;
  if (sealed)
    await c.env.DB.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)").bind(pid, sealed, "primary", nowIso()).run();
  const requestedRoutes = Array.isArray(body.routes) && body.routes.length ? body.routes : (preset.routes || []);
  const seeded = body.seed_routes === false ? { created: [], skipped: [] } : await seedProviderRoutes(c, pid, requestedRoutes);
  blog("PROVIDER preset=" + preset.id + " id=" + pid + " name=" + name + " routes=" + seeded.created.length + " skipped=" + seeded.skipped.length);
  return c.json({
    id: pid,
    preset: preset.id,
    name,
    base_url: baseUrl,
    fmt: fmt2,
    transport,
    api_key_set: !!body.api_key,
    routes: seeded.created,
    routes_skipped: seeded.skipped,
    credential_hint: preset.credential_hint
  }, 201);
}
app.get("/admin/provider-presets", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  return c.json({ presets: PROVIDER_PRESETS });
});
app.post("/admin/providers", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const presetId = String((b && b.preset) || "").trim();
  if (presetId && presetId !== "custom")
    return createProviderFromPreset(c, b);
  if (b) delete b.preset;
  if (!b.name || !b.base_url)
    return c.json({ error: { message: "name + base_url required" } }, 400);
  let fmt2;
  try {
    fmt2 = normalizeProviderFormat(b.fmt, "openai");
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  let transport = "auto";
  try {
    transport = normalizeTransport(b.transport);
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  const sealedKey = b.api_key ? await sealProviderKey(c.env, String(b.api_key)) : null;
  let extraHeaders = "{}";
  try { extraHeaders = normalizeExtraHeaders(b.extra_headers); }
  catch (e) { return c.json({ error: { message: e.message } }, 400); }
  const strategy = KEY_STRATEGIES.includes(b.key_strategy) ? b.key_strategy : "round_robin";
  const info = await c.env.DB.prepare("INSERT INTO providers (name, base_url, priority, healthy, notes, fmt, proxy_url, transport, extra_headers, api_key, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id").bind(b.name, b.base_url, Number(b.priority) || 0, b.healthy === false ? 0 : 1, b.notes || null, fmt2, b.proxy_url || null, transport, extraHeaders, sealedKey, strategy, nowIso()).all();
  const pid = info.results && info.results[0] && info.results[0].id;
  if (sealedKey)
    await c.env.DB.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)").bind(pid, sealedKey, "primary", nowIso()).run();
  const seeded = await seedProviderRoutes(c, pid, Array.isArray(b.routes) ? b.routes : []);
  return c.json({ id: pid, name: b.name, fmt: fmt2, proxy_url: b.proxy_url || null, transport, api_key_set: !!b.api_key, key_strategy: strategy, routes: seeded.created, routes_skipped: seeded.skipped }, 201);
});
app.patch("/admin/providers/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const sets = [];
  const binds = [];
  if (b.fmt !== void 0) {
    try {
      sets.push("fmt=?");
      binds.push(normalizeProviderFormat(b.fmt, "zaiweb"));
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  for (const f of ["name", "base_url", "notes", "proxy_url"]) {
    if (b[f] === void 0)
      continue;
    sets.push(f + "=?");
    binds.push(b[f]);
  }
  if (b.api_key) {
    const sealedNew = await sealProviderKey(c.env, String(b.api_key));
    sets.push("api_key=?");
    binds.push(sealedNew);
    const primary = await c.env.DB.prepare("SELECT id FROM provider_keys WHERE provider_id=? ORDER BY id LIMIT 1").bind(id).first();
    if (primary)
      await c.env.DB.prepare("UPDATE provider_keys SET api_key=?, label='primary' WHERE id=?").bind(sealedNew, primary.id).run();
    else
      await c.env.DB.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)").bind(id, sealedNew, "primary", nowIso()).run();
  }
  if (b.priority !== void 0) {
    sets.push("priority=?");
    binds.push(Number(b.priority));
  }
  if (b.healthy !== void 0) {
    sets.push("healthy=?");
    binds.push(b.healthy ? 1 : 0);
  }
  // enabled is the operator off-switch and is deliberately independent of
  // healthy: disabling takes the provider out of rotation, marking it down
  // does not.
  if (b.enabled !== void 0) {
    sets.push("enabled=?");
    binds.push(b.enabled ? 1 : 0);
  }
  if (b.transport !== void 0) {
    try {
      sets.push("transport=?");
      binds.push(normalizeTransport(b.transport));
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  if (b.extra_headers !== void 0) {
    try {
      sets.push("extra_headers=?");
      binds.push(normalizeExtraHeaders(b.extra_headers));
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  if (b.key_strategy !== void 0) {
    if (!KEY_STRATEGIES.includes(b.key_strategy))
      return c.json({ error: { message: "key_strategy must be one of " + KEY_STRATEGIES.join(", ") } }, 400);
    sets.push("key_strategy=?");
    binds.push(b.key_strategy);
  }
  if (!sets.length)
    return c.json({ id });
  await c.env.DB.prepare("UPDATE providers SET " + sets.join(", ") + ", updated_at=? WHERE id=?").bind(...binds, nowIso(), id).run();
  const p = await c.env.DB.prepare("SELECT id, name, base_url, priority, healthy, enabled, fmt, proxy_url, transport, extra_headers, key_strategy, (SELECT COUNT(*) FROM provider_keys pk WHERE pk.provider_id=providers.id AND pk.enabled=1) AS key_count FROM providers WHERE id=?").bind(id).first();
  return c.json({ provider: p });
});
app.post("/admin/providers/:id/test", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  const provider = await c.env.DB.prepare("SELECT id, name, fmt, base_url FROM providers WHERE id=?").bind(id).first();
  if (!provider)
    return c.json({ error: { message: "provider not found" } }, 404);
  const keys = await providerKeys(c, id);
  if (!keys.length)
    return c.json({ ok: false, error: "provider has no usable key", key_label: null }, 200);
  if (isZaiWebFormat(provider.fmt)) {
    const result = await validateZaiWebKey(keys[0].key, fetch);
    return c.json({ ok: result.ok, status: result.status, error: result.error, key_label: keys[0].label, fmt: provider.fmt }, 200);
  }
  // Any other provider gets a real reachability check against its own base_url,
  // so the button means something for every format instead of only chat.z.ai.
  const route = await c.env.DB.prepare("SELECT * FROM model_routes WHERE provider_id=? ORDER BY rank LIMIT 1").bind(id).first();
  if (!route)
    return c.json({ ok: false, error: "provider has no model route to probe", key_label: keys[0].label, fmt: provider.fmt }, 200);
  const probeBase = providerBaseFor(provider, route);
  try {
    const res = await probeEgress(c, provider, route, keys[0].key, probeBase + "/chat/completions", "POST",
      { "Content-Type": "application/json", Authorization: "Bearer " + keys[0].key }, 12000);
    const status = res.response.status;
    const ok = status >= 200 && status < 400;
    // A successful test button probe is live evidence the upstream serves this
    // route with this key. Release the provider, route, and key breakers so
    // serving picks the route up again instead of hiding behind stale
    // in-process state - the operator just watched a real request succeed.
    if (ok) {
      circuitRecordOk("provider", id);
      if (route && route.id != null)
        circuitRecordOk("route", route.id);
      circuitRecordOk("key", keys[0].keyId);
    }
    return c.json({
      ok,
      status,
      error: status >= 400 ? String(await res.response.text().catch(() => "")).slice(0, 200) : null,
      key_label: keys[0].label,
      fmt: provider.fmt,
      base_url: probeBase
    }, 200);
  } catch (e) {
    return c.json({ ok: false, status: 0, error: String(e && e.message || e).slice(0, 200), key_label: keys[0].label, fmt: provider.fmt }, 200);
  }
});
// Live upstream balance for a provider that has one. Charm Hyper answers
// GET <base>/credits with the team's remaining Hypercredits ({"balance":N});
// teams that turned hypercredit display off get {"balance_usd":X} instead and
// NO shard figure at all. Every key of the provider is read and the team
// balances are SUMMED: an operator pooling several Hyper keys wants the total
// across all of them, not whichever key happens to lead rotation. Each key's
// own figure is also returned so the total is auditable key by key. A key that
// fails (bad credential, upstream error) is reported per key and never
// contributes a phantom number to the total; ok is true when at least one key
// reported a figure.
app.get("/admin/providers/:id/credits", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const provider = await c.env.DB.prepare("SELECT id, name, fmt, base_url FROM providers WHERE id=?").bind(id).first();
  if (!provider) return c.json({ error: { message: "provider not found" } }, 404);
  const keys = await providerKeys(c, id);
  if (!keys.length) return c.json({ ok: false, error: "provider has no usable key", key_label: null }, 200);
  const route = await c.env.DB.prepare("SELECT * FROM model_routes WHERE provider_id=? ORDER BY rank LIMIT 1").bind(id).first();
  const base = providerBaseFor(provider, route);
  if (!base) return c.json({ ok: false, error: "provider has no base_url", key_label: keys[0].label }, 200);
  const fetched_at = nowIso();
  const perKey = [];
  let balance = null;
  let balance_usd = null;
  for (const k of keys) {
    const entry = { key_label: k.label };
    perKey.push(entry);
    try {
      // probeEgress(c, provider, route, key, url, method, headers, body, timeoutMs):
      // a GET must carry no body, so the timeout goes in its own slot.
      const res = await probeEgress(c, provider, route, k.key, base + "/credits", "GET",
        { Authorization: "Bearer " + k.key }, null, 10000);
      const status = res.response.status;
      if (status !== 200) {
        entry.ok = false;
        entry.status = status;
        entry.error = String(await res.response.text().catch(() => "")).slice(0, 200);
        continue;
      }
      const body = await res.response.json().catch(() => null);
      const b = body && Number.isFinite(Number(body.balance)) ? Number(body.balance) : null;
      const bu = body && Number.isFinite(Number(body.balance_usd)) ? Number(body.balance_usd) : null;
      entry.ok = true;
      entry.status = status;
      entry.balance = b;
      entry.balance_usd = bu;
      entry.unit = b != null ? "hypercredits" : bu != null ? "usd" : null;
      if (b != null) balance = (balance || 0) + b;
      if (bu != null) balance_usd = (balance_usd || 0) + bu;
    } catch (e) {
      entry.ok = false;
      entry.status = 0;
      entry.error = String(e && e.message || e).slice(0, 200);
    }
  }
  const anyOk = perKey.some((e) => e.ok);
  return c.json({
    ok: anyOk, status: anyOk ? 200 : 0,
    provider: { id: provider.id, name: provider.name },
    base_url: base,
    // Sum across every key that reported a figure. null means no key reported
    // one, not zero: an all-failed read must not look like an empty balance.
    balance,
    balance_usd,
    unit: balance != null ? "hypercredits" : balance_usd != null ? "usd" : null,
    keys: perKey,
    key_label: keys.length === 1 ? keys[0].label : keys.length + " keys",
    fetched_at
  }, 200);
});
// ---------------------------------------------------------------------------
// Model-integrity probes (ported from modelprobe): does this provider actually
// serve the model a route claims, or is it a reseller answering with something
// cheaper? See ai-gateway/src/modelprobe.js for the probes and their evidence.
// ---------------------------------------------------------------------------
function providerBaseFor(provider, route) {
  const raw = String((provider && provider.base_url) || (route && route.base_url) || "").trim();
  return raw.replace(/\/+$/, "");
}
// One egress path for probes so they honour the same transport rules as traffic.
// The body must be forwarded: a probe with a dropped body looks like a request
// for no model at all, which many gateways answer with 200 for anything.
async function probeEgress(c, provider, route, key, url, method, headers, body, timeoutMs) {
  // route is null for a provider with no model route yet; a balance or health
  // read must still work off the provider's own base_url.
  const transport = routeTransport(route || { transport: "direct" }, c.env);
  const merged = withExtraHeaders(headers, route);
  if (transport === "oci" && route && route.proxy_url)
    return fetchViaProxy(c, route.proxy_url, url, method, merged, body);
  if (transport === "koyeb") {
    const providerName = String((route && route.provider_name) || (provider && provider.name) || "").toLowerCase();
    const res = await koyebExchange(c, {
      provider: providerName,
      method,
      path: url,
      headers: merged,
      body: body ? encoder.encode(body) : void 0,
      isStream: false,
      requestId: "probe-" + Date.now()
    });
    return { response: new Response(res.bytes || "", { status: res.status, headers: res.headers }), usage: null };
  }
  const res = await probeFetchWithTimeout(c, url, { method, headers: merged, body: body || void 0 }, timeoutMs);
  return { response: res, usage: null };
}
function probeFetchWithTimeout(c, url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  return fetch(url, { ...init, signal: ctrl.signal })
    .then((r) => {
      clearTimeout(timer);
      return r;
    })
    .catch((e) => {
      clearTimeout(timer);
      throw e;
    });
}
async function declaredLimitForSlug(c, slug) {
  try {
    if (!modelsDevCache.catalog)
      await fetchModelsDevCatalog().catch(() => {});
    const byId = modelsDevCache.catalog ? flattenModelsDevCatalog(modelsDevCache.catalog) : null;
    const entry = byId ? matchModelsDevPrice(byId, slug) : null;
    const caps = entryCapabilities(entry);
    return { input: Number(entry && entry.limit && entry.limit.input) || caps.context || 0, context: caps.context || 0, entry };
  } catch {
    return { input: 0, context: 0, entry: null };
  }
}
// A decision model does not answer /chat/completions, so tokenizer and chat
// probes would mark a perfectly healthy Jev as broken. Probe it with a tiny
// structured SystemOne request instead and judge that.
async function runDecisionIntegrityProbe(c, provider, route, key, options) {
  const started = Date.now();
  const res = await callSystemOne({
    base: providerBaseFor(provider, route),
    path: decisionPathFor(route, provider),
    model: route.upstream_model || route.slug,
    state: { probe: "integrity", request: "answer one yes/no question" },
    questions: { ok: { type: "noul", instructions: "Is this endpoint reachable and answering structured questions?" } },
    apiKey: key,
    timeoutMs: (options && options.timeoutMs) || 20000
  });
  const elapsed = Date.now() - started;
  const verdict = res.ok ? "ok" : (res.http === 401 || res.http === 403 ? "auth_error" : "broken");
  return {
    result: {
      model: route.upstream_model || route.slug,
      base: providerBaseFor(provider, route),
      model_kind: "decision",
      protocol: effectiveFormat(route, provider),
      basic: { status: res.ok ? "ok" : (res.http ? "http_" + res.http : "error"), http: res.http, detail: res.reason || res.providerMessage || "" },
      verdict,
      signals: [{ kind: "decision", level: res.ok ? "ok" : "alert", text: res.ok ? "structured decision endpoint answered" : (res.reason || "decision endpoint HTTP " + res.http) }]
    },
    base: providerBaseFor(provider, route),
    model: route.upstream_model || route.slug,
    declared: { input: 0, context: 0, entry: null }
  };
}
async function runIntegrityProbe(c, provider, route, key, options) {
  if (effectiveModelKind(route) === "decision")
    return runDecisionIntegrityProbe(c, provider, route, key, options);
  const { runProbes } = await import("./modelprobe.js");
  const base = providerBaseFor(provider, route);
  const model = route.upstream_model || route.slug;
  const declared = await declaredLimitForSlug(c, route.slug);
  // Probes must not become a side door around egress rules, so every probe
  // request rides the provider's own transport.
  const fetchImpl = (url, init) => probeEgress(
    c, provider, route, key, url,
    (init && init.method) || "POST",
    (init && init.headers) || {},
    (init && init.body) || null,
    (options && options.timeoutMs) || 20000
  ).then((r) => r.response);
  const result = await runProbes({
    base,
    model,
    key,
    declaredInputTokens: declared.input || declared.context || null,
    options: { timeoutMs: (options && options.timeoutMs) || 20000, fetchImpl }
  });
  return { result, base, model, declared };
}
app.post("/admin/providers/:id/integrity", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  let body = {};
  try {
    body = await c.req.json();
  } catch {
  }
  const provider = await c.env.DB.prepare("SELECT * FROM providers WHERE id=?").bind(id).first();
  if (!provider)
    return c.json({ error: { message: "provider not found" } }, 404);
  if (isZaiWebFormat(provider.fmt))
    return c.json({ error: { message: "the z.ai consumer transports are not OpenAI-compatible endpoints; integrity probing does not apply" } }, 400);
  const keys = await providerKeys(c, id);
  if (!keys.length)
    return c.json({ error: { message: "provider has no usable key" } }, 400);
  const routes = await c.env.DB.prepare("SELECT * FROM model_routes WHERE provider_id=? ORDER BY rank").bind(id).all();
  const all = routes.results || [];
  // Named slug = that route only, even if it's currently off. Unnamed = first
  // enabled route, so a provider-level verify never walks the whole catalog.
  const wanted = body.slug ? all.filter((r) => r.slug === body.slug) : all.filter((r) => r.enabled).slice(0, Number(body.limit) || 1);
  if (!wanted.length)
    return c.json({ error: { message: body.slug ? "no route with that slug on this provider" : "no enabled route to probe for this provider" } }, 400);
  const key = keys[0].key;
  const runs = [];
  for (const route of wanted) {
    const { result } = await runIntegrityProbe(c, provider, route, key, body);
    const signals = result.signals || [];
    const relay = signals.find((s) => s.kind === "routing" && s.level === "alert");
    const exact = !!(result.tokenize && result.tokenize.available && result.tokenize.exactMatches && result.tokenize.exactMatches.length);
    await c.env.DB.prepare(
      "INSERT INTO provider_probe_runs (provider_id, slug, upstream_model, verdict, measured_family, claimed_family, relay_count, exact_fingerprint, signals_json, detail_json, http_status, elapsed_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      id, route.slug, route.upstream_model || "", result.verdict || "UNKNOWN",
      result.measured_family || null, (result.expected && result.expected.family) || null,
      (result.routing && result.routing.count) || 0, exact ? 1 : 0,
      JSON.stringify(signals).slice(0, 8000), JSON.stringify({ slope: result.slope, tokenize: result.tokenize, identity: result.identity, limit: result.limit, determinism: result.determinism, leak: result.leak, ceiling: result.ceiling, cutoff: result.cutoff }).slice(0, 8000),
      result.basic && result.basic.http, result.elapsed_ms || 0, nowIso()
    ).run();
    blog("PROBE provider=" + provider.name + " slug=" + route.slug + " verdict=" + result.verdict);
    runs.push({ slug: route.slug, upstream_model: route.upstream_model, ...result, relay_signal: relay ? relay.text : null });
  }
  return c.json({ provider_id: id, provider: provider.name, runs });
});
app.get("/admin/integrity", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  // Latest verdict per (slug, provider) — the console's integrity board.
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.provider_id, r.slug, r.upstream_model, r.verdict, r.measured_family, r.claimed_family,
            r.relay_count, r.exact_fingerprint, r.created_at, p.name AS provider_name, p.enabled AS provider_enabled
     FROM provider_probe_runs r
     JOIN providers p ON p.id = r.provider_id
     WHERE r.id IN (SELECT MAX(id) FROM provider_probe_runs GROUP BY slug, provider_id)
     ORDER BY CASE r.verdict WHEN 'MULTI-MODEL RELAY' THEN 0 WHEN 'TOKENIZER MISMATCH' THEN 1 WHEN 'STACK LEAK' THEN 2 WHEN 'UNVERIFIED' THEN 3 WHEN 'INCONCLUSIVE' THEN 4 ELSE 5 END, r.slug`
  ).all();
  const runs = rows.results || [];
  const counts = { alert: 0, ok: 0, unverified: 0, blocked: 0 };
  for (const r of runs) {
    if (r.verdict === "MULTI-MODEL RELAY" || r.verdict === "TOKENIZER MISMATCH" || r.verdict === "STACK LEAK")
      counts.alert++;
    else if (r.verdict === "CONSISTENT WITH CLAIM")
      counts.ok++;
    else if (r.verdict === "INCONCLUSIVE")
      counts.blocked++;
    else
      counts.unverified++;
  }
  return c.json({ runs, counts });
});
app.get("/admin/providers/:id/integrity", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  const rows = await c.env.DB.prepare(
    "SELECT * FROM provider_probe_runs WHERE provider_id=? ORDER BY id DESC LIMIT 50"
  ).bind(id).all();
  return c.json({ runs: rows.results || [] });
});
app.post("/admin/providers/:id/toggle", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("UPDATE providers SET healthy = CASE WHEN healthy=1 THEN 0 ELSE 1 END WHERE id=?").bind(id).run();
  const p = await c.env.DB.prepare("SELECT id, healthy FROM providers WHERE id=?").bind(id).first();
  // Marking a provider up is operator evidence the upstream is fine; the
  // in-process breaker must never override that judgment with stale state.
  // The toggle flips health, so a mark-UP clears the provider breaker.
  if (p && p.healthy)
    circuitRecordOk("provider", id);
  return c.json({ id: p.id, healthy: !!p.healthy });
});
// Explicit off-switch endpoints. Separate from /toggle (health): disable takes
// a provider fully out of rotation so its slugs stop being advertised and
// selected, while /toggle only marks it down.
async function setProviderEnabled(c, id, enabled) {
  const provider = await c.env.DB.prepare("SELECT id, name FROM providers WHERE id=?").bind(id).first();
  if (!provider)
    return c.json({ error: { message: "provider not found" } }, 404);
  await c.env.DB.prepare("UPDATE providers SET enabled=?, updated_at=? WHERE id=?").bind(enabled ? 1 : 0, nowIso(), id).run();
  const slugs = await c.env.DB.prepare("SELECT DISTINCT slug FROM model_routes WHERE provider_id=?").bind(id).all();
  blog("PROVIDER " + (enabled ? "enabled" : "disabled") + " id=" + id + " name=" + provider.name);
  return c.json({ id, name: provider.name, enabled: !!enabled, slugs: (slugs.results || []).map((r) => r.slug) });
}
app.post("/admin/providers/:id/disable", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  return setProviderEnabled(c, Number(c.req.param("id")), false);
});
app.post("/admin/providers/:id/enable", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  return setProviderEnabled(c, Number(c.req.param("id")), true);
});
app.post("/admin/routes", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  if (!b.slug || !b.provider_id || !b.upstream_model)
    return c.json({ error: { message: "slug + provider_id + upstream_model required" } }, 400);
  const kind = String(b.model_kind || "chat").toLowerCase() === "decision" ? "decision" : "chat";
  const wire = b.wire_format ? String(b.wire_format) : null;
  const endpoint = b.endpoint_path ? String(b.endpoint_path) : null;
  const contextOverride = routeLimitOverride(b.context_limit_override);
  const outputOverride = routeLimitOverride(b.output_limit_override);
  if (contextOverride === false || outputOverride === false)
    return c.json({ error: { message: "a route limit override must be a positive number or empty" } }, 400);
  const existing = await c.env.DB.prepare("SELECT COALESCE(MAX(rank),-1)+1 AS next FROM model_routes WHERE slug=?").bind(b.slug).first();
  const rank = b.rank != null ? Number(b.rank) : existing.next;
  await ensureRouteCapabilityColumns(c.env.DB);
  await c.env.DB.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled, model_kind, wire_format, endpoint_path, context_limit_override, output_limit_override) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(b.slug, Number(b.provider_id), b.upstream_model, rank, b.enabled === false ? 0 : 1, kind, wire, endpoint, contextOverride, outputOverride).run();
  return c.json({ ok: true, slug: b.slug, rank, model_kind: kind, wire_format: wire, endpoint_path: endpoint }, 201);
});
app.get("/admin/routes", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare(
    `SELECT mr.id, mr.slug, mr.provider_id, mr.upstream_model, mr.rank, mr.enabled,
            COALESCE(mr.model_kind,'chat') AS model_kind, mr.wire_format, mr.endpoint_path,
            mr.context_limit_override, mr.output_limit_override,
            p.name AS provider_name, p.healthy AS provider_healthy, p.enabled AS provider_enabled,
            pr.verdict AS probe_verdict, pr.measured_family AS probe_measured_family, pr.created_at AS probe_at
     FROM model_routes mr
     JOIN providers p ON p.id=mr.provider_id
     LEFT JOIN provider_probe_runs pr ON pr.id = (
       SELECT MAX(id) FROM provider_probe_runs
       WHERE slug = mr.slug AND provider_id = mr.provider_id
     )
     ORDER BY mr.slug, mr.rank`
  ).all();
  return c.json({ routes: rows.results || [] });
});
app.post("/admin/routes/:id/toggle", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("UPDATE model_routes SET enabled = CASE WHEN enabled=1 THEN 0 ELSE 1 END WHERE id=?").bind(id).run();
  const r = await c.env.DB.prepare("SELECT id, enabled FROM model_routes WHERE id=?").bind(id).first();
  return c.json({ id: r.id, enabled: !!r.enabled });
});
app.get("/admin/routes/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  const r = await c.env.DB.prepare("SELECT mr.*, p.name AS provider_name FROM model_routes mr JOIN providers p ON p.id=mr.provider_id WHERE mr.id=?").bind(id).first();
  if (!r)
    return c.json({ error: { message: "route not found" } }, 404);
  return c.json({ route: r });
});
app.patch("/admin/routes/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const sets = [];
  const binds = [];
  for (const f of ["slug", "provider_id", "upstream_model", "rank", "model_kind", "wire_format", "endpoint_path", "context_limit_override", "output_limit_override"]) {
    if (b[f] !== void 0) {
      if (f === "model_kind" && !["chat", "decision"].includes(String(b[f])))
        return c.json({ error: { message: "model_kind must be chat or decision" } }, 400);
      if (f === "context_limit_override" || f === "output_limit_override") {
        const override = routeLimitOverride(b[f]);
        if (override === false)
          return c.json({ error: { message: "a route limit override must be a positive number or empty" } }, 400);
        sets.push(f + "=?");
        binds.push(override);
        continue;
      }
      sets.push(f + "=?");
      binds.push(f === "rank" || f === "provider_id" ? Number(b[f]) : b[f]);
    }
  }
  if (b.enabled !== void 0) {
    sets.push("enabled=?");
    binds.push(b.enabled ? 1 : 0);
  }
  if (!sets.length)
    return c.json({ id });
  await c.env.DB.prepare("UPDATE model_routes SET " + sets.join(", ") + " WHERE id=?").bind(...binds, id).run();
  const r = await c.env.DB.prepare("SELECT * FROM model_routes WHERE id=?").bind(id).first();
  return c.json({ route: r });
});
app.delete("/admin/routes/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM model_routes WHERE id=?").bind(id).run();
  return c.json({ deleted: id });
});
app.delete("/admin/providers/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM model_routes WHERE provider_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM providers WHERE id=?").bind(id).run();
  return c.json({ deleted: id });
});
app.get("/admin/overview", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const providers = await c.env.DB.prepare(
    "SELECT p.id, p.name, p.base_url, p.priority, p.healthy, p.enabled, p.fmt, p.proxy_url, p.transport, p.last_status, p.last_checked, (SELECT COUNT(*) FROM model_routes mr WHERE mr.provider_id=p.id) AS route_count FROM providers p ORDER BY p.priority"
  ).all();
  const routes = await c.env.DB.prepare(
    "SELECT mr.id, mr.slug, mr.provider_id, mr.upstream_model, mr.rank, mr.enabled, p.name AS provider_name, p.healthy AS provider_healthy, p.enabled AS provider_enabled FROM model_routes mr JOIN providers p ON p.id=mr.provider_id ORDER BY mr.slug, mr.rank"
  ).all();
  const keys = await c.env.DB.prepare(
    "SELECT key_id, name, budget_mode, budget_limit, used_tokens, used_usd, request_count, active, allowed_models, created_at FROM api_keys ORDER BY created_at DESC"
  ).all();
  const totals = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(request_count),0) AS requests, COALESCE(SUM(used_tokens),0) AS used_tokens, COALESCE(SUM(used_usd),0) AS used_usd FROM api_keys"
  ).first();
  const limits = await c.env.DB.prepare("SELECT slug, kind, period, limit_value, updated_at FROM model_limits ORDER BY slug, kind, period").all();
  // Per-limit live usage from trajectories (cache hits excluded) so the
  // overview matches what enforcement actually counts, pre/post limit-set.
  const seen = new Set();
  const limitUsage = [];
  for (const l of limits.results || []) {
    const k = l.slug + "|" + l.kind + "|" + l.period;
    if (seen.has(k))
      continue;
    seen.add(k);
    limitUsage.push({ slug: l.slug, kind: l.kind, period: l.period, used: await periodUsage(c, l.slug, l.kind, l.period) });
  }
  const cacheRow = await c.env.DB.prepare(
    "SELECT COUNT(*) AS entries, COALESCE(SUM(hits),0) AS hits, COALESCE(SUM(hits * source_cost_usd),0) AS saved_usd, COALESCE(SUM(hits * source_tokens),0) AS saved_tokens FROM response_cache WHERE expires_at > ?"
  ).bind(nowIso()).first();
  return c.json({
    providers: providers.results || [],
    routes: routes.results || [],
    keys: keys.results || [],
    totals: totals || { requests: 0, used_tokens: 0, used_usd: 0 },
    limits: limits.results || [],
    limit_usage: limitUsage,
    cache: cacheRow || { entries: 0, hits: 0, saved_usd: 0, saved_tokens: 0 },
    generated_at: nowIso()
  });
});
app.get("/admin/logs", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  return c.json({ logs: logBuffer });
});
// One definition of "which trajectories does this view cover", shared by the
// list and the exports so a filter can never mean one thing in the table and
// another in the file. Returns SQL conditions, their binds, and the resolved
// key ids (null when the filter is not key-scoped, [] when it matched none).
async function trajectoryScope(c, options) {
  const opts = options || {};
  const slug = String(c.req.query("slug") || "").trim();
  const keyId = String(c.req.query("key_id") || "").trim();
  const accountId = String(c.req.query("account_id") || "").trim();
  const status = String(c.req.query("status") || "").trim();
  const conds = [];
  const binds = [];
  let keyIds = null;
  if (slug) { conds.push("slug=?"); binds.push(slug); }
  if (opts.includeStatus && (status === "ok" || status === "fail")) { conds.push("status=?"); binds.push(status); }
  if (keyId) { conds.push("key_id=?"); binds.push(keyId); keyIds = [keyId]; }
  // An account filter reaches every key it owns plus, for the legacy 1:1
  // shape, the account's own key. No matching keys means no rows, not all rows.
  if (accountId) {
    const owned = await c.env.DB.prepare("SELECT key_id FROM api_keys WHERE account_id=?").bind(accountId).all();
    const ids = (owned.results || []).map((r) => r.key_id);
    const legacy = await c.env.DB.prepare("SELECT key_id FROM console_accounts WHERE key_id=?").bind(accountId).first();
    if (legacy && legacy.key_id && ids.indexOf(legacy.key_id) < 0) ids.push(legacy.key_id);
    // Both filters together mean the intersection: the key must belong to the
    // account. The SQL conditions already AND that way; this keeps the key id
    // list handed to the streaming export honest about the same scope.
    keyIds = keyIds ? ids.filter((id) => keyIds.indexOf(id) >= 0) : ids;
    if (!ids.length)
      conds.push("1=0");
    else { conds.push("key_id IN (" + ids.map(() => "?").join(",") + ")"); binds.push(...ids); }
  }
  return { conds, binds, keyIds };
}

app.get("/admin/trajectories", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 100));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const scope = await trajectoryScope(c, { includeStatus: true });
  const conds = scope.conds;
  const condBinds = scope.binds;
  const where = conds.length ? " WHERE " + conds.join(" AND ") : "";
  const sql = "SELECT id, created_at, key_id, key_name, slug, stream, cache_state, status, http_status, provider, rank, attempts, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, error FROM trajectories" + where + " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  const rows = await c.env.DB.prepare(sql).bind(...condBinds, limit, offset).all();
  const matched = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM trajectories" + where).bind(...condBinds).first();
  // Latency and totals follow the same filter, so a filtered view never
  // reports gateway-wide numbers next to a narrowed list.
  const latRows = await c.env.DB.prepare(
    "SELECT slug, AVG(latency_ms) avg_ms, COUNT(*) n FROM trajectories WHERE status='ok' AND latency_ms IS NOT NULL" +
    (conds.length ? " AND " + conds.join(" AND ") : "") +
    " GROUP BY slug ORDER BY avg_ms DESC"
  ).bind(...condBinds).all();
  const agg = await c.env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_count, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost FROM trajectories" + where).bind(...condBinds).first();
  return c.json({
    trajectories: rows.results || [],
    stats: agg || { total: 0, ok_count: 0, tokens: 0, cost: 0 },
    latency: (latRows.results || []).map((r) => ({ slug: String(r.slug || ""), avg_ms: Math.round(Number(r.avg_ms) || 0), n: Number(r.n) || 0 })),
    page: { limit, offset, matched: Number(matched && matched.n) || 0, hasMore: (Number(matched && matched.n) || 0) > offset + limit }
  });
});
app.get("/admin/trajectories-export", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const format = String(c.req.query("format") || "openai");
  // The scope is resolved before the format branch so every export, Vey
  // included, covers exactly what the Trajectories table is showing.
  const scope = await trajectoryScope(c, { includeStatus: false });
  if (format === "vey" || format === "world") {
    // Vey exports the whole episode — including failed attempts — so it must
    // NOT run through the successful-completion query below. The Response it
    // builds has to be returned: dropping it sends the browser an empty body
    // (NS_ERROR_NET_EMPTY_RESPONSE).
    // See exportVeyDataset in src/export/vey-serve.js.
    const vey = await exportVeyDataset(c, format, { keyIds: scope.keyIds });
    if (vey)
      return vey;
    return c.json({ error: { message: "vey export produced no response" } }, 500);
  }
  if (!["openai", "sharegpt", "trl", "rl"].includes(format))
    return c.json({ error: { message: "format must be one of openai, sharegpt, trl, rl, vey" } }, 400);
  // Exports are training data: they need a complete request/response pair, so
  // the successful-completion requirement stays. The status filter is therefore
  // not part of an export scope, and the UI says so.
  let sql = "SELECT slug, stream, status, provider, attempts, steps_json, request_json, response_json, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, created_at FROM trajectories WHERE status='ok' AND request_json IS NOT NULL AND response_json IS NOT NULL";
  const binds = [];
  for (const cond of scope.conds) sql += " AND " + cond;
  binds.push(...scope.binds);
  sql += " ORDER BY created_at";
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  const lines = [];
  let skipped = 0;
  for (const r of rows.results || []) {
    try {
      const line = exportTrajectoryLine(r, format);
      if (line)
        lines.push(line);
      else
        skipped++;
    } catch {
      skipped++;
    }
  }
  return new Response(lines.join("\n") + (lines.length ? "\n" : ""), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": "attachment; filename=trajectories-" + format + ".jsonl",
      "x-trajectory-count": String(lines.length),
      "x-trajectory-skipped": String(skipped)
    }
  });
});
app.get("/admin/trajectories/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const row = await c.env.DB.prepare("SELECT * FROM trajectories WHERE id=?").bind(c.req.param("id")).first();
  if (!row)
    return c.json({ error: { message: "trajectory not found" } }, 404);
  return c.json({ trajectory: row });
});
// Reconciliation between the authoritative per-attempt telemetry (route_attempts)
// and the legacy per-request trajectories. route_attempts is the source of
// truth; trajectories still feeds live V1 health until the cutover, so drift
// between them must be visible rather than buried in aggregates.
app.get("/admin/router/reconcile", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const hours = Math.min(168, Math.max(1, Number(c.req.query("hours")) || 24));
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  // health_impact samples are the only observations that train a posterior;
  // auth/caller/cancel/capability exclusions are deliberately excluded, so a
  // route must clear 20 of THEM (not raw attempts) before its numbers mean
  // anything. 3/5 health samples must never read as "60% reliable".
  const MIN_HEALTH_SAMPLES = 20;
  const readiness = (healthSamples) =>
    healthSamples >= 50 ? "normal" : healthSamples >= 20 ? "low_confidence" : "insufficient_sample";

  const atts = await c.env.DB.prepare(
    `SELECT id, request_id, public_slug, route_id, transport, task_type, success, health_impact,
            failure_class, failure_code, ttft_ms, headers_ms, latency_ms, started_at, finished_at, fallback_from_route_id
     FROM route_attempts WHERE started_at >= ?`
  ).bind(cutoff).all();
  const attemptRows = atts.results || [];

  const byRoute = new Map();
  const unmatchedAttempts = [];
  for (const a of attemptRows) {
    const key = String(a.public_slug || "?");
    if (!byRoute.has(key)) {
      byRoute.set(key, {
        slug: key,
        attempts: 0, health_samples: 0, health_success: 0, health_failure: 0,
        excluded: 0, cancelled: 0, incomplete: 0,
        latencies: [], ttfts: [], task_types: new Map(), failure_classes: new Map(),
        fallback_in: 0, fallback_out: 0
      });
    }
    const r = byRoute.get(key);
    r.attempts++;
    if (a.task_type) r.task_types.set(String(a.task_type), (r.task_types.get(String(a.task_type)) || 0) + 1);
    if (a.fallback_from_route_id != null) r.fallback_in++;
    if (a.latency_ms != null) r.latencies.push(Number(a.latency_ms));
    if (a.ttft_ms != null) r.ttfts.push(Number(a.ttft_ms));

    if (!a.health_impact) {
      // Cancelled streams carry health_impact=0 and their own class; excluded
      // operational noise should not inflate a route's apparent maturity.
      if (a.failure_class === "cancelled") r.cancelled++;
      r.excluded++;
      continue;
    }
    r.health_samples++;
    if (a.success) r.health_success++;
    else {
      r.health_failure++;
      if (a.failure_class === "stream_incomplete") r.incomplete++;
      const fc = String(a.failure_class || "unknown");
      r.failure_classes.set(fc, (r.failure_classes.get(fc) || 0) + 1);
    }
  }

  const traj = await c.env.DB.prepare(
    `SELECT id, slug, status, http_status, provider, created_at FROM trajectories WHERE created_at >= ?`
  ).bind(cutoff).all();
  const trajRows = traj.results || [];

  // Terminal-outcome semantics: route_attempts success=1 is the same verdict as
  // a trajectory "ok"; both cancelled and incomplete map to their own classes on
  // the attempt side, so compare the normalized bucket, not raw HTTP status.
  const attemptVerdict = new Map();
  for (const a of attemptRows)
    attemptVerdict.set(String(a.request_id), { verdict: a.success ? "success" : (a.failure_class || "failure"), row: a });

  let matched = 0, statusMismatches = 0, routeMismatches = 0;
  const mismatchExamples = [];
  const trajIds = new Set(trajRows.map((t) => String(t.id)));
  for (const [reqId, v] of attemptVerdict) {
    if (!trajIds.has(reqId)) {
      unmatchedAttempts.push({ request_id: reqId, slug: v.row.public_slug, failure_class: v.row.failure_class || null });
      continue;
    }
    matched++;
    const t = trajRows.find((x) => String(x.id) === reqId);
    const trajVerdict = t.status === "ok" ? "success" : t.status === "cancelled" ? "cancelled" : "failure";
    const attVerdict = v.verdict === "stream_incomplete" ? "failure" : v.verdict;
    if (trajVerdict !== attVerdict) {
      statusMismatches++;
      if (mismatchExamples.length < 25)
        mismatchExamples.push({ request_id: reqId, slug: v.row.public_slug, route_attempt_verdict: attVerdict, trajectory_status: t.status });
    }
    // The final route a request used is the one the trajectory recorded as its
    // provider/rank; a successful attempt on a route the trajectory never names
    // means the two systems disagreed about who served the request.
    if (t.provider && v.row.route_id != null && String(t.slug) !== String(v.row.public_slug))
      routeMismatches++;
  }
  // Multi-attempt requests can write several attempt rows but one trajectory;
  // count trajectory rows that never produced an attempt (e.g. cache hits and
  // pre-forward rejections) so the hole is visible instead of netting to zero.
  const trajNoAttempt = trajRows.filter((t) => !attemptVerdict.has(String(t.id)));
  const unmatchedTrajectories = trajNoAttempt
    .slice(0, 25)
    .map((t) => ({ id: t.id, slug: t.slug, status: t.status }));

  const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((x, y) => x - y);
    const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
    return s[i];
  };

  const routes = [...byRoute.values()].map((r) => {
    const healthRate = r.health_samples ? r.health_success / r.health_samples : null;
    return {
      slug: r.slug,
      attempts: r.attempts,
      health_samples: r.health_samples,
      health_success: r.health_success,
      health_failure: r.health_failure,
      health_success_rate: healthRate == null ? null : Number(healthRate.toFixed(4)),
      excluded_attempts: r.excluded,
      cancelled: r.cancelled,
      stream_incomplete: r.incomplete,
      failure_classes: Object.fromEntries([...r.failure_classes.entries()].sort((a, b) => b[1] - a[1])),
      task_types: Object.fromEntries([...r.task_types.entries()].sort((a, b) => b[1] - a[1])),
      latency_ms: { p50: pct(r.latencies, 0.5), p95: pct(r.latencies, 0.95) },
      ttft_ms: { p50: pct(r.ttfts, 0.5), p95: pct(r.ttfts, 0.95) },
      fallback_in: r.fallback_in,
      fallback_out: r.fallback_out,
      fallback_rate: r.attempts ? Number((r.fallback_in / r.attempts).toFixed(4)) : 0,
      decision_readiness: {
        status: readiness(r.health_samples),
        health_samples: r.health_samples,
        minimum_health_samples: MIN_HEALTH_SAMPLES
      }
    };
  }).sort((a, b) => b.attempts - a.attempts);

  const totalHealth = routes.reduce((s, r) => s + r.health_samples, 0);
  const totalHealthSuccess = routes.reduce((s, r) => s + r.health_success, 0);
  const okTraj = trajRows.filter((t) => t.status === "ok").length;
  // Aggregate failure classes across every route, so a single systemic class
  // (e.g. stream_incomplete) is visible without summing the per-route tables.
  const failureClassAgg = new Map();
  for (const a of attemptRows) {
    if (!a.health_impact || a.success) continue;
    const fc = String(a.failure_class || "unknown");
    failureClassAgg.set(fc, (failureClassAgg.get(fc) || 0) + 1);
  }

  return c.json({
    window_hours: hours,
    attempts: {
      rows: attemptRows.length,
      health_samples: totalHealth,
      operational: totalHealth,
      success_rate: totalHealth ? Number((totalHealthSuccess / totalHealth).toFixed(4)) : null
    },
    trajectories: {
      requests: trajRows.length,
      success_rate: trajRows.length ? Number((okTraj / trajRows.length).toFixed(4)) : null
    },
    agreement: {
      matched_requests: matched,
      status_mismatches: statusMismatches,
      route_mismatches: routeMismatches,
      mismatch_examples: mismatchExamples,
      unmatched_attempts: unmatchedAttempts.slice(0, 25),
      unmatched_attempt_count: unmatchedAttempts.length,
      unmatched_trajectories: unmatchedTrajectories,
      unmatched_trajectory_count: trajNoAttempt.length
    },
    by_route: routes,
    by_failure_class: Object.fromEntries([...failureClassAgg.entries()].sort((a, b) => b[1] - a[1])),
    warnings: []
  });
});

// Router V2 shadow experiment evaluation. The dual decision (operational pick
// vs constraint-first quality-aware pick) is recorded on the final serving
// attempt of each auto-routed request; this answers "how often would quality
// change the choice, and does the alternate look better?" from real traffic.
// Read-only. Sample-threshold guidance mirrors the experiment plan: below 100
// decisions per task family the numbers are noise; 100-499 is early signal;
// 500+ is where floor calibration becomes meaningful.
app.get("/admin/router/shadow-experiment", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const hours = Math.min(168, Math.max(1, Number(c.req.query("hours")) || 24));
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  // Exactly one decision per request: only the SUCCESSFUL serving attempt
  // carries the columns, so requiring success=1 and deduping by request_id
  // keeps a request that failed twice and succeeded once at one decision.
  const rows = await c.env.DB.prepare(
    `SELECT request_id, task_type, public_slug, route_id, success, health_impact, latency_ms, actual_cost_usd,
            v2_operational_route_id, v2_quality_route_id, v2_quality_changed, v2_quality_state, v2_quality_reason,
            v2_reliability_floor, v2_quality_floor
     FROM route_attempts
     WHERE started_at >= ? AND v2_quality_changed IS NOT NULL AND success=1
     GROUP BY request_id`
  ).bind(cutoff).all();
  const decs = rows.results || [];

  const byTask = new Map();
  const byState = new Map();
  let changed = 0;
  for (const d of decs) {
    const task = String(d.task_type || "(none)");
    const t = byTask.get(task) || { task, decisions: 0, changed: 0, cold: 0, no_candidate: 0 };
    t.decisions++;
    if (d.v2_quality_changed) { t.changed++; changed++; }
    if (d.v2_quality_state === "cold") t.cold++;
    if (d.v2_quality_state === "none") t.no_candidate++;
    byTask.set(task, t);
    const st = String(d.v2_quality_state || "unknown");
    byState.set(st, (byState.get(st) || 0) + 1);
  }

  // Objective evidence attached to the requests where quality changed the
  // choice. TRUTHFUL LABELING: the quality-aware alternate was shadow-only and
  // was never executed, so its answer quality is unknowable from this request.
  // These observations describe the route that ACTUALLY SERVED. Proving the
  // alternate is better requires a live canary/A-B; this is the baseline.
  const changedReqIds = decs.filter((d) => d.v2_quality_changed).map((d) => String(d.request_id));
  let servedObjectiveValid = 0, servedObjectiveInvalid = 0, servedNoEvidence = 0;
  if (changedReqIds.length) {
    const placeholders = changedReqIds.map(() => "?").join(",");
    const obs = await c.env.DB.prepare(
      `SELECT o.request_id, o.canonical_model_id, o.signal_type, o.value
       FROM quality_observations o
       WHERE o.request_id IN (${placeholders}) AND o.signal_type='tool_valid'`
    ).bind(...changedReqIds).all();
    const evidence = new Map();
    for (const o of (obs.results || [])) {
      const k = String(o.request_id);
      evidence.set(k, Number(o.value));
    }
    for (const d of decs.filter((x) => x.v2_quality_changed)) {
      const v = evidence.get(String(d.request_id));
      if (v == null) servedNoEvidence++;
      else if (v >= 1) servedObjectiveValid++;
      else servedObjectiveInvalid++;
    }
  }

  const tasks = [...byTask.values()].map((t) => ({
    ...t,
    disagreement_rate: t.decisions ? Number((t.changed / t.decisions).toFixed(4)) : null,
    // Noise/inspect only below 100; early signal 100-499; calibrate at 500+.
    maturity: t.decisions >= 500 ? "calibrate" : t.decisions >= 100 ? "early_signal" : "noise"
  })).sort((a, b) => b.decisions - a.decisions);

  return c.json({
    window_hours: hours,
    decisions: decs.length,
    disagreement: {
      changed_choice: changed,
      rate: decs.length ? Number((changed / decs.length).toFixed(4)) : null,
      // 1000+ overall disagreements is the strong-evaluation threshold.
      evaluation_strength: changed >= 1000 ? "strong" : changed >= 100 ? "weak" : "insufficient"
    },
    by_task: tasks,
    by_quality_state: Object.fromEntries([...byState.entries()].sort((a, b) => b[1] - a[1])),
    served_objective_evidence: changed ? {
      valid: servedObjectiveValid,
      invalid: servedObjectiveInvalid,
      no_objective_evidence: servedNoEvidence
    } : null,
    notes: [
      "Only auto-routed requests carry shadow columns; explicit-model traffic is excluded.",
      "Sample thresholds: <100/task = noise, 100-499 = early signal, 500+/task = calibrate floors, 1000+ disagreements = evaluate.",
      "Traffic recorded before the v2 columns existed is not counted (rows are null)."
    ]
  });
});

// Canonical model registry admin. Identity is DATA: two names are the same
// model only when an explicit alias row says so. Seeding is idempotent
// (INSERT OR IGNORE) and never clobbers operator-authored aliases.
app.post("/admin/router/registry/seed", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const seed = await seedModelRegistry(c);
  const backfill = await backfillQualityCanonicalIds(c);
  const rebuilt = await rebuildQualityStats(c);
  return c.json({ ok: true, seed, backfill, rebuilt });
});
// Rebuild the derived model_quality_stats cache from immutable
// quality_observations. Safe to call any time; never merges old Beta rows.
app.post("/admin/router/registry/rebuild-quality", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const backfill = await backfillQualityCanonicalIds(c);
  const rebuilt = await rebuildQualityStats(c);
  return c.json({ ok: true, backfill, rebuilt });
});
// Registry visibility: canonical models, alias rows, and — most importantly —
// the identities live traffic actually used (route_attempts + model_routes)
// that NO alias resolves. An unresolved alias silently trains a provisional
// "raw:<upstream>" quality bucket, so operators must be able to see and fix it.
app.get("/admin/router/registry", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const models = await c.env.DB.prepare(
    "SELECT id, family, display_name, reasoning, tools, vision, context_limit, output_limit FROM canonical_models ORDER BY id"
  ).all();
  const aliases = await c.env.DB.prepare(
    "SELECT alias, canonical_model_id, alias_type, provider_id, confidence, source FROM model_aliases ORDER BY canonical_model_id, alias"
  ).all();
  const index = await loadAliasIndex(c);
  // Distinct (provider_id, public_slug, upstream_model) live traffic has seen,
  // from both the configured routes and recorded attempts.
  const seen = new Map();
  const addSeen = (providerId, publicSlug, upstreamModel) => {
    const pid = providerId == null ? null : Number(providerId);
    const key = pid + "\u0000" + String(publicSlug || "") + "\u0000" + String(upstreamModel || "");
    if (!seen.has(key))
      seen.set(key, { provider_id: pid, public_slug: publicSlug || null, upstream_model: upstreamModel || null });
  };
  const routeRows = await c.env.DB.prepare(
    "SELECT DISTINCT provider_id, slug, upstream_model FROM model_routes"
  ).all();
  for (const r of routeRows.results || [])
    addSeen(r.provider_id, r.slug, r.upstream_model);
  const attemptRows = await c.env.DB.prepare(
    "SELECT DISTINCT provider_id, public_slug, upstream_model FROM route_attempts WHERE upstream_model IS NOT NULL OR public_slug IS NOT NULL"
  ).all();
  for (const r of attemptRows.results || [])
    addSeen(r.provider_id, r.public_slug, r.upstream_model);
  const unresolved = [];
  for (const s of seen.values()) {
    const hit = resolveCanonicalModel(index, { providerId: s.provider_id, publicSlug: s.public_slug, upstreamModel: s.upstream_model });
    if (!hit)
      unresolved.push(s);
  }
  return c.json({
    canonical_models: models.results || [],
    aliases: aliases.results || [],
    unresolved: unresolved.slice(0, 200),
    unresolved_count: unresolved.length
  });
});
// Agent-loop repetition telemetry (Z.AI agent shim). Body-free aggregate that
// quantifies whether the continuation-aware prompt reduced re-derivation:
// repeat-rate (tool_calls_repeated / emitted) and mean reasoning_prefix_overlap,
// sliced by continuation_mode and agent_round. Reasoning is never stored or
// returned as text — only hash-derived overlap.
app.get("/admin/router/agent-loop", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const hours = Math.min(720, Math.max(1, Number(c.req.query("hours")) || 24));
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const rowsQ = await c.env.DB.prepare(
    `SELECT continuation_mode, agent_round, tool_calls_emitted, tool_calls_repeated,
            reasoning_chars, reasoning_prefix_overlap
     FROM agent_loop_events WHERE created_at >= ?`
  ).bind(cutoff).all();
  const rows = rowsQ.results || [];

  const bucket = () => ({ events: 0, emitted: 0, repeated: 0, overlap_sum: 0, overlap_n: 0 });
  const fold = (b, r) => {
    b.events++;
    b.emitted += Number(r.tool_calls_emitted) || 0;
    b.repeated += Number(r.tool_calls_repeated) || 0;
    if (r.reasoning_prefix_overlap != null) {
      b.overlap_sum += Number(r.reasoning_prefix_overlap);
      b.overlap_n++;
    }
  };
  const summarize = (b) => ({
    events: b.events,
    tool_calls_emitted: b.emitted,
    tool_calls_repeated: b.repeated,
    repeat_rate: b.emitted ? Number((b.repeated / b.emitted).toFixed(4)) : null,
    mean_reasoning_overlap: b.overlap_n ? Number((b.overlap_sum / b.overlap_n).toFixed(4)) : null,
    overlap_samples: b.overlap_n
  });

  const overall = bucket();
  const byMode = new Map();
  const byRound = new Map();
  for (const r of rows) {
    fold(overall, r);
    const mode = String(r.continuation_mode || "unknown");
    if (!byMode.has(mode)) byMode.set(mode, bucket());
    fold(byMode.get(mode), r);
    // Round buckets past 6 collapse into "6+" so a long loop does not explode
    // the response with one row per round.
    const rn = Number(r.agent_round) || 1;
    const rk = rn >= 6 ? "6+" : String(rn);
    if (!byRound.has(rk)) byRound.set(rk, bucket());
    fold(byRound.get(rk), r);
  }

  return c.json({
    window_hours: hours,
    overall: summarize(overall),
    by_continuation_mode: Object.fromEntries([...byMode.entries()].map(([k, v]) => [k, summarize(v)])),
    by_agent_round: Object.fromEntries([...byRound.entries()].sort((a, b) => (a[0] === "6+" ? 99 : Number(a[0])) - (b[0] === "6+" ? 99 : Number(b[0]))).map(([k, v]) => [k, summarize(v)]))
  });
});
// ---- Proxy pool: egress inventory + connectivity testing ----
// Credentials are sealed with the same providerCryptoKey machinery as provider
// keys and are NEVER returned to the browser. Batch testing runs server-side
// through the loopback zaihttp /check-egress against a fixed neutral target.
var PROXY_DEAD_THRESHOLD = 3;
// Rank order for both the pool table and auto-selection: healthy first, then
// lowest measured latency, then most proven successes. untested rides ahead of
// flaky/dead so a fresh pool still yields a pick before its first test run.
var PROXY_STATUS_RANK = { healthy: 0, untested: 1, flaky: 2, disabled: 3, dead: 4 };
function compareProxyRank(a, b) {
  const sa = PROXY_STATUS_RANK[a.status] ?? 5;
  const sb = PROXY_STATUS_RANK[b.status] ?? 5;
  if (sa !== sb) return sa - sb;
  const la = a.last_latency_ms == null ? Infinity : Number(a.last_latency_ms);
  const lb = b.last_latency_ms == null ? Infinity : Number(b.last_latency_ms);
  if (la !== lb) return la - lb;
  return (Number(b.success_count) || 0) - (Number(a.success_count) || 0);
}
// Sticky active egress: one process = one identity. The chosen proxy is cached
// and only re-picked when it stops being a healthy candidate (dead/disabled/
// gone), never per request — auto selection must not rotate identity mid
// session. Manual mode (default) returns null so the helper uses its env.
var activeEgress = { id: null, url: null, at: 0 };
var ACTIVE_EGRESS_TTL_MS = 30000;
async function resolveActiveEgress(c) {
  const mode = await settingValue(c, "proxy_egress_mode", "manual");
  if (mode !== "auto") {
    if (c) c.zaiEgressId = null;
    return null;
  }
  // Bind the proxy identity onto THIS request. A concurrent request may
  // re-select a different sticky egress before this one fails, so failure
  // attribution must use the id this request actually dialed, not the global.
  const bind = (url) => { if (c) c.zaiEgressId = activeEgress.id; return url; };
  const now = Date.now();
  // WAF-blocked is NOT transport-dead: the proxy may be perfectly healthy
  // for other destinations. Exclude it from Z.AI auto-selection only.
  const wafBlocked = (id) => zaiWaf.isBlocked(id == null ? "direct" : "proxy:" + id);
  // Sticky TTL: drop the sticky pick if ITS breaker just opened, rather than
  // keep routing onto a blocked egress for up to 30s.
  if (activeEgress.url && now - activeEgress.at < ACTIVE_EGRESS_TTL_MS && !wafBlocked(activeEgress.id))
    return bind(activeEgress.url);
  const rows = await c.env.DB.prepare(
    "SELECT id, scheme, host, port, username, password_enc, status, last_latency_ms, success_count FROM proxy_pool WHERE enabled=1 AND status='healthy'"
  ).all();
  const candidates = (rows.results || []).slice().filter((r) => !wafBlocked(r.id)).sort(compareProxyRank);
  // Keep the current sticky pick if it is still a healthy, unblocked candidate.
  if (activeEgress.id != null) {
    const keep = candidates.find((r) => r.id === activeEgress.id);
    if (keep) {
      activeEgress.at = now;
      return bind(activeEgress.url);
    }
  }
  // Try candidates in rank order; skip any whose credential cannot be
  // decrypted (config error, NOT a proxy fault) rather than dialing with an
  // empty password and mislabeling the proxy as auth-failed.
  for (const pick of candidates) {
    if (pick.password_enc) {
      let plainPassword;
      try {
        plainPassword = await openProviderKey(c.env, pick.password_enc);
      } catch (e) {
        blog("proxy egress decrypt failed id=" + pick.id + " (config error, not proxy fault): " + String(e.message || e));
        continue;
      }
      activeEgress = { id: pick.id, url: proxyEgressUrl(pick, plainPassword), at: now };
      return bind(activeEgress.url);
    }
    activeEgress = { id: pick.id, url: proxyEgressUrl(pick, ""), at: now };
    return bind(activeEgress.url);
  }
  activeEgress = { id: null, url: null, at: now };
  return bind(null);
}
function __resetActiveEgress() { activeEgress = { id: null, url: null, at: 0 }; }
// A production Z.AI request just failed because the active egress proxy could
// not be dialed (not chat.z.ai). Record it against the proxy pool exactly like
// a check failure so the proxy trends toward flaky/dead, and invalidate the
// sticky pick so the next request re-selects a healthy egress.
async function noteEgressFailure(c, failureClass) {
  // Prefer the proxy this request actually bound; fall back to the global
  // sticky id only if the request was not stamped (older call paths).
  const id = (c && c.zaiEgressId != null) ? c.zaiEgressId : activeEgress.id;
  if (id == null)
    return;
  try {
    await applyProxyResult(c, id, { success: false, failure_class: "egress:" + String(failureClass || "egress") });
  } catch (e) {
    blog("noteEgressFailure failed: " + String(e.message || e));
  }
  // Only invalidate the sticky pick if it is still the proxy that failed; a
  // concurrent request may already have re-selected a different egress.
  if (activeEgress.id === id)
    __resetActiveEgress();
}
// The uTLS helper lives at ZAI_UTLS_PROXY when auto-update injected it, else at
// the conventional ZAI_HTTP_ADDR. Discover it by health rather than assuming
// its absence from a missing env var — a missing var must not read as "helper
// offline" when the process is in fact up on the default port.
async function helperHealthCheck(base) {
  if (!base) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(base.replace(/\/+$/, "") + "/healthz", { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}
async function zaiHelperBase() {
  const configured = String(process.env.ZAI_UTLS_PROXY || "").trim();
  const fallback = process.env.ZAI_HTTP_ADDR ? "http://" + String(process.env.ZAI_HTTP_ADDR).trim() : "http://127.0.0.1:8477";
  for (const base of [configured, fallback]) {
    if (base && await helperHealthCheck(base))
      return base.replace(/\/+$/, "");
  }
  return null;
}
function maskProxyRow(row) {
  const host = String(row.host).includes(":") ? "[" + row.host + "]" : row.host;
  const auth = row.username ? row.username + ":\u2022\u2022\u2022@" : "";
  return {
    id: row.id,
    scheme: row.scheme,
    endpoint: auth + host + ":" + row.port,
    host: row.host,
    port: row.port,
    username: row.username || "",
    has_password: !!row.password_enc,
    enabled: !!row.enabled,
    status: row.status,
    success_count: row.success_count,
    failure_count: row.failure_count,
    consecutive_failures: row.consecutive_failures,
    last_latency_ms: row.last_latency_ms,
    last_failure_class: row.last_failure_class,
    last_checked_at: row.last_checked_at
  };
}
function proxyEgressUrl(row, plainPassword) {
  const host = String(row.host).includes(":") ? "[" + row.host + "]" : row.host;
  const cred = row.username
    ? encodeURIComponent(row.username) + (plainPassword ? ":" + encodeURIComponent(plainPassword) : "") + "@"
    : "";
  return row.scheme + "://" + cred + host + ":" + row.port;
}
app.get("/admin/proxies", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare(
    "SELECT id, scheme, host, port, username, password_enc, enabled, status, success_count, failure_count, consecutive_failures, last_latency_ms, last_failure_class, last_checked_at FROM proxy_pool ORDER BY id"
  ).all();
  const list = (rows.results || []).slice().sort(compareProxyRank);
  const counts = { untested: 0, healthy: 0, flaky: 0, dead: 0, disabled: 0 };
  for (const r of list)
    counts[r.status] = (counts[r.status] || 0) + 1;
  const mode = await settingValue(c, "proxy_egress_mode", "manual");
  let active = null;
  if (mode === "auto") {
    await resolveActiveEgress(c);
    if (activeEgress.id != null) {
      const row = list.find((r) => r.id === activeEgress.id);
      if (row) active = maskProxyRow(row).endpoint;
    }
  }
  const helper = await zaiHelperBase();
  return c.json({ proxies: list.map(maskProxyRow), total: list.length, counts, mode, active, helper: { online: !!helper, base: helper } });
});
app.post("/admin/proxies/mode", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "invalid JSON body" } }, 400);
  }
  const mode = b.mode === "auto" ? "auto" : "manual";
  await c.env.DB.prepare("INSERT INTO gateway_settings (key, value, updated_at) VALUES ('proxy_egress_mode', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(mode, nowIso()).run();
  __resetActiveEgress();
  return c.json({ mode });
});
// Reachability tester: probe any https URL, directly or through a pool proxy
// (by id) or an inline proxy URL. Returns metadata only (status + stage
// timings + failure class), never the body, and runs through the loopback
// helper. Answers "can THIS box reach X, and does proxy Y help?" — the exact
// question when an egress IP is blocked.
app.post("/admin/egress/test", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "invalid JSON body" } }, 400);
  }
  const url = String(b.url || "").trim();
  if (!/^https:\/\//i.test(url))
    return c.json({ error: { message: "url must be an https:// URL" } }, 400);
  const base = await zaiHelperBase();
  if (!base)
    return c.json({ error: { message: "uTLS helper offline; cannot run egress test" } }, 503);
  // Resolve the proxy: a pool id, an inline proxy URL, or none (direct).
  let proxy = "";
  if (b.proxy_id != null) {
    const row = await c.env.DB.prepare("SELECT scheme, host, port, username, password_enc FROM proxy_pool WHERE id=?").bind(Number(b.proxy_id)).first();
    if (!row)
      return c.json({ error: { message: "proxy id not found" } }, 404);
    let plainPassword = "";
    if (row.password_enc) {
      try {
        plainPassword = await openProviderKey(c.env, row.password_enc);
      } catch {
        return c.json({ error: { message: "proxy credential could not be decrypted (config error)" } }, 500);
      }
    }
    proxy = proxyEgressUrl(row, plainPassword);
  } else if (b.proxy) {
    proxy = String(b.proxy).trim();
  }
  const timeoutMs = Math.min(20000, Math.max(1000, Number(b.timeout_ms) || 15000));
  try {
    const resp = await fetch(base + "/reach-egress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, proxy, timeout_ms: timeoutMs })
    });
    const result = await resp.json();
    // Echo back which egress was used (masked) so the operator sees context;
    // never echo the decrypted proxy URL.
    return c.json({ url, via: b.proxy_id != null ? ("proxy #" + Number(b.proxy_id)) : (proxy ? "inline proxy" : "direct"), result });
  } catch (e) {
    return c.json({ error: { message: "egress test failed: " + String(e.message || e) } }, 502);
  }
});
app.post("/admin/proxies/import", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "invalid JSON body" } }, 400);
  }
  const defaultScheme = ["http", "https", "socks5", "socks5h"].includes(b.default_scheme) ? b.default_scheme : "http";
  const parsed = parseProxyImport(String(b.text || ""), defaultScheme);
  let imported = 0;
  let duplicatesInDb = 0;
  const now = nowIso();
  for (const p of parsed.accepted) {
    const passwordEnc = p.password ? await sealProviderKey(c.env, p.password) : null;
    try {
      const r = await c.env.DB.prepare(
        "INSERT INTO proxy_pool (scheme, host, port, username, password_enc, enabled, status, created_at, updated_at) VALUES (?,?,?,?,?,1,'untested',?,?) ON CONFLICT(scheme, host, port, username) DO NOTHING"
      ).bind(p.scheme, p.host, p.port, p.username || "", passwordEnc, now, now).run();
      if (r && r.meta && r.meta.changes > 0)
        imported++;
      else
        duplicatesInDb++;
    } catch (e) {
      blog("proxy import row failed: " + String(e.message || e));
    }
  }
  return c.json({
    imported,
    duplicates: parsed.duplicates + duplicatesInDb,
    invalid: parsed.invalid.length,
    invalid_samples: parsed.invalid.slice(0, 10)
  });
});
app.post("/admin/proxies/:id/toggle", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT enabled, status FROM proxy_pool WHERE id=?").bind(id).first();
  if (!row)
    return c.json({ error: { message: "proxy not found" } }, 404);
  const enabled = row.enabled ? 0 : 1;
  // Disabling parks the row in the explicit 'disabled' state; enabling returns
  // it to 'untested' so it must re-earn health.
  const status = enabled ? "untested" : "disabled";
  await c.env.DB.prepare("UPDATE proxy_pool SET enabled=?, status=?, updated_at=? WHERE id=?").bind(enabled, status, nowIso(), id).run();
  return c.json({ id, enabled: !!enabled, status });
});
app.post("/admin/proxies/delete", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "invalid JSON body" } }, 400);
  }
  if (b.dead === true) {
    const r = await c.env.DB.prepare("DELETE FROM proxy_pool WHERE status='dead'").run();
    return c.json({ deleted: (r && r.meta && r.meta.changes) || 0 });
  }
  const ids = Array.isArray(b.ids) ? b.ids.map((x) => Number(x)).filter(Number.isInteger) : [];
  if (!ids.length)
    return c.json({ error: { message: "provide ids[] or dead:true" } }, 400);
  const placeholders = ids.map(() => "?").join(",");
  const r = await c.env.DB.prepare("DELETE FROM proxy_pool WHERE id IN (" + placeholders + ")").bind(...ids).run();
  return c.json({ deleted: (r && r.meta && r.meta.changes) || 0 });
});
app.post("/admin/proxies/test", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    b = {};
  }
  const base = await zaiHelperBase();
  if (!base)
    return c.json({ error: { message: "uTLS helper offline; start zaihttp (ZAI_HTTP_ADDR / ZAI_UTLS_PROXY) to test egress" } }, 503);
  const concurrency = Math.min(50, Math.max(1, Number(b.concurrency) || 20));
  const timeoutMs = Math.min(20000, Math.max(1000, Number(b.timeout_ms) || 10000));
  let where = "enabled=1";
  if (Array.isArray(b.ids) && b.ids.length) {
    const ids = b.ids.map((x) => Number(x)).filter(Number.isInteger);
    where = "id IN (" + ids.map(() => "?").join(",") + ")";
    var idBinds = ids;
  } else if (b.failed_only === true) {
    where = "enabled=1 AND status IN ('dead','flaky')";
  }
  const rows = await c.env.DB.prepare(
    "SELECT id, scheme, host, port, username, password_enc FROM proxy_pool WHERE " + where + " ORDER BY id"
  ).bind(...(typeof idBinds !== "undefined" ? idBinds : [])).all();
  const pool = rows.results || [];
  const wantsStream = b.stream === true;
  let tested = 0;
  let healthy = 0;
  let dead = 0;
  // emit is a sink: SSE writer when streaming, else a no-op. runOne tests one
  // proxy, patches its health, and reports the post-update row snapshot so the
  // UI can repaint that single row live instead of reloading the whole pool.
  const makeRunOne = (emit) => async (row) => {
    let plainPassword = "";
    if (row.password_enc) {
      try {
        plainPassword = await openProviderKey(c.env, row.password_enc);
      } catch (e) {
        // Config/crypto error, not a proxy fault: do not dial, do not touch
        // proxy health, surface it as an internal error for this row.
        blog("proxy test decrypt failed id=" + row.id + ": " + String(e.message || e));
        tested++;
        emit({ type: "result", id: row.id, error: "decrypt_failed", tested });
        return;
      }
    }
    const proxyUrl = proxyEgressUrl(row, plainPassword);
    let result = { success: false, failure_class: "request_failed" };
    try {
      const resp = await fetch(base + "/check-egress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proxy: proxyUrl, timeout_ms: timeoutMs })
      });
      result = await resp.json();
    } catch (e) {
      result = { success: false, failure_class: "request_failed" };
    }
    const snap = await applyProxyResult(c, row.id, result);
    tested++;
    if (result.success) healthy++;
    else if (snap && snap.status === "dead") dead++;
    emit({
      type: "result",
      id: row.id,
      success: !!result.success,
      status: snap ? snap.status : null,
      last_latency_ms: snap ? snap.last_latency_ms : null,
      consecutive_failures: snap ? snap.consecutive_failures : null,
      last_failure_class: snap ? snap.last_failure_class : null,
      last_checked_at: snap ? snap.last_checked_at : null,
      tested, healthy, dead
    });
  };
  if (!wantsStream) {
    const runOne = makeRunOne(() => {});
    for (let i = 0; i < pool.length; i += concurrency)
      await Promise.all(pool.slice(i, i + concurrency).map(runOne));
    return c.json({ tested, healthy, dead });
  }
  // Live mode: stream one SSE event per proxy as its result lands, so the UI
  // updates rows and progress without a reload. Bounded concurrency preserved.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => { try { controller.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n")); } catch {} };
      send({ type: "start", total: pool.length });
      const runOne = makeRunOne(send);
      try {
        for (let i = 0; i < pool.length; i += concurrency)
          await Promise.all(pool.slice(i, i + concurrency).map(runOne));
        send({ type: "done", tested, healthy, dead });
      } catch (e) {
        send({ type: "done", tested, healthy, dead, error: String(e && e.message || e) });
      }
      send({ type: "eof" });
      try { controller.close(); } catch {}
    }
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" } });
});
async function applyProxyResult(c, id, result) {
  const now = nowIso();
  const row = await c.env.DB.prepare("SELECT success_count, failure_count, consecutive_failures FROM proxy_pool WHERE id=?").bind(id).first();
  if (!row)
    return;
  await c.env.DB.prepare(
    "INSERT INTO proxy_test_runs (proxy_id, success, failure_class, connect_ms, tunnel_ms, tls_ms, total_ms, created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(id, result.success ? 1 : 0, result.failure_class || null, result.connect_ms ?? null, result.tunnel_ms ?? null, result.tls_ms ?? null, result.total_ms ?? null, now).run();
  if (result.success) {
    // A single success clears the consecutive-failure streak and marks healthy.
    await c.env.DB.prepare(
      "UPDATE proxy_pool SET success_count=success_count+1, consecutive_failures=0, status='healthy', last_latency_ms=?, last_failure_class=NULL, last_checked_at=?, updated_at=? WHERE id=?"
    ).bind(result.total_ms ?? null, now, now, id).run();
    return { status: "healthy", last_latency_ms: result.total_ms ?? null, consecutive_failures: 0, last_failure_class: null, last_checked_at: now };
  }
  const consec = (Number(row.consecutive_failures) || 0) + 1;
  // 3 consecutive failures => dead. Below that, a failing proxy is 'flaky'
  // rather than deleted: public proxies are noisy and a single failure should
  // not evict one. Remove Dead only removes the dead.
  const status = consec >= PROXY_DEAD_THRESHOLD ? "dead" : "flaky";
  await c.env.DB.prepare(
    "UPDATE proxy_pool SET failure_count=failure_count+1, consecutive_failures=?, status=?, last_failure_class=?, last_checked_at=?, updated_at=? WHERE id=?"
  ).bind(consec, status, result.failure_class || "request_failed", now, now, id).run();
  return { status, last_latency_ms: null, consecutive_failures: consec, last_failure_class: result.failure_class || "request_failed", last_checked_at: now };
}
// Live Z.AI diagnostic. Runs the real warm + session-acquire phases through
// the same uTLS helper + egress the request path uses, and reports each step's
// status/timing so a failing route can be diagnosed without shell access.
// Credentials are never returned — only presence, source, redacted userId.
app.get("/admin/zai/diagnose", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  await ensureUpstreamDispatcher();
  const slug = String(c.req.query("slug") || "").trim();
  // Find a Z.AI route: the requested slug, else the first enabled zai* route.
  const rows = await c.env.DB.prepare(
    `SELECT mr.slug, mr.upstream_model, mr.provider_id, p.name AS provider_name, p.fmt, p.transport
     FROM model_routes mr JOIN providers p ON p.id=mr.provider_id
     WHERE mr.enabled=1 AND p.enabled=1 AND p.fmt IN ('zaiminted','zaiweb','zaiwebbrowser')` +
     (slug ? " AND mr.slug=?" : "") + " ORDER BY mr.rank LIMIT 1"
  ).bind(...(slug ? [slug] : [])).all();
  const route = (rows.results || [])[0];
  if (!route)
    return c.json({ error: { message: slug ? ("no enabled Z.AI route for slug " + slug) : "no enabled Z.AI route found" } }, 404);
  route.zai_session_key = "provider:" + route.provider_id + ":diag";
  // Resolve the sealed credential for this provider, same as the live path.
  let rawKey = "";
  try {
    const keys = await providerKeys(c, route.provider_id);
    rawKey = (keys[0] && keys[0].key) || "";
  } catch (e) {
    return c.json({ error: { message: "could not load provider credential: " + String(e.message || e) } }, 500);
  }
  // Pin the same egress the live path would use (auto-pool or env), so the
  // probe reflects reality.
  try { c.zaiEgress = await resolveActiveEgress(c); } catch { c.zaiEgress = null; }
  c.upstreamFetch = (url, init) => upstreamFetch(c, url, init);
  const report = await diagnoseZai(c, route, rawKey, {});
  report.helper_online = !!(await zaiHelperBase());
  return c.json(report);
});
// Z.AI egress health: WAF breaker state (blocked/probing/backoff) plus the
// bounded-reuse session pool status. Admin-only; leaks no credentials, only
// operational counters. Cheap — no upstream calls.
app.get("/admin/zai/status", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const waf = zaiWaf.status();
  return c.json({
    waf: {
      blocked: waf.blocked,
      anyProbing: waf.anyProbing,
      blockedEgresses: waf.blockedEgresses || [],
      egresses: waf.egresses || []
    },
    sessions: zaiSessionPoolStatus()
  });
});
// Z.AI device-token pool: operational refill visibility + live import into the
// canonical SQLite FIFO (zai_device_tokens). Tokens are single-use Aliyun
// device tokens consumed as CAPTCHA proofs are minted. Admin-only; token VALUES
// are never returned by either endpoint — only counts.
var LOW_TOKEN_THRESHOLD = 25;
function zaiTokenStorePath(c) {
  return (c && c.env && c.env.ZAI_TOKEN_STORE) || undefined;
}
function captchaProofsReady() {
  try {
    return (zaiCaptchaCacheStatus() || []).reduce((n, cache) => n + (Number(cache.ready) || 0), 0);
  } catch {
    return 0;
  }
}
app.get("/admin/zai/device-tokens/status", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const available = await peekDeviceTokens(zaiTokenStorePath(c), c.env.DB);
  return c.json({
    available,
    captcha_ready: captchaProofsReady(),
    low: available < LOW_TOKEN_THRESHOLD
  });
});
// Accepts a JSON token array (`{"tokens":[...]}`) or a newline-delimited string
// (`{"tokens":"a\nb"}` or a raw text body). Inserts directly into the FIFO; the
// table's UNIQUE(token) constraint dedupes against existing rows. Counts:
//   invalid    = submitted entries that are empty after trimming (non-tokens)
//   duplicates = repeats within the batch PLUS entries already in the store
//   accepted   = genuinely new rows (measured by the store count delta)
// Token format is opaque, so validation is only "non-empty after trim" — the
// same contract the token store itself applies; no admin-only length rules.
app.post("/admin/zai/device-tokens/import", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let raw;
  const ctype = String(c.req.header("content-type") || "");
  if (ctype.includes("application/json")) {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "Invalid JSON body" } }, 400);
    }
    raw = body && body.tokens != null ? body.tokens : body;
  } else {
    raw = await c.req.text();
  }
  // A raw text body may have a trailing newline; trimming first avoids counting
  // that as an invalid empty entry. Array entries are coerced/trimmed the same.
  const list = Array.isArray(raw) ? raw : String(raw || "").trim().split(/[\r\n]+/);
  const unique = [];
  const seen = new Set();
  let invalid = 0;
  let batchDuplicates = 0;
  for (const item of list) {
    const t = String(item == null ? "" : item).trim();
    if (!t) { invalid++; continue; }
    if (seen.has(t)) { batchDuplicates++; continue; }
    seen.add(t);
    unique.push(t);
  }
  const before = await peekDeviceTokens(zaiTokenStorePath(c), c.env.DB);
  if (unique.length)
    await appendDeviceTokens(unique, zaiTokenStorePath(c), c.env.DB);
  const after = await peekDeviceTokens(zaiTokenStorePath(c), c.env.DB);
  const accepted = after - before;
  // Repeats inside the batch + tokens already present both count as duplicates.
  const existingDuplicates = unique.length - accepted;
  return c.json({
    accepted,
    duplicates: batchDuplicates + existingDuplicates,
    invalid,
    available: after
  });
});
// ---- Trajectory exporters ----
// Each ok request/response pair becomes a training example. The request
// already carries the full multi-turn conversation (agents resend history
// including tool results), so the trajectory is the whole sequence, not
// just the last turn.
function assistantMessage(resObj) {
  const msg = resObj && resObj.choices && resObj.choices[0] && resObj.choices[0].message;
  if (!msg)
    return null;
  return {
    role: "assistant",
    ...(msg.content != null ? { content: msg.content } : { content: "" }),
    ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
    ...(Array.isArray(msg.tool_calls) && msg.tool_calls.length ? { tool_calls: msg.tool_calls } : {})
  };
}
function validTrainingMessages(messages) {
  return Array.isArray(messages) && messages.length > 0 && messages.every(function (m) {
    if (!m || typeof m.role !== "string")
      return false;
    // Assistant turns with tool calls may legitimately carry null content.
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length)
      return true;
    return m.content != null;
  });
}
function exportTrajectoryLine(r, format) {
  const req = JSON.parse(r.request_json);
  const resObj = JSON.parse(r.response_json);
  const assistant = assistantMessage(resObj);
  if (!assistant || !validTrainingMessages(req.messages))
    return null;
  const finish = resObj.choices && resObj.choices[0] && resObj.choices[0].finish_reason || "stop";
  if (format === "openai") {
    // OpenAI fine-tuning / chatml convention: full conversation + target.
    return JSON.stringify({
      messages: req.messages.concat([assistant]),
      model: r.slug
    });
  }
  if (format === "sharegpt") {
    // ShareGPT/Vicuna convention: {"conversations": [{from,value},...]}
    // tool calls/results map to function_call/function_response turns.
    const conv = [];
    for (const m of req.messages) {
      if (m.role === "system") {
        conv.push({ from: "system", value: String(m.content) });
      } else if (m.role === "user") {
        conv.push({ from: "human", value: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
      } else if (m.role === "assistant") {
        if (m.content)
          conv.push({ from: "gpt", value: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
        if (Array.isArray(m.tool_calls))
          for (const tc of m.tool_calls)
            conv.push({ from: "function_call", value: JSON.stringify({ name: tc.function && tc.function.name, arguments: tc.function && tc.function.arguments }) });
      } else if (m.role === "tool") {
        conv.push({ from: "function_response", value: { name: m.name || m.tool_call_id || "tool", content: m.content } });
      }
    }
    if (assistant.content)
      conv.push({ from: "gpt", value: assistant.content });
    if (Array.isArray(assistant.tool_calls))
      for (const tc of assistant.tool_calls)
        conv.push({ from: "function_call", value: JSON.stringify({ name: tc.function && tc.function.name, arguments: tc.function && tc.function.arguments }) });
    if (!conv.some(function (x) { return x.from === "gpt"; }))
      return null;
    return JSON.stringify({ conversations: conv, model: r.slug });
  }
  if (format === "trl") {
    // HuggingFace TRL conversational format: {"messages": [...]} with
    // system/user/assistant/tool roles, tool calls preserved verbatim.
    return JSON.stringify({
      messages: req.messages.concat([assistant]),
      metadata: { model: r.slug, finish_reason: finish }
    });
  }
  if (format === "rl") {
    // RL episode: state = conversation so far, action = the completion,
    // reward signal fields for downstream preference/RLHF pipelines.
    return JSON.stringify({
      prompt: { messages: req.messages },
      completion: { message: assistant, finish_reason: finish },
      reward: null,
      info: {
        model: r.slug,
        provider: r.provider,
        attempts: r.attempts,
        steps: JSON.parse(r.steps_json || "[]"),
        prompt_tokens: r.prompt_tokens || 0,
        completion_tokens: r.completion_tokens || 0,
        total_tokens: r.total_tokens || 0,
        cost_usd: r.cost_usd,
        latency_ms: r.latency_ms,
        created_at: r.created_at
      }
    });
  }
  return null;
}
app.post("/admin/trajectories/purge", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const r = await c.env.DB.prepare("DELETE FROM trajectories").run();
  return c.json({ purged: r && r.meta ? r.meta.changes : 0 });
});
app.get("/admin/trajectory-settings", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  return c.json({ capture: await settingValue(c, "trajectory_capture", "on") });
});
app.get("/admin/model-limits", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare(
    "SELECT slug, kind, period, limit_value, updated_at FROM model_limits ORDER BY slug, kind, period"
  ).all();
  return c.json({ limits: rows.results || [] });
});
app.post("/admin/model-limits", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try { b = await c.req.json(); } catch { return c.json({ error: { message: "Invalid JSON" } }, 400); }
  const slug = String(b.slug || "").trim();
  const kind = String(b.kind || "").toLowerCase();
  const period = String(b.period || "").toLowerCase();
  if (!slug)
    return c.json({ error: { message: "slug required" } }, 400);
  if (!MODEL_LIMIT_KINDS.includes(kind))
    return c.json({ error: { message: "kind must be one of " + MODEL_LIMIT_KINDS.join(", ") } }, 400);
  if (!MODEL_LIMIT_PERIODS.includes(period))
    return c.json({ error: { message: "period must be one of " + MODEL_LIMIT_PERIODS.join(", ") } }, 400);
  const value = Number(b.limit_value);
  if (!Number.isFinite(value) || value < 0)
    return c.json({ error: { message: "limit_value must be 0 or positive (0 = unlimited)" } }, 400);
  if (value === 0) {
    await c.env.DB.prepare("DELETE FROM model_limits WHERE slug=? AND kind=? AND period=?").bind(slug, kind, period).run();
    return c.json({ slug, kind, period, limit_value: 0, removed: true });
  }
  await c.env.DB.prepare(
    `INSERT INTO model_limits (slug, kind, period, limit_value, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(slug,kind,period) DO UPDATE SET limit_value=excluded.limit_value, updated_at=excluded.updated_at`
  ).bind(slug, kind, period, value, nowIso()).run();
  return c.json({ slug, kind, period, limit_value: value });
});
app.delete("/admin/model-limits/:slug/:kind/:period", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const slug = decodeURIComponent(c.req.param("slug"));
  const kind = c.req.param("kind");
  const period = c.req.param("period");
  await c.env.DB.prepare("DELETE FROM model_limits WHERE slug=? AND kind=? AND period=?").bind(slug, kind, period).run();
  return c.json({ ok: true });
});
app.post("/admin/trajectory-settings", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try { b = await c.req.json(); } catch { return c.json({ error: { message: "Invalid JSON" } }, 400); }
  const v = b.capture === "off" ? "off" : "on";
  await c.env.DB.prepare("INSERT INTO gateway_settings (key, value, updated_at) VALUES ('trajectory_capture', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(v, nowIso()).run();
  return c.json({ capture: v });
});
app.get("/admin/auto-settings", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  return c.json(await autoSettings(c));
});
app.post("/admin/auto-settings", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try { b = await c.req.json(); } catch { return c.json({ error: { message: "Invalid JSON" } }, 400); }
  const enabled = b.enabled === false || b.enabled === "off" ? "off" : "on";
  const pref = Math.min(100, Math.max(0, Number(b.preference)));
  const excluded = splitModelSlugs(Array.isArray(b.excluded) ? b.excluded.join(",") : String(b.excluded || "")).join(",");
  let overrides = {};
  if (b.overrides !== void 0) {
    if (typeof b.overrides !== "object" || Array.isArray(b.overrides) || b.overrides === null)
      return c.json({ error: { message: "overrides must be an object of slug -> multiplier" } }, 400);
    for (const [k, v] of Object.entries(b.overrides)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0)
        return c.json({ error: { message: "override for " + k + " must be a positive number" } }, 400);
      overrides[k] = n;
    }
  } else {
    try { overrides = JSON.parse(await settingValue(c, "auto_overrides", "{}")) || {}; } catch { overrides = {}; }
  }
  const set = async (k, v) => c.env.DB.prepare("INSERT INTO gateway_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(k, v, nowIso()).run();
  await set("auto_enabled", enabled);
  if (Number.isFinite(pref))
    await set("auto_preference", String(Math.round(pref)));
  await set("auto_excluded", excluded);
  await set("auto_overrides", JSON.stringify(overrides));
  return c.json({ enabled: enabled === "on", preference: Number.isFinite(pref) ? Math.round(pref) : 70, excluded: excluded ? excluded.split(",") : [], overrides });
});
app.post("/admin/auto-preview", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try { b = await c.req.json(); } catch { return c.json({ error: { message: "Invalid JSON" } }, 400); }
  const messages = Array.isArray(b.messages) ? b.messages : [{ role: "user", content: String(b.prompt || "") }];
  const decision = await pickAutoModel(c, { messages, tools: b.tools || undefined });
  if (!decision)
    return c.json({ error: { message: "auto routing unavailable (disabled or no routed models)" } }, 503);
  const hz = decision.horizon || {};
  return c.json({
    picked: decision.slug,
    fallback: !!decision.fallback,
    need: decision.need,
    complexity: decision.complexity,
    preference: decision.preference,
    candidates: decision.candidates,
    queue: decision.queue || hz.queue || [],
    horizon: {
      speed: hz.speed,
      role: hz.role,
      mvc: hz.mvc,
      hopsMax: hz.hopsMax,
      phase: hz.phase,
      compact: !!hz.compact,
      taskIR: hz.taskIR || null
    },
    v2: decision.v2 || null
  });
});
app.get("/admin/cache", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  await c.env.DB.prepare("DELETE FROM response_cache WHERE expires_at<=?").bind(nowIso()).run();
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) AS entries, COALESCE(SUM(hits),0) AS hits, COALESCE(SUM(hits * source_cost_usd),0) AS saved_usd, COALESCE(SUM(hits * source_tokens),0) AS saved_tokens FROM response_cache"
  ).first();
  return c.json({ cache: row || { entries: 0, hits: 0, saved_usd: 0, saved_tokens: 0 }, policy: {
    opt_in_header: "x-gateway-cache: true",
    refresh_header: "x-gateway-cache: refresh",
    ttl_header: "x-gateway-cache-ttl",
    default_ttl_seconds: 3600,
    min_ttl_seconds: 60,
    max_ttl_seconds: 86400,
    deterministic_only: true,
    key_scoped: true
  } });
});
app.post("/admin/cache/purge", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let body;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const keyId = body && body.key_id ? String(body.key_id) : null;
  if (keyId) {
    const r2 = await c.env.DB.prepare("DELETE FROM response_cache WHERE key_id=?").bind(keyId).run();
    return c.json({ purged: Number(r2.meta && r2.meta.changes) || 0, scope: "key" });
  }
  if (!body || body.confirm !== "PURGE_ALL_CACHE")
    return c.json({ error: { message: "confirm must equal PURGE_ALL_CACHE to clear every cached response" } }, 400);
  const r = await c.env.DB.prepare("DELETE FROM response_cache").run();
  return c.json({ purged: Number(r.meta && r.meta.changes) || 0, scope: "all" });
});
app.post("/admin/rotate", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const t = String(b.token || "");
  if (t.length < 16)
    return c.json({ error: { message: "token >= 16 chars" } }, 400);
  await c.env.DB.prepare("INSERT OR IGNORE INTO admin_tokens (token_hash, created_at) VALUES (?,?)").bind(await sha256hex(t), nowIso()).run();
  return c.json({ ok: true });
});
app.get("/admin/prices", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  await ensurePriceColumns(c.env.DB);
  const queries = [
    "SELECT p.slug, p.provider_id, pr.name AS provider_name, p.prompt_per_1m, p.completion_per_1m, p.actual_prompt_per_1m, p.actual_completion_per_1m, p.cache_read_per_1m, p.cache_write_per_1m, p.actual_mode, p.actual_per_request, p.currency, p.updated_at FROM prices p LEFT JOIN providers pr ON pr.id=p.provider_id ORDER BY p.slug, p.provider_id",
    "SELECT slug, prompt_per_1m, completion_per_1m, actual_prompt_per_1m, actual_completion_per_1m, cache_read_per_1m, cache_write_per_1m, actual_mode, actual_per_request, currency, updated_at FROM prices ORDER BY slug",
    "SELECT slug, prompt_per_1m, completion_per_1m, currency, updated_at FROM prices ORDER BY slug"
  ];
  for (const sql of queries) {
    try {
      const rows = await c.env.DB.prepare(sql).all();
      return c.json({ prices: (rows && rows.results) || [] });
    } catch {
    }
  }
  return c.json({ prices: [] });
});
app.post("/admin/prices/sync-models-dev", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let catalog;
  try {
    catalog = await fetchModelsDevCatalog();
  } catch (e) {
    return c.json({ error: { message: "models.dev fetch failed: " + String(e.message || e) } }, 502);
  }
  await ensurePriceColumns(c.env.DB);
  const hasProv = await pricesHasProvider(c);
  const byId = flattenModelsDevCatalog(catalog);
  const slugs = await c.env.DB.prepare("SELECT DISTINCT slug FROM model_routes").all();
  const list = slugs.results || [];
  let matched = 0, unmatched = 0;
  const missing = [];
  const updated = [];
  const ts = nowIso();
  for (const row of list) {
    const slug = row.slug;
    const hit = matchModelsDevPrice(byId, slug);
    if (!hit) {
      unmatched++;
      if (missing.length < 50)
        missing.push(slug);
      continue;
    }
    if (hasProv)
      await c.env.DB.prepare("INSERT INTO prices (slug, provider_id, prompt_per_1m, completion_per_1m, currency, updated_at) VALUES (?,0,?,?,?,?) ON CONFLICT(slug, provider_id) DO UPDATE SET prompt_per_1m=excluded.prompt_per_1m, completion_per_1m=excluded.completion_per_1m, currency=excluded.currency, updated_at=excluded.updated_at").bind(slug, hit.prompt_per_1m, hit.completion_per_1m, "USD", ts).run();
    else
      await c.env.DB.prepare("INSERT INTO prices (slug, prompt_per_1m, completion_per_1m, currency, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET prompt_per_1m=excluded.prompt_per_1m, completion_per_1m=excluded.completion_per_1m, currency=excluded.currency, updated_at=excluded.updated_at").bind(slug, hit.prompt_per_1m, hit.completion_per_1m, "USD", ts).run();
    matched++;
    updated.push({ slug, prompt_per_1m: hit.prompt_per_1m, completion_per_1m: hit.completion_per_1m, source: hit.id });
  }
  return c.json({ ok: true, source: MODELS_DEV_API, matched, unmatched, updated, missing });
});
app.post("/admin/prices", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  if (!b.slug)
    return c.json({ error: { message: "slug required" } }, 400);
  const p = Number(b.prompt_per_1m) || 0;
  const ct = Number(b.completion_per_1m) || 0;
  const ap = numOrNull(b.actual_prompt_per_1m);
  const ac = numOrNull(b.actual_completion_per_1m);
  const cr = numOrNull(b.cache_read_per_1m);
  const cw = numOrNull(b.cache_write_per_1m);
  const mode = b.actual_mode === "per_request" ? "per_request" : "per_1m";
  const perReq = numOrNull(b.actual_per_request);
  const pid = Number(b.provider_id) || 0;
  await ensurePriceColumns(c.env.DB);
  const wrote = { ok: true, slug: b.slug, provider_id: pid, prompt_per_1m: p, completion_per_1m: ct, actual_prompt_per_1m: ap, actual_completion_per_1m: ac, cache_read_per_1m: cr, cache_write_per_1m: cw, actual_mode: mode, actual_per_request: perReq };
  if (await pricesHasProvider(c)) {
    await c.env.DB.prepare("INSERT INTO prices (slug, provider_id, prompt_per_1m, completion_per_1m, actual_prompt_per_1m, actual_completion_per_1m, cache_read_per_1m, cache_write_per_1m, actual_mode, actual_per_request, currency, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(slug, provider_id) DO UPDATE SET prompt_per_1m=excluded.prompt_per_1m, completion_per_1m=excluded.completion_per_1m, actual_prompt_per_1m=excluded.actual_prompt_per_1m, actual_completion_per_1m=excluded.actual_completion_per_1m, cache_read_per_1m=excluded.cache_read_per_1m, cache_write_per_1m=excluded.cache_write_per_1m, actual_mode=excluded.actual_mode, actual_per_request=excluded.actual_per_request, currency=excluded.currency, updated_at=excluded.updated_at").bind(b.slug, pid, p, ct, ap, ac, cr, cw, mode, perReq, b.currency || "USD", nowIso()).run();
    return c.json(wrote);
  }
  try {
    await c.env.DB.prepare("INSERT INTO prices (slug, prompt_per_1m, completion_per_1m, actual_prompt_per_1m, actual_completion_per_1m, cache_read_per_1m, cache_write_per_1m, actual_mode, actual_per_request, currency, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET prompt_per_1m=excluded.prompt_per_1m, completion_per_1m=excluded.completion_per_1m, actual_prompt_per_1m=excluded.actual_prompt_per_1m, actual_completion_per_1m=excluded.actual_completion_per_1m, cache_read_per_1m=excluded.cache_read_per_1m, cache_write_per_1m=excluded.cache_write_per_1m, actual_mode=excluded.actual_mode, actual_per_request=excluded.actual_per_request, currency=excluded.currency, updated_at=excluded.updated_at").bind(b.slug, p, ct, ap, ac, cr, cw, mode, perReq, b.currency || "USD", nowIso()).run();
  } catch {
    await c.env.DB.prepare("INSERT INTO prices (slug, prompt_per_1m, completion_per_1m, currency, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET prompt_per_1m=excluded.prompt_per_1m, completion_per_1m=excluded.completion_per_1m, currency=excluded.currency, updated_at=excluded.updated_at").bind(b.slug, p, ct, b.currency || "USD", nowIso()).run();
  }
  return c.json(wrote);
});
app.delete("/admin/prices/:slug", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const slug = decodeURIComponent(c.req.param("slug"));
  const pid = Number(c.req.query("provider_id")) || 0;
  if (await pricesHasProvider(c))
    await c.env.DB.prepare("DELETE FROM prices WHERE slug=? AND provider_id=?").bind(slug, pid).run();
  else
    await c.env.DB.prepare("DELETE FROM prices WHERE slug=?").bind(slug).run();
  return c.json({ ok: true });
});
var SHARED_THEME = ":root{--bg:#0a0c10;--surface:#12161d;--surface-deep:#0c1016;--line:#232a34;--line-hi:#3a4454;--text:#eef2f7;--muted:#8b96a6;--accent:#3dd6c6;--good:#62d3a5;--warn:#e7bd67;--bad:#f07d7d;--w-med:600;--w-bold:650;}";
var ADMIN_UI_PATH = "/_gw";
function adminHtml(html) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store",
      // The SPA uses its bundled inline script/style; no third-party code,
      // frames, forms, or network destinations are permitted.
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "permissions-policy": "geolocation=(), camera=(), microphone=()"
    }
  });
}
app.post(ADMIN_UI_PATH + "/auth", async (c) => {
  let b;
  try {
    b = await c.req.json();
  } catch {
    b = {};
  }
  if (!await allowAdminLoginAttempt(c)) {
    return new Response(JSON.stringify({ ok: false, error: "Too many attempts. Try again later." }), { status: 429, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "900" } });
  }
  const ok = await checkAdminPassword(String(b.password || ""), c.env);
  if (!ok)
    return new Response(JSON.stringify({ ok: false, error: "Invalid password" }), { status: 401, headers: { "content-type": "application/json" } });
  const session = genSessionToken();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1e3).toISOString();
  await c.env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(nowIso()).run();
  await c.env.DB.prepare("INSERT INTO admin_sessions (token_hash, expires_at, created_at) VALUES (?,?,?)").bind(await sha256hex(session), expiresAt, nowIso()).run();
  const cookie = "gw_adm=" + encodeURIComponent(session) + "; Path=/; Max-Age=43200; SameSite=Lax; HttpOnly";
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", "Set-Cookie": cookie } });
});
app.get(ADMIN_UI_PATH, async (c) => {
  if (!await isAdmin(c))
    return adminHtml(LOGIN_HTML);
  return adminHtml(PLAYGROUND_HTML);
});
app.get(ADMIN_UI_PATH + "/", async (c) => {
  if (!await isAdmin(c))
    return adminHtml(LOGIN_HTML);
  return adminHtml(PLAYGROUND_HTML);
});
function clientResponseHeaders(upstreamHeaders, streaming = false) {
  const contentType = upstreamHeaders.get("content-type") || (streaming ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
  return {
    "content-type": contentType,
    "cache-control": streaming ? "no-cache, no-store" : "no-store"
  };
}
export const __test = { recordUsage, __setModelsDevCache, decisionSnapshot, shadowAttemptFields, stripHistoricalReasoning, closeSseGracefully, wrapAnthropicStream, fromAnthropicStreamChunk, sanitizeClientResponse, safeSseData, sealProviderKey, openProviderKey, stableJson, isCacheableRequest, responseCacheKey, isCacheableResponse, normalizeRequestLimit, normalizeKeyExpiry, isKeyExpired, splitModelSlugs, effectiveModelSlugs, cacheCoalesceDelayMs, classifyUpstreamFailure, isGenericUpstreamErrorResponse, routeTransport, normalizeTransport, transportLabel, koyebCfg, flattenModelsDevCatalog, matchModelsDevPrice, qualityPrior, promptComplexity, analyzeRequest, entryCapabilities, pickAutoModel, normalizeProviderFormat, routerHealth, __resetRouterHealthCache, isLuxuryFlagship, isWorkhorse, buildWorldModel, compactMessages, applyAutoHarness, planHorizon, renderHorizonState, usableContextWindow, isRetryableTransportError, sseUpstreamDisconnect, sanitizeUpstreamResponse, sanitizeRequest, circuitOpen, circuitRecord, circuitKey, circuitRecordFailure, circuitSnapshot, __resetCircuitState, publicProviderError, isPublicRequestProviderError, orderKeys, shouldRetrySameKey, shouldRetryHttp, SAME_KEY_ATTEMPTS, genericUpstreamError, costFromRates, priceFromRow, numOrNull, routeReliability, reflexPick, ROUTE_RELIABILITY_FLOOR, REFLEX_LATENCY_SLA_MS, computeCost, lookupPriceRow, __resetPricesSchema, classifyAttempt, recordRouteAttempt, updateRouterStat, streamTerminalOutcome, applyProxyResult, compareProxyRank, resolveActiveEgress, __resetActiveEgress, noteEgressFailure };
export function createApp(env) {
  if (!env) return app;
  return { fetch: (req, ctx) => app.fetch(req, env, ctx) };
}
