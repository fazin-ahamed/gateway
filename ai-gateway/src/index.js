import { LOGIN_HTML } from "./login.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { PLAYGROUND_HTML } from "./playground.js";
import { callZaiBrowser, callZaiMinted, callZaiWeb, isZaiBrowserFormat, isZaiMintedFormat, isZaiWebFormat, modelCatalogEntry, validateZaiWebKey, withRotatedToken, ZaiWebError } from "./zaiweb.js";
import { planHorizon, renderHorizonState, isTinySlug, usableContextWindow } from "./horizon.js";
import { normalizeTerminalFinishReason } from "../../server/tool-loop-guard.mjs";
var app = new Hono();
app.use("/*", async (c, next) => {
  c.header("X-Content-Type-Options");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options");
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
  if (mode !== "loose" && payload.temperature != null && Number(payload.temperature) !== 0)
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
  return "data: " + JSON.stringify({
    error: {
      message: "Upstream stream disconnected",
      type: "upstream_stream_error",
      code: "upstream_socket_closed",
      retryable: true
    }
  }) + "\n\ndata: [DONE]\n\n";
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
    v: 3,
    messages: p.messages ?? p.input ?? [],
    temperature: p.temperature ?? 0,
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
  return "rc:c3:" + await sha256hex(String(key.key_id) + "\n" + String(slug) + "\n" + stableJson(trimmed));
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
function orderKeys(keys, strategy, providerId) {
  if (!keys.length)
    return [];
  if (strategy === "random")
    return [keys[Math.floor(Math.random() * keys.length)]];
  if (strategy === "round_robin") {
    const n = rrCounters.get(providerId) || 0;
    rrCounters.set(providerId, n + 1);
    return [keys[n % keys.length]];
  }
  return keys; // failover: all keys in order
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
    "SELECT DISTINCT mr.slug FROM model_routes mr JOIN providers p ON p.id=mr.provider_id WHERE mr.enabled=1 AND p.enabled=1 AND p.healthy=1 AND mr.slug IN (" + allowed.map(() => "?").join(",") + ") ORDER BY mr.slug"
  ).bind(...allowed).all();
  const data = [{ id: AUTO_SLUG, object: "model", created: 0, owned_by: "gateway" }];
  for (const r of routes.results || [])
    data.push({ id: r.slug, object: "model", created: 0, owned_by: "gateway" });
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
          headers: { Authorization: "Bearer " + key }
          // short timeout so status isn't slow
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
async function runChatCompletion(c, key, isAdminPlayground) {
  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body" } }, 400);
  }
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
  const requestId = c.req.header("x-request-id") || uuid();
  const started = Date.now();
  const isStream = !!payload.stream;
  const traj = trajectorySeed(c, payload, key, slug || "unknown", isStream, requestId);
  if (autoDecision)
    traj.steps.push({ provider: "horizon", rank: 0, ok: true, picked: slug, costPer1M: autoDecision.cost, quality: autoDecision.quality, fallback: !!autoDecision.fallback, speed: autoDecision.horizon && autoDecision.horizon.speed, role: autoDecision.horizon && autoDecision.horizon.role, queue: autoDecision.queue || [] });
  if (!slug) {
    await recordTrajectory(c, { ...traj, status: "fail", httpStatus: 400, attempts: 0, latencyMs: Date.now() - started, error: "model is required" });
    return c.json({ error: { message: "model is required" } }, 400);
  }
  if (!isAdminPlayground && !autoDecision && slug !== AUTO_SLUG && !await slugAllowed(c, key, slug)) {
    await recordTrajectory(c, { ...traj, status: "fail", httpStatus: 403, attempts: 0, latencyMs: Date.now() - started, error: "model not enabled for this key" });
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
      "SELECT mr.*, p.base_url, p.name AS provider_name, p.healthy, p.enabled, p.fmt, p.proxy_url, p.transport, p.extra_headers FROM model_routes mr JOIN providers p ON p.id=mr.provider_id WHERE mr.slug=? AND mr.enabled=1 AND p.enabled=1 AND p.healthy=1 ORDER BY mr.rank"
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
  const cacheMode = (cacheModeHeader === "off" || cacheModeHeader === "false" || cacheModeHeader === "0") ? "off" : cacheModeHeader;
  const cacheable = !!key && !autoDecision && isCacheableRequest(payload, isStream, cacheMode);
  const cacheKey = cacheable ? await responseCacheKey(key, slug, payload) : null;
  blog("REQ id=" + requestId + " model=" + slug + " stream=" + isStream + " cache=" + cacheMode + (cacheKey ? "" : "-skip") + " key=" + (key ? key.name : "admin-playground"));
  if (cacheKey && cacheMode !== "refresh") {
    const cached = await lookupResponseCache(c, cacheKey);
    if (cached) {
      blog("TRACE id=" + requestId + " cache=HIT ms=" + (Date.now() - started));
      await recordTrajectory(c, { ...traj, status: "ok", httpStatus: 200, cacheState: "HIT", latencyMs: Date.now() - started, totalTokens: cached.source_tokens || 0, costUsd: cached.source_cost_usd || 0, responseJson: cached.response_body });
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
        return serveCachedCompletion(c, { cached, key, slug, payload, started, state: "COALESCED" });
      }
    }
  }
  if (isStream)
    payload.stream_options = { ...payload.stream_options || {}, include_usage: true };
  try {
    let lastErr = null;
    let lastErrStatus = null;
    let attempts = 0;
    for (const route of routes.results) {
      const liveSlug = route.public_slug || slug;
      if (payload.model !== liveSlug)
        payload = { ...payload, model: liveSlug };
      if (circuitOpen(route.provider_name)) {
        blog("ROUTE skip provider=" + route.provider_name + " circuit-open");
        traj.steps.push({ provider: route.provider_name, rank: route.rank, error: "circuit open", ms: 0, slug: liveSlug });
        lastErr = "provider " + route.provider_name + " circuit open (recent failures)";
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
      for (const k of orderedKeys) {
        try {
          const res = await forwardToProvider(c, route, k.key, payload, isStream, requestId);
          const up = res.response;
          // chat.z.ai retires its session cookie as it issues a new one; keep
          // the stored secret current so the route survives past the rotation.
          if (res.recovered && res.recovered !== k.key && k.keyId)
            await updateProviderKeySecret(c, k.keyId, withRotatedToken(k.key, res.recovered));
          await c.env.DB.prepare("UPDATE providers SET last_status=?, last_checked=? WHERE id=?").bind(up.status, nowIso(), route.provider_id).run();
          if (!up.ok || !up.body) {
            const txt = await up.text();
            const why = classifyUpstreamFailure(txt);
            blog("FWD FAIL " + route.provider_name + " key=" + k.label + " -> HTTP " + up.status + " [" + why + "] " + String(txt).slice(0, 300));
            circuitRecord(route.provider_name, false);
            lastErr = "provider " + route.provider_name + " -> HTTP " + up.status + " [" + why + "]";
            attempts++;
            if (why === "auth" && orderedKeys.indexOf(k) < orderedKeys.length - 1)
              continue; // next key on this provider
            break; // next route
          }
          if (!isStream) {
            const txt = await up.text();
            const usage = res.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
            const costUsd = await computeCost(c, liveSlug, usage);
            const clientTxt = sanitizeClientResponse(txt, liveSlug);
            if (isGenericUpstreamErrorResponse(clientTxt)) {
              blog("FWD MALFORMED " + route.provider_name + " -> " + String(txt).slice(0, 300));
              lastErr = "provider " + route.provider_name + " -> malformed upstream completion envelope";
              traj.steps.push({ ...baseStep, http: up.status, error: "malformed envelope", ms: Date.now() - stepStart });
              attempts++;
              break; // next route
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
            circuitRecord(route.provider_name, true);
            traj.steps.push({ ...baseStep, http: up.status, ok: true, key: k.label, ms: Date.now() - stepStart });
            await recordTrajectory(c, { ...traj, slug: liveSlug, status: "ok", httpStatus: up.status, provider: route.provider_name, rank: route.rank, attempts: attempts + 1, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens, costUsd, latencyMs: Date.now() - started, cacheState: cacheKey ? (cacheMode === "refresh" ? "REFRESH" : "MISS") : null, responseJson: clientTxt });
            return new Response(clientTxt, { status: up.status, headers: hdrs });
          }
          circuitRecord(route.provider_name, true);
          blog("TRACE id=" + requestId + " stream provider=" + route.provider_name + " model=" + liveSlug + " key=" + k.label + " rank=" + route.rank);
          traj.steps.push({ ...baseStep, http: up.status, ok: true, key: k.label, ms: Date.now() - stepStart, streaming: true });
          const horizonHdrs = { "x-gateway-model": liveSlug };
          if (autoDecision && autoDecision.horizon)
            horizonHdrs["x-gateway-horizon"] = String(autoDecision.horizon.speed || "") + "/" + String(autoDecision.horizon.role || "");
          const result = await handleStream(c, up, key, liveSlug, route, requestId, payload, started, res.usage, { traj: { ...traj, slug: liveSlug }, attempts: attempts + 1, cacheKey, cacheTtlSeconds: cacheTtlSeconds(c), gatewayHeaders: horizonHdrs });
          return result;
        } catch (e) {
          // Zai-web failures carry an actionable status and code (missing
          // session, stale captcha, unsupported tools). Return them as-is —
          // collapsing them into a 503 "no healthy route" would hide the fix.
          // Client-side (4xx) faults skip the circuit breaker: the provider is
          // healthy, the request was not.
          if (e instanceof ZaiWebError) {
            if (e.status >= 500)
              circuitRecord(route.provider_name, false);
            const safeMessage = sanitizeUpstreamResponse(e.message);
            blog("FWD ZAI " + route.provider_name + " -> " + e.status + " " + e.code + " " + e.message);
            traj.steps.push({ ...baseStep, error: e.code, key: k.label, http: e.status, ms: Date.now() - stepStart });
            if (e.status < 500) {
              await recordTrajectory(c, { ...traj, status: "fail", httpStatus: e.status, provider: route.provider_name, rank: route.rank, attempts: attempts + 1, latencyMs: Date.now() - started, error: e.code + ": " + e.message });
              return c.json({ error: { message: safeMessage, type: "upstream_error", code: e.code } }, e.status, { "x-gateway-attempts": String(attempts + 1) });
            }
            lastErr = "provider " + route.provider_name + " -> " + e.code;
            lastErrStatus = e.status;
            attempts++;
            continue;
          }
          circuitRecord(route.provider_name, false);
          blog("FWD CATCH " + route.provider_name + " key=" + k.label + " -> " + String(e && e.message || e));
          lastErr = "provider " + route.provider_name + " -> " + String(e.message || e) + " [" + transportLabel(routeTransport(route, c.env)) + "]";
          if (e && e.status)
            lastErrStatus = e.status;
          traj.steps.push({ ...baseStep, error: String(e.message || e).slice(0, 300), key: k.label, ms: Date.now() - stepStart });
          attempts++;
          if (isRetryableTransportError(e) && !k._retriedOnce) {
            k._retriedOnce = true;
            blog("FWD RETRY " + route.provider_name + " key=" + k.label + " pre-header transport error");
            continue;
          }
        }
      }
    }
    blog("TRACE id=" + requestId + " fail attempts=" + attempts + " ms=" + (Date.now() - started) + " err=" + String(lastErr || "no routes"));
    const finalStatus = lastErrStatus || 503;
    await recordTrajectory(c, { ...traj, status: "fail", httpStatus: finalStatus, attempts, latencyMs: Date.now() - started, cacheState: cacheKey ? "MISS" : null, error: lastErr || "no healthy route succeeded" });
    const errBody = lastErrStatus === 504
      ? { error: { message: "The selected model did not respond in time. Please retry.", type: "upstream_error", code: "upstream_timeout" } }
      : genericUpstreamError();
    return c.json(errBody, finalStatus, { "x-gateway-attempts": String(attempts || routes.results.length) });
  } finally {
    await releaseResponseCacheLease(c, cacheKey, cacheLeaseId);
  }
}
async function forwardToProvider(c, route, apiKey, payload, isStream, requestId) {
  const fmt2 = (route.fmt || "openai").toLowerCase();
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
  const ms = Number(c && c.env && c.env.UPSTREAM_TIMEOUT_MS) || UPSTREAM_TIMEOUT_MS;
  let timer = null;
  const clear = () => { if (timer) clearTimeout(timer); };
  try {
    const p = fetch(url, { ...init, signal: ctrl.signal });
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
        if (frame.type === "response_end")
          break;
        if (frame.type === "error")
          throw new Error("koyeb relay: " + String(frame.code || "error") + ": " + String(frame.message || "unknown"));
        continue;
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
    let body = null;
    if (!opts.isStream) {
      body = new Uint8Array(received);
      let at = 0;
      for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.length;
      }
    }
    return { status, headers: respHeaders, stream, bytes: body, connectMs, ttfbMs: firstByteAt ? firstByteAt - t0 : 0 };
  } catch (e) {
    try {
      ws.close();
    } catch {
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
            const chunk = fromAnthropicStreamChunk(obj, model);
            if (!chunk)
              continue;
            if (chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason)
              finishSeen = true;
            controller.enqueue(enc.encode("data: " + JSON.stringify(chunk) + "\n\n"));
          }
        }
        // Anthropic upstreams sometimes end with message_stop but no
        // message_delta carrying a stop_reason — OpenAI clients hard-fail with
        // "stream closed before a finish_reason". Synthesize the terminal stop.
        if (!finishSeen) {
          const finishChunk = {
            id: "gen-anthropic",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
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
  let lastUsage = usageHint || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
  let malformedSseSent = false;
  let contentBuf = "";
  let reasoningBuf = "";
  let toolCallsBuf = [];
  const keepAlive = ((promise) => {
    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === "function")
      ctx.waitUntil(promise);
  });
  const persistOnce = (async () => {
    const costUsd = await computeCost(c, slug, lastUsage);
    await recordUsage(c, key, { ...lastUsage, cost_usd: costUsd });
    await recordModelUsage(c, slug, lastUsage.total_tokens, costUsd);
    if (extra && extra.traj) {
      const msg = {
        role: "assistant",
        content: contentBuf || null,
        ...(reasoningBuf ? { reasoning_content: reasoningBuf } : {}),
        ...(toolCallsBuf.length ? { tool_calls: toolCallsBuf } : {})
      };
      await recordTrajectory(c, {
        ...extra.traj,
        status: streamError ? "fail" : "ok",
        httpStatus: streamError ? 500 : 200,
        provider: route.provider_name,
        rank: route.rank,
        attempts: extra.attempts || 1,
        promptTokens: lastUsage.prompt_tokens,
        completionTokens: lastUsage.completion_tokens,
        totalTokens: lastUsage.total_tokens,
        costUsd,
        latencyMs: Date.now() - started,
        error: streamError || null,
        responseJson: (contentBuf || reasoningBuf || toolCallsBuf.length) ? JSON.stringify({ choices: [{ message: msg }], usage: lastUsage }) : null
      });
      if (!streamError && extra.cacheKey && (contentBuf || toolCallsBuf.length)) {
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
  const pump = (async () => {
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
          try {
            const obj = JSON.parse(data);
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
              if (typeof dc.content === "string" && contentBuf.length < TRAJ_BODY_CAP)
                contentBuf += dc.content;
              const rc = dc.reasoning_content ?? dc.reasoning ?? dc.thinking;
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
          const finishReason = normalizeTerminalFinishReason(
            null,
            hasAccumulatedToolCalls(toolCallsBuf),
            !!(contentBuf || reasoningBuf)
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
        limit: model && model.limit || null
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
// Circuit-breaker: three provider failures within a minute opens the
// circuit for 60s; the auto router and route loop skip open providers.
var circuitState = new Map();
function circuitOpen(providerName) {
  const s = circuitState.get(providerName);
  return !!(s && s.openUntil && Date.now() < s.openUntil);
}
function circuitRecord(providerName, ok) {
  const now = Date.now();
  const s = circuitState.get(providerName) || { fails: 0, firstFail: 0, openUntil: 0 };
  if (ok) {
    s.fails = 0;
    s.openUntil = 0;
  } else {
    if (now - s.firstFail > 60000)
      s.firstFail = now;
    s.fails++;
    if (s.fails >= 3)
      s.openUntil = now + 60000;
  }
  circuitState.set(providerName, s);
}
var AUTO_SLUG = "auto";
var routerHealthCache = { at: 0, rows: [] };
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
       FROM (SELECT slug, status, latency_ms, created_at FROM trajectories WHERE created_at >= ?)
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
            COALESCE((SELECT MAX(p2.healthy) FROM model_routes mr2 JOIN providers p2 ON p2.id=mr2.provider_id WHERE mr2.slug=mr.slug AND mr2.enabled=1 AND p2.enabled=1),0) AS healthy,
            (SELECT GROUP_CONCAT(p3.name) FROM model_routes mr3 JOIN providers p3 ON p3.id=mr3.provider_id WHERE mr3.slug=mr.slug AND mr3.enabled=1 AND p3.enabled=1) AS providers
     FROM model_routes mr WHERE mr.enabled=1 GROUP BY mr.slug`
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
     WHERE mr.enabled=1 AND p.enabled=1 GROUP BY mr.slug`
  ).all();
  const overlay = new Map();
  for (const r of routes2.results || []) {
    if (!isZaiWebFormat(r.fmt))
      continue;
    const local = modelCatalogEntry(r.upstream_model);
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
  let need = Math.min(6, 1 + Math.max(0, score) / 2.2);
  const hasTools = !!(payload.tools || payload.functions);
  if (hasTools)
    need = Math.min(6, Math.max(need, 2.6));
  if (reqImages)
    need = Math.min(6, Math.max(need, 2.4));
  const candidates = [];
  for (const r of enabled) {
    const entry = overlay.get(r.slug) || (byId ? matchModelsDevPrice(byId, r.slug) : null);
    const mult = Number(cfg.overrides[r.slug]);
    let q = qualityPrior(entry, r.slug);
    if (Number.isFinite(mult) && mult > 0)
      q *= Math.min(3, mult);
    const caps = entryCapabilities(entry);
    const ctxOk = caps.unknown ? reqTokens < 32000 : (!caps.context || reqTokens <= Math.floor(caps.context * 0.9));
    const ctxTight = !!(caps.context && reqTokens > caps.context * 0.55);
    const visionOk = reqImages === 0 || (!caps.unknown && caps.vision);
    const toolsOk = !hasTools || caps.tools || caps.unknown;
    const capable = ctxOk && visionOk && toolsOk;
    // Provider circuits are keyed by provider name; the router works per slug.
    const provNames = String(r.providers || "").split(",").map((s) => s.trim()).filter(Boolean);
    let openCount = 0;
    let wob = 0;
    for (const name of provNames) {
      if (circuitOpen(name))
        openCount++;
      else {
        const cs = circuitState.get(name);
        if (cs && cs.fails > 0)
          wob = Math.max(wob, cs.fails >= 2 ? 1.2 : 0.5);
      }
    }
    const allOpen = provNames.length > 0 && openCount >= provNames.length;
    const h = healthBySlug.get(r.slug);
    const okRate = h ? Number(h.ok_rate) : 1;
    // Eligible if capable and not a known-bad integrity slug. Quality floor
    // is a soft skip (q + 0.8 >= need) so a 3.2 GLM-5 still takes need=3.6
    // agent work instead of falling through to Astra.
    const eligible = capable && !allOpen && q + 0.8 >= need && !(h && Number(h.n) >= 5 && okRate < 0.5);
    const rawCost = entry ? Number(entry.prompt_per_1m) + Number(entry.completion_per_1m) : 0.5;
    const cost = Number.isFinite(rawCost) ? rawCost : 0.5;
    const rawMs = h ? Number(h.avg_ms) : 0;
    candidates.push({ slug: r.slug, cost, quality: q, okRate, avgMs: Number.isFinite(rawMs) ? rawMs : 0, eligible, samples: h ? Number(h.n) : 0, capable, ctxOk, visionOk, toolsOk, wob, ctxTight, context: caps.context || 0, output: caps.output || 0, unknown: !!caps.unknown, luxury: isLuxuryFlagship(r.slug), workhorse: isWorkhorse(r.slug), tiny: isTinySlug(r.slug) });
  }
  const workhorseEligible = candidates.filter((x) => x.eligible && x.workhorse);
  const strongWork = workhorseEligible.filter((x) => !x.tiny);
  const eligibleList = (need >= 2.5 && strongWork.length) ? strongWork : (workhorseEligible.length ? workhorseEligible : candidates.filter((x) => x.eligible));
  let picked;
  if (!eligibleList.length) {
    const poolBase = candidates.some((x) => x.capable) ? candidates.filter((x) => x.capable) : candidates;
    const poolWork = poolBase.filter((x) => x.workhorse);
    const pool = poolWork.length ? poolWork : poolBase;
    let best = null;
    for (const cand of pool) {
      if (!best || cand.quality > best.quality || cand.quality === best.quality && cand.cost < best.cost)
        best = cand;
    }
    picked = best ? { ...best, fallback: true } : null;
  } else if (need <= 2.1) {
    let best = null;
    for (const cand of eligibleList) {
      if (!best || cand.cost < best.cost || cand.cost === best.cost && cand.quality > best.quality)
        best = cand;
    }
    picked = best;
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
      const s = (1 - w) * cand.quality - w * costTerm - relPenalty - slowPenalty - wobbling - overkill - tight;
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
  const slug = (horizon && horizon.slug) || picked.slug;
  const chosen = candidates.find((x) => x.slug === slug) || picked;
  return { ...chosen, candidates, need, complexity: score, preference: cfg.preference, estInputTokens: reqTokens, images: reqImages, context: chosen.context || picked.context || 0, output: chosen.output || picked.output || 0, horizon, queue: (horizon && horizon.queue) || [] };
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
async function computeCost(c, slug, usage) {
  const pt = Number(usage && usage.cost_usd) || 0;
  if (pt > 0)
    return pt;
  if (!slug)
    return 0;
  try {
    const row = await c.env.DB.prepare("SELECT prompt_per_1m, completion_per_1m FROM prices WHERE slug=?").bind(slug).first();
    if (row) {
      const p = Number(row.prompt_per_1m) || 0;
      const ct = Number(row.completion_per_1m) || 0;
      return (Number(usage && usage.prompt_tokens) || 0) / 1e6 * p + (Number(usage && usage.completion_tokens) || 0) / 1e6 * ct;
    }
  } catch {
  }
  // Fallback: the models.dev catalog if it is already loaded in memory. Never
  // block a completion on a live fetch; a background refresh keeps it warm.
  const catalog = modelsDevCache.catalog;
  if (!catalog) {
    fetchModelsDevCatalog().catch((e) => blog("MODELS_DEV warm failed: " + String(e.message || e)));
    return 0;
  }
  const hit = matchModelsDevPrice(flattenModelsDevCatalog(catalog), slug);
  if (hit)
    return (Number(usage && usage.prompt_tokens) || 0) / 1e6 * hit.prompt_per_1m + (Number(usage && usage.completion_tokens) || 0) / 1e6 * hit.completion_per_1m;
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
async function recordUsage(c, key, usage) {
  if (!key || !key.key_id)
    return;
  await c.env.DB.prepare(
    "UPDATE api_keys SET used_tokens=used_tokens+?, used_usd=used_usd+?, request_count=request_count+1, updated_at=? WHERE key_id=?"
  ).bind(usage.total_tokens, usage.cost_usd || 0, nowIso(), key.key_id).run();
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
    `SELECT k.key_id, k.name, k.budget_mode, k.budget_limit, k.used_tokens, k.used_usd, k.request_count, k.request_limit_per_minute, k.expires_at, k.active, k.allowed_models, k.excluded_models, k.created_at, k.updated_at,
      COALESCE((SELECT GROUP_CONCAT(akmt.tier_id, ',') FROM api_key_model_tiers akmt WHERE akmt.key_id=k.key_id), '') AS tier_ids,
      COALESCE((SELECT GROUP_CONCAT(mt.name, ' \xB7 ') FROM api_key_model_tiers akmt JOIN model_tiers mt ON mt.id=akmt.tier_id WHERE akmt.key_id=k.key_id), '') AS tier_names
     FROM api_keys k ORDER BY k.created_at DESC`
  ).all();
  return c.json({ keys: rows.results || [] });
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
  await c.env.DB.prepare("DELETE FROM api_key_model_tiers WHERE key_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM api_keys WHERE key_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM response_cache WHERE key_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM api_key_rate_windows WHERE key_id=?").bind(id).run();
  return c.json({ deleted: id });
});
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
    label: "Z.AI web chat — automatic (no browser)",
    summary: "Pure HTTP: the gateway mints the Aliyun captcha proof itself from a harvested device-token file. No browser, no packages. Needs the session token plus data/zai-device-tokens.txt.",
    fmt: "zaiminted",
    name: "Z.AI web chat (minted)",
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
    label: "Z.AI web chat — automatic (browser)",
    summary: "Drives chat.z.ai in a local Chromium so the page solves its own CAPTCHA. No token file, but needs Chromium and playwright installed on the host.",
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
    summary: "Consumer GLM-5.3 session. Needs the token from chat.z.ai Local Storage plus a captcha_verify_param; no tools.",
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
  const provider = await c.env.DB.prepare("SELECT id, name, fmt FROM providers WHERE id=?").bind(id).first();
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
    return c.json({
      ok: status >= 200 && status < 400,
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
  const transport = routeTransport(route, c.env);
  const merged = withExtraHeaders(headers, route);
  if (transport === "oci" && route.proxy_url)
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
async function runIntegrityProbe(c, provider, route, key, options) {
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
  const existing = await c.env.DB.prepare("SELECT COALESCE(MAX(rank),-1)+1 AS next FROM model_routes WHERE slug=?").bind(b.slug).first();
  const rank = b.rank != null ? Number(b.rank) : existing.next;
  await c.env.DB.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,?,?)").bind(b.slug, Number(b.provider_id), b.upstream_model, rank, b.enabled === false ? 0 : 1).run();
  return c.json({ ok: true, slug: b.slug, rank }, 201);
});
app.get("/admin/routes", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare(
    `SELECT mr.id, mr.slug, mr.provider_id, mr.upstream_model, mr.rank, mr.enabled,
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
  for (const f of ["slug", "provider_id", "upstream_model", "rank"]) {
    if (b[f] !== void 0) {
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
app.get("/admin/trajectories", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
  const slug = String(c.req.query("slug") || "").trim();
  const status = String(c.req.query("status") || "").trim();
  let sql = "SELECT id, created_at, key_name, slug, stream, cache_state, status, http_status, provider, rank, attempts, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, error FROM trajectories";
  const conds = [];
  const binds = [];
  if (slug) { conds.push("slug=?"); binds.push(slug); }
  if (status === "ok" || status === "fail") { conds.push("status=?"); binds.push(status); }
  if (conds.length) sql += " WHERE " + conds.join(" AND ");
  sql += " ORDER BY created_at DESC LIMIT ?";
  binds.push(limit);
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  const agg = await c.env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_count, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost FROM trajectories").first();
  return c.json({ trajectories: rows.results || [], stats: agg || { total: 0, ok_count: 0, tokens: 0, cost: 0 } });
});
app.get("/admin/trajectories-export", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const format = String(c.req.query("format") || "openai");
  if (!["openai", "sharegpt", "trl", "rl"].includes(format))
    return c.json({ error: { message: "format must be one of openai, sharegpt, trl, rl" } }, 400);
  const slugFilter = String(c.req.query("slug") || "").trim();
  let sql = "SELECT slug, stream, status, provider, attempts, steps_json, request_json, response_json, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, created_at FROM trajectories WHERE status='ok' AND request_json IS NOT NULL AND response_json IS NOT NULL";
  const binds = [];
  if (slugFilter) {
    sql += " AND slug=?";
    binds.push(slugFilter);
  }
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
    }
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
  const rows = await c.env.DB.prepare("SELECT slug, prompt_per_1m, completion_per_1m, currency, updated_at FROM prices ORDER BY slug").all();
  return c.json({ prices: rows.results || [] });
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
  await c.env.DB.prepare("INSERT INTO prices (slug, prompt_per_1m, completion_per_1m, currency, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET prompt_per_1m=excluded.prompt_per_1m, completion_per_1m=excluded.completion_per_1m, currency=excluded.currency, updated_at=excluded.updated_at").bind(b.slug, p, ct, b.currency || "USD", nowIso()).run();
  return c.json({ ok: true, slug: b.slug, prompt_per_1m: p, completion_per_1m: ct });
});
app.delete("/admin/prices/:slug", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const slug = decodeURIComponent(c.req.param("slug"));
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
export const __test = { sanitizeClientResponse, safeSseData, sealProviderKey, openProviderKey, stableJson, isCacheableRequest, responseCacheKey, isCacheableResponse, normalizeRequestLimit, normalizeKeyExpiry, isKeyExpired, splitModelSlugs, effectiveModelSlugs, cacheCoalesceDelayMs, classifyUpstreamFailure, isGenericUpstreamErrorResponse, routeTransport, normalizeTransport, transportLabel, koyebCfg, flattenModelsDevCatalog, matchModelsDevPrice, qualityPrior, promptComplexity, analyzeRequest, entryCapabilities, pickAutoModel, normalizeProviderFormat, routerHealth, isLuxuryFlagship, isWorkhorse, buildWorldModel, compactMessages, applyAutoHarness, planHorizon, renderHorizonState, usableContextWindow, isRetryableTransportError, sseUpstreamDisconnect, sanitizeUpstreamResponse, genericUpstreamError };
export function createApp(env) {
  if (!env) return app;
  return { fetch: (req, ctx) => app.fetch(req, env, ctx) };
}
