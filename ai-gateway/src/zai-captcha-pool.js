// Background CAPTCHA proof cache for the pure-HTTP Z.AI transport.
//
// Mirrors GLM-Free-API's operational model: keep two fresh single-use proofs
// ready, expire them quickly (75s), and stop spending device tokens after the
// route has been idle for three minutes. The gateway-specific WAF controller
// remains authoritative, so a blocked egress never burns harvested tokens.

import { takeDeviceToken } from "./zai-tokens.js";
import { mintCaptcha } from "./zai-captcha.js";
import { zaiWaf } from "./zai-waf.js";

const DEFAULT_MAX = 2;
const DEFAULT_TTL_MS = 75_000;
const DEFAULT_IDLE_MS = 180_000;
const DEFAULT_RETRIES = 5;
const pools = new Map();

function nowMs() {
  return Date.now();
}

export class ZaiCaptchaPool {
  constructor(options = {}) {
    this.db = options.db || null;
    this.storePath = options.storePath;
    this.fetchImpl = options.fetchImpl;
    this.max = Math.max(1, Number(options.max) || DEFAULT_MAX);
    this.ttlMs = Math.max(5_000, Number(options.ttlMs) || DEFAULT_TTL_MS);
    this.idleMs = Math.max(this.ttlMs, Number(options.idleMs) || DEFAULT_IDLE_MS);
    this.retries = Math.max(1, Number(options.retries) || DEFAULT_RETRIES);
    this.entries = [];
    this.lastUse = 0;
    this.refillPromise = null;
    this.timer = null;
    this.lastError = "";
  }

  _prune() {
    const cutoff = nowMs() + 2_000;
    this.entries = this.entries.filter((entry) => entry && entry.param && entry.expiresAt > cutoff);
  }

  _active() {
    return this.lastUse && nowMs() - this.lastUse < this.idleMs;
  }

  async _mintOne() {
    zaiWaf.assertAvailable();
    let remaining = 0;
    let last = "";
    for (let attempt = 0; attempt < this.retries; attempt++) {
      zaiWaf.assertAvailable();
      const taken = await takeDeviceToken({
        db: this.db,
        storePath: this.storePath
      });
      remaining = Number(taken.remaining || 0);
      if (!taken.token)
        break;
      const minted = await mintCaptcha(taken.token, { fetchImpl: this.fetchImpl });
      if (minted && minted.ok && minted.param) {
        this.lastError = "";
        return {
          ok: true,
          param: minted.param,
          expiresAt: nowMs() + this.ttlMs,
          remaining
        };
      }
      last = String(minted && minted.reason || "mint-failed") +
        (minted && minted.detail ? ": " + String(minted.detail).slice(0, 180) : "");
    }
    this.lastError = last || "device-token store empty";
    return { ok: false, remaining, reason: this.lastError };
  }

  async _refill() {
    if (this.refillPromise)
      return this.refillPromise;
    this.refillPromise = (async () => {
      this._prune();
      while (this._active() && this.entries.length < this.max) {
        try {
          const minted = await this._mintOne();
          if (!minted.ok)
            break;
          this.entries.push(minted);
        } catch (err) {
          this.lastError = String(err && err.message || err).slice(0, 200);
          break;
        }
      }
    })().finally(() => {
      this.refillPromise = null;
    });
    return this.refillPromise;
  }

  _scheduleRefill() {
    if (this.timer)
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this._active())
        return;
      void this._refill().finally(() => {
        this._prune();
        if (this._active() && this.entries.length < this.max)
          this._scheduleRefill();
      });
    }, 25);
    if (typeof this.timer.unref === "function")
      this.timer.unref();
  }

  async take() {
    this.lastUse = nowMs();
    zaiWaf.assertAvailable();
    this._prune();
    const cached = this.entries.shift();
    if (cached) {
      this._scheduleRefill();
      return { ...cached, cached: true };
    }

    const minted = await this._mintOne();
    if (minted.ok)
      this._scheduleRefill();
    return { ...minted, cached: false };
  }

  status() {
    this._prune();
    return {
      cached: this.entries.length,
      max: this.max,
      ttlMs: this.ttlMs,
      idleMs: this.idleMs,
      active: !!this._active(),
      lastError: this.lastError
    };
  }

  close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.entries.length = 0;
  }
}

export function captchaPoolFor(key = "default", options = {}) {
  const id = String(key || "default");
  let pool = pools.get(id);
  if (!pool) {
    pool = new ZaiCaptchaPool(options);
    pools.set(id, pool);
  } else {
    pool.db = options.db || pool.db;
    pool.storePath = options.storePath || pool.storePath;
    pool.fetchImpl = options.fetchImpl || pool.fetchImpl;
  }
  return pool;
}

export function resetCaptchaPools() {
  for (const pool of pools.values())
    pool.close();
  pools.clear();
}

export const __captchaPoolTest = { pools, DEFAULT_MAX, DEFAULT_TTL_MS, DEFAULT_IDLE_MS };
