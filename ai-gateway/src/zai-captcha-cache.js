// Background CAPTCHA proof cache for the pure-HTTP Z.AI transport.
//
// Adapted from GLM-Free-API's CaptchaCache (MIT, see THIRD_PARTY_NOTICES.md).
// Proofs are single-use and short-lived. Keep a tiny standing cache while the
// route is active, then stop burning harvested device tokens after inactivity.
//
// Gateway-specific pieces retained:
// - no embedded Aliyun credentials;
// - the existing file-backed token store (works on restricted ecli eggs);
// - process-wide Z.AI WAF pacing/breaker.

import { takeDeviceToken } from "./zai-tokens.js";
import { mintCaptcha } from "./zai-captcha.js";
import { zaiWaf } from "./zai-waf.js";

const MAX_PARAMS = Math.max(1, Number(process.env.ZAI_CAPTCHA_CACHE_SIZE) || 2);
const TTL_MS = Math.max(5_000, Number(process.env.ZAI_CAPTCHA_CACHE_TTL_MS) || 75_000);
const IDLE_MS = Math.max(30_000, Number(process.env.ZAI_CAPTCHA_CACHE_IDLE_MS) || 180_000);
const TICK_MS = Math.max(250, Number(process.env.ZAI_CAPTCHA_CACHE_TICK_MS) || 500);
const MAX_TOKEN_RETRIES = Math.max(1, Number(process.env.ZAI_CAPTCHA_TOKEN_RETRIES) || 5);

const caches = new Map();

function cacheKey(storePath) {
  return String(storePath || process.env.ZAI_TOKEN_STORE || "default");
}

function sweep(cache, now = Date.now()) {
  cache.params = cache.params.filter((p) => now - p.at < TTL_MS);
}

async function computeProof(storePath, fetchImpl) {
  zaiWaf.assertAvailable();
  let lastReason = "";
  let remaining = 0;
  for (let attempt = 0; attempt < MAX_TOKEN_RETRIES; attempt++) {
    zaiWaf.assertAvailable();
    const taken = await takeDeviceToken(storePath);
    remaining = taken.remaining;
    if (!taken.token)
      break;
    const minted = await mintCaptcha(taken.token, { fetchImpl });
    if (minted && minted.ok && minted.param)
      return { ok: true, param: minted.param, remaining };
    lastReason = String(minted && minted.reason || "mint-failed");
  }
  return { ok: false, remaining, reason: lastReason || "token-store-empty" };
}

function ensureRunner(cache) {
  if (cache.timer)
    return;
  cache.timer = setInterval(() => {
    void refill(cache);
  }, TICK_MS);
  if (typeof cache.timer.unref === "function")
    cache.timer.unref();
}

async function refill(cache) {
  const now = Date.now();
  sweep(cache, now);
  if (now - cache.lastActive > IDLE_MS)
    return;
  while (cache.params.length + cache.generating < MAX_PARAMS) {
    cache.generating++;
    void (async () => {
      try {
        const minted = await computeProof(cache.storePath, cache.fetchImpl);
        if (minted.ok) {
          sweep(cache);
          if (cache.params.length < MAX_PARAMS)
            cache.params.push({ value: minted.param, at: Date.now() });
        }
      } catch {
        // WAF/config/network failures are surfaced by the foreground caller;
        // background generation stays quiet and tries again on a later tick.
      } finally {
        cache.generating--;
      }
    })();
  }
}

function getCache(storePath, fetchImpl) {
  const key = cacheKey(storePath);
  let cache = caches.get(key);
  if (!cache) {
    cache = {
      key,
      storePath,
      fetchImpl,
      params: [],
      generating: 0,
      lastActive: 0,
      timer: null
    };
    caches.set(key, cache);
  } else if (fetchImpl) {
    cache.fetchImpl = fetchImpl;
  }
  ensureRunner(cache);
  return cache;
}

export async function getZaiCaptchaProof({ storePath, fetchImpl } = {}) {
  const cache = getCache(storePath, fetchImpl);
  cache.lastActive = Date.now();
  sweep(cache);
  const hit = cache.params.shift();
  // Refill asynchronously after a hit, exactly like a small prefetch queue.
  void refill(cache);
  if (hit)
    return { ok: true, param: hit.value, cached: true };

  // Cache miss: compute synchronously so the current request can continue.
  const minted = await computeProof(storePath, fetchImpl);
  cache.lastActive = Date.now();
  void refill(cache);
  return { ...minted, cached: false };
}

export function zaiCaptchaCacheStatus() {
  const now = Date.now();
  return [...caches.values()].map((cache) => {
    sweep(cache, now);
    return {
      key: cache.key,
      ready: cache.params.length,
      generating: cache.generating,
      active: now - cache.lastActive <= IDLE_MS
    };
  });
}

export function resetZaiCaptchaCaches() {
  for (const cache of caches.values())
    if (cache.timer)
      clearInterval(cache.timer);
  caches.clear();
}

export const __zaiCaptchaCacheTest = { caches, sweep, computeProof };
