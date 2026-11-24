// Cloudflare D1 HTTP client for the Node host (server/server.mjs).
// Implements the same surface as server/db.mjs (the worker's
// `c.env.DB.prepare(sql).bind(...).first/all/run`) against the D1 REST API:
//   POST /accounts/{account}/d1/database/{id}/query  {sql, params}
//   POST /accounts/{account}/d1/database/{id}/raw     {batch:[{sql}]} | {sql}
// Auth: Bearer CLOUDFLARE_API_TOKEN. No D1_DATABASE_ID config -> server.mjs
// falls back to node:sqlite instead of using this module.
//
// CPU/latency notes: every statement below is an HTTPS round trip to
// Cloudflare (~3ms CPU, ~20ms wall each on a fast core). A chat request
// issues ~40 statements, so this client cuts round trips two ways:
//   1. A TTL cache for SELECTs that only read operator-config tables.
//   2. A write-behind queue that batches fire-and-forget telemetry writes
//      into one /raw {batch} call. Reads and writes that touch a table with
//      queued rows flush first, so read-your-writes ordering is preserved.

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const PRAGMA_TABLE_INFO_RE = /^\s*PRAGMA\s+table_info\(([^)]+)\)\s*$/i;

// Operator configuration: rows change only through admin endpoints in this
// same process, so a short TTL bounds staleness from out-of-band writers
// (wrangler). Anything request-scoped (api_keys, console_accounts,
// request_summaries, posteriors) is deliberately NOT cacheable.
const CACHEABLE_TABLES = new Set([
  "model_routes", "providers", "provider_keys", "prices", "model_limits",
  "gateway_settings", "model_tiers", "api_key_model_tiers", "proxy_pool",
  "canonical_models",
]);

// Fire-and-forget telemetry: INSERT/UPDATE statements whose run() result is
// never consumed by the caller (meta.changes/last_row_id are ignored for
// these tables; DELETE is never deferred because purge endpoints report
// meta.changes). Money (api_keys, console_accounts, spend_events) and
// route_attempts (its last_row_id feeds quality observations) stay sync.
const DEFERRED_TABLES = new Set([
  "model_usage", "trajectories", "request_summaries", "router_stats",
  "reflex_posteriors", "taste_posteriors", "taste_verdicts",
]);

// The one per-request providers write. Deferred like the telemetry above, and
// it does not clear the read cache: it touches only last_status/last_checked,
// which no cached SELECT reads (routing reads healthy/enabled/fmt/...).
const PROVIDER_STATUS_PREFIX = "UPDATE providers SET last_status=";

// Admin edits to `providers` return meta.changes (404 on zero), so only the
// per-request status stamp is deferred.
function isDeferred(sql, target) {
  if (!target || DELETE_RE.test(sql)) return false;
  return DEFERRED_TABLES.has(target) || sql.startsWith(PROVIDER_STATUS_PREFIX);
}

const INSERT_RE = /^\s*(?:INSERT(?:\s+OR\s+(?:IGNORE|REPLACE))?|REPLACE)\s+INTO\s+([A-Za-z_][\w]*)/i;
const UPDATE_RE = /^\s*UPDATE\s+([A-Za-z_][\w]*)/i;
const DELETE_RE = /^\s*DELETE\s+FROM\s+([A-Za-z_][\w]*)/i;
const SELECT_RE = /^\s*SELECT\b/i;
const FROM_RE = /\b(?:FROM|JOIN)\s+([A-Za-z_][\w]*)/gi;

// D1 (SQLite) returns `notnull`, `dflt_value`, `pk` columns from table_info;
// quote the ones that collide with SQL keywords so SELECT aliases work.
const TABLE_INFO_FALLBACK = (table) =>
  `SELECT cid, name, type, "notnull" AS notnull, dflt_value AS [default], pk FROM pragma_table_info(${table})`;

class D1Error extends Error {
  constructor(message, code) {
    super(message);
    this.name = "D1Error";
    this.code = code;
  }
}

function parseTableInfoTarget(raw) {
  const m = PRAGMA_TABLE_INFO_RE.exec(raw);
  if (!m) return null;
  const t = m[1].trim();
  // strip surrounding quotes/backticks if present
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("`") && t.endsWith("`"))) {
    return { quoted: t.slice(1, -1), sql: t };
  }
  return { quoted: t, sql: t };
}

