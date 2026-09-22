// Vey World export — the native (state, candidates, action) → outcome dataset.
//
// The other exporters (openai/sharegpt/trl/rl) answer "what was said?". Vey
// answers a different question a future tiny HORIZON/Vey decision model needs:
//
//     (state, candidates, policy, action) → (operations, semantics, cost, latency)
//
// Two worlds are kept strictly separate:
//
//     OpsWorld      transport/runtime outcome  (route/provider-scoped)
//     SemanticWorld answer/task quality        (canonical-model-scoped)
//
// The foundational invariant: an operational failure is NOT semantic evidence.
// A timeout means the answer was never delivered, not that it would have been
// bad. Those attempts export quality: null, never quality: 0. Teaching
// P(transport survives | state, route) must not also teach
// P(model produces bad answers | route) = 1.
//
// Reward is deliberately null in the raw dataset. Observations and reward
// recipes stay separate so the same episodes can be reprocessed under a new
// objective (R = quality, or quality − cost − latency, or a hard transport
// gate) without rewriting history. A derived reward belongs to an export for
// a specific RL run, not to the canonical record.
//
// Candidate sets are HISTORICAL TRUTH. This module never reconstructs them
// from the current model_routes table — a request from yesterday routed
// against today's route table is fake training data. When no decision-time
// snapshot exists the record says so:
//
//     candidate_set: null
//     provenance.decision_snapshot: "unavailable"
//
// All inputs are injected: this module touches no database. The caller passes
// the trajectory row, its attempts, quality evidence, and (when present) the
// decision snapshot. Assembly is pure, so every invariant below is testable
// without a D1 instance.

export const VEY_SCHEMA = "vey.world.v1";

const OPERATIONAL_FAILURES = new Set([
  "timeout",
  "connection_reset",
  "connection_refused",
  "provider_503",
  "provider_500",
  "provider_429",
  "stream_incomplete",
  "premature_eof",
  "upstream_socket_closed",
  "credential_failure",
  "auth_rejected",
  "rate_limited",
  "dns_failure",
  "tls_failure"
]);

// The failure classes that say nothing about the route's own reliability.
// Caller-side causes (bad payload, auth, unsupported capability, client
// cancel) keep health_impact false so they do not poison route posteriors.
const CALLER_SIDE = new Set([
  "caller_payload",
  "auth_rejected",
  "client_cancelled",
  "unsupported_capability",
  "not_found",
  "policy_rejected"
]);

function isOperationalFailure(failureClass, httpStatus) {
  if (OPERATIONAL_FAILURES.has(failureClass))
    return true;
  if (httpStatus && Number(httpStatus) >= 500)
    return true;
  return false;
}

function isOperationalSuccess(attempt) {
  if (attempt.success === 1 || attempt.success === true)
    return true;
  // A success has no failure classification; presence of one means the
  // transport did not complete cleanly.
  return !attempt.failure_class && !attempt.failure_code && attempt.success !== 0;
}

// Semantic evidence is only what spoke about the ANSWER after acting: a tool
// call that validated and executed, a verifier score, explicit user feedback.
// A bare 200 creates no quality observation and must not manufacture one.
function outcomeQuality(evidence) {
  if (!evidence || evidence.length === 0)
    return null;
  let weight = 0;
  let acc = 0;
  let objective = null;
  for (const obs of evidence) {
    const w = Number(obs.weight) || 0;
    acc += (Number(obs.value) || 0) * w;
    weight += w;
    if (obs.objective === 1 || obs.objective === true) {
      if (objective === null)
        objective = true;
      else if (!obs.value)
        objective = false;
    }
  }
  if (weight === 0)
    return null;
  return {
    quality: Math.round((acc / weight) * 10000) / 10000,
    quality_weight: Math.round(weight * 1000) / 1000,
    quality_objective: objective
  };
}

function asQualityEvidence(rows) {
  if (!rows)
    return [];
  return rows.map((r) => ({
    type: r.signal_type,
    value: Number(r.value),
    weight: Number(r.weight) || 0,
    objective: r.objective === 1 || r.objective === true
  }));
}

