// Vey World export tests — the invariants the native dataset is built on.
//
// The exporter is pure over injected rows, so every invariant below is
// asserted without a D1 instance. The serving-side query module
// (vey-serve.js) only assembles those rows; these tests pin what a valid
// assembled episode must look like.

import test from "node:test";
import assert from "node:assert/strict";

import {
  exportVeyEpisode,
  aggregateQuality,
  operationalFailureIsNotSemantic,
  VEY_SCHEMA,
  VEY_INTERNALS
} from "../src/export/vey-world.js";

function traj(extra = {}) {
  return {
    id: "req_1",
    created_at: "2026-09-22T00:00:00Z",
    slug: "glm-5.3",
    stream: 0,
    status: "ok",
    prompt_tokens: 100,
    request_json: JSON.stringify({ messages: [{ role: "user", content: "fix the leak" }] }),
    ...extra
  };
}

function attempt(extra = {}) {
  return {
    id: 1,
    request_id: "req_1",
    route_id: 17,
    provider_id: 4,
    public_slug: "glm-5.3",
    upstream_model: "model-x",
    attempt_index: 0,
    success: 1,
    health_impact: 0,
    http_status: 200,
    failure_class: null,
    failure_code: null,
    ttft_ms: 178,
    latency_ms: 1132,
    prompt_tokens: 100,
    completion_tokens: 617,
    actual_cost_usd: 0.0028,
    tool_valid: null,
    tool_success: null,
    ...extra
  };
}

test("the attempt carries the route that served and the time headers arrived", () => {
  const ep = exportVeyEpisode({
    trajectory: traj(),
    attempts: [attempt({ route_id: 22, headers_ms: 640, ttft_ms: 2100 })],
    evidence: new Map(),
    decision: null
  });
  assert.equal(ep.attempts[0].action.route_id, 22, "the serving route is recorded on the attempt");
  assert.equal(ep.attempts[0].outcome.headers_ms, 640);
  assert.equal(ep.attempts[0].outcome.ttft_ms, 2100, "first token stays distinct from headers");
});

test("episode carries the vey.world.v1 schema and the request id", () => {
  const ep = exportVeyEpisode({ trajectory: traj(), attempts: [attempt()], evidence: new Map(), decision: null });
  assert.equal(ep.schema, VEY_SCHEMA);
  assert.equal(ep.id, "req_1");
  assert.equal(ep.state.stream, false);
  assert.deepEqual(ep.state.messages, [{ role: "user", content: "fix the leak" }]);
});

test("a failed transport exports quality null, never 0", () => {
  const ep = exportVeyEpisode({
    trajectory: traj({ status: "error" }),
    attempts: [attempt({ success: 0, http_status: null, failure_class: "timeout", failure_code: "upstream_timeout", latency_ms: 30124, completion_tokens: 0 })],
    evidence: new Map([[1, [{ signal_type: "tool_valid", value: 1, weight: 1, objective: 1 }]]]),
    decision: null
  });
  const o = ep.attempts[0].outcome;
  assert.equal(o.operational_success, false);
  assert.equal(o.failure_class, "timeout");
  assert.equal(o.quality, null, "an operational failure must not score the answer");
  assert.equal(o.quality_weight, 0);
  assert.equal(o.quality_objective, null);
  // The foundational invariant, as a named predicate.
  assert.equal(operationalFailureIsNotSemantic(ep.attempts[0].attempt ? null : { success: 0, failure_class: "timeout", http_status: null }), true);
});

test("OpsWorld failure MUST NOT create SemanticWorld evidence", () => {
  const failed = attempt({ success: 0, failure_class: "stream_incomplete", failure_code: "premature_eof" });
  const ep = exportVeyEpisode({ trajectory: traj(), attempts: [failed], evidence: new Map(), decision: null });
  assert.equal(ep.attempts[0].outcome.operational_success, false);
  assert.equal(ep.attempts[0].outcome.quality, null);
  assert.equal(ep.terminal.operational_success, false);
  assert.equal(ep.terminal.semantic_evidence, false);
  assert.equal(ep.terminal.quality, null);
  assert.equal(ep.terminal.reward, null);
});

test("a bare 200 with no semantic evidence still has quality null", () => {
  const ep = exportVeyEpisode({ trajectory: traj(), attempts: [attempt()], evidence: new Map(), decision: null });
  assert.equal(ep.attempts[0].outcome.operational_success, true);
  assert.equal(ep.attempts[0].outcome.quality, null, "a 200 is not evidence about the answer");
  assert.equal(ep.terminal.quality, null);
  assert.equal(ep.terminal.semantic_evidence, false);
});

test("tool/test/verifier evidence populates quality via weighted mean", () => {
  const ep = exportVeyEpisode({
    trajectory: traj(),
    attempts: [attempt()],
    evidence: new Map([[1, [
      { signal_type: "tool_valid", value: 1, weight: 0.2, objective: 1 },
      { signal_type: "tool_success", value: 1, weight: 0.9, objective: 1 }
    ]]]),
    decision: null
  });
  assert.equal(ep.attempts[0].outcome.quality, 1);
  assert.equal(ep.attempts[0].outcome.quality_weight, 1.1);
  assert.equal(ep.attempts[0].outcome.quality_objective, true);
  assert.equal(ep.terminal.semantic_evidence, true);
  assert.equal(ep.terminal.quality, 1);
});

