import test from "node:test";
import assert from "node:assert/strict";

import { __test as t } from "../src/index.js";
import { guardToolLoopResponse } from "../../server/tool-loop-guard.mjs";
import { generateActions, pickAction, planHorizon } from "../src/horizon.js";

function withFakeNow(ms, fn) {
  const realNow = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = realNow; }
}

test("GET /admin/prices falls back when extra price columns are missing", async () => {
  const { createApp } = await import("../src/index.js");
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        first() { return null; },
        all() {
          if (String(sql).includes("actual_prompt_per_1m"))
            throw new Error("no such column: actual_prompt_per_1m");
          if (String(sql).includes("FROM prices"))
            return { results: [{ slug: "z-ai/glm-5.3", prompt_per_1m: 1, completion_per_1m: 2, currency: "USD", updated_at: "t" }] };
          return { results: [] };
        },
        run() { return { meta: { changes: 0 } }; }
      };
    }
  };
  const app = createApp({ DB: db, ADMIN_TOKEN: "secret" });
  const res = await app.fetch(new Request("http://gw/admin/prices", { headers: { authorization: "Bearer secret" } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.prices[0].slug, "z-ai/glm-5.3");
  assert.equal(body.prices[0].prompt_per_1m, 1);
});

test("Bayesian reliability floor degrades 0/2 and 50%/10 routes, keeps cold starts", () => {
  const floor = t.ROUTE_RELIABILITY_FLOOR;
  const fresh = t.routeReliability(null);
  assert.equal(fresh.band, "unproven");
  assert.ok(fresh.lcb >= floor, "cold-start route stays above the floor on the prior");
  const zeroTwo = t.routeReliability({ n: 2, ok_rate: 0 });
  assert.equal(zeroTwo.band, "degraded");
  assert.ok(zeroTwo.lcb < floor, "0/2 must fall below the floor");
  const fiftyTen = t.routeReliability({ n: 10, ok_rate: 0.5 });
  assert.equal(fiftyTen.band, "degraded");
  assert.ok(fiftyTen.lcb < floor, "50% over 10 must fall below the floor");
  const strong = t.routeReliability({ n: 50, ok_rate: 0.95 });
  assert.equal(strong.band, "healthy");
  const oneFail = t.routeReliability({ n: 1, ok_rate: 0 });
  assert.equal(oneFail.n, 1, "a single attempt is thin evidence, floor needs >=2");
});

test("reflex pick prefers fast+reliable over cheap+slow, then cheapest among equals", () => {
  const cheapSlow = { slug: "cheap-slow", cost: 0.2, avgMs: 124000, lcb: 0.51 };
  const fastOk = { slug: "fast-ok", cost: 0.7, avgMs: 700, lcb: 0.7 };
  const fastLux = { slug: "fast-lux", cost: 3.65, avgMs: 700, lcb: 0.7 };
  assert.equal(t.reflexPick([cheapSlow, fastOk, fastLux]).slug, "fast-ok");
  assert.equal(t.reflexPick([fastOk, fastLux]).slug, "fast-ok", "same reliability+latency → cheaper wins");
  assert.equal(t.reflexPick([cheapSlow]).slug, "cheap-slow", "never returns null when the pool is non-empty");
  assert.equal(t.reflexPick([]), null);
});

test("reflex pick lets a free fast non-workhorse beat a pricier slower one at equal reliability", () => {
  // The screenshot case: Atria (free, 1.3s) must beat DeepSeek (0.26/M, 3.1s)
  // once the workhorse hard-prefilter is gone and both reach the optimizer.
  const atria = { slug: "atria-dawn-preview", cost: 0, avgMs: 1309, lcb: 0.67 };
  const deepseek = { slug: "deepseek/deepseek-v4-flash-0731", cost: 0.26, avgMs: 3087, lcb: 0.67 };
  assert.equal(t.reflexPick([deepseek, atria]).slug, "atria-dawn-preview");
});

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

