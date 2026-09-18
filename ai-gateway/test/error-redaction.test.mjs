import test from "node:test";
import assert from "node:assert/strict";
import { __test as t } from "../src/index.js";

test("sanitizeUpstreamResponse strips URLs, hostnames, transport, and provider names", () => {
  const out = t.sanitizeUpstreamResponse(
    "provider OpenRouter -> HTTP 502 [unknown] https://api.openrouter.ai/v1 via-proxy"
  );
  assert.doesNotMatch(out, /openrouter/i);
  assert.doesNotMatch(out, /https?:\/\//i);
  assert.doesNotMatch(out, /via-proxy/);
  assert.match(out, /upstream/);
});

test("sanitizeUpstreamResponse strips chat.z.ai and IPv4-looking hosts", () => {
  const out = t.sanitizeUpstreamResponse("Z.ai session expired: https://chat.z.ai/api/v1/auths 401");
  assert.doesNotMatch(out, /chat\.z\.ai/);
  assert.doesNotMatch(out, /https?:\/\//i);
});

test("sseUpstreamDisconnect never echoes the raw exception", () => {
  const sse = t.sseUpstreamDisconnect("The socket connection was closed unexpectedly at https://internal-relay.example");
  assert.doesNotMatch(sse, /internal-relay/);
  assert.doesNotMatch(sse, /https?:\/\//i);
  assert.match(sse, /upstream_socket_closed/);
  assert.match(sse, /data: \[DONE\]/);
});

test("exhausted routes return a generic outage, not lastErr", async () => {
  const generic = t.genericUpstreamError();
  assert.equal(generic.error.type, "upstream_error");
  assert.doesNotMatch(generic.error.message, /provider /);
  assert.doesNotMatch(generic.error.message, /https?:\/\//i);
  assert.doesNotMatch(generic.error.message, /via-proxy|via-koyeb|DIRECT/);
});

test("same-key retry is three in-place attempts, then the next credential", () => {
  assert.equal(t.SAME_KEY_ATTEMPTS, 3);
  assert.equal(t.shouldRetrySameKey(0, { code: "ECONNRESET", message: "read ECONNRESET" }), true);
  assert.equal(t.shouldRetrySameKey(1, { code: "ECONNRESET" }), true);
  assert.equal(t.shouldRetrySameKey(2, { code: "ECONNRESET" }), false);
  assert.equal(t.shouldRetrySameKey(0, new Error("The socket connection was closed unexpectedly")), true);
  assert.equal(t.shouldRetrySameKey(0, { status: 401, message: "unauthorized" }), false);
  assert.equal(t.shouldRetrySameKey(0, { status: 503, message: "model overloaded" }), false);
  assert.equal(t.shouldRetryHttp(0, 400, "relay"), true);
  assert.equal(t.shouldRetryHttp(1, 502, "unknown"), true);
  assert.equal(t.shouldRetryHttp(2, 502, "unknown"), false);
  assert.equal(t.shouldRetryHttp(0, 401, "auth"), false);
  assert.equal(t.shouldRetryHttp(0, 503, "zai_browser_unavailable"), false);
  assert.equal(t.shouldRetryHttp(0, 502, "zai_browser"), true);
  assert.equal(t.shouldRetryHttp(0, 503, "zai_model_unavailable"), false);
  assert.equal(t.shouldRetryHttp(0, 503, "zai_tokens"), false);
  assert.equal(t.shouldRetryHttp(0, 503, "zai_captcha_config"), false);
  assert.equal(t.shouldRetryHttp(0, 503, "zai_http_fallback_failed"), false);
});
