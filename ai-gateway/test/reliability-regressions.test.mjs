import test from "node:test";
import assert from "node:assert/strict";

import { __test as t } from "../src/index.js";
import { guardToolLoopResponse } from "../../server/tool-loop-guard.mjs";
import { generateActions, pickAction } from "../src/horizon.js";

function withFakeNow(ms, fn) {
  const realNow = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = realNow; }
}

test("circuit window resets stale failure count instead of accumulating forever", () => {
  assert.equal(typeof t.__resetCircuitState, "function");
  assert.equal(typeof t.circuitRecord, "function");
  assert.equal(typeof t.circuitOpen, "function");
  t.__resetCircuitState();

  withFakeNow(0, () => t.circuitRecord("p", false));
  withFakeNow(1_000, () => t.circuitRecord("p", false));
  assert.equal(withFakeNow(61_001, () => t.circuitOpen("p")), false);

  withFakeNow(61_001, () => t.circuitRecord("p", false));
  assert.equal(withFakeNow(61_001, () => t.circuitOpen("p")), false, "new window should start at one failure, not inherit old failures");
});

test("non-provider-health failures do not trip the provider breaker", () => {
  assert.equal(typeof t.circuitRecordFailure, "function");
  t.__resetCircuitState();
  const failures = [
    { status: 401, kind: "auth" },
    { status: 429, kind: "rate_limit" },
    { status: 400, kind: "model" },
    { status: 400, kind: "tool_schema" },
    { status: 413, kind: "request_size" },
    { status: 400, kind: "relay" },
    { status: 400, kind: "unknown" },
    { status: 503, kind: "zai_model_unavailable" },
    { status: 503, kind: "zai_browser_unavailable" },
    { status: 503, kind: "zai_transport" },
    { status: 503, kind: "zai_tokens" },
    { status: 503, kind: "zai_captcha_config" },
    { status: 503, kind: "zai_http_fallback_failed" }
  ];
  failures.forEach((f, i) => withFakeNow(i * 1000, () => t.circuitRecordFailure("p", f)));
  assert.equal(withFakeNow(10_000, () => t.circuitOpen("p")), false);
});

test("opaque Relbackend upstream_error is classified as relay, not unknown", () => {
  const body = '{"error":{"code":"upstream_error","message":"upstream_error","param":"","type":"upstream_error"}}';
  assert.equal(t.classifyUpstreamFailure(body), "relay");
});

test("circuit identity is route-scoped so one model route cannot poison siblings", () => {
  assert.equal(typeof t.circuitKey, "function");
  const a = t.circuitKey({ id: 41, provider_id: 7, provider_name: "same-provider", upstream_model: "model-a" });
  const b = t.circuitKey({ id: 42, provider_id: 7, provider_name: "same-provider", upstream_model: "model-b" });
  assert.notEqual(a, b);
  t.__resetCircuitState();
  t.circuitRecord(a, false);
  t.circuitRecord(a, false);
  t.circuitRecord(a, false);
  assert.equal(t.circuitOpen(a), true);
  assert.equal(t.circuitOpen(b), false);
});

