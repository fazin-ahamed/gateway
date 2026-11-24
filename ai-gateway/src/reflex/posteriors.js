// ReflexCore — posterior store + empirical calibration.
//
// SQLite-backed (D1) task × capability posteriors. One row per
// (scope, scope_id, task_type): scope ∈ {model, skill, profile, tool}.
// The gateway already owns operational Beta posteriors in router_stats;
// this table carries the ReflexCore-specific verified-success view used by
// skill/profile/tool selection.
//
// Freeze-safe: additive. No serving path reads or writes it yet; the only
// callers are admin/reflex endpoints and tests.

const TABLE = "reflex_posteriors";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (`,
  `  scope TEXT NOT NULL,`,
  `  scope_id TEXT NOT NULL,`,
  `  task_type TEXT NOT NULL DEFAULT '',`,
  `  success_alpha REAL NOT NULL DEFAULT 1,`,
  `  failure_beta REAL NOT NULL DEFAULT 1,`,
  `  samples INTEGER NOT NULL DEFAULT 0,`,
  `  latency_ema REAL,`,
  `  cost_ema REAL,`,
  `  verified_ema REAL,`,
  `  updated_at TEXT NOT NULL,`,
  `  PRIMARY KEY (scope, scope_id, task_type)`,
  `)`
].join("\n");

export const REFLEX_SCHEMA = SCHEMA;

// One DDL per db handle: observeReflex calls this on every request, and on D1
// each statement is an HTTPS round trip.
const ensured = new WeakSet();

export async function migrateReflexPosteriors(db) {
  if (!db || typeof db.prepare !== "function") return false;
  if (ensured.has(db)) return true;
  try {
    await db.prepare(SCHEMA).run();
    ensured.add(db);
    return true;
  } catch (e) {
    return false;
  }
}

export async function loadPosterior(db, scope, scopeId, taskType = "") {
  if (!db) return null;
  try {
    const row = await db.prepare(
      `SELECT success_alpha, failure_beta, samples, latency_ema, cost_ema, verified_ema, updated_at
       FROM ${TABLE} WHERE scope=? AND scope_id=? AND task_type=?`
    ).bind(scope, scopeId, taskType || "").first();
    if (!row) return null;
    return {
      alpha: Number(row.success_alpha) || 1,
      beta: Number(row.failure_beta) || 1,
      samples: Number(row.samples) || 0,
      latencyEma: row.latency_ema == null ? null : Number(row.latency_ema),
      costEma: row.cost_ema == null ? null : Number(row.cost_ema),
      verifiedEma: row.verified_ema == null ? null : Number(row.verified_ma || row.verified_ema)
    };
  } catch {
    return null;
  }
}

export async function observePosterior(db, scope, scopeId, taskType, { success, latencyMs = null, costUsd = null, verified = null } = {}) {
  if (!db) return false;
  const tt = taskType || "";
  const alphaInc = success ? 1 : 0;
  const betaInc = success ? 0 : 1;
  const now = new Date().toISOString();
  try {
    await db.prepare(
      `INSERT INTO ${TABLE} (scope, scope_id, task_type, success_alpha, failure_beta, samples, latency_ema, cost_ema, verified_ema, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, scope_id, task_type) DO UPDATE SET
         success_alpha = success_alpha + ?,
         failure_beta = failure_beta + ?,
         samples = samples + 1,
        latency_ema = CASE WHEN ? IS NULL THEN latency_ema WHEN latency_ema IS NULL THEN ? ELSE latency_ema * 0.8 + ? * 0.2 END,
        cost_ema = CASE WHEN ? IS NULL THEN cost_ema WHEN cost_ema IS NULL THEN ? ELSE cost_ema * 0.8 + ? * 0.2 END,
        verified_ema = CASE WHEN ? IS NULL THEN verified_ema WHEN verified_ema IS NULL THEN ? ELSE verified_ema * 0.8 + ? * 0.2 END,
         updated_at = ?`
    ).bind(
      scope, scopeId, tt,
      1 + alphaInc, 1 + betaInc, 1,
      latencyMs, costUsd, verified == null ? null : (verified ? 1 : 0),
      now,
      alphaInc, betaInc,
      latencyMs, latencyMs, latencyMs,
      costUsd, costUsd, costUsd,
      verified == null ? null : (verified ? 1 : 0), verified == null ? null : (verified ? 1 : 0), verified == null ? null : (verified ? 1 : 0), now
    ).run();
    return true;
  } catch {
    return false;
  }
}

// Empirical calibration buckets. ReflexCore predicted confidence is blended
// toward the observed success rate inside each bucket, so a system claiming
// 0.90 that historically delivers 0.72 is corrected before a decision is
// made from it. Seed values are placeholders; real values come from data.
export const CALIBRATION_SEED = Object.freeze([
  { lo: 0.0, hi: 0.5, observed: 0.4 },
  { lo: 0.5, hi: 0.6, observed: 0.56 },
  { lo: 0.6, hi: 0.7, observed: 0.64 },
  { lo: 0.7, hi: 0.8, observed: 0.76 },
  { lo: 0.8, hi: 0.9, observed: 0.85 },
  { lo: 0.9, hi: 1.0, observed: 0.94 }
]);
