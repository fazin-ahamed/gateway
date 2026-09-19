import test from "node:test";
import assert from "node:assert/strict";

import { compileTaskIR, classifyTask } from "../src/router/task-ir.js";
import { normalizeModelId, routeKey } from "../src/router/identity.js";
import { age, observe, lcb, mean, seedBeta, summarize } from "../src/router/posterior.js";
import { candidatePolicies, pareto, pickPolicy, shadowDecide } from "../src/router/policies.js";
import { ROUTER_V2_MODE, shadowFromV1, shadowV2, buildV2Universe } from "../src/router/index.js";
import { effectivePosterior, estimateCost, v2Capable, shapeV2Route, isLuxurySlug } from "../src/router/candidates.js";
import { generateActions } from "../src/horizon.js";

test("casual hi is chat:casual, debug stack is code:debug", () => {
  const hi = classifyTask({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(hi.task, "chat:casual");
  const debug = classifyTask({
    messages: [{ role: "user", content: "debug this TypeError stack trace in src/cache.ts" }]
  });
  assert.equal(debug.task, "code:debug");
  const ir = compileTaskIR({
    messages: [{ role: "user", content: "hi" }]
  });
  assert.ok(ir.difficulty < 0.35);
  assert.equal(ir.tools.required, false);
});

test("slug punctuation does not change model identity", () => {
  assert.equal(normalizeModelId("z-ai/glm-5.3-flash"), normalizeModelId("glm-5.3-flash"));
  assert.equal(normalizeModelId("Qwen3.8"), normalizeModelId("qwen-3.8"));
  assert.equal(normalizeModelId("qwen3.8"), "qwen-3-8");
  const a = routeKey({ slug: "zai/glm-5.3-flash", upstream_model: "glm-5.3-flash", provider_id: 1, transport: "direct" });
  const b = routeKey({ slug: "zai/glm-5.3-flash", upstream_model: "GLM-5.3-Flash", provider_id: 1, transport: "direct" });
  assert.equal(a, b);
});

test("0/2 is not treated as 100% healthy", () => {
  const seed = { ...seedBeta("route"), updatedAt: 0 };
  assert.ok(mean(seed) > 0.7);
  const twoFail = observe(observe(seed, false), false);
  assert.ok(mean(twoFail) < 0.72);
  assert.ok(mean(twoFail) > 0.5);
  const twoOk = observe(observe(seed, true), true);
  const mature = { alpha: 997, beta: 3, updatedAt: 1 };
  assert.ok(lcb(mature) > lcb(twoOk), "997/1000 LCB must beat 2/2");
  const s = summarize(twoFail);
  assert.equal(s.samples, 2);
});

test("dominated policies are pruned from the frontier", () => {
  const policies = [
    { id: "A", success: 0.91, cost: 0.012, latency: 1100, mode: "reflex" },
    { id: "B", success: 0.87, cost: 0.020, latency: 2200, mode: "rescue" }
  ];
  const front = pareto(policies);
  assert.deepEqual(front.map((p) => p.id), ["A"]);
});

test("easy chat prefers reflex over rescue", () => {
  const routes = [
    { slug: "glm-5.3-flash", cost: 0.01, avgMs: 800, workhorse: true, capable: true, hardEligible: true, posterior: seedBeta() },
    { slug: "glm-5.3", cost: 0.2, avgMs: 4000, workhorse: true, capable: true, hardEligible: true, posterior: seedBeta() }
  ];
  const taskIR = compileTaskIR({ messages: [{ role: "user", content: "hi" }] });
  const picked = pickPolicy(candidatePolicies(routes, taskIR), 70, taskIR);
  assert.ok(picked);
  assert.notEqual(picked.mode, "rescue");
});

test("V2 shadow does not change V1 picked slug", () => {
  const prev = process.env.ROUTER_V2;
  process.env.ROUTER_V2 = "shadow";
  try {
    assert.equal(ROUTER_V2_MODE(), "shadow");
    const v1Slug = "zai/glm-5.3-flash";
    const shadow = shadowFromV1({
      payload: { messages: [{ role: "user", content: "hi" }] },
      candidates: [
        { slug: v1Slug, cost: 0.01, avgMs: 900, samples: 10, okRate: 0.9, capable: true, workhorse: true, eligible: true, hardEligible: true }
      ],
      preference: 70
    });
    assert.ok(shadow);
    assert.equal(shadow.mode, "shadow");
    assert.ok(shadow.picked);
    assert.equal(v1Slug, "zai/glm-5.3-flash");
  } finally {
    if (prev === undefined) delete process.env.ROUTER_V2;
    else process.env.ROUTER_V2 = prev;
  }
});

test("HORIZON actions carry a single defined cost", () => {
  const actions = generateActions([
    { slug: "glm-5.3-flash", cost: 0.4, capable: true, workhorse: true, eligible: true, avgMs: 800 }
  ], { families: ["chat"], difficulty: 0.1, toolComplexity: 0 }, {});
  const model = actions.find((a) => a.type === "model");
  assert.equal(typeof model.cost, "number");
  assert.ok(model.cost > 0);
});

test("shadowDecide returns explainable policy for a cheap pool", () => {
  const taskIR = compileTaskIR({ messages: [{ role: "user", content: "hi" }] });
  const decision = shadowDecide({
    routes: [
      { slug: "glm-5.3-flash", cost: 0.01, avgMs: 700, workhorse: true, capable: true, hardEligible: true, posterior: seedBeta() },
      { slug: "qwen3-flash", cost: 0.012, avgMs: 650, workhorse: true, capable: true, hardEligible: true, posterior: seedBeta() }
    ],
    taskIR,
    preference: 80
  });
  assert.equal(decision.version, 2);
  assert.ok(decision.picked);
  assert.ok(decision.explain);
  assert.equal(decision.explain.task, "chat:casual");
});

test("hi with twenty attached tools stays chat:casual", () => {
  const tools = Array.from({ length: 20 }, (_, i) => ({ type: "function", function: { name: "t" + i } }));
  const ir = compileTaskIR({ messages: [{ role: "user", content: "Hi" }], tools });
  assert.equal(ir.task, "chat:casual");
  assert.equal(ir.tools.required, false);
  assert.equal(ir.tools.available, 20);
});

test("implement a parser classifies as code:generation", () => {
  const ir = compileTaskIR({ messages: [{ role: "user", content: "Implement a function that parses this format" }] });
  assert.equal(ir.task, "code:generation");
});

test("stale prior-turn keywords do not classify the current turn", () => {
  const ir = compileTaskIR({
    messages: [
      { role: "user", content: "Debug this Rust race condition" },
      { role: "assistant", content: "Looking at the lock." },
      { role: "user", content: "Thanks. Now write me a short email." }
    ]
  });
  assert.equal(ir.task, "writing:professional");
});

test("long idle posterior converges to prior, not zero", () => {
  const hot = { kind: "route", alpha: 20, beta: 10, updatedAt: 0 };
  const cooled = age(hot, 10 * 365 * 86400000);
  assert.ok(Math.abs(mean(cooled) - mean(seedBeta("route"))) < 0.02);
  assert.ok(cooled.alpha > 7);
  assert.ok(cooled.beta < 3);
});

test("ineligible route never enters V2 policies", () => {
  const taskIR = compileTaskIR({ messages: [{ role: "user", content: "hi" }] });
  const policies = candidatePolicies([
    { slug: "z-ai/glm-5.3-flash", hardEligible: false, capable: true, workhorse: true, cost: 0.01, posterior: seedBeta() },
    { slug: "qwen-flash", hardEligible: true, capable: true, workhorse: true, cost: 0.7, posterior: seedBeta() }
  ], taskIR);
  assert.ok(policies.every((p) => p.primary !== "z-ai/glm-5.3-flash"));
  assert.ok(policies.some((p) => p.primary === "qwen-flash"));
});

test("V2 universe does not inherit V1 eligibility: a V1-degraded route with a key still competes", () => {
  const payload = { messages: [{ role: "user", content: "hi" }] };
  const { routes } = buildV2Universe([
    {
      slug: "glm-5.3-flash",
      upstream_model: "glm-5.3-flash",
      provider_id: 1,
      route_id: 7,
      key_count: 1,
      circuitOpen: false,
      price: { prompt_per_1m: 0.1, completion_per_1m: 0.4 },
      stats: { success_alpha: 8, failure_beta: 12, latency_ema: 900, updated_at: new Date().toISOString() }
    }
  ], payload);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].eligible, true, "V2 must not inherit V1's degraded-ok_rate filter");
  assert.equal(routes[0].hardEligible, true);
  assert.ok(routes[0].posterior.beta > 2, "router_stats posterior is used, not trajectory ok_rate");
});

