// Passive usage-pattern detection. Watches for behavior that looks like model
// distillation or budget/limit bypass, records it, and surfaces it to the
// operator. It never blocks, throttles, or reroutes a request: detection is
// observability, not enforcement. The operator decides what to do with it.
//
// Evidence discipline, same as the rest of the gateway: a detection event
// stores counts, durations, and a small set of FACTS (distinct model count,
// request rate, distinct IP count). It never stores prompt or response text.
//
// Signals, each a heuristic with a score in [0,1]:
//   distillation  - a single account systematically sweeping the input space:
//                   high request volume, high prompt-length diversity, and many
//                   distinct models probed in a short window. Distillation
//                   runs look different from real usage.
//   bypass        - patterns aimed at evading caps: cycling across many keys
//                   from one source, rate pulses that hug the limit, or a burst
//                   right after a 429/budget response.
//
// Scores are per (account, kind) with a rolling half-life so an old burst
// decays instead of sticking forever.

const HALF_LIFE_MS = 7 * 86400000; // 7 days
const WINDOW_MS = 3600000; // 1 hour analysis window

const ensured = new WeakSet();
export async function ensureDetectionSchema(db) {
  if (!db || ensured.has(db)) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS detection_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, score REAL NOT NULL, facts TEXT NOT NULL DEFAULT '{}')"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_detection_account ON detection_events(account_id, at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_detection_kind ON detection_events(kind, at)").run();
  // Per (account, kind) score state with decay.
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS detection_state (account_id TEXT NOT NULL, kind TEXT NOT NULL, score REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (account_id, kind))"
  ).run();
  ensured.add(db);
}

function decayed(score, updatedAt, now) {
  const age = now - new Date(updatedAt).getTime();
  return score * Math.pow(0.5, age / HALF_LIFE_MS);
}

// Bump a (account, kind) score and, when it crosses a threshold, emit an event.
// Returns the new score. Writing the state row is idempotent; the event row is
// only written when the score crosses 0.5 upward or every 0.25 above that.
async function bump(db, accountId, kind, delta, facts, now) {
  const row = await db.prepare("SELECT score, updated_at FROM detection_state WHERE account_id=? AND kind=?").bind(accountId, kind).first();
  const prior = row ? decayed(Number(row.score), row.updated_at, now) : 0;
  const next = Math.min(1, prior + delta);
  const crossed = prior < 0.5 && next >= 0.5;
  const stepped = next >= 0.5 && Math.floor(next / 0.25) > Math.floor(prior / 0.25);
  await db.prepare(
    "INSERT INTO detection_state (account_id, kind, score, updated_at) VALUES (?,?,?,?) ON CONFLICT(account_id, kind) DO UPDATE SET score=excluded.score, updated_at=excluded.updated_at"
  ).bind(accountId, kind, next, new Date(now).toISOString()).run();
  if (crossed || stepped) {
    await db.prepare("INSERT INTO detection_events (at, account_id, kind, score, facts) VALUES (?,?,?,?,?)")
      .bind(new Date(now).toISOString(), accountId, kind, Math.round(next * 1000) / 1000, JSON.stringify(facts || {})).run();
  }
  return next;
}

// Called once per finished request with body-free facts. Cheap: a few SQL
// reads/writes, no prompt text, no model calls. Anything it throws is the
// caller's to swallow - detection must never break a request.
export async function observeRequest(db, { accountId, keyId, model, promptChars, ok, status, ip }) {
  if (!db || !accountId) return;
  await ensureDetectionSchema(db);
  const now = Date.now();
  const sinceIso = new Date(now - WINDOW_MS).toISOString();

  // --- distillation: volume + diversity + model spread in the window ---
  const stats = await db.prepare(
    "SELECT COUNT(*) AS n, COUNT(DISTINCT public_slug) AS models, AVG(LENGTH(COALESCE(request_id,''))) AS _pad FROM request_summaries WHERE key_id IN (SELECT key_id FROM api_keys WHERE account_id=? OR key_id=?) AND created_at >= ?"
  ).bind(accountId, accountId, sinceIso).first();
  const n = Number(stats && stats.n) || 0;
  const models = Number(stats && stats.models) || 0;
  // High sustained rate with many distinct models is the distillation shape.
  const rateScore = Math.min(1, n / 300); // 300+/hour is heavy for one account
  const spreadScore = Math.min(1, models / 5); // probing 5+ models in an hour
  if (rateScore > 0 && spreadScore > 0) {
    const combined = rateScore * 0.6 + spreadScore * 0.4;
    if (combined > 0.25)
      await bump(db, accountId, "distillation", combined * 0.2, { requests_per_hour: n, distinct_models: models }, now);
  }

  // --- bypass: burst right after a denial, or key cycling ---
  if (status === 429 || status === 403 || ok === 0) {
    // A burst of retries immediately after a limit/budget response.
    const recentDenials = await db.prepare(
      "SELECT COUNT(*) AS n FROM request_summaries WHERE key_id IN (SELECT key_id FROM api_keys WHERE account_id=? OR key_id=?) AND created_at >= ? AND (http_status=429 OR http_status=403)"
    ).bind(accountId, accountId, new Date(now - 600000).toISOString()).first();
    const denials = Number(recentDenials && recentDenials.n) || 0;
    if (denials >= 3)
      await bump(db, accountId, "bypass", 0.15, { recent_denials_10m: denials, last_status: status }, now);
  }

  // Key cycling: many distinct keys from one account in the window.
  const keys = await db.prepare(
    "SELECT COUNT(DISTINCT key_id) AS n FROM request_summaries WHERE key_id IN (SELECT key_id FROM api_keys WHERE account_id=? OR key_id=?) AND created_at >= ?"
  ).bind(accountId, accountId, sinceIso).first();
  const keyCount = Number(keys && keys.n) || 0;
  if (keyCount >= 5)
    await bump(db, accountId, "bypass", 0.1, { distinct_keys_per_hour: keyCount }, now);
}

export async function loadDetectionFeed(db, { limit = 100, kind = null, accountId = null } = {}) {
  await ensureDetectionSchema(db);
  let sql = "SELECT id, at, account_id, kind, score, facts FROM detection_events WHERE 1=1";
  const binds = [];
  if (kind) { sql += " AND kind=?"; binds.push(kind); }
  if (accountId) { sql += " AND account_id=?"; binds.push(accountId); }
  sql += " ORDER BY id DESC LIMIT ?";
  binds.push(limit);
  const rows = await db.prepare(sql).bind(...binds).all();
  return (rows.results || []).map((r) => ({
    id: Number(r.id),
    at: r.at,
    account_id: r.account_id,
    kind: r.kind,
    score: Number(r.score),
    severity: r.score >= 0.75 ? "high" : r.score >= 0.5 ? "medium" : "low",
    facts: safeJson(r.facts)
  }));
}

export async function loadDetectionSummary(db) {
  await ensureDetectionSchema(db);
  const rows = await db.prepare(
    "SELECT account_id, kind, score, updated_at FROM detection_state WHERE score > 0.1 ORDER BY score DESC"
  ).all();
  const now = Date.now();
  return (rows.results || []).map((r) => {
    const score = Math.round(decayed(Number(r.score), r.updated_at, now) * 1000) / 1000;
    return { account_id: r.account_id, kind: r.kind, score, severity: score >= 0.75 ? "high" : score >= 0.5 ? "medium" : "low", updated_at: r.updated_at };
  }).filter((r) => r.score > 0.1);
}

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}