test("actual cost uses cache-read rate for cached prompt tokens", () => {
  const usage = { prompt_tokens: 1_000_000, cached_tokens: 250_000, completion_tokens: 500_000 };
  const noCache = t.costFromRates(usage, 1, 2, null, null);
  assert.equal(noCache, 2);
  const withCache = t.costFromRates(usage, 1, 2, 0.1, 0);
  assert.equal(withCache, 0.75 + 0.025 + 1);
  const row = t.priceFromRow({ prompt_per_1m: 3, completion_per_1m: 6, actual_prompt_per_1m: 1, actual_completion_per_1m: 2, cache_read_per_1m: 0.1 });
  assert.equal(row.equivalentPrompt, 3);
  assert.equal(row.actualPrompt, 1);
  assert.equal(row.cacheRead, 0.1);
});

test("priceFromRow exposes per-request actual basis", () => {
  const perReq = t.priceFromRow({ prompt_per_1m: 3, completion_per_1m: 6, actual_mode: "per_request", actual_per_request: 0.004 });
  assert.equal(perReq.actualMode, "per_request");
  assert.equal(perReq.actualPerRequest, 0.004);
  const perToken = t.priceFromRow({ prompt_per_1m: 3, completion_per_1m: 6 });
  assert.equal(perToken.actualMode, "per_1m");
  assert.equal(perToken.actualPerRequest, 0);
});

test("actual pricing resolves per provider, then the provider_id=0 default", async () => {
  const { createDb } = await import("../../server/db.mjs");
  const db = createDb(":memory:");
  db.exec("CREATE TABLE prices (slug TEXT NOT NULL, provider_id INTEGER NOT NULL DEFAULT 0, prompt_per_1m REAL NOT NULL DEFAULT 0, completion_per_1m REAL NOT NULL DEFAULT 0, actual_prompt_per_1m REAL, actual_completion_per_1m REAL, cache_read_per_1m REAL, cache_write_per_1m REAL, actual_mode TEXT NOT NULL DEFAULT 'per_1m', actual_per_request REAL, currency TEXT, updated_at TEXT, PRIMARY KEY(slug, provider_id))");
  const ins = (pid, ap, ac, mode, per) => db.prepare("INSERT INTO prices (slug, provider_id, prompt_per_1m, completion_per_1m, actual_prompt_per_1m, actual_completion_per_1m, actual_mode, actual_per_request, updated_at) VALUES ('m',?,10,20,?,?,?,?, 't')").bind(pid, ap, ac, mode || "per_1m", per == null ? null : per).run();
  ins(0, 1, 2, "per_1m", null);          // default: $1 + $2 per 1M
  ins(5, 3, 4, "per_1m", null);          // provider 5: $3 + $4 per 1M
  ins(6, null, null, "per_request", 0.01); // provider 6: flat $0.01/request
  t.__resetPricesSchema();
  const c = { env: { DB: db } };
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
  assert.equal(await t.computeCost(c, "m", usage, 5), 7, "provider-specific rate wins");
  assert.equal(await t.computeCost(c, "m", usage, 99), 3, "unpriced provider falls back to the default");
  assert.equal(await t.computeCost(c, "m", usage, 6), 0.01, "per-request provider bills the flat fee");
});