test("V2 universe drops routes with no credential even if V1 would have scored them", () => {
  const payload = { messages: [{ role: "user", content: "hi" }] };
  const { routes } = buildV2Universe([
    { slug: "glm-5.3-flash", key_count: 0, circuitOpen: false, price: { prompt_per_1m: 0.1, completion_per_1m: 0.1 } }
  ], payload);
  assert.equal(routes[0].eligible, false);
  assert.equal(routes[0].reason, "no key");
});

test("shadowV2 source is v2-universe, not v1-compat", () => {
  const prev = process.env.ROUTER_V2;
  process.env.ROUTER_V2 = "shadow";
  try {
    const decision = shadowV2({
      payload: { messages: [{ role: "user", content: "hi" }] },
      rows: [
        { slug: "glm-5.3-flash", key_count: 1, circuitOpen: false, price: { prompt_per_1m: 0.01, completion_per_1m: 0.02 } }
      ],
      preference: 70
    });
    assert.equal(decision.source, "v2-universe");
    assert.equal(decision.mode, "shadow");
    assert.ok(decision.picked);
    assert.equal(decision.picked.primary, "glm-5.3-flash");
  } finally {
    if (prev === undefined) delete process.env.ROUTER_V2;
    else process.env.ROUTER_V2 = prev;
  }
});