test("quality evidence attaches to the correct attempt only", () => {
  const ep = exportVeyEpisode({
    trajectory: traj(),
    attempts: [
      attempt({ id: 1, attempt_index: 0, success: 0, failure_class: "timeout" }),
      attempt({ id: 2, attempt_index: 1, route_id: 34 })
    ],
    evidence: new Map([[2, [{ signal_type: "tool_success", value: 1, weight: 1, objective: 1 }]]]),
    decision: null
  });
  assert.equal(ep.attempts[0].outcome.quality, null, "evidence must not leak into the failed attempt");
  assert.equal(ep.attempts[0].outcome.quality_evidence.length, 0);
  assert.equal(ep.attempts[1].outcome.quality, 1);
  assert.equal(ep.attempts[1].outcome.quality_evidence.length, 1);
  assert.equal(ep.attempts[1].action.route_id, 34);
});

test("fallback preserves policy intent versus the served action", () => {
  const ep = exportVeyEpisode({
    trajectory: traj(),
    attempts: [
      attempt({ id: 1, attempt_index: 0, route_id: 17, success: 0, failure_class: "timeout", fallback_from_route_id: null }),
      attempt({ id: 2, attempt_index: 1, route_id: 22, success: 0, failure_class: "connection_reset", fallback_from_route_id: 17 }),
      attempt({ id: 3, attempt_index: 2, route_id: 34, fallback_from_route_id: 22 })
    ],
    evidence: new Map(),
    decision: null
  });
  assert.equal(ep.execution.initial_action, "route:17");
  assert.equal(ep.execution.served_action, "route:34");
  assert.equal(ep.execution.attempt_count, 3);
  assert.equal(ep.execution.fallback_used, true);
  assert.equal(ep.attempts[2].outcome.operational_success, true);
});

test("an all-failed episode is exported with response null", () => {
  const ep = exportVeyEpisode({
    trajectory: traj({ status: "error", response_json: null }),
    attempts: [
      attempt({ id: 1, attempt_index: 0, success: 0, failure_class: "timeout" }),
      attempt({ id: 2, attempt_index: 1, success: 0, failure_class: "provider_503", http_status: 503 })
    ],
    evidence: new Map(),
    decision: null
  });
  assert.equal(ep.response, null);
  assert.equal(ep.terminal.operational_success, false);
  assert.equal(ep.terminal.quality, null);
  assert.equal(ep.attempts.length, 2);
  assert.equal(ep.execution.served_action, null);
});

test("health_impact separates caller-side failures from route unreliability", () => {
  const ep = exportVeyEpisode({
    trajectory: traj(),
    attempts: [attempt({ success: 0, failure_class: "auth_rejected", health_impact: 0 })],
    evidence: new Map(),
    decision: null
  });
  assert.equal(ep.attempts[0].outcome.operational_success, false);
  assert.equal(ep.attempts[0].outcome.health_impact, false, "auth rejection must not train route unreliable");
  assert.ok(VEY_INTERNALS.CALLER_SIDE.has("auth_rejected"));
  const real = exportVeyEpisode({
    trajectory: traj(),
    attempts: [attempt({ success: 0, failure_class: "timeout", health_impact: 1 })],
    evidence: new Map(),
    decision: null
  });
  assert.equal(real.attempts[0].outcome.health_impact, true);
});

test("deterministic policy exports propensity null, never invented", () => {
  const ep = exportVeyEpisode({ trajectory: traj(), attempts: [attempt()], evidence: new Map(), decision: null });
  assert.equal(ep.policy.propensity, null);
  assert.equal(ep.policy.exploration, false);
  assert.equal(ep.policy.decision_type, null);
  assert.equal(ep.candidate_set, null);
  assert.equal(ep.provenance.decision_snapshot, "unavailable");
});

test("a decision snapshot attaches its candidate set and policy", () => {
  const decision = {
    policy_name: "router-v2",
    policy_version: "router-v2@0a3a81c",
    selected_action_id: "route:17",
    propensity: null,
    exploration: 0,
    decision_type: "deterministic",
    task_ir_version: "taskir-v1",
    candidate_set_json: JSON.stringify([
      { action_id: "route:17", route_id: 17, eligible: true },
      { action_id: "route:22", route_id: 22, eligible: false }
    ])
  };
  const ep = exportVeyEpisode({ trajectory: traj(), attempts: [attempt()], evidence: new Map(), decision });
  assert.equal(ep.policy.name, "router-v2");
  assert.equal(ep.policy.version, "router-v2@0a3a81c");
  assert.equal(ep.policy.selected_action, "route:17");
  assert.equal(ep.policy.decision_type, "deterministic");
  assert.equal(ep.state.task_ir.version, "taskir-v1");
  assert.equal(ep.candidate_set.length, 2, "rejected candidates must be kept");
  assert.equal(ep.candidate_set[1].eligible, false);
  assert.equal(ep.provenance.decision_snapshot, "present");
});

