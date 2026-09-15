import { LOGIN_HTML } from "./login.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { PLAYGROUND_HTML } from "./playground.js";
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
  allowHeaders: ["Content-Type", "Authorization", "x-api-key", "x-request-id", "x-gateway-cache", "x-gateway-cache-ttl"],
  exposeHeaders: ["x-request-id", "x-gateway-cache", "x-gateway-used-usd", "x-gateway-used-tokens", "x-gateway-route", "x-gateway-attempts"]
}));
var encoder = new TextEncoder();
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
function isCacheableRequest(payload, isStream, mode) {
  if (mode !== "true" && mode !== "refresh")
    return false;
  if (isStream || !payload)
    return false;
  if (payload.temperature != null && Number(payload.temperature) !== 0)
    return false;
  if (payload.tools || payload.functions || payload.tool_choice || payload.parallel_tool_calls)
    return false;
  return true;
}
async function responseCacheKey(key, slug, payload) {
  const normalized = { ...payload, stream: false };
  return "rc:v1:" + await sha256hex(String(key.key_id) + "\n" + String(slug) + "\n" + stableJson(normalized));
}
function isCacheableResponse(text) {
  try {
    const body = JSON.parse(text);
    return !!(body && typeof body === "object" && !body.error && Array.isArray(body.choices));
  } catch {
    return false;
  }
}
async function serveCachedCompletion(c, { cached, key, slug, payload, started, state }) {
  const hdrs = clientResponseHeaders(new Headers({ "content-type": "application/json; charset=utf-8" }), false);
  hdrs["x-gateway-cache"] = state || "HIT";
  return new Response(cached.response_body, { status: 200, headers: hdrs });
}
function cacheTtlSeconds(c) {
  const requested = Number(c.req.header("x-gateway-cache-ttl") || 3600);
  return Number.isFinite(requested) ? Math.max(60, Math.min(86400, Math.floor(requested))) : 3600;
}
function cacheExpiry(ttl) {
  return new Date(Date.now() + ttl * 1e3).toISOString().replace(".000", "");
}
var RESPONSE_CACHE_LEASE_MS = 2e4;
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
async function providerKey(c, id) {
  try {
    const row = await c.env.DB.prepare("SELECT api_key FROM providers WHERE id=?").bind(id).first();
    if (row && row.api_key) {
      const stored = String(row.api_key);
      if (stored.startsWith("enc:v1:")) {
        try {
          return await openProviderKey(c.env, stored);
        } catch (e) {
          if (!c.env.PROVIDER_CRYPTO_KEY || !c.env.ADMIN_TOKEN) {
            console.log("PROVIDER_KEY decrypt failed id=" + id + ": " + String(e.message || e));
            throw e;
          }
          const legacyPlain = await openProviderKey(c.env, stored, true);
          await c.env.DB.prepare("UPDATE providers SET api_key=?, updated_at=? WHERE id=?").bind(await sealProviderKey(c.env, legacyPlain), nowIso(), id).run();
          console.log("PROVIDER_KEY re-encrypted id=" + id);
          return legacyPlain;
        }
      }
      const sealed = await sealProviderKey(c.env, stored);
      await c.env.DB.prepare("UPDATE providers SET api_key=?, updated_at=? WHERE id=?").bind(sealed, nowIso(), id).run();
      console.log("PROVIDER_KEY migrated id=" + id);
      return stored;
    }
  } catch (e) {
    console.log("PROVIDER_KEY unavailable id=" + id + ": " + String(e.message || e));
    return null;
  }
  return null;
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
  const routes = await c.env.DB.prepare(
    "SELECT DISTINCT slug FROM model_routes WHERE enabled=1 AND slug IN (" + allowed.map(() => "?").join(",") + ") ORDER BY slug"
  ).bind(...allowed).all();
  const data = (routes.results || []).map((r) => ({
    id: r.slug,
    object: "model",
    created: 0,
    owned_by: "gateway"
  }));
  return c.json({ object: "list", data });
});
app.get("/status", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const provs = await c.env.DB.prepare("SELECT * FROM providers ORDER BY priority").all();
  const status = [];
  for (const p of provs.results || []) {
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
    status.push({
      id: p.id,
      name: p.name,
      base_url: p.base_url,
      priority: p.priority,
      fmt: p.fmt,
      healthy_flag: !!p.healthy,
      last_status: code,
      ok,
      error: err
    });
  }
  const routes = await c.env.DB.prepare(
    "SELECT mr.slug, mr.rank, mr.upstream_model, mr.enabled, p.name AS provider, p.healthy FROM model_routes mr JOIN providers p ON p.id=mr.provider_id ORDER BY mr.slug, mr.rank"
  ).all();
  return c.json({ providers: status, routes: routes.results || [] });
});
app.post("/v1/chat/completions", async (c) => {
  const auth = await authClient(c);
  if (auth instanceof Response)
    return auth;
  return runChatCompletion(c, auth.key, false);
});
app.post("/admin/playground/completions", async (c) => {
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
  const slug = payload.model;
  if (!slug)
    return c.json({ error: { message: "model is required" } }, 400);
  if (!isAdminPlayground && !await slugAllowed(c, key, slug)) {
    return c.json({ error: { message: 'Model "' + slug + '" is not enabled for this key', type: "model_not_allowed" } }, 403);
  }
  const routes = await c.env.DB.prepare(
    "SELECT mr.*, p.base_url, p.name AS provider_name, p.healthy, p.fmt, p.proxy_url, p.transport, p.extra_headers FROM model_routes mr JOIN providers p ON p.id=mr.provider_id WHERE mr.slug=? AND mr.enabled=1 AND p.healthy=1 ORDER BY mr.rank"
  ).bind(slug).all();
  if (!routes.results || !routes.results.length) {
    return c.json({ error: { message: 'No healthy route for model "' + slug + '"', type: "no_route" } }, 503);
  }
  const requestId = c.req.header("x-request-id") || uuid();
  const started = Date.now();
  const isStream = !!payload.stream;
  const cacheModeHeader = String(c.req.header("x-gateway-cache") || "true").toLowerCase();
  const cacheMode = (cacheModeHeader === "off" || cacheModeHeader === "false" || cacheModeHeader === "0") ? "off" : cacheModeHeader;
  const cacheable = !!key && isCacheableRequest(payload, isStream, cacheMode);
  const cacheKey = cacheable ? await responseCacheKey(key, slug, payload) : null;
  console.log("REQ id=" + requestId + " model=" + slug + " stream=" + isStream + " cache=" + cacheMode + (cacheKey ? "" : "-skip") + " key=" + (key ? key.name : "admin-playground"));
  if (cacheKey && cacheMode !== "refresh") {
    const cached = await lookupResponseCache(c, cacheKey);
    if (cached) {
      console.log("TRACE id=" + requestId + " cache=HIT ms=" + (Date.now() - started));
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
        console.log("TRACE id=" + requestId + " cache=COALESCED ms=" + (Date.now() - started));
        return serveCachedCompletion(c, { cached, key, slug, payload, started, state: "COALESCED" });
      }
    }
  }
  if (isStream)
    payload.stream_options = { ...payload.stream_options || {}, include_usage: true };
  try {
    let lastErr = null;
    let attempts = 0;
    for (const route of routes.results) {
      const key2 = await providerKey(c, route.provider_id);
      if (!key2) {
        lastErr = "provider " + route.provider_name + " has no key";
        attempts++;
        continue;
      }
      try {
        const res = await forwardToProvider(c, route, key2, payload, isStream, requestId);
        const up = res.response;
        await c.env.DB.prepare("UPDATE providers SET last_status=?, last_checked=? WHERE id=?").bind(up.status, nowIso(), route.provider_id).run();
        if (!up.ok || !up.body) {
          const txt = await up.text();
          console.log("FWD FAIL " + route.provider_name + " -> HTTP " + up.status + " [" + classifyUpstreamFailure(txt) + "] " + String(txt).slice(0, 300));
          attempts++;
          continue;
        }
        if (!isStream) {
          const txt = await up.text();
          const usage = res.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
          const costUsd = await computeCost(c, slug, usage);
          const clientTxt = sanitizeClientResponse(txt, slug);
          if (isGenericUpstreamErrorResponse(clientTxt)) {
            console.log("FWD MALFORMED " + route.provider_name + " -> " + String(txt).slice(0, 300));
            lastErr = "provider " + route.provider_name + " -> malformed upstream completion envelope";
            attempts++;
            continue;
          }
          await recordUsage(c, key, { ...usage, cost_usd: costUsd });
          if (cacheKey && isCacheableResponse(clientTxt)) {
            await storeResponseCache(c, {
              cacheKey,
              keyId: key.key_id,
              slug,
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
          if (cacheKey)
            hdrs["x-gateway-cache"] = cacheMode === "refresh" ? "REFRESH" : "MISS";
          console.log("TRACE id=" + requestId + " ok provider=" + route.provider_name + " rank=" + route.rank + " status=" + up.status + " ms=" + (Date.now() - started) + " tokens=" + usage.total_tokens + " cost=" + costUsd);
          return new Response(clientTxt, { status: up.status, headers: hdrs });
        }
        console.log("TRACE id=" + requestId + " stream provider=" + route.provider_name + " rank=" + route.rank);
        const result = await handleStream(c, up, key, slug, route, requestId, payload, started, res.usage);
        return result;
      } catch (e) {
        console.log("FWD CATCH " + route.provider_name + " -> " + String(e && e.stack || e.message || e));
        lastErr = "provider " + route.provider_name + " -> " + String(e.message || e) + " [" + transportLabel(routeTransport(route, c.env)) + "]";
        attempts++;
      }
    }
    console.log("TRACE id=" + requestId + " fail attempts=" + attempts + " ms=" + (Date.now() - started) + " err=" + String(lastErr || "no routes"));
    const errBody = lastErr
      ? { error: { message: lastErr, type: "upstream_error" } }
      : genericUpstreamError();
    return c.json(errBody, 503, { "x-gateway-attempts": String(attempts || routes.results.length) });
  } finally {
    await releaseResponseCacheLease(c, cacheKey, cacheLeaseId);
  }
}
async function forwardToProvider(c, route, apiKey, payload, isStream, requestId) {
  const fmt2 = (route.fmt || "openai").toLowerCase();
  const transport = routeTransport(route, c.env);
  if (transport === "oci" && route.proxy_url) {
    console.log("FWD proxy_url present len=" + route.proxy_url.length);
    const reqBody = JSON.stringify({ ...payload, model: route.upstream_model });
    const target = fmt2 === "anthropic" ? route.base_url + "/messages" : route.base_url + "/chat/completions";
    const headers = withExtraHeaders(fmt2 === "anthropic" ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION } : { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, route);
    return fetchViaProxy(route.proxy_url, target, "POST", headers, reqBody);
  }
  if (transport === "koyeb") {
    console.log("FWD koyeb provider=" + route.provider_name);
    return fetchViaKoyeb(c, route, apiKey, payload, isStream, requestId);
  }
  console.log("FWD DIRECT; route keys=" + Object.keys(route).join(",") + " proxy_url=" + route.proxy_url);
  if (fmt2 === "anthropic")
    return forwardAnthropic(c, route, apiKey, payload);
  return forwardOpenAI(c, route, apiKey, payload);
}
var PROXY_TIMEOUT_MS = 20000;
async function fetchViaProxy(proxyUrl, targetUrl, method, headers, body) {
  const sep = proxyUrl.includes("?") ? "&" : "?";
  const fwd = proxyUrl + sep + "url=" + encodeURIComponent(targetUrl);
  const fwdHeaders = { ...headers };
  delete fwdHeaders["host"];
  delete fwdHeaders["content-length"];
  delete fwdHeaders["connection"];
  delete fwdHeaders["transfer-encoding"];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
  try {
    const r = await fetch(fwd, {
      method: method || "POST",
      headers: fwdHeaders,
      body: body || void 0,
      signal: ctrl.signal
    });
    let usage = null;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      try {
        const txt = await r.clone().text();
        const p = JSON.parse(txt);
        if (p && p.usage)
          usage = usageFrom(p);
      } catch {
      }
    }
    return { response: r, usage };
  } catch (e) {
    if (e && e.name === "AbortError")
      throw new Error("proxy timeout after " + PROXY_TIMEOUT_MS + "ms");
    throw e;
  } finally {
    clearTimeout(timer);
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
    out.push(b);
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
  const up = await fetch(route.base_url + "/chat/completions", {
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
    return {
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { role: "assistant" } }]
    };
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
  const up = await fetch(route.base_url + "/messages", {
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
            if (chunk)
              controller.enqueue(enc.encode("data: " + JSON.stringify(chunk) + "\n\n"));
          }
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        try {
          controller.error(e);
        } catch {
        }
      }
    }
  }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}
async function handleStream(c, upReq, key, slug, route, requestId, payload, started, usageHint) {
  const reader = upReq.body.getReader();
  const dec = new TextDecoder();
  const enc = encoder;
  let controllerRef = null;
  let clientCancelled = false;
  let buf = "";
  let streamError = null;
  let lastUsage = usageHint || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
  let malformedSseSent = false;
  const keepAlive = ((promise) => {
    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === "function")
      ctx.waitUntil(promise);
  });
  const persistOnce = (async () => {
    const costUsd = await computeCost(c, slug, lastUsage);
    await recordUsage(c, key, { ...lastUsage, cost_usd: costUsd });
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
        safeEnqueue("data: [DONE]\n\n");
        try {
          controllerRef.close();
        } catch {
        }
      }
    } catch (e) {
      streamError = String(e && e.message || e).slice(0, 4e3);
      console.log("Stream error id=" + requestId + " " + streamError);
      if (!clientCancelled) {
        try {
          controllerRef.error(e);
        } catch {
        }
      }
    } finally {
      await persistOnce();
    }
  });
  const reader2 = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      const work = pump();
      keepAlive(work.catch((e) => console.log("Stream background error=" + String(e && e.message || e))));
    },
    cancel(reason) {
      clientCancelled = true;
      console.log("Stream client cancelled id=" + requestId + " reason=" + String(reason || "unknown").slice(0, 160));
    }
  });
  const hdrs = clientResponseHeaders(upReq.headers, true);
  hdrs["content-type"] = "text/event-stream; charset=utf-8";
  hdrs["cache-control"] = "no-cache, no-store";
  hdrs["connection"] = "keep-alive";
  hdrs["x-request-id"] = requestId;
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
        completion_per_1m: Number.isFinite(output) ? output : 0
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
  const bare = want.includes("/") ? want.slice(want.lastIndexOf("/") + 1) : want;
  if (bare && byId.has(bare))
    return byId.get(bare);
  const bareLower = bare.toLowerCase();
  for (const [id, entry] of byId) {
    if (id.toLowerCase() === bareLower || id.toLowerCase().endsWith("/" + bareLower))
      return entry;
  }
  return null;
}
var MODELS_DEV_CACHE_MS = 3600000;
var modelsDevCache = { at: 0, catalog: null };
async function fetchModelsDevCatalog() {
  const now = Date.now();
  if (modelsDevCache.catalog && now - modelsDevCache.at < MODELS_DEV_CACHE_MS)
    return modelsDevCache.catalog;
  const r = await fetch(MODELS_DEV_API, { headers: { accept: "application/json" } });
  if (!r.ok)
    throw new Error("models.dev HTTP " + r.status);
  const catalog = await r.json();
  modelsDevCache = { at: now, catalog };
  return catalog;
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
  try {
    const catalog = await fetchModelsDevCatalog();
    const hit = matchModelsDevPrice(flattenModelsDevCatalog(catalog), slug);
    if (hit)
      return (Number(usage && usage.prompt_tokens) || 0) / 1e6 * hit.prompt_per_1m + (Number(usage && usage.completion_tokens) || 0) / 1e6 * hit.completion_per_1m;
  } catch (e) {
    console.log("MODELS_DEV cost lookup failed: " + String(e.message || e));
  }
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
    console.log("RESPONSE_CACHE lookup unavailable");
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
    console.log("RESPONSE_CACHE store unavailable");
  }
}
async function recordUsage(c, key, usage) {
  if (!key || !key.key_id)
    return;
  await c.env.DB.prepare(
    "UPDATE api_keys SET used_tokens=used_tokens+?, used_usd=used_usd+?, request_count=request_count+1, updated_at=? WHERE key_id=?"
  ).bind(usage.total_tokens, usage.cost_usd || 0, nowIso(), key.key_id).run();
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
  s = s.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]");
  s = s.replace(/\b[a-z0-9.-]+\.(?:ai|top|cn|cc|site|top)\b/gi, "[redacted-provider]");
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
  const rows = await c.env.DB.prepare("SELECT id, name, base_url, priority, healthy, last_status, last_checked, notes, fmt, proxy_url, transport, extra_headers, (api_key IS NOT NULL AND api_key <> '') AS api_key_set FROM providers ORDER BY priority").all();
  return c.json({ providers: rows.results || [] });
});
app.get("/admin/proxy-health", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare("SELECT id, name, base_url, proxy_url, transport FROM providers").all();
  const out = [];
  const koyebHealthUrl = String(c.env.KOYEB_RELAY_URL || "").replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").replace(/\/tunnel\/?$/, "/healthz");
  for (const p of rows.results || []) {
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
  if (!b.name || !b.base_url)
    return c.json({ error: { message: "name + base_url required" } }, 400);
  const fmt2 = b.fmt === "anthropic" ? "anthropic" : "openai";
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
  const info = await c.env.DB.prepare("INSERT INTO providers (name, base_url, priority, healthy, notes, fmt, proxy_url, transport, extra_headers, api_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id").bind(b.name, b.base_url, Number(b.priority) || 0, b.healthy === false ? 0 : 1, b.notes || null, fmt2, b.proxy_url || null, transport, extraHeaders, sealedKey, nowIso()).all();
  const pid = info.results && info.results[0] && info.results[0].id;
  return c.json({ id: pid, name: b.name, fmt: fmt2, proxy_url: b.proxy_url || null, transport, api_key_set: !!b.api_key }, 201);
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
  for (const f of ["name", "base_url", "notes", "fmt", "proxy_url", "api_key"]) {
    if (b[f] === void 0)
      continue;
    if (f === "api_key") {
      if (!b.api_key)
        continue;
      sets.push("api_key=?");
      binds.push(await sealProviderKey(c.env, String(b.api_key)));
      continue;
    }
    sets.push(f + "=?");
    binds.push(f === "fmt" ? b.fmt === "anthropic" ? "anthropic" : "openai" : b[f]);
  }
  if (b.priority !== void 0) {
    sets.push("priority=?");
    binds.push(Number(b.priority));
  }
  if (b.healthy !== void 0) {
    sets.push("healthy=?");
    binds.push(b.healthy ? 1 : 0);
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
  if (!sets.length)
    return c.json({ id });
  await c.env.DB.prepare("UPDATE providers SET " + sets.join(", ") + ", updated_at=? WHERE id=?").bind(...binds, nowIso(), id).run();
  const p = await c.env.DB.prepare("SELECT id, name, base_url, priority, healthy, fmt, proxy_url, transport, extra_headers, (api_key IS NOT NULL AND api_key <> '') AS api_key_set FROM providers WHERE id=?").bind(id).first();
  return c.json({ provider: p });
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
    "SELECT mr.id, mr.slug, mr.provider_id, mr.upstream_model, mr.rank, mr.enabled, p.name AS provider_name, p.healthy AS provider_healthy FROM model_routes mr JOIN providers p ON p.id=mr.provider_id ORDER BY mr.slug, mr.rank"
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
    "SELECT p.id, p.name, p.base_url, p.priority, p.healthy, p.fmt, p.proxy_url, p.transport, p.last_status, p.last_checked, (SELECT COUNT(*) FROM model_routes mr WHERE mr.provider_id=p.id) AS route_count FROM providers p ORDER BY p.priority"
  ).all();
  const routes = await c.env.DB.prepare(
    "SELECT mr.id, mr.slug, mr.provider_id, mr.upstream_model, mr.rank, mr.enabled, p.name AS provider_name, p.healthy AS provider_healthy FROM model_routes mr JOIN providers p ON p.id=mr.provider_id ORDER BY mr.slug, mr.rank"
  ).all();
  const keys = await c.env.DB.prepare(
    "SELECT key_id, name, budget_mode, budget_limit, used_tokens, used_usd, request_count, active, allowed_models, created_at FROM api_keys ORDER BY created_at DESC"
  ).all();
  const totals = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(request_count),0) AS requests, COALESCE(SUM(used_tokens),0) AS used_tokens, COALESCE(SUM(used_usd),0) AS used_usd FROM api_keys"
  ).first();
  return c.json({
    providers: providers.results || [],
    routes: routes.results || [],
    keys: keys.results || [],
    totals: totals || { requests: 0, used_tokens: 0, used_usd: 0 },
    generated_at: nowIso()
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
export const __test = { sanitizeClientResponse, safeSseData, sealProviderKey, openProviderKey, stableJson, isCacheableRequest, responseCacheKey, isCacheableResponse, normalizeRequestLimit, normalizeKeyExpiry, isKeyExpired, splitModelSlugs, effectiveModelSlugs, cacheCoalesceDelayMs, classifyUpstreamFailure, isGenericUpstreamErrorResponse, routeTransport, normalizeTransport, transportLabel, koyebCfg, flattenModelsDevCatalog, matchModelsDevPrice };
export function createApp(env) {
  if (!env) return app;
  return { fetch: (req, ctx) => app.fetch(req, env, ctx) };
}