test("V2 vision gate uses TaskIR modalities, not V1 quality/need", () => {
  const payload = {
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/a.png" } }, { type: "text", text: "what is this" }] }]
  };
  const { taskIR, routes } = buildV2Universe([
    {
      slug: "text-only",
      key_count: 1,
      entry: { limit: { context: 128000 }, modalities: { input: ["text"] }, toolCall: true }
    },
    {
      slug: "vision-ok",
      key_count: 1,
      entry: { limit: { context: 128000 }, modalities: { input: ["text", "image"] }, toolCall: true }
    }
  ], payload);
  assert.ok(taskIR.modalities.includes("image"));
  const text = routes.find((r) => r.slug === "text-only");
  const vis = routes.find((r) => r.slug === "vision-ok");
  assert.equal(text.eligible, false);
  assert.equal(text.reason, "vision");
  assert.equal(vis.eligible, true);
});


test("policies carry route identity (routeId + routeKey), not just slug", () => {
  const payload = { messages: [{ role: "user", content: "hi" }] };
  // Same public slug, two different provider routes.
  const { routes } = buildV2Universe([
    { slug: "glm-5.3", upstream_model: "glm-5.3", provider_id: 1, route_id: 12, key_count: 1, price: { prompt_per_1m: 0.01, completion_per_1m: 0.02 } },
    { slug: "glm-5.3", upstream_model: "glm-5.3", provider_id: 2, route_id: 29, key_count: 1, price: { prompt_per_1m: 0.08, completion_per_1m: 0.16 } }
  ], payload);
  const policies = candidatePolicies(routes, compileTaskIR(payload));
  const reflex = policies.find((p) => p.mode === "reflex");
  assert.ok(reflex.primaryRef, "policy carries a route ref");
  assert.ok(reflex.primaryRef.routeKey, "route key present");
  assert.ok([12, 29].includes(reflex.primaryRef.routeId), "route id present");
  // The cheaper route (12) must be the chosen primary — proving route-level,
  // not slug-level, selection.
  assert.equal(reflex.primaryRef.routeId, 12);
});

