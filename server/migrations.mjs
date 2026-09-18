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