test("pickAutoModel does not throw on healthy zaiminted routes", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    t.__resetCircuitState();
    const db = {
      prepare(sql) {
        const stmt = {
          bind() { return stmt; },
          async first() { return null; },
          async all() {
            if (sql.includes("route_ids"))
              return { results: [{ slug: "zai/glm-5.3-flash", healthy: 1, route_ids: "1" }] };
            if (sql.includes("upstream_model"))
              return { results: [{ slug: "zai/glm-5.3-flash", fmt: "zaiminted", upstream_model: "glm-5.3-flash" }] };
            return { results: [] };
          }
        };
        return stmt;
      }
    };
    const decision = await t.pickAutoModel({ env: { DB: db } }, { messages: [{ role: "user", content: "hi" }] }, null);
    assert.ok(decision);
    assert.equal(decision.slug, "zai/glm-5.3-flash");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("round_robin orders every enabled key so a dead credential can fail over", () => {
  assert.equal(typeof t.orderKeys, "function");
  const keys = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const first = t.orderKeys(keys, "round_robin", 777);
  const second = t.orderKeys(keys, "round_robin", 777);
  assert.deepEqual(first.map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(second.map((x) => x.id), [2, 3, 1]);
});

test("random key strategy keeps all credentials as fallbacks", () => {
  assert.equal(typeof t.orderKeys, "function");
  const keys = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const ordered = t.orderKeys(keys, "random", 1);
  assert.equal(ordered.length, 3);
  assert.deepEqual(new Set(ordered.map((x) => x.id)), new Set([1, 2, 3]));
});

test("response cache does not treat missing temperature as deterministic zero", () => {
  assert.equal(t.isCacheableRequest({ messages: [{ role: "user", content: "this is long enough to cache" }] }, false, "true"), false);
  assert.equal(t.isCacheableRequest({ messages: [{ role: "user", content: "this is long enough to cache" }], temperature: 0 }, false, "true"), true);
});

test("HORIZON reflex actions carry candidate cost before comparing cheapest", () => {
  const actions = generateActions([
    { slug: "model-a-mini", cost: 3, eligible: true, capable: true },
    { slug: "model-b-mini", cost: 1, eligible: true, capable: true }
  ], { difficulty: 0.1, toolComplexity: 0, families: ["chat"] }, {});
  const picked = pickAction(actions, { difficulty: 0.1, toolComplexity: 0, families: ["chat"] });
  assert.equal(picked.slug, "model-b-mini");
  assert.equal(picked.cost, 1);
});

test("outer SSE guard never exposes raw source exception text", async () => {
  const secret = "SECRET_PROVIDER_RELbackend https://internal-relay.example";
  const source = new ReadableStream({
    start(controller) {
      controller.error(new Error(secret));
    }
  });
  const guarded = guardToolLoopResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), "public-model");
  const text = await guarded.text();
  assert.doesNotMatch(text, /SECRET_PROVIDER_RELbackend|internal-relay\.example/);
  assert.match(text, /upstream_socket_closed/);
});

test("typed provider errors are converted to gateway-owned provider-neutral public errors", () => {
  assert.equal(typeof t.publicProviderError, "function");
  const cases = [
    { status: 403, code: "zai_waf", message: "Z.ai edge rejected https://chat.z.ai/secret SECRET_PROVIDER_RELbackend" },
    { status: 401, code: "zai_auth", message: "provider Z.AI credential rejected" },
    { status: 400, code: "zai_tools_unsupported", message: "Z.ai consumer models do not accept caller-supplied tools" },
    { status: 400, code: "zai_vision_unsupported", message: "Z.ai web transports do not upload images" }
  ];
  for (const input of cases) {
    const out = t.publicProviderError(input);
    const encoded = JSON.stringify(out);
    assert.ok(out && Number.isInteger(out.status));
    assert.ok(out.error && typeof out.error.message === "string");
    assert.doesNotMatch(encoded, /z\.ai|chat\.z\.ai|relbackend|SECRET_PROVIDER|provider\s+Z/i);
    assert.doesNotMatch(encoded, /zai_/i, "public error codes must not reveal the provider adapter");
  }
  assert.deepEqual(t.publicProviderError(cases[2]), {
    status: 400,
    error: { message: "Tools are not supported by the selected model.", type: "invalid_request_error", code: "unsupported_tools" }
  });
  assert.deepEqual(t.publicProviderError(cases[3]), {
    status: 400,
    error: { message: "Image input is not supported by the selected model.", type: "invalid_request_error", code: "unsupported_image_input" }
  });
  assert.equal(t.publicProviderError(cases[0]).status, 503);
  assert.equal(t.publicProviderError(cases[1]).status, 503);
});