function writeTarget(sql) {
  const m = INSERT_RE.exec(sql) || UPDATE_RE.exec(sql) || DELETE_RE.exec(sql);
  return m ? m[1].toLowerCase() : null;
}

function readTables(sql) {
  const out = new Set();
  let m;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(sql))) out.add(m[1].toLowerCase());
  return out;
}

export function createD1Db(env = process.env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = env.D1_DATABASE_ID;
  if (!token || !account || !databaseId) {
    throw new Error("createD1Db requires CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and D1_DATABASE_ID");
  }
  const base = `${API_BASE}/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(databaseId)}`;
  const CACHE_TTL_MS = env.D1_CACHE_TTL_MS != null ? Number(env.D1_CACHE_TTL_MS) : 10000;
  const FLUSH_MS = env.D1_FLUSH_MS != null ? Number(env.D1_FLUSH_MS) : 400;
  const CACHE_MAX = 500;
  const QUEUE_MAX = 1000;
  const BATCH_MAX = 25;

  const stats = { calls: 0, cacheHits: 0, deferred: 0, flushes: 0, batches: 0, dropped: 0 };
  const cache = new Map(); // key -> { expires, json }
  let queue = [];         // [{ sql, params }]
  let pendingTables = new Set();
  let flushingTables = new Set(); // tables in the batch currently on the wire
  let flushing = null;     // in-flight flush promise
  let flushTimer = null;

  async function request(path, body) {
    stats.calls++;
    const res = await fetch(base + path, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new D1Error(`D1 ${path} returned non-JSON (HTTP ${res.status}): ${e.message}`, res.status);
    }
    if (!json || json.success !== true) {
      const err = json && Array.isArray(json.errors) && json.errors[0];
      throw new D1Error(err ? err.message : `D1 ${path} failed (HTTP ${res.status})`, err ? err.code : res.status);
    }
    return json;
  }

  // ---- write-behind queue -------------------------------------------------

  function scheduleFlush() {
    if (!FLUSH_MS || flushTimer || flushing) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
  }

  function clearCache() {
    if (cache.size) cache.clear();
  }

  function enqueue(sql, params) {
    if (queue.length >= QUEUE_MAX) {
      // The table is likely wedged (D1 daily cap, network). Drop the oldest
      // rather than grow without bound; telemetry only, so this is survivable.
      queue.shift();
      pendingTables = new Set(queue.map((q) => writeTarget(q.sql)).filter(Boolean));
      stats.dropped++;
      console.warn("[d1] write queue overflow, dropped the oldest queued statement");
    }
    queue.push({ sql, params });
    pendingTables.add(writeTarget(sql));
    stats.deferred++;
    // A deferred write to an operator-config table must invalidate cached
    // reads of it (an admin edit, say). The per-request providers last_status
    // update is the exception: no cached SELECT reads those columns, and
    // clearing on every request would defeat the cache.
    const target = writeTarget(sql);
    if (target && CACHEABLE_TABLES.has(target) && !sql.startsWith(PROVIDER_STATUS_PREFIX)) clearCache();
    if (queue.length >= BATCH_MAX) {
      flush().catch(() => {});
    } else {
      scheduleFlush();
    }
    return { meta: { changes: 1, last_row_id: 0 } };
  }

  async function flush() {
    if (flushing) return flushing;
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    flushingTables = pendingTables;
    pendingTables = new Set();
    flushing = (async () => {
      try {
        await request("/raw", { batch: batch.map((s) => ({ sql: s.sql, params: s.params || [] })) });
        stats.flushes++;
        stats.batches++;
      } catch (e) {
        // A D1 batch is transactional: one bad statement fails the whole
        // batch. Retry each statement alone so the other rows survive; a
        // statement that fails twice is dropped with a line in the log.
        for (const s of batch) {
          try {
            await query(s.sql, s.params || []);
            stats.flushes++;
          } catch (e2) {
            stats.dropped++;
            console.warn("[d1] deferred write dropped: " + String(e2 && e2.message || e2));
          }
        }
      }
    })();
    try {
      await flushing;
    } finally {
      flushing = null;
      flushingTables = new Set();
    }
  }

  function tablesNeedFlush(tables) {
    for (const t of tables) if (pendingTables.has(t) || flushingTables.has(t)) return true;
    return false;
  }

  // Wait until no queued or in-flight write touches `tables`.
  async function settle(tables) {
    while (tablesNeedFlush(tables)) await flush();
  }

  // ---- query paths ---------------------------------------------------------

  // POST /query: single statement, params bound. Returns the result entry
  // {results, success, meta} from result[0].
  async function query(sql, params) {
    const json = await request("/query", { sql, params: params || [] });
    const entry = Array.isArray(json.result) ? json.result[0] : json.result;
    if (entry && entry.success === false) {
      throw new D1Error("D1 query reported failure", 0);
    }
    return entry || { results: [], meta: {} };
  }

  // D1 runs PRAGMA table_info fine as a query; if it ever rejects it, retry
  // with the sqlite pragma table-valued-function translation so the
  // ensureXColumns migrations keep working.
  async function queryWithPragmaFallback(sql, params) {
    const info = parseTableInfoTarget(sql);
    if (info) {
      try {
        return await query(sql, params);
      } catch (e) {
        return await query(TABLE_INFO_FALLBACK(info.quoted), []);
      }
    }
    return query(sql, params);
  }

  const cacheable = (sql) => {
    if (!CACHE_TTL_MS || !SELECT_RE.test(sql) || PRAGMA_TABLE_INFO_RE.test(sql)) return false;
    const tables = readTables(sql);
    if (!tables.size) return false;
    for (const t of tables) if (!CACHEABLE_TABLES.has(t)) return false;
    return true;
  };

  function cacheKey(sql, params) {
    return sql + "\u0000" + JSON.stringify(params || []);
  }

  async function readThrough(sql, params) {
    // Read-your-writes: a queued write to a table this SELECT reads must be
    // visible, so flush before the cache lookup (a cache entry can predate a
    // queued write only for the providers last_status update, which by
    // construction never touches columns a cached read uses).
    await settle(readTables(sql));
    if (cacheable(sql)) {
      const key = cacheKey(sql, params);
      const hit = cache.get(key);
      if (hit && hit.expires > Date.now()) {
        stats.cacheHits++;
        // Parse per hit: callers may mutate the row objects they get back.
        return JSON.parse(hit.json);
      }
      const r = await queryWithPragmaFallback(sql, params);
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(key, { expires: Date.now() + CACHE_TTL_MS, json: JSON.stringify(r) });
      return r;
    }
    return queryWithPragmaFallback(sql, params);
  }

  function bound(sql, params) {
    return {
      async first() {
        const r = await readThrough(sql, params);
        return (r.results && r.results.length) ? r.results[0] : null;
      },
      async all() {
        const r = await readThrough(sql, params);
        return { results: r.results || [] };
      },
      async run() {
        const target = writeTarget(sql);
        if (isDeferred(sql, target)) {
          // Ordering vs later sync statements on the same table is kept by
          // the flush-before-read/-write checks.
          return enqueue(sql, params);
        }
        // A sync write must not be reordered ahead of queued writes to the
        // same table, and it invalidates cached reads of tables it changes.
        if (target) await settle(new Set([target]));
        try {
          const r = await queryWithPragmaFallback(sql, params);
          const meta = r.meta || {};
          return { meta: { changes: Number(meta.changes || 0), last_row_id: Number(meta.last_row_id || 0) } };
        } finally {
          if (target == null || (CACHEABLE_TABLES.has(target) && !sql.startsWith(PROVIDER_STATUS_PREFIX))) clearCache();
        }
      },
    };
  }

  return {
    exec(sql) {
      // Multiple statements in one string: /raw supports a single {sql} with
      // semicolon-joined statements, or a {batch} array. Schema-level SQL can
      // touch anything, so flush the queue and drop the cache first.
      return flush().then(() => { clearCache(); return request("/raw", { sql }); });
    },
    prepare(sql) {
      return {
        bind(...params) {
          return bound(sql, params);
        },
        ...bound(sql, []),
      };
    },
    async batch(statements) {
      await flush();
      clearCache();
      const json = await request("/raw", { batch: statements.map((s) => ({ sql: s.sql, params: s.params || [] })) });
      return (Array.isArray(json.result) ? json.result : [json.result]).map((entry) => ({
        results: (entry && entry.results) || [],
        meta: (entry && entry.meta) || {},
      }));
    },
    flush,
    stats,
  };
}
