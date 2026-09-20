// Quality observations — evidence about the ANSWER, kept strictly separate
// from operational outcomes (route success / latency / cost in router_stats).
// Invariant: a bare 200 NEVER creates a quality observation. Quality only
// moves when something spoke about the response itself: a tool call that
// validated and executed, a verifier score, explicit user feedback.
// SHADOW-ONLY until calibration is reviewed: nothing in this module may
// influence route selection.

// The weight table IS the epistemics — objective execution evidence carries
// more statistical mass than any model-graded judgement. An LLM judge can
// never outvote a test run.
export const SIGNALS = {
  test_pass:        { value: 1, weight: 1.0, objective: 1 },
  test_fail:        { value: 0, weight: 1.0, objective: 1 },
  schema_valid:     { value: 1, weight: 0.9, objective: 1 },
  tool_success:     { weight: 0.9, objective: 1 },   // value = execution outcome (1/0)
  tool_invalid:     { value: 0, weight: 0.9, objective: 1 },
  tool_valid:       { value: 1, weight: 0.5, objective: 1 },  // solo weight; 0.2 when tool_success also present
  user_thumbs_up:   { value: 1, weight: 0.8, objective: 0 },
  user_thumbs_down: { value: 0, weight: 0.8, objective: 0 },
  verifier_score:   { weight: 0.5, objective: 0 },   // value = clamped 0..1 score
  llm_judge:        { weight: 0.25, objective: 0 }   // value = judged 0..1 score
};

// Beta(2,2) prior — deliberately unconfident, unlike the operational route
// prior. "Unmeasured" must look unmeasured: the prior mean of 0.5 is not
// evidence and must never be displayed as a measured quality.
export const QUALITY_PRIOR_ALPHA = 2;
export const QUALITY_PRIOR_BETA = 2;
// Weighted observations required before a posterior mean may be displayed.
export const QUALITY_EVIDENCE_MATURE = 5;

// Correlated-signal dedup: tool_valid (structural) and tool_success (execution
// outcome) fire from the same tool call. When the outcome exists it is the
// stronger final signal, so the structural check is down-weighted to a
// corroborating note instead of counting the event twice at full mass.
export const TOOL_VALID_WEIGHT_SOLO = 0.5;
export const TOOL_VALID_WEIGHT_DEDUPED = 0.2;

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

// Provisional identity resolver. The #4 canonical model registry replaces
// this and backfills quality_observations.canonical_model_id. Until then the
// raw upstream_model is used VERBATIM under a "raw:" prefix — no punctuation
// normalization pretending two spellings are one intelligence.
export function qualityIdentity(a = {}) {
  if (a.canonical_model_id) return String(a.canonical_model_id);
  const raw = String(a.upstream_model || a.public_slug || "").trim();
  return raw ? "raw:" + raw : null;
}

// Structural validity of the model's EMITTED tool calls. NULL when the
// response emitted none — absence of tool calls is a choice, not invalidity;
// only a malformed emitted call (missing name, truncated arguments JSON) is
// tool_invalid evidence.
export function deriveToolValidFromToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") return 0;
    const fn = tc.function || (tc.type === "function" ? tc : null);
    if (!fn || !String(fn.name || "").trim()) return 0;
    const args = fn.arguments;
    if (args != null && typeof args !== "string") return 0;
    if (typeof args === "string" && args.trim()) {
      try { JSON.parse(args); } catch { return 0; }
    }
  }
  return 1;
}

// Pure: attempt -> observation list. Empty for evidence-free attempts — this
// is what guarantees "200 without evidence creates zero observations".
export function deriveQualityFromAttempt(a = {}) {
  if (!a.success) return []; // a failed request carries no answer-quality evidence
  const out = [];
  const hasOutcome = a.tool_success === 0 || a.tool_success === 1;
  if (a.tool_valid === 0 || a.tool_valid === 1) {
    out.push({
      signal_type: a.tool_valid === 1 ? "tool_valid" : "tool_invalid",
      value: a.tool_valid === 1 ? 1 : 0,
      weight: hasOutcome ? TOOL_VALID_WEIGHT_DEDUPED : TOOL_VALID_WEIGHT_SOLO,
      objective: 1,
      source: "attempt"
    });
  }
  if (hasOutcome) {
    out.push({
      signal_type: "tool_success",
      value: a.tool_success === 1 ? 1 : 0,
      weight: SIGNALS.tool_success.weight,
      objective: 1,
      source: "attempt"
    });
  }
  if (a.verification_score != null && Number.isFinite(Number(a.verification_score))) {
    out.push({
      signal_type: "verifier_score",
      value: clamp01(a.verification_score),
      weight: SIGNALS.verifier_score.weight,
      objective: 0,
      source: "attempt"
    });
  }
  return out;
}

// Fractional Beta update math: alpha += weight*value, beta += weight*(1-value).
// Binary and continuous evidence combine in one accumulator.
export function fractionalUpdate(signals) {
  let dAlpha = 0, dBeta = 0, w = 0, ow = 0, sw = 0;
  for (const s of signals) {
    dAlpha += s.weight * s.value;
    dBeta += s.weight * (1 - s.value);
    w += s.weight;
    if (s.objective) ow += s.weight; else sw += s.weight;
  }
  return { dAlpha, dBeta, w, ow, sw };
}

