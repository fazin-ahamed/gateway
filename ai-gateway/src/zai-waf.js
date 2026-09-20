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

  // WAF blocks are egress-IP conditions: one proxy can be blocked while others
  // (and direct) stay healthy. State is therefore keyed by egress ("direct" or
  // "proxy:<id>"), never process-global. Pacing stays global — it protects the
  // shared upstream, not a single egress.
  const lanes = new Map();
  let nextAllowedAt = 0;
  let pacingLane = Promise.resolve();
  let probeFn = typeof options.probe === "function" ? options.probe : null;

  const laneOf = (egressKey) => {
    const key = String(egressKey || "direct");
    let s = lanes.get(key);
    if (!s) {
      s = { key, blockCount: 0, blocked: false, nextProbeAt: 0, cooldownMs: 0, lastReason: "", probing: false, target: null };
      lanes.set(key, s);
    }
    return s;
  };

  const retryAfterSecOf = (s) => (s.blocked && s.nextProbeAt > now()) ? Math.max(1, Math.ceil((s.nextProbeAt - now()) / 1000)) : (s.blocked ? 1 : 0);

  const shape = (s) => ({
    egress: s.key,
    blocked: s.blocked,
    blockCount: s.blockCount,
    consecutiveBlocks: s.blockCount,
    cooldownMs: s.blocked ? s.cooldownMs : 0,
    retryAfterSec: retryAfterSecOf(s),
    probing: s.probing,
    lastReason: s.lastReason
  });

  // status(key) -> one egress lane. status() with no key -> all lanes plus a
  // rolled-up `blocked` (any egress blocked) for the admin surface.
  const status = (egressKey) => {
    if (egressKey != null)
      return shape(laneOf(egressKey));
    const egresses = [...lanes.values()].map(shape);
    return {
      blocked: egresses.some((e) => e.blocked),
      anyProbing: egresses.some((e) => e.probing),
      blockedEgresses: egresses.filter((e) => e.blocked).map((e) => e.egress),
      egresses
    };
  };

  const escalate = (s) => {
    // 60s -> 120s -> 240s -> ... -> maxCooldownMs (default 30 min).
    s.cooldownMs = Math.min(maxCooldownMs, baseCooldownMs * (2 ** Math.max(0, s.blockCount - 1)));
    s.nextProbeAt = now() + s.cooldownMs;
  };

  // Kick a recovery probe for THIS egress if its breaker is open, a probe is
  // due, none is in flight, and a probe function is registered. Fire-and-forget:
  // a user request never becomes the recovery test. The probe is handed the
  // frozen target captured at block time, so it always traverses the exact
  // egress that was blocked — never whatever egress is active now.
  const maybeProbe = (s) => {
    if (!s.blocked || s.probing || !probeFn || s.nextProbeAt > now())
      return;
    s.probing = true;
    Promise.resolve()
      .then(() => probeFn({ egress: s.key, target: s.target }))
      .then((recovered) => {
        if (recovered) {
          s.blocked = false;
          s.blockCount = 0;
          s.cooldownMs = 0;
          s.nextProbeAt = 0;
          s.lastReason = "";
          s.target = null;
        } else {
          s.blockCount++;
          escalate(s);
        }
      })
      .catch(() => {
        // Probe error is inconclusive: keep the breaker open, back off, retry.
        s.blockCount++;
        escalate(s);
      })
      .finally(() => { s.probing = false; });
  };

  const assertAvailable = (egressKey) => {
    const s = laneOf(egressKey);
    if (s.blocked) {
      maybeProbe(s);
      throw new ZaiWafBlockedError(retryAfterSecOf(s));
    }
  };

  // target: { egressId, egressUrl } frozen so the recovery probe re-uses the
  // exact blocked path (with its already-resolved credentials).
  const recordBlock = (egressKey, reason = "edge-block", target = null) => {
    const s = laneOf(egressKey);
    s.blockCount++;
    s.blocked = true;
    if (target) s.target = target;
    escalate(s);
    s.lastReason = String(reason || "edge-block").slice(0, 80);
    return shape(s);
  };

  const recordSuccess = (egressKey) => {
    const s = laneOf(egressKey);
    s.blockCount = 0;
    s.blocked = false;
    s.cooldownMs = 0;
    s.nextProbeAt = 0;
    s.lastReason = "";
    s.target = null;
    return shape(s);
  };

  const isBlocked = (egressKey) => laneOf(egressKey).blocked;

  const setProbe = (fn) => { probeFn = typeof fn === "function" ? fn : null; };

  const pace = () => {
    const task = pacingLane.catch(() => {}).then(async () => {
      const before = now();
      const delay = Math.max(0, nextAllowedAt - before);
      if (delay > 0)
        await sleep(delay);
      const span = Math.max(0, maxPaceMs - minPaceMs);
      const interval = minPaceMs + Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * (span + 1));
      const after = now();
      nextAllowedAt = Math.max(after, nextAllowedAt) + interval;
    });
    pacingLane = task;
    return task;
  };

  const beforeRequest = async (egressKey) => {
    assertAvailable(egressKey);
    await pace();
    // A block might have been recorded while this caller waited in the shared
    // pacing lane. Re-check before it spends a captcha or sends the POST.
    assertAvailable(egressKey);
  };

  return { status, assertAvailable, recordBlock, recordSuccess, isBlocked, pace, beforeRequest, setProbe, maybeProbe };
}

export const zaiWaf = createZaiWafController();
