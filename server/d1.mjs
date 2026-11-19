// Cloudflare D1 HTTP client for the Node host (server/server.mjs).
// Implements the same surface as server/db.mjs (the worker's
// `c.env.DB.prepare(sql).bind(...).first/all/run`) against the D1 REST API:
//   POST /accounts/{account}/d1/database/{id}/query  {sql, params}
//   POST /accounts/{account}/d1/database/{id}/raw     {batch:[{sql}]} | {sql}
// Auth: Bearer CLOUDFLARE_API_TOKEN. No D1_DATABASE_ID config -> server.mjs
// falls back to node:sqlite instead of using this module.

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const PRAGMA_TABLE_INFO_RE = /^\s*PRAGMA\s+table_info\(([^)]+)\)\s*$/i;

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

export function createD1Db(env = process.env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = env.D1_DATABASE_ID;
  if (!token || !account || !databaseId) {
    throw new Error("createD1Db requires CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and D1_DATABASE_ID");
  }
  const base = `${API_BASE}/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(databaseId)}`;

  async function request(path, body) {
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
    const info = params && !params.length ? parseTableInfoTarget(sql) : parseTableInfoTarget(sql);
    if (info) {
      try {
        return await query(sql, params);
      } catch (e) {
        return await query(TABLE_INFO_FALLBACK(info.quoted), []);
      }
    }
    return query(sql, params);
  }

  function bound(sql, params) {
    return {
      async first() {
        const r = await queryWithPragmaFallback(sql, params);
        return (r.results && r.results.length) ? r.results[0] : null;
      },
      async all() {
        const r = await queryWithPragmaFallback(sql, params);
        return { results: r.results || [] };
      },
      async run() {
        const r = await queryWithPragmaFallback(sql, params);
        const meta = r.meta || {};
        return { meta: { changes: Number(meta.changes || 0), last_row_id: Number(meta.last_row_id || 0) } };
      },
    };
  }

  return {
    exec(sql) {
      // Multiple statements in one string: /raw supports a single {sql} with
      // semicolon-joined statements, or a {batch} array. Use {sql} directly.
      return request("/raw", { sql });
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
      const json = await request("/raw", { batch: statements.map((s) => ({ sql: s.sql, params: s.params || [] })) });
      return (Array.isArray(json.result) ? json.result : [json.result]).map((entry) => ({
        results: (entry && entry.results) || [],
        meta: (entry && entry.meta) || {},
      }));
    },
  };
}