test("migratePrices rebuilds a slug-only table with NULL actual_mode into (slug, provider_id)", async () => {
  const { createDb } = await import("../../server/db.mjs");
  const { migratePrices } = await import("../../server/migrations.mjs");
  const db = createDb(":memory:");
  db.exec("CREATE TABLE prices (slug TEXT PRIMARY KEY, prompt_per_1m REAL NOT NULL DEFAULT 0, completion_per_1m REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', updated_at TEXT NOT NULL)");
  db.exec("ALTER TABLE prices ADD COLUMN actual_mode TEXT");
  db.exec("ALTER TABLE prices ADD COLUMN actual_per_request REAL");
  db.prepare("INSERT INTO prices (slug, prompt_per_1m, completion_per_1m, currency, updated_at) VALUES ('glm',1,2,'USD','t')").run();
  db.prepare("INSERT INTO prices (slug, prompt_per_1m, completion_per_1m, actual_mode, actual_per_request, currency, updated_at) VALUES ('qwen',3,4,'per_request',0.02,'USD','t')").run();
  migratePrices(db);
  const cols = db.prepare("PRAGMA table_info(prices)").all();
  const list = Array.isArray(cols) ? cols : (cols && cols.results) || [];
  assert.ok(list.some((x) => x.name === "provider_id"), "provider_id column added");
  const rows = (db.prepare("SELECT slug, provider_id, actual_mode, actual_per_request FROM prices ORDER BY slug").all().results) || [];
  const glm = rows.find((r) => r.slug === "glm");
  assert.equal(glm.provider_id, 0, "existing rows become the provider_id=0 default");
  assert.equal(glm.actual_mode, "per_1m", "NULL actual_mode coalesces instead of aborting the rebuild");
  const qwen = rows.find((r) => r.slug === "qwen");
  assert.equal(qwen.actual_mode, "per_request");
  assert.equal(qwen.actual_per_request, 0.02);
  db.prepare("INSERT INTO prices (slug, provider_id, prompt_per_1m, completion_per_1m, actual_mode, actual_prompt_per_1m, updated_at) VALUES ('glm',5,1,2,'per_1m',0.9,'t')").run();
  const glmRows = (db.prepare("SELECT provider_id FROM prices WHERE slug='glm' ORDER BY provider_id").all().results) || [];
  assert.deepEqual(glmRows.map((r) => r.provider_id), [0, 5], "composite key admits a provider override beside the default");
  migratePrices(db);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM prices").all().results)[0].n, 3, "re-running the migration is a no-op");
});

test("classifyAttempt marks only operational failures for route health", () => {
  const imp = (s, why, ek) => t.classifyAttempt(s, why, ek).health_impact;
  assert.equal(imp(0, "model"), 0, "model-not-found is capability, not health");
  assert.equal(imp(0, "tool_schema"), 0);
  assert.equal(imp(0, "request_size"), 0);
  assert.equal(imp(401, "auth"), 0, "a dead key is credential, not route health");
  assert.equal(imp(429, "rate_limit"), 0);
  assert.equal(imp(400, "unknown"), 0, "an opaque 400 with no known cause is a caller error");
  assert.equal(imp(400, "relay"), 1, "a Relbackend opaque-upstream 400 is operational, matched by why before status");
  assert.equal(imp(404, ""), 0);
  assert.equal(imp(500, "unknown"), 1);
  assert.equal(imp(504, ""), 1);
  assert.equal(imp(0, "relay"), 1);
  assert.equal(imp(0, null, "ECONNRESET"), 1);
  assert.equal(t.classifyAttempt(500, "unknown").failure_class, "upstream_5xx");
  assert.equal(t.classifyAttempt(0, "relay").failure_class, "bad_upstream_response");
  assert.equal(t.classifyAttempt(400, "relay").failure_class, "bad_upstream_response");
  const malformed = t.classifyAttempt(200, "malformed");
  assert.equal(malformed.failure_class, "bad_upstream_response", "a 200 with a generic error body is a bad upstream response");
  assert.equal(malformed.health_impact, 1);
});

test("recordRouteAttempt writes one row per attempt and moves the posterior only on operational outcomes", async () => {
  const { createDb } = await import("../../server/db.mjs");
  const { readFileSync } = await import("node:fs");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const c = { env: { DB: db } };
  const base = { public_slug: "glm", route_id: 7, provider_id: 1, provider_key_id: 3, task_type: "chat:casual", started_at: "t", finished_at: "t", latency_ms: 800 };
  await t.recordRouteAttempt(c, { ...base, request_id: "r1", success: 1, health_impact: 1, http_status: 200, failure_class: "success", actual_cost_usd: 0.001 });
  await t.recordRouteAttempt(c, { ...base, request_id: "r2", success: 0, health_impact: 1, http_status: 500, failure_class: "upstream_5xx" });
  await t.recordRouteAttempt(c, { ...base, request_id: "r3", success: 0, health_impact: 0, http_status: 400, failure_class: "caller" });
  const n = db.prepare("SELECT COUNT(*) AS n FROM route_attempts").all().results[0].n;
  assert.equal(n, 3, "one row per attempt, including the excluded caller error");
  const stat = db.prepare("SELECT success_alpha, failure_beta FROM router_stats WHERE scope='route' AND scope_id='route:7' AND task_type=''").all().results[0];
  assert.ok(stat.success_alpha > 8 && stat.success_alpha < 10, "one operational success raised alpha");
  assert.ok(stat.failure_beta > 2 && stat.failure_beta < 4, "one operational failure raised beta; the caller error did not");
  // A deferred (streaming handoff) record writes the row but must not move the
  // posterior until the stream's terminal outcome is known.
  const before = db.prepare("SELECT success_alpha, failure_beta FROM router_stats WHERE scope='route' AND scope_id='route:9' AND task_type=''").all().results[0];
  assert.equal(before, undefined, "no stat for a fresh route yet");
  await t.recordRouteAttempt(c, { ...base, request_id: "r4", route_id: 9, success: 1, health_impact: 1, http_status: 200, deferPosterior: true });
  const rows9 = db.prepare("SELECT COUNT(*) AS n FROM route_attempts WHERE route_id=9").all().results[0].n;
  assert.equal(rows9, 1, "deferred record still writes the attempt row");
  const stat9 = db.prepare("SELECT success_alpha FROM router_stats WHERE scope='route' AND scope_id='route:9' AND task_type=''").all().results[0];
  assert.equal(stat9, undefined, "deferred posterior is not observed at handoff");
});