test("a malformed candidate snapshot is marked invalid, not silently present", () => {
  const ep = exportVeyEpisode({
    trajectory: traj(),
    attempts: [attempt()],
    evidence: new Map(),
    decision: { candidate_set_json: "{not json", policy_name: "router-v2" }
  });
  assert.equal(ep.candidate_set, null);
  assert.equal(ep.provenance.decision_snapshot, "invalid", "pipelines must be able to filter corrupt snapshots");
  const notArray = exportVeyEpisode({
    trajectory: traj(),
    attempts: [attempt()],
    evidence: new Map(),
    decision: { candidate_set_json: JSON.stringify({ oops: true }) }
  });
  assert.equal(notArray.candidate_set, null);
  assert.equal(notArray.provenance.decision_snapshot, "invalid");
});

test("reward stays null in the raw dataset", () => {
  const ep = exportVeyEpisode({
    trajectory: traj(),
    attempts: [attempt()],
    evidence: new Map([[1, [{ signal_type: "tool_success", value: 0.9, weight: 1, objective: 1 }]]]),
    decision: null
  });
  assert.equal(ep.terminal.quality, 0.9);
  assert.equal(ep.terminal.reward, null, "observations and reward recipes stay separate");
});

test("aggregateQuality derives the weighted mean from raw evidence", () => {
  const q = aggregateQuality([
    { signal_type: "tool_valid", value: 1, weight: 0.2, objective: 1 },
    { signal_type: "tool_success", value: 0.8, weight: 0.8, objective: 1 }
  ]);
  assert.equal(q.quality, 0.84);
  assert.equal(q.quality_weight, 1);
  assert.equal(q.quality_objective, true);
  assert.equal(aggregateQuality([]), null);
  assert.equal(aggregateQuality([{ signal_type: "x", value: 1, weight: 0 }]), null);
});

test("caller-side and 5xx failures are classified as operational", () => {
  assert.equal(VEY_INTERNALS.isOperationalFailure("timeout", null), true);
  assert.equal(VEY_INTERNALS.isOperationalFailure("provider_503", 503), true);
  assert.equal(VEY_INTERNALS.isOperationalFailure(null, 500), true);
  assert.equal(VEY_INTERNALS.isOperationalFailure("client_cancelled", 499), false);
  assert.equal(VEY_INTERNALS.isOperationalFailure(null, null), false);
});

test("state context is pre-action only and separates offered tools from history", () => {
  // The request body carries 2 offered tool definitions, one image, an
  // assistant tool_call and a tool result in history. Prompt tokens are
  // post-action usage and must not leak into state.
  const ep = exportVeyEpisode({
    trajectory: traj({
      prompt_tokens: 99999,
      request_json: JSON.stringify({
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "x" } }] },
          { role: "assistant", content: "ok", tool_calls: [{ id: "t1", function: { name: "run" } }] },
          { role: "tool", tool_call_id: "t1", name: "run", content: "done" }
        ],
        tools: [{ type: "function", function: { name: "run" } }, { type: "function", function: { name: "read" } }]
      })
    }),
    attempts: [attempt()],
    evidence: new Map(),
    decision: null
  });
  const ctx = ep.state.context;
  assert.equal(ctx.available_tool_count, 2, "request.tools must be reflected in available_tool_count");
  assert.equal(ctx.has_available_tools, true);
  assert.equal(ctx.tool_calls_in_history, 1);
  assert.equal(ctx.tool_results_in_history, 1);
  assert.equal(ctx.image_count, 1);
  assert.equal(ctx.token_source, "request_approximation");
  assert.notEqual(ctx.estimated_input_tokens, 99999, "post-action prompt_tokens must never leak into state");
  assert.ok(ctx.estimated_input_tokens > 0);
});

test("a first-turn agent request with tools and empty history is labelled correctly", () => {
  const defs = Array.from({ length: 50 }, (_, i) => ({ type: "function", function: { name: "tool_" + i } }));
  const ep = exportVeyEpisode({
    trajectory: traj({ request_json: JSON.stringify({ messages: [{ role: "user", content: "go" }], tools: defs }) }),
    attempts: [attempt()],
    evidence: new Map(),
    decision: null
  });
  assert.equal(ep.state.context.available_tool_count, 50);
  assert.equal(ep.state.context.has_available_tools, true);
  assert.equal(ep.state.context.tool_calls_in_history, 0);
  assert.equal(ep.state.context.tool_results_in_history, 0);
});

test("a decision snapshot supplies context tokens and the token source", () => {
  const decision = {
    policy_name: "router-v2",
    policy_version: "router-v2@x",
    context_features_json: JSON.stringify({ context_tokens: 2811, difficulty: 0.68 }),
    candidate_set_json: JSON.stringify([{ action_id: "route:17", route_id: 17 }])
  };
  const ep = exportVeyEpisode({ trajectory: traj(), attempts: [attempt()], evidence: new Map(), decision });
  assert.equal(ep.state.context.estimated_input_tokens, 2811);
  assert.equal(ep.state.context.token_source, "decision_snapshot");
});
