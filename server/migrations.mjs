// Prices-table migrations for the Node host DB (node:sqlite via server/db.mjs).
// Kept in one testable function so the NULL-copy rebuild is exercised by tests,
// not only discovered in production.

function colNames(db) {
  const cols = db.prepare("PRAGMA table_info(prices)").all();
  const list = Array.isArray(cols) ? cols : (cols && cols.results) || [];
  return new Set(list.map((c) => c.name));
}

export function migratePrices(db) {
  // 1. Dual-rate + per-request columns (added incrementally over time).
  try {
    const names = colNames(db);
    if (names.has("prompt_per_1m")) {
      const add = (name, sql) => {
        if (!names.has(name)) {
          db.exec(sql);
          console.warn("[gateway] migration: added prices." + name);
        }
      };
      add("actual_prompt_per_1m", "ALTER TABLE prices ADD COLUMN actual_prompt_per_1m REAL");
      add("actual_completion_per_1m", "ALTER TABLE prices ADD COLUMN actual_completion_per_1m REAL");
      add("cache_read_per_1m", "ALTER TABLE prices ADD COLUMN cache_read_per_1m REAL");
      add("cache_write_per_1m", "ALTER TABLE prices ADD COLUMN cache_write_per_1m REAL");
      add("actual_mode", "ALTER TABLE prices ADD COLUMN actual_mode TEXT");
      add("actual_per_request", "ALTER TABLE prices ADD COLUMN actual_per_request REAL");
    }
  } catch (e) {
    console.warn("[gateway] prices dual-rate migration skipped:", e.message);
  }

  // 2. Composite (slug, provider_id) key so pricing can vary per provider.
  // Existing rows become the provider_id=0 default that applies to all.
  try {
    const names = colNames(db);
    if (names.has("slug") && !names.has("provider_id")) {
      const carry = ["slug", "prompt_per_1m", "completion_per_1m", "actual_prompt_per_1m", "actual_completion_per_1m", "cache_read_per_1m", "cache_write_per_1m", "actual_mode", "actual_per_request", "currency", "updated_at"].filter((c) => names.has(c));
      // COALESCE the NOT NULL targets: rows created before the mode/currency
      // columns existed carry NULL, which would abort the whole rebuild.
      const selExpr = carry.map((c) => c === "actual_mode" ? "COALESCE(actual_mode, 'per_1m')" : c === "currency" ? "COALESCE(currency, 'USD')" : c).join(", ");
      db.exec("DROP TABLE IF EXISTS prices_new");
      db.exec("BEGIN");
      db.exec("CREATE TABLE prices_new (slug TEXT NOT NULL, provider_id INTEGER NOT NULL DEFAULT 0, prompt_per_1m REAL NOT NULL DEFAULT 0, completion_per_1m REAL NOT NULL DEFAULT 0, actual_prompt_per_1m REAL, actual_completion_per_1m REAL, cache_read_per_1m REAL, cache_write_per_1m REAL, actual_mode TEXT NOT NULL DEFAULT 'per_1m', actual_per_request REAL, currency TEXT NOT NULL DEFAULT 'USD', updated_at TEXT NOT NULL, PRIMARY KEY (slug, provider_id))");
      db.exec("INSERT INTO prices_new (provider_id, " + carry.join(", ") + ") SELECT 0, " + selExpr + " FROM prices");
      db.exec("DROP TABLE prices");
      db.exec("ALTER TABLE prices_new RENAME TO prices");
      db.exec("COMMIT");
      console.warn("[gateway] migration: prices keyed by (slug, provider_id)");
    }
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    console.warn("[gateway] prices provider-key migration skipped:", e.message);
  }
}

// schema.sql uses CREATE TABLE IF NOT EXISTS, so an existing DB never gets the
// canonical_model_id column added later — the quality-observation INSERT then
// fails on every request ("no such column: canonical_model_id"), silently
// killing the whole quality layer on any deployment whose DB predates the
// column. Same class as the providers.enabled/key_strategy fixes below.
export function migrateQualityIdentity(db) {
  try {
    const r = db.prepare("PRAGMA table_info(quality_observations)").all();
    const names = new Set(((r && r.results) || []).map((c) => c && c.name));
    if (names.has("canonical_model_id")) return false;
    db.exec("ALTER TABLE quality_observations ADD COLUMN canonical_model_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_quality_model_task ON quality_observations(canonical_model_id, task_type, created_at)");
    console.warn("[gateway] migration: added quality_observations.canonical_model_id");
    return true;
  } catch (e) {
    console.warn("[gateway] quality identity migration skipped:", e.message);
    return false;
  }
}

