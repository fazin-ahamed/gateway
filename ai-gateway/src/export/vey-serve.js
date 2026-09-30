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
//
// Memory: a dataset export must never hold more than one trajectory body.
// The previous exporter did `.all()` over every request_json and response_json,
// then kept the serialized episodes and their joined string at the same time.
// That tripled the dataset in the V8 heap and killed Node at its ~2GB limit
// inside node::sqlite::StatementSync::All. The page query below selects ids
// only; each body is loaded with `.first()`, emitted, and dropped.

import { exportVeyEpisode, VEY_SCHEMA } from "./vey-world.js";

// One page of id-only rows. Bodies stay out of this query on purpose.
const PAGE_SIZE = 100;

export const __test = { loadAliasIndex, PAGE_SIZE };

const TRAJECTORY_COLUMNS = "id, created_at, key_id, key_name, slug, stream, status, http_status, provider, attempts, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, error, request_json, response_json";

// Export one episode fully (single request_id) as pretty JSON.
export async function exportVeyEpisodeFull(db, requestId) {
  const traj = await db.prepare(
    "SELECT " + TRAJECTORY_COLUMNS + " FROM trajectories WHERE id=?"
  ).bind(requestId).first();
  if (!traj)
    return null;
  return assembleEpisode(db, traj);
}

// Dataset export for the admin endpoint. NDJSON, one vey.world.v1 record per
// line, ordered by creation time. Includes failed episodes; skips rows with no
// request body at all (there is no state to learn from).
//
// The body is a stream. Peak memory is one page of ids plus one episode,
// however large the table is. A second overlapping export gets 409: two of
// these running together is how the heap death repeated.
let exportInFlight = false;

