// Vey dataset query side — the only piece of the Vey exporter that touches a
// database. Lives here so vey-world.js stays pure and fully testable.
//
// This module READS ONLY. It never writes a router_decisions row and never
// touches the live routing path; decision-time snapshots are a post-window
// concern. Historical records simply mark the unavailable fields truthfully
// instead of reconstructing candidate sets from today's route table.
//
// The four legacy formats (openai/sharegpt/trl/rl) export only
// status='ok' AND request_json IS NOT NULL AND response_json IS NOT NULL.
// Vey must NOT inherit that filter: the failed operational attempts are the
// signal an OpsWorld model learns from, so an all-failed episode is still a
// complete record with response: null.

import { exportVeyEpisode, VEY_SCHEMA } from "./vey-world.js";

// Export one episode fully (single request_id) as pretty JSON.
export async function exportVeyEpisodeFull(db, requestId) {
  const traj = await db.prepare(
    "SELECT id, created_at, key_id, key_name, slug, stream, status, http_status, provider, attempts, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, error, request_json, response_json FROM trajectories WHERE id=?"
  ).bind(requestId).first();
  if (!traj)
    return null;
  const episode = await assembleEpisode(db, traj);
  return episode;
}

// Dataset export for the admin endpoint. NDJSON, one vey.world.v1 record per
// line, ordered by creation time. Includes failed episodes; skips rows with no
// request body at all (there is no state to learn from).
export async function exportVeyDataset(c, format) {
  const slugFilter = String(c.req.query("slug") || "").trim();
  let sql = "SELECT id, created_at, key_id, key_name, slug, stream, status, http_status, provider, attempts, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, error, request_json, response_json FROM trajectories WHERE request_json IS NOT NULL";
  const binds = [];
  if (slugFilter) {
    sql += " AND slug=?";
    binds.push(slugFilter);
  }
  sql += " ORDER BY created_at";
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();

  const lines = [];
  let skipped = 0;
  for (const traj of rows.results || []) {
    try {
      const episode = await assembleEpisode(c.env.DB, traj);
      if (!episode) {
        skipped++;
        continue;
      }
      lines.push(JSON.stringify(episode));
    } catch {
      skipped++;
    }
  }

  const name = format === "world" ? "vey" : format;
  return new Response(lines.join("\n") + (lines.length ? "\n" : ""), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename=trajectories-${name}.jsonl`,
      "x-trajectory-count": String(lines.length),
      "x-trajectory-skipped": String(skipped),
      "x-schema": VEY_SCHEMA
    }
  });
}

// Assemble one episode from a trajectory row: every route attempt, the quality
// evidence per attempt, the decision snapshot if one exists, and the response
// body when the request completed.
async function assembleEpisode(db, traj) {
  const id = traj.id;

  const attempts = await db.prepare(
    "SELECT id, request_id, route_id, provider_id, public_slug, upstream_model, transport, task_type, attempt_index, started_at, finished_at, success, health_impact, http_status, failure_class, failure_code, ttft_ms, latency_ms, prompt_tokens, completion_tokens, estimated_cost_usd, actual_cost_usd, tool_valid, tool_success, verification_score, fallback_from_route_id, rescue_used FROM route_attempts WHERE request_id=? ORDER BY attempt_index, id"
  ).bind(id).all();
  const attemptRows = attempts.results || [];

  // Evidence map keyed by route_attempt_id, falling back to attempt order.
  const evidence = new Map();
  if (attemptRows.length) {
    const ids = attemptRows.map((a) => a.id).filter(Boolean);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      const qrows = await db.prepare(
        `SELECT route_attempt_id, signal_type, value, weight, objective, source FROM quality_observations WHERE request_id=? AND route_attempt_id IN (${placeholders})`
      ).bind(id, ...ids).all();
      for (const q of qrows.results || []) {
        const key = q.route_attempt_id;
        if (!evidence.has(key))
          evidence.set(key, []);
        evidence.get(key).push(q);
      }
    }
  }

  // Canonical identity per attempt, resolved through the alias index the same
  // way serving does — but read-only, at export time.
  let resolve = (row) => row.canonical_model_id || null;
  try {
    const { resolveCanonicalModel } = await import("../router/model-registry.js");
    const aliasIndex = await loadAliasIndex(db);
    resolve = (row) => resolveCanonicalModel(aliasIndex, row.public_slug, row.upstream_model, row.provider_id);
  } catch {
    // Registry unavailable: identity stays provisional, which is honest.
  }
  for (const a of attemptRows)
    a.canonical_model_id = a.canonical_model_id || resolve(a);

  // Decision snapshot: present only when decision-time capture is enabled
  // (post-window). Absent is reported as unavailable, never reconstructed.
  let decision = null;
  try {
    decision = await db.prepare(
      "SELECT request_id, policy_name, policy_version, task_type, task_ir_version, context_features_json, candidate_set_json, selected_action_id, propensity, exploration, decision_type, created_at FROM router_decisions WHERE request_id=?"
    ).bind(id).first();
  } catch {
    // Table not present yet (schema shipped, capture not enabled). The
    // episode records provenance.decision_snapshot: "unavailable".
  }

  let response = null;
  if (traj.response_json) {
    try {
      response = JSON.parse(traj.response_json);
    } catch {
      response = null;
    }
  }

  const episode = exportVeyEpisode({ trajectory: traj, attempts: attemptRows, evidence, decision, response });
  return episode;
}

async function loadAliasIndex(db) {
  try {
    const { loadAliasIndex: load } = await import("../router/model-registry.js");
    return load(db);
  } catch {
    return null;
  }
}