// Same CREATE TABLE IF NOT EXISTS gap as the quality column above: a DB created
// before the V2 shadow experiment columns existed never receives them, and the
// route_attempts INSERT would then fail on every auto-routed request.
export function migrateRouteAttemptsV2(db) {
  const added = [];
  try {
    const r = db.prepare("PRAGMA table_info(route_attempts)").all();
    const names = new Set(((r && r.results) || []).map((c) => c && c.name));
    const cols = [
      ["v2_operational_route_id", "INTEGER"],
      ["v2_quality_route_id", "INTEGER"],
      ["v2_quality_changed", "INTEGER"],
      ["v2_quality_state", "TEXT"],
      ["v2_quality_reason", "TEXT"],
      ["v2_reliability_floor", "REAL"],
      ["v2_quality_floor", "REAL"],
      ["headers_ms", "INTEGER"]
    ];
    for (const [name, type] of cols) {
      if (names.has(name)) continue;
      db.exec("ALTER TABLE route_attempts ADD COLUMN " + name + " " + type);
      added.push(name);
    }
    if (added.length)
      console.warn("[gateway] migration: added route_attempts V2 shadow columns:", added.join(", "));
  } catch (e) {
    console.warn("[gateway] route_attempts V2 migration skipped:", e.message);
  }
  return added;
}

// The shadow table is new. CREATE TABLE IF NOT EXISTS is a no-op on a database
// that already has it and creates it on one that predates it.
export function migrateLatencyShadow(db) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS latency_shadow_decisions (
      request_id TEXT PRIMARY KEY,
      primary_route_id INTEGER NOT NULL,
      primary_provider_id INTEGER,
      primary_slug TEXT,
      backup_route_id INTEGER,
      backup_provider_id INTEGER,
      backup_slug TEXT,
      task_type TEXT,
      context_bucket TEXT,
      deadline_ms INTEGER NOT NULL,
      baseline_ms REAL,
      baseline_samples INTEGER NOT NULL DEFAULT 0,
      deadline_source TEXT NOT NULL,
      observed_headers_ms INTEGER,
      observed_ttft_ms INTEGER,
      would_hedge INTEGER,
      hedge_possible INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      finished_at TEXT
    )`);
    return true;
  } catch (e) {
    console.warn("[gateway] latency shadow migration skipped:", e.message);
    return false;
  }
}

// New table, created on databases that predate it. Off-by-default path writes
// it; creating it early is harmless and keeps the shape ready.
export function migrateZaiConversations(db) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS zai_conversations (
      id TEXT PRIMARY KEY,
      tenant_key TEXT NOT NULL,
      user_key TEXT,
      contract_hash TEXT NOT NULL,
      provider_id INTEGER NOT NULL,
      provider_key_id INTEGER NOT NULL,
      canonical_model_id TEXT,
      upstream_chat_id TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      chain_hash TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'ready',
      lease_id TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_zai_conv_match ON zai_conversations(tenant_key, user_key, chain_hash, message_count)");
    return true;
  } catch (e) {
    console.warn("[gateway] zai conversations migration skipped:", e.message);
    return false;
  }
}

// model_routes becomes typed: a decision model is an ordinary route that
// answers a structured endpoint, not a second routing system. Existing
// databases keep the old shape because CREATE TABLE IF NOT EXISTS is a no-op,
// so the columns are added by guarded ALTERs.
export function migrateModelRouteKinds(db) {
  const added = [];
  try {
    const r = db.prepare("PRAGMA table_info(model_routes)").all();
    const names = new Set(((r && r.results) || []).map((c) => c && c.name));
    const cols = [
      ["model_kind", "TEXT NOT NULL DEFAULT 'chat'"],
      ["wire_format", "TEXT"],
      ["endpoint_path", "TEXT"]
    ];
    for (const [name, type] of cols) {
      if (names.has(name)) continue;
      db.exec("ALTER TABLE model_routes ADD COLUMN " + name + " " + type);
      added.push(name);
    }
    if (added.length)
      console.warn("[gateway] migration: added model_routes type columns:", added.join(", "));
  } catch (e) {
    console.warn("[gateway] model route kinds migration skipped:", e.message);
  }
  return added;
}
