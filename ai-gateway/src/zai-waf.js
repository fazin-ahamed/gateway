// Process-wide protection for the chat.z.ai / Aliyun request path.
//
// This is intentionally separate from the gateway's per-model-route circuit:
// a confirmed edge/WAF block is an egress-IP condition shared by every Z.AI
// route on this process, while ordinary provider/model failures must remain
// route-scoped.

const DEFAULT_BASE_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_MIN_PACE_MS = 200;
const DEFAULT_MAX_PACE_MS = 500;

export class ZaiWafBlockedError extends Error {
  constructor(retryAfterSec) {
    super("Z.AI edge temporarily unavailable");
    this.name = "ZaiWafBlockedError";
    this.code = "zai_waf_blocked";
    this.status = 503;
    this.retryAfterSec = Math.max(1, Math.ceil(Number(retryAfterSec) || 1));
  }
}

export function isZaiWafBlock(status, body) {
  const code = Number(status) || 0;
  const text = String(body || "").toLowerCase();
  const html = /<!doctype|<html|<title|<body/.test(text);
  const aliyun = /aliyun|alicloud|captcha-open-southeast\.aliyuncs\.com/.test(text);
  const explicitBlock = /\bwaf\b|request\s+(?:was\s+)?blocked|access\s+denied|cloud\s*firewall|temporarily\s+blocked/.test(text);

  // Known block pages are normally 403/405 HTML from the Aliyun edge. Require
  // either an Aliyun marker or explicit block/WAF language so an ordinary API
  // error mentioning "security" or "captcha" does not poison the global IP
  // breaker.
  if ((code === 403 || code === 405) && ((html && (aliyun || explicitBlock)) || (aliyun && explicitBlock)))
    return true;
  return false;
}

export function createZaiWafController(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const sleep = typeof options.sleep === "function" ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const random = typeof options.random === "function" ? options.random : Math.random;
  const baseCooldownMs = Math.max(1, Number(options.baseCooldownMs) || DEFAULT_BASE_COOLDOWN_MS);
  const maxCooldownMs = Math.max(baseCooldownMs, Number(options.maxCooldownMs) || DEFAULT_MAX_COOLDOWN_MS);
  const minPaceMs = Math.max(0, Number(options.minPaceMs) || DEFAULT_MIN_PACE_MS);
  const maxPaceMs = Math.max(minPaceMs, Number(options.maxPaceMs) || DEFAULT_MAX_PACE_MS);

  let blockCount = 0;
  let openUntil = 0;
  let cooldownMs = 0;
  let lastReason = "";
  let nextAllowedAt = 0;
  let lane = Promise.resolve();

  const retryAfterSec = () => openUntil > now() ? Math.max(1, Math.ceil((openUntil - now()) / 1000)) : 0;

  const status = () => ({
    blocked: openUntil > now(),
    blockCount,
    cooldownMs: openUntil > now() ? cooldownMs : (blockCount ? cooldownMs : 0),
    retryAfterSec: retryAfterSec(),
    lastReason
  });

  const assertAvailable = () => {
    const retry = retryAfterSec();
    if (retry > 0)
      throw new ZaiWafBlockedError(retry);
  };

  const recordBlock = (reason = "edge-block") => {
    blockCount++;
    cooldownMs = Math.min(maxCooldownMs, baseCooldownMs * (2 ** Math.max(0, blockCount - 1)));
    openUntil = now() + cooldownMs;
    lastReason = String(reason || "edge-block").slice(0, 80);
    return status();
  };

  const recordSuccess = () => {
    blockCount = 0;
    openUntil = 0;
    cooldownMs = 0;
    lastReason = "";
    return status();
  };

  const pace = () => {
    const task = lane.catch(() => {}).then(async () => {
      const before = now();
      const delay = Math.max(0, nextAllowedAt - before);
      if (delay > 0)
        await sleep(delay);
      const span = Math.max(0, maxPaceMs - minPaceMs);
      const interval = minPaceMs + Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * (span + 1));
      const after = now();
      nextAllowedAt = Math.max(after, nextAllowedAt) + interval;
    });
    lane = task;
    return task;
  };

  const beforeRequest = async () => {
    assertAvailable();
    await pace();
    // A block might have been recorded while this caller waited in the shared
    // pacing lane. Re-check before it spends a captcha or sends the POST.
    assertAvailable();
  };

  return { status, assertAvailable, recordBlock, recordSuccess, pace, beforeRequest };
}

export const zaiWaf = createZaiWafController();
