// Edge-build Z.AI stubs. The Cloudflare Worker must not depend on or run the
// consumer-web GLM bridge (chat.z.ai protocol, CAPTCHA harvesting, device
// tokens, session pools, uTLS): those modules require Node-only APIs
// (fs, child_process) and cannot
// exist in a Worker isolate. This module replaces the zai imports of
// src/index.js inside .edge-build/ only — src/ itself is never modified.
//
// Semantics:
// - isZai*Format() is false, so provider dispatch falls through to the
//   ordinary OpenAI-compatible path and NO consumer-web route is ever
//   selected, dialed, or advertised.
// - ZaiWebError remains a real Error class so `instanceof` checks in shared
//   error handling stay type-safe; it can never be thrown on the edge path.
// - modelCatalogEntry() returns null: catalog enrichment only ever applied to
//   consumer-web routes.
// - withRotatedToken / validateZaiWebKey / zaiWaf / pool+token+captcha status
//   report empty/inert state for the excluded admin surfaces.

class ZaiWebError extends Error {
  constructor(status, message, code, retryAfterSec) {
    super(String(message || "provider transport error"));
    this.name = "ZaiWebError";
    this.status = Number(status) || 502;
    this.code = String(code || "zai_transport");
    this.retryAfterSec = Number(retryAfterSec) || 0;
  }
}

export const ZaiWebError_ = ZaiWebError;
export { ZaiWebError };
// The ONLY provider formats this deployment can dispatch. Consumer-web
// formats are absent, so PROVIDER_FORMATS in index.js (which consults this
// global) excludes them from validation, /v1/models, console listings, and
// route dispatch: a legacy zai row can never be created, advertised, or dialed.
globalThis.HORIZON_EXCLUDED_FORMATS = ["zaiweb", "zaiwebbrowser", "zaiminted"];
// Validation allowlist for provider creation on this deployment: consumer-web
// formats cannot even be configured here (legacy imported rows are refused at
// serving by the exclusion above, config preserved for the operator).
globalThis.HORIZON_SUPPORTED_FORMATS = ["openai", "anthropic"];
export function isZaiWebFormat() { return false; }
export function isZaiBrowserFormat() { return false; }
export function isZaiMintedFormat() { return false; }
export function isZaiMintedFormatAlias() { return false; }
export function isZaiBrowserFormatAlias() { return false; }

// Never called on the edge path (no zai route can be selected); if a stale
// route row somehow reaches dialing, forwardToProvider receives an opaque
// passthrough and the fetch fails like any other misconfigured provider.
export function callZaiWeb() { throw new ZaiWebError(501, "consumer-web bridge is not available on this deployment", "bridge_disabled"); }
export function callZaiBrowser() { throw new ZaiWebError(501, "consumer-web bridge is not available on this deployment", "bridge_disabled"); }
export function callZaiMinted() { throw new ZaiWebError(501, "consumer-web bridge is not available on this deployment", "bridge_disabled"); }
export function diagnoseZai() { return { supported: false, reason: "consumer-web bridge excluded from this deployment" }; }

export function modelCatalogEntry() { return null; }
export function validateZaiWebKey() { return { ok: false, status: 0, error: "consumer-web bridge is not available on this deployment" }; }
export function withRotatedToken(current) { return current; }

export const zaiWaf = {
  isBlocked() { return false; },
  record() {},
  status() { return { blocked: [], perEgress: [] }; },
};

export function zaiSessionPoolStatus() { return { ready: 0, inFlight: 0, reuseBudget: 0 }; }
export function peekDeviceTokens() { return Promise.resolve([]); }
export function appendDeviceTokens() { return Promise.resolve(0); }
export function zaiCaptchaCacheStatus() { return []; }