export async function exportVeyDataset(c, format, options) {
  if (exportInFlight)
    return c.json({ error: { message: "a vey export is already running" } }, 409);
  exportInFlight = true;

  const slugFilter = String(c.req.query("slug") || "").trim();
  const since = bound(c.req.query("since"));
  const until = bound(c.req.query("until"));
  const limit = clampLimit(c.req.query("limit"));
  // null means the caller did not scope by key; an array (even empty) means it
  // did, and an empty one is a filter that matched nothing.
  const keyIds = options && Array.isArray(options.keyIds) ? options.keyIds : null;
  const name = format === "world" ? "vey" : format;
  const encoder = new TextEncoder();

  let cursor = { created_at: "", id: "" };
  let emitted = 0;
  let stopped = false;
  // Ids only. The bodies they name are loaded one per pull, so a slow reader
  // never queues more than the chunk it has not consumed yet.
  let pending = [];
  let exhausted = false;

  let controllerRef = null;
  const finish = () => {
    if (stopped)
      return;
    stopped = true;
    exportInFlight = false;
    controllerRef.close();
  };

  const stream = new ReadableStream({
    async pull(controller) {
      controllerRef = controller;
      if (stopped)
        return;
      try {
        if (limit != null && emitted >= limit)
          return finish();
        while (!pending.length && !exhausted) {
          const page = await loadIdPage(c.env.DB, { slugFilter, since, until, cursor, keyIds });
          if (!page.length) {
            exhausted = true;
            break;
          }
          cursor = { created_at: page[page.length - 1].created_at, id: page[page.length - 1].id };
          pending = page;
        }
        while (pending.length) {
          const meta = pending.shift();
          if (limit != null && emitted >= limit)
            return finish();
          const episode = await loadAndAssembleOne(c.env.DB, meta.id);
          if (!episode)
            continue;
          controller.enqueue(encoder.encode(JSON.stringify(episode) + "\n"));
          emitted++;
          return;
        }
        finish();
      } catch (e) {
        stopped = true;
        exportInFlight = false;
        controller.error(e);
      }
    },
    cancel() {
      stopped = true;
      pending = [];
      exportInFlight = false;
    }
  });

  // No content-length and no count header: both require reading every row
  // before the first byte, which is the heap bug this stream exists to avoid.
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename=trajectories-${name}.jsonl`,
      "x-schema": VEY_SCHEMA,
      "cache-control": "no-store"
    }
  });
}

function bound(value) {
  const text = String(value || "").trim();
  return text || null;
}

function clampLimit(value) {
  if (value == null || value === "")
    return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1)
    return null;
  return Math.min(100000, Math.floor(n));
}

async function loadIdPage(db, { slugFilter, since, until, cursor, keyIds }) {
  // A key scope that matched no keys yields no page, which ends the stream
  // rather than exporting the whole table under a filter that matched nothing.
  if (Array.isArray(keyIds) && !keyIds.length)
    return [];
  let sql = "SELECT id, created_at FROM trajectories WHERE request_json IS NOT NULL";
  const binds = [];
  if (slugFilter) {
    sql += " AND slug=?";
    binds.push(slugFilter);
  }
  if (Array.isArray(keyIds) && keyIds.length) {
    sql += " AND key_id IN (" + keyIds.map(() => "?").join(",") + ")";
    binds.push(...keyIds);
  }
  if (since) {
    sql += " AND created_at>=?";
    binds.push(since);
  }
  if (until) {
    sql += " AND created_at<=?";
    binds.push(until);
  }
  if (cursor.created_at) {
    sql += " AND (created_at>? OR (created_at=? AND id>?))";
    binds.push(cursor.created_at, cursor.created_at, cursor.id);
  }
  sql += " ORDER BY created_at, id LIMIT ?";
  binds.push(PAGE_SIZE);
  const rows = await db.prepare(sql).bind(...binds).all();
  return rows.results || [];
}

async function loadAndAssembleOne(db, id) {
  const traj = await db.prepare(
    "SELECT " + TRAJECTORY_COLUMNS + " FROM trajectories WHERE id=?"
  ).bind(id).first();
  if (!traj)
    return null;
  try {
    return await assembleEpisode(db, traj);
  } catch {
    return null;
  }
}

// Assemble one episode from a trajectory row: every route attempt, the quality
// evidence per attempt, the decision snapshot if one exists, and the response
// body when the request completed.
async function assembleEpisode(db, traj) {
  const id = traj.id;

  const attempts = await db.prepare(
    "SELECT id, request_id, route_id, provider_id, public_slug, upstream_model, transport, task_type, attempt_index, started_at, finished_at, success, health_impact, http_status, failure_class, failure_code, ttft_ms, headers_ms, latency_ms, prompt_tokens, completion_tokens, estimated_cost_usd, actual_cost_usd, tool_valid, tool_success, verification_score, fallback_from_route_id, rescue_used FROM route_attempts WHERE request_id=? ORDER BY attempt_index, id"
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
  // way serving does — but read-only, at export time. resolveCanonicalModel
  // takes an options object and returns { canonicalModelId, alias, step }, so
  // the string is unwrapped; an unresolved identity stays null rather than
  // being turned into a bogus id.
  let resolve = (row) => row.canonical_model_id || null;
  try {
    const { resolveCanonicalModel } = await import("../router/model-registry.js");
    const aliasIndex = await loadAliasIndex(db);
    resolve = (row) => {
      if (!aliasIndex || !aliasIndex.size)
        return null;
      const hit = resolveCanonicalModel(aliasIndex, {
        providerId: row.provider_id,
        publicSlug: row.public_slug,
        upstreamModel: row.upstream_model
      });
      return hit && hit.canonicalModelId ? hit.canonicalModelId : null;
    };
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

  return exportVeyEpisode({ trajectory: traj, attempts: attemptRows, evidence, decision, response });
}

async function loadAliasIndex(db) {
  // model-registry expects a gateway context (c.env.DB), not the raw handle.
  // An empty index makes every resolve a miss, which is honest — never a
  // fabricated id.
  try {
    const { loadAliasIndex: load } = await import("../router/model-registry.js");
    return await load({ env: { DB: db } });
  } catch {
    return new Map();
  }
}