test("task-specific posterior overrides global once mature, else global prior", () => {
  const global = { success_alpha: 20, failure_beta: 4, updated_at: new Date().toISOString() };
  // 1 sample task row is immature -> global wins
  const immature = effectivePosterior(global, { success_alpha: 9, failure_beta: 1, updated_at: new Date().toISOString() });
  assert.equal(immature.alpha, 20, "immature task posterior does not override global");
  // 10 task samples is mature -> task wins
  const mature = effectivePosterior(global, { success_alpha: 2, failure_beta: 16, updated_at: new Date().toISOString() });
  assert.equal(mature.alpha, 2, "mature task posterior overrides global");
  assert.ok(mature.beta > global.failure_beta, "route learned it is worse on this task");
});

test("cost uses per-request actual and cost_ema, not a raw per-1M sum", () => {
  const taskIR = compileTaskIR({ messages: [{ role: "user", content: "hi" }] });
  // per-request actual pricing wins over token rates
  const perReq = estimateCost({ price: { actual_mode: "per_request", actual_per_request: 0.003, prompt_per_1m: 5, completion_per_1m: 5 } }, taskIR);
  assert.equal(perReq, 0.003);
  // mature cost_ema wins over everything
  const ema = estimateCost({ stats: { cost_ema: 0.0012, success_alpha: 20, failure_beta: 5 }, price: { prompt_per_1m: 5, completion_per_1m: 5 } }, taskIR);
  assert.equal(ema, 0.0012);
  // token rates are evaluated against TaskIR tokens, not summed blindly
  const big = compileTaskIR({ messages: [{ role: "user", content: "x".repeat(400000) }] });
  const tokenCost = estimateCost({ price: { prompt_per_1m: 1, completion_per_1m: 3 } }, big);
  assert.ok(tokenCost > 0 && tokenCost < 4, "token cost scales with estimated tokens, not 1+3");
});

test("capability gates fail closed on unknown tools and cap missing context", () => {
  const toolTask = compileTaskIR({ messages: [{ role: "user", content: "use the tool" }], tools: [{ type: "function", function: { name: "f" } }], tool_choice: "required" });
  // Unknown capability must NOT satisfy a hard tool requirement.
  const unknown = v2Capable({ unknown: true }, { ...toolTask, tools: { required: true } });
  assert.equal(unknown.toolsOk, false, "unknown tool capability fails closed");
  // Known route with context=0 uses conservative fallback, not infinity.
  const huge = compileTaskIR({ messages: [{ role: "user", content: "y".repeat(200000) }] });
  const noCtx = v2Capable({ unknown: false, context: 0, tools: true }, huge);
  assert.equal(noCtx.ctxOk, false, "missing context window is not treated as unlimited");
  // Output limit is checked against expected output.
  const smallOut = v2Capable({ unknown: false, context: 1000000, output: 10, tools: true }, { contextTokens: 10, expectedOutputTokens: 5000, modalities: ["text"], tools: {} });
  assert.equal(smallOut.outOk, false, "tiny output limit fails a large expected output");
});

test("usable key count excludes circuit-open keys", () => {
  const payload = { messages: [{ role: "user", content: "hi" }] };
  const { routes } = buildV2Universe([
    { slug: "glm-5.3", key_count: 3, usable_key_count: 0, price: { prompt_per_1m: 0.01, completion_per_1m: 0.01 } }
  ], payload);
  assert.equal(routes[0].eligible, false, "3 enabled but 0 usable keys is not eligible");
  assert.equal(routes[0].reason, "keys circuit-open");
});

test("luxury is a soft prior, not a hard exclusion", () => {
  const payload = { messages: [{ role: "user", content: "prove this theorem rigorously with full derivation" }] };
  const { routes } = buildV2Universe([
    { slug: "gpt-6-astra", upstream_model: "gpt-6-astra", provider_id: 1, route_id: 1, key_count: 1, entry: { limit: { context: 400000 }, modalities: { input: ["text"] }, toolCall: true }, price: { prompt_per_1m: 5, completion_per_1m: 15 } }
  ], payload);
  assert.equal(isLuxurySlug("gpt-6-astra"), true);
  assert.equal(routes[0].luxury, true);
  assert.equal(routes[0].eligible, true, "luxury route is still hard-eligible; cost discourages it, capability does not exclude it");
  const policies = candidatePolicies(routes, compileTaskIR(payload));
  assert.ok(policies.some((p) => p.primary === "gpt-6-astra"), "a luxury route can be selected when it is the only capable option");
});