test("updateRouterStat serializes concurrent observations without losing any", async () => {
  const { createDb } = await import("../../server/db.mjs");
  const { readFileSync } = await import("node:fs");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const c = { env: { DB: db } };
  const N = 20;
  await Promise.all(Array.from({ length: N }, () => t.updateRouterStat(c, "route", "route:1", "", true, 100, 0.001)));
  const row = db.prepare("SELECT success_alpha FROM router_stats WHERE scope='route' AND scope_id='route:1' AND task_type=''").all().results[0];
  assert.ok(row.success_alpha > 8 + N - 1, "all " + N + " concurrent successes observed (no lost read-modify-write); got alpha=" + row.success_alpha);
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

test("ineligible candidate can never be selected by HORIZON", () => {
  const actions = generateActions([
    { slug: "z-ai/glm-5.3-flash", eligible: false, capable: true, workhorse: true, cost: 0.1, tiny: true },
    { slug: "alibaba/qwen3.8-flash-next", eligible: true, capable: true, workhorse: true, cost: 0.7, tiny: true }
  ], { families: ["chat"], difficulty: 0.1, toolComplexity: 0 }, {});
  const models = actions.filter((a) => a.type === "model");
  assert.equal(models.length, 1);
  assert.equal(models[0].slug, "alibaba/qwen3.8-flash-next");
  const plan = planHorizon({
    payload: { messages: [{ role: "user", content: "Hi" }] },
    candidates: [
      { slug: "z-ai/glm-5.3-flash", eligible: false, capable: true, workhorse: true, cost: 0.1, tiny: true },
      { slug: "alibaba/qwen3.8-flash-next", eligible: true, capable: true, workhorse: true, cost: 0.7, tiny: true }
    ],
    picked: { slug: "z-ai/glm-5.3-flash", eligible: false, cost: 0.1 },
    need: 1,
    reqTokens: 10,
    cx: { score: 0, estInputTokens: 10, images: 0 }
  });
  assert.equal(plan.slug, "alibaba/qwen3.8-flash-next");
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
test("stream terminal outcome: incomplete is an operational failure, cancel never trains, dual-write agrees", () => {
  const cancelled = t.streamTerminalOutcome({ clientCancelled: true, streamError: null, finishSeen: false });
  assert.equal(cancelled.success, 0);
  assert.equal(cancelled.failure_class, "cancelled");
  assert.equal(cancelled.observe, false, "a client cancel must never move the posterior");
  assert.equal(cancelled.health_impact, 0, "a cancel is not a route failure");
  assert.equal(cancelled.trajectory_status, "cancelled", "dual-write must not log a cancel as ok");

  const err = t.streamTerminalOutcome({ clientCancelled: false, streamError: "boom", finishSeen: false });
  assert.equal(err.success, 0);
  assert.equal(err.failure_class, "stream_error");
  assert.equal(err.observe, true);
  assert.equal(err.health_impact, 1);
  assert.equal(err.trajectory_status, "fail");

  // The core fix: a stream that produced some bytes but closed without a
  // finish_reason is NOT a Bayesian win — success must be 0.
  const incomplete = t.streamTerminalOutcome({ clientCancelled: false, streamError: null, finishSeen: false });
  assert.equal(incomplete.success, 0, "no valid terminal completion is an operational failure, not a partial win");
  assert.equal(incomplete.failure_class, "stream_incomplete");
  assert.equal(incomplete.observe, true, "an incomplete stream still trains the posterior — as a failure");
  assert.equal(incomplete.trajectory_status, "fail");

  const ok = t.streamTerminalOutcome({ clientCancelled: false, streamError: null, finishSeen: true });
  assert.equal(ok.success, 1);
  assert.equal(ok.failure_class, "success");
  assert.equal(ok.trajectory_status, "ok");

  // Cancel wins over a late error flag; the user abandoned the stream first.
  const cancelWins = t.streamTerminalOutcome({ clientCancelled: true, streamError: "late", finishSeen: false });
  assert.equal(cancelWins.failure_class, "cancelled");

  // Dual-write invariant both systems depend on: a success posterior observation
  // (success===1) exists iff the trajectory logs "ok"; every other outcome that
  // is observed logs "fail", and the one unobserved outcome logs "cancelled".
  for (const o of [cancelled, err, incomplete, ok]) {
    assert.equal(o.success === 1, o.trajectory_status === "ok");
    assert.equal(o.health_impact === 1, o.observe === true);
    if (!o.observe) assert.equal(o.trajectory_status, "cancelled");
  }
});

test("routerHealth excludes cancelled streams from the V1 ok-rate", async () => {
  const { createDb } = await import("../../server/db.mjs");
  const { readFileSync } = await import("node:fs");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const c = { env: { DB: db } };
  const now = new Date().toISOString();
  const ins = (id, status) => db.prepare(
    "INSERT INTO trajectories (id, created_at, slug, status, latency_ms) VALUES (?,?,?,?,?)"
  ).bind(id, now, "glm", status, 100).run();
  ins("a", "ok");
  ins("b", "fail");
  ins("c", "cancelled");
  t.__resetRouterHealthCache();
  const rows = await t.routerHealth(c);
  const glm = rows.find((r) => r.slug === "glm");
  assert.ok(glm, "glm has health rows");
  assert.equal(Number(glm.n), 2, "cancelled is excluded from the sample entirely (ok + fail only)");
  assert.equal(Number(glm.ok_rate), 0.5, "1 ok of 2 real completions; the cancel neither helps nor hurts");
  t.__resetRouterHealthCache();
});
test("POST /v1/chat/completions reaches the provider (regression: tool-repair import missing → ReferenceError 500)", async () => {
  // This is the layer 42ecf8d shipped broken: runChatCompletion calls
  // applyToolRepairPolicyToPayload on every request. With no import it threw a
  // ReferenceError before routing, which Hono surfaced as a plaintext
  // "Internal Server Error" 500 for every model. Unit tests over __test exports
  // never touch this path, so only a real request through createApp catches it.
  const { createApp } = await import("../src/index.js");
  const { createDb } = await import("../../server/db.mjs");
  const { readFileSync } = await import("node:fs");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key-please-change", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").bind("sk-test", "t", 1, "usd", 1e9, now, now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(1, "P", "http://up.local/v1", "direct", "openai", 1, 1, "round_robin", now).run();
  const sealed = await t.sealProviderKey(env, "up-secret");
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)").bind(1, sealed, "primary", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)").bind("m", 1, "up-m").run();

  const realFetch = globalThis.fetch;
  let sawUpstream = false;
  globalThis.fetch = async (url) => {
    sawUpstream = true;
    return new Response(
      JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const app = createApp(env);
    const res = await app.fetch(new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] })
    }));
    const text = await res.text();
    assert.notEqual(text, "Internal Server Error", "handler must not throw uncaught before routing");
    assert.equal(res.status, 200, "the request reaches the provider and returns its completion");
    assert.ok(sawUpstream, "the request actually got past payload prep to the upstream forward");
    const body = JSON.parse(text);
    assert.equal(body.choices[0].message.content, "hi");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("/admin/router/reconcile gates route conclusions on health samples and exposes dual-write drift", async () => {
  const { createApp } = await import("../src/index.js");
  const { createDb } = await import("../../server/db.mjs");
  const { readFileSync } = await import("node:fs");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();

  const attSeq = { n: 0 };
  const att = (slug, success, healthImpact, cls, opts = {}) => {
    attSeq.n++;
    const reqId = opts.req_id || ("r" + attSeq.n);
    db.prepare(
      "INSERT INTO route_attempts (request_id, public_slug, route_id, task_type, success, health_impact, failure_class, latency_ms, ttft_ms, started_at, finished_at, fallback_from_route_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(reqId, slug, opts.route_id ?? 7, opts.task_type ?? "chat:casual", success, healthImpact, cls ?? null, opts.latency ?? 100, opts.ttft ?? 50, now, now, opts.fallback_from ?? null).run();
    return reqId;
  };

  // noisy route: 7 health samples — below the 20-sample floor, so 4/7 must
  // never read as a meaningful 57% reliability.
  for (let i = 0; i < 4; i++) att("noisy", 1, 1, "success", { latency: 100 + i });
  for (let i = 4; i < 7; i++) att("noisy", 0, 1, "upstream_5xx", { latency: 300 });
  // mature route: 50 health samples, 45 ok / 5 fail — normal confidence.
  for (let i = 0; i < 45; i++) att("mature", 1, 1, "success", { latency: 80, ttft: 40, req_id: "m" + i });
  for (let i = 45; i < 50; i++) att("mature", 0, 1, "stream_incomplete", { latency: 1200, req_id: "m" + i });
  // excluded classes must not count toward maturity
  att("mature", 0, 0, "cancelled", {});
  att("mature", 0, 0, "auth", {});
  // one fallback into mature from another route
  att("mature", 1, 1, "success", { fallback_from: 6 });

  // trajectories: match most mature requests, but flip one verdict so the
  // agreement layer must surface a mismatch by ID (not body).
  for (let i = 0; i < 45; i++)
    db.prepare("INSERT INTO trajectories (id, created_at, slug, status, provider) VALUES (?,?,?,?,?)").bind("m" + i, now, "mature", "ok", "P").run();
  db.prepare("INSERT INTO trajectories (id, created_at, slug, status, provider) VALUES (?,?,?,?,?)").bind("m45", now, "mature", "ok", "P").run();
  // a trajectory with no matching attempt row (cache hit / pre-forward reject)
  db.prepare("INSERT INTO trajectories (id, created_at, slug, status, provider) VALUES (?,?,?,?,?)").bind("lonely", now, "mature", "ok", "P").run();

  const app = createApp(env);
  const res = await app.fetch(new Request("http://gw/admin/router/reconcile", { headers: { authorization: "Bearer admin" } }));
  assert.equal(res.status, 200, "read-only reconcile behind requireAdmin");
  const body = await res.json();

  const noisy = body.by_route.find((r) => r.slug === "noisy");
  assert.ok(noisy, "noisy route present");
  assert.equal(noisy.health_samples, 7);
  assert.equal(noisy.decision_readiness.status, "insufficient_sample", "7 samples is below the 20 floor");
  assert.equal(noisy.decision_readiness.minimum_health_samples, 20);
  assert.equal(noisy.excluded_attempts, 0, "no exclusions on noisy");

  const mature = body.by_route.find((r) => r.slug === "mature");
  assert.ok(mature, "mature route present");
  assert.equal(mature.health_samples, 51, "45 ok + 5 incomplete + 1 fallback; cancelled/auth excluded");
  assert.equal(mature.decision_readiness.status, "normal", "50+ samples is full confidence");
  assert.equal(mature.cancelled, 1, "the cancelled attempt is reported but excluded from health");
  assert.equal(mature.excluded_attempts, 2, "cancelled + auth are both excluded");
  assert.equal(mature.stream_incomplete, 5);
  assert.equal(mature.fallback_in, 1);
  assert.ok(mature.fallback_rate > 0, "fallback rate is populated");
  assert.equal(Object.keys(mature.task_types).length, 1, "task-type breakdown is populated");
  assert.notEqual(mature.latency_ms.p50, null, "latency percentiles populated");

  // The agreement layer: m45 is attempt-fail but trajectory-ok, so exactly
  // one status mismatch must surface by ID, and 'lonely' is an unmatched
  // trajectory.
  assert.equal(body.agreement.status_mismatches, 1, "attempt-fail vs trajectory-ok is a mismatch");
  assert.equal(body.agreement.mismatch_examples[0].request_id, "m45");
  assert.ok(!JSON.stringify(body.agreement.mismatch_examples[0]).includes("response_json"), "mismatch examples carry IDs only, no bodies");
  assert.equal(body.agreement.unmatched_trajectory_count, 1, "'lonely' has no attempt row");
  assert.equal(body.agreement.unmatched_trajectories[0].id, "lonely");
  assert.ok(body.agreement.matched_requests >= 45, "the 45 matching mature requests join");

  // Excluded classes must not be in the health failure-class table.
  assert.equal(body.by_failure_class["cancelled"], undefined, "cancelled is not a health failure class");
  assert.equal(body.by_failure_class["auth"], undefined, "auth is not a health failure class");
  assert.equal(body.by_failure_class["stream_incomplete"], 5, "stream_incomplete is a health failure");

  // An unauthenticated request must not see any of this.
  const nope = await app.fetch(new Request("http://gw/admin/router/reconcile"));
  assert.equal(nope.status, 401, "reconcile requires admin");
});

test("fallback lineage: the winning attempt after a 5xx route records fallback_from_route_id", async () => {
  // Two routes share slug "m". The first provider 5xxes every time; the
  // gateway must fail over to the second route and the surviving
  // route_attempts row must name the route it fell back FROM — otherwise the
  // posterior learns the fallback's outcome against the wrong route.
  const { createApp } = await import("../src/index.js");
  const { createDb } = await import("../../server/db.mjs");
  const { readFileSync } = await import("node:fs");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key-please-change", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").bind("sk-test", "t", 1, "usd", 1e9, now, now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (1,'Bad','http://bad.local/v1','direct','openai',1,1,'round_robin',?)").bind(now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (2,'Good','http://good.local/v1','direct','openai',1,1,'round_robin',?)").bind(now).run();
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)").bind(1, await t.sealProviderKey(env, "bad-secret"), "k1", now).run();
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)").bind(2, await t.sealProviderKey(env, "good-secret"), "k2", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)").bind("m", 1, "up-m").run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,1,1)").bind("m", 2, "up-m").run();
  const badRouteId = db.prepare("SELECT id FROM model_routes WHERE provider_id=1").all().results[0].id;
  const goodRouteId = db.prepare("SELECT id FROM model_routes WHERE provider_id=2").all().results[0].id;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("bad.local"))
      return new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 500, headers: { "content-type": "application/json" } });
    if (u.includes("good.local"))
      return new Response(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "from-second" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("unexpected " + u, { status: 500 });
  };
  try {
    const app = createApp(env);
    const res = await app.fetch(new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] })
    }));
    assert.equal(res.status, 200, "the request survives the dead first route");
    const body = await res.json();
    assert.equal(body.choices[0].message.content, "from-second");

    const atts = db.prepare("SELECT route_id, success, fallback_from_route_id FROM route_attempts WHERE public_slug='m' ORDER BY id").all().results;
    const badAtts = atts.filter((a) => a.route_id === badRouteId);
    const goodAtts = atts.filter((a) => a.route_id === goodRouteId);
    assert.ok(badAtts.length >= 1, "dead-route attempts are recorded");
    assert.ok(badAtts.every((a) => a.success === 0), "dead-route attempts are failures");
    assert.ok(badAtts.every((a) => a.fallback_from_route_id == null), "the first route did not fall back from anything");
    assert.ok(goodAtts.length >= 1, "the winning route attempt is recorded");
    const win = goodAtts[goodAtts.length - 1];
    assert.equal(win.success, 1);
    assert.equal(win.fallback_from_route_id, badRouteId, "the winning attempt names the route it fell back from");
  } finally {
    globalThis.fetch = realFetch;
  }
});