// Emit observations for a recorded attempt and fold them into the derived
// stats cache. Idempotent per (request, attempt, signal, source) via the
// table's UNIQUE constraint. Never throws into the request path.
export async function emitQualityObservations(c, attemptId, a) {
  try {
    if (!c || !c.env || !c.env.DB || !attemptId) return [];
    const allSignals = deriveQualityFromAttempt(a);
    if (!allSignals.length) return [];
    const identity = qualityIdentity(a);
    if (!identity) return [];
    // Idempotency: a replayed (request, attempt, signal, source) has its
    // observation rows silently ignored by the UNIQUE constraint — but the
    // derived-stats fold below must consume only NEWLY recorded signals, or a
    // replay double-counts alpha/beta while the observation count stays flat.
    const seen = await c.env.DB.prepare(
      "SELECT signal_type, source FROM quality_observations WHERE route_attempt_id=?"
    ).bind(attemptId).all();
    const seenKeys = new Set(((seen && seen.results) || []).map((r) => String(r.signal_type) + "|" + String(r.source)));
    const signals = allSignals.filter((s) => !seenKeys.has(s.signal_type + "|" + s.source));
    if (!signals.length) return [];
    const now = new Date().toISOString();
    for (const s of signals) {
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO quality_observations
         (request_id, route_attempt_id, route_id, provider_id, public_slug, upstream_model, canonical_model_id,
          task_type, signal_type, value, weight, objective, source, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        a.request_id ?? null, attemptId, a.route_id ?? null, a.provider_id ?? null,
        a.public_slug ?? null, a.upstream_model ?? null, a.canonical_model_id ?? null,
        String(a.task_type || ""), s.signal_type, s.value, s.weight, s.objective ? 1 : 0, s.source, now
      ).run();
    }
    const { dAlpha, dBeta, w, ow, sw } = fractionalUpdate(signals);
    const task = String(a.task_type || "");
    const prevRow = await c.env.DB.prepare(
      `SELECT quality_alpha, quality_beta, observation_weight, objective_weight, subjective_weight
       FROM model_quality_stats WHERE model_identity=? AND task_type=?`
    ).bind(identity, task).all();
    const prev = prevRow && prevRow.results && prevRow.results[0];
    if (prev) {
      await c.env.DB.prepare(
        `UPDATE model_quality_stats SET
           quality_alpha = quality_alpha + ?, quality_beta = quality_beta + ?,
           observation_weight = observation_weight + ?,
           objective_weight = objective_weight + ?, subjective_weight = subjective_weight + ?,
           updated_at = ?
         WHERE model_identity=? AND task_type=?`
      ).bind(dAlpha, dBeta, w, ow, sw, now, identity, task).run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO model_quality_stats
         (model_identity, task_type, quality_alpha, quality_beta, observation_weight, objective_weight, subjective_weight, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(
        identity, task,
        QUALITY_PRIOR_ALPHA + dAlpha, QUALITY_PRIOR_BETA + dBeta, w, ow, sw, now
      ).run();
    }
    return signals;
  } catch (e) {
    // Quality must never break the serving path.
    console.log("quality observation emit failed: " + String(e && e.message || e));
    return [];
  }
}

// Request-level feedback (user thumbs, later milestones) attaches to the FINAL
// SUCCESSFUL attempt of the request — the route that actually served the
// answer — never to earlier failed attempts in the fallback chain.
export async function resolveServingAttemptId(c, requestId) {
  const r = await c.env.DB.prepare(
    `SELECT id FROM route_attempts WHERE request_id=? AND success=1 ORDER BY attempt_index DESC LIMIT 1`
  ).bind(requestId).all();
  return r && r.results && r.results[0] ? r.results[0].id : null;
}

// Shadow-only read path for the explain payload. Returns derived stats for
// (identity, task); below the maturity threshold the mean is withheld — the
// UI must show "insufficient evidence (prior only)", never a fake 50%.
export async function loadQualityShadow(c, identity, task) {
  try {
    if (!c || !c.env || !c.env.DB || !identity) return null;
    const r = await c.env.DB.prepare(
      `SELECT quality_alpha, quality_beta, observation_weight, objective_weight, subjective_weight
       FROM model_quality_stats WHERE model_identity=? AND task_type=?`
    ).bind(identity, String(task || "")).all();
    const s = r && r.results && r.results[0];
    const evidence = s ? Number(s.observation_weight) || 0 : 0;
    const base = {
      evidence,
      objectiveWeight: s ? Number(s.objective_weight) || 0 : 0,
      subjectiveWeight: s ? Number(s.subjective_weight) || 0 : 0
    };
    if (!s || evidence < QUALITY_EVIDENCE_MATURE)
      return { ...base, sufficient: false };
    const alpha = Number(s.quality_alpha), beta = Number(s.quality_beta);
    return { ...base, sufficient: true, alpha, beta, mean: alpha / (alpha + beta) };
  } catch {
    return null;
  }
}