// Build one attempt's outcome. quality comes ONLY from request-local evidence
// attached to that attempt; the historical candidate belief is never copied
// in as the outcome.
function buildAttempt(attempt, evidence) {
  const opSuccess = isOperationalSuccess(attempt);
  const quality = opSuccess ? outcomeQuality(evidence) : null;
  return {
    attempt_index: attempt.attempt_index ?? 0,
    action: {
      route_id: attempt.route_id ?? null,
      provider_id: attempt.provider_id ?? null,
      canonical_model_id: attempt.canonical_model_id ?? null
    },
    outcome: {
      operational_success: opSuccess,
      http_status: attempt.http_status ?? null,
      failure_class: attempt.failure_class ?? null,
      failure_code: attempt.failure_code ?? null,
      health_impact: attempt.health_impact === 1 || attempt.health_impact === true,
      ttft_ms: attempt.ttft_ms ?? null,
      latency_ms: attempt.latency_ms ?? null,
      prompt_tokens: attempt.prompt_tokens ?? 0,
      completion_tokens: attempt.completion_tokens ?? 0,
      actual_cost_usd: attempt.actual_cost_usd ?? null,
      tool_valid: attempt.tool_valid === null || attempt.tool_valid === undefined
        ? null
        : attempt.tool_valid === 1 || attempt.tool_valid === true,
      tool_success: attempt.tool_success === null || attempt.tool_success === undefined
        ? null
        : attempt.tool_success === 1 || attempt.tool_success === true,
      quality: quality ? quality.quality : null,
      quality_weight: quality ? quality.quality_weight : 0,
      quality_objective: quality ? quality.quality_objective : null,
      quality_evidence: asQualityEvidence(evidence)
    }
  };
}

// The terminal aggregate of the whole episode: what the caller actually got.
function buildTerminal(attempts, response) {
  const served = attempts.filter((a) => a.outcome.operational_success);
  const last = served.length ? served[served.length - 1] : null;
  const opSuccess = Boolean(last);
  const quality = last ? outcomeQuality(last.outcome.quality_evidence) : null;
  return {
    operational_success: opSuccess,
    semantic_evidence: Boolean(quality),
    quality: quality ? quality.quality : null,
    reward: null
  };
}

// exportVeyEpisode: assemble one vey.world.v1 record. All inputs injected.
//
//   trajectory   trajectories row (id, created_at, slug, stream, status, ...)
//   attempts     route_attempts rows for this request_id, in attempt order
//   evidence     { attemptIndex | routeAttemptId -> quality_observations rows }
//   decision     router_decisions row when a decision-time snapshot exists,
//                else null. Never reconstruct one here.
//   response     parsed response body (may be null for an all-failed episode)
export function exportVeyEpisode({ trajectory, attempts = [], evidence = new Map(), decision = null, response = null }) {
  const request = parseRequest(trajectory);
  const built = attempts.map((a, i) => {
    const key = a.id ?? i;
    return buildAttempt(a, evidence.get(key) || []);
  });

  // Policy intent vs actual execution. A request may intend route:17, fail it,
  // fall back to route:22, and finally be served by route:34 — a single
  // top-level action cannot express that, so the distinction is preserved.
  const ordered = attempts;
  const initial = ordered.length ? routeKey(ordered[0]) : null;
  const succeededIndex = built.findIndex((b) => b.outcome.operational_success);
  const served = succeededIndex >= 0 ? routeKey(ordered[succeededIndex]) : null;
  const fallbackUsed = Boolean(ordered.some((a) => a.fallback_from_route_id));
  const rescueUsed = Boolean(ordered.some((a) => a.rescue_used === 1 || a.rescue_used === true));

  const episode = {
    schema: VEY_SCHEMA,
    id: trajectory.id,
    state: {
      messages: request ? request.messages : [],
      task_type: trajectory.task_type || attempts[0]?.task_type || null,
      stream: Boolean(trajectory.stream),
      context: buildStateContext(request, decision),
      task_ir: null
    },
    candidate_set: null,
    policy: {
      name: decision ? decision.policy_name : null,
      version: decision ? decision.policy_version : null,
      selected_action: decision ? decision.selected_action_id : null,
      propensity: decision ? decision.propensity : null,
      exploration: decision ? Boolean(decision.exploration) : false,
      decision_type: decision ? decision.decision_type : null
    },
    execution: {
      initial_action: initial,
      served_action: served,
      attempt_count: ordered.length,
      fallback_used: fallbackUsed,
      rescue_used: rescueUsed
    },
    attempts: built,
    response: response ? {
      message: assistantMessage(response),
      finish_reason: finishReason(response)
    } : null,
    terminal: buildTerminal(built, response),
    provenance: {
      source: "real_gateway",
      policy_version: decision ? decision.policy_version : null,
      decision_snapshot: decision ? "present" : "unavailable",
      created_at: trajectory.created_at || nowIso()
    }
  };

  // Attach the historical candidate snapshot when one exists. It carries what
  // the policy actually knew at decision time, including rejected candidates
  // (without them the model only sees "options considered good enough" instead
  // of "this existed but failed the reliability floor").
  if (decision && decision.candidate_set_json) {
    try {
      const parsed = JSON.parse(decision.candidate_set_json);
      if (Array.isArray(parsed)) {
        episode.candidate_set = parsed;
      } else {
        episode.candidate_set = null;
        episode.provenance.decision_snapshot = "invalid";
      }
    } catch {
      episode.candidate_set = null;
      // Distinguish "snapshot exists but is unreadable" from "no snapshot":
      // training pipelines can filter invalid deterministically instead of
      // guessing whether null means absent or corrupt.
      episode.provenance.decision_snapshot = "invalid";
    }
  }
  if (decision && decision.task_ir_version)
    episode.state.task_ir = { version: decision.task_ir_version };

  return episode;
}

function routeKey(attempt) {
  if (attempt.route_id == null)
    return null;
  return "route:" + attempt.route_id;
}

function parseRequest(trajectory) {
  if (!trajectory.request_json)
    return null;
  try {
    return JSON.parse(trajectory.request_json);
  } catch {
    return null;
  }
}

function assistantMessage(response) {
  const choice = response && response.choices && response.choices[0];
  if (!choice)
    return {};
  return choice.message || {};
}

function finishReason(response) {
  const choice = response && response.choices && response.choices[0];
  return (choice && choice.finish_reason) || "stop";
}

// State context must contain ONLY what existed before the policy chose.
// trajectory.prompt_tokens is provider-side usage known AFTER the action —
// putting it in state leaks the outcome into the observation and teaches the
// model to condition on the future. The decision snapshot's context_tokens
// is used when present; otherwise a provider-independent approximation is
// computed from the request itself, exactly the way TaskIR does
// (message chars + system chars + tool-schema chars, /4, plus images).
function buildStateContext(request, decision) {
  let snapshotTokens = null;
  if (decision && decision.context_features_json) {
    try {
      const cf = JSON.parse(decision.context_features_json);
      snapshotTokens = Number.isFinite(cf.context_tokens) ? cf.context_tokens : null;
    } catch {
      snapshotTokens = null;
    }
  }

  const msgs = request && Array.isArray(request.messages) ? request.messages : [];
  const tools = request && (request.tools || request.functions);
  const availableToolCount = Array.isArray(tools) ? tools.length : tools ? 1 : 0;

  let imageCount = 0;
  let textChars = 0;
  let systemChars = 0;
  for (const m of msgs) {
    const c = m && m.content;
    const add = (part) => {
      if (typeof part === "string") return part.length;
      if (part && typeof part.text === "string") return part.text.length;
      return 0;
    };
    if (typeof c === "string") {
      if (m.role === "system" || m.role === "developer") systemChars += c.length;
      else textChars += c.length;
    } else if (Array.isArray(c)) {
      for (const p of c) {
        const n = add(p);
        if (m.role === "system" || m.role === "developer") systemChars += n;
        else textChars += n;
        if (p && (p.type === "image_url" || p.type === "image")) imageCount++;
      }
    }
  }
  let toolSchemaChars = 0;
  try {
    if (tools) toolSchemaChars = JSON.stringify(tools).length;
  } catch {}

  // Offered tools and historical tool traffic are different signals: a
  // first-turn agent request with 50 tool definitions and zero history has
  // available_tool_count=50, tool_calls_in_history=0. Overloading one
  // tool_count conflated them into bad policy-training data.
  let toolCallsInHistory = 0;
  let toolResultsInHistory = 0;
  for (const m of msgs) {
    if (m && Array.isArray(m.tool_calls))
      toolCallsInHistory += m.tool_calls.length;
    if (m && m.role === "tool")
      toolResultsInHistory++;
  }

  const approximatedTokens = Math.ceil((textChars + systemChars + toolSchemaChars) / 4) + imageCount * 500;
  return {
    estimated_input_tokens: snapshotTokens != null ? snapshotTokens : approximatedTokens,
    token_source: snapshotTokens != null ? "decision_snapshot" : "request_approximation",
    image_count: imageCount,
    has_available_tools: availableToolCount > 0,
    available_tool_count: availableToolCount,
    tool_calls_in_history: toolCallsInHistory,
    tool_results_in_history: toolResultsInHistory
  };
}

function nowIso() {
  return new Date().toISOString();
}

// Quality aggregation over raw evidence: weighted mean and total weight.
// Exported so an RL run can derive Q from the same observations the episode
// recorded, without the scalar being baked into the raw record.
export function aggregateQuality(evidence) {
  return outcomeQuality(evidence);
}

// The OpsWorld/SemanticWorld separation, as a predicate, so tests can name the
// invariant directly: an operational failure carries NO semantic evidence.
export function operationalFailureIsNotSemantic(attempt) {
  if (isOperationalSuccess(attempt))
    return true;
  return isOperationalFailure(attempt.failure_class, attempt.http_status);
}

export const VEY_INTERNALS = {
  isOperationalFailure,
  isOperationalSuccess,
  outcomeQuality,
  CALLER_SIDE
};
