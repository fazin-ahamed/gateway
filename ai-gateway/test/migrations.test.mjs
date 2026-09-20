import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateQualityIdentity, migratePrices } from "../../server/migrations.mjs";


// A legacy DB: quality_observations exists WITHOUT canonical_model_id, exactly
// the shape produced by an older schema.sql. CREATE TABLE IF NOT EXISTS then
// never adds the column, and the quality INSERT fails on every request.
function legacyDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE quality_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      route_attempt_id INTEGER,
      route_id INTEGER,
      provider_id INTEGER,
      public_slug TEXT,
      upstream_model TEXT,
      task_type TEXT NOT NULL DEFAULT '',
      signal_type TEXT NOT NULL,
      value REAL NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      objective INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(request_id, route_attempt_id, signal_type, source)
    )
  `);
  return db;
}

test("migrateQualityIdentity adds canonical_model_id to a legacy DB and unblocks the quality INSERT", () => {
  const raw = legacyDb();
  const wrapper = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      const api = { bind(...p) { api._p = p; return api; } };
      api.run = () => { stmt.run(...(api._p || [])); return { meta: {} }; };
      api.all = () => ({ results: stmt.all(...(api._p || [])) });
      api.first = () => stmt.get(...(api._p || [])) ?? null;
      return api;
    },
  };

  const cols = raw.prepare("PRAGMA table_info(quality_observations)").all().map((c) => c.name);
  assert.ok(!cols.includes("canonical_model_id"), "legacy DB must lack the column");

  const added = migrateQualityIdentity(wrapper);
  assert.equal(added, true, "migration reports it added the column");

  const after = raw.prepare("PRAGMA table_info(quality_observations)").all().map((c) => c.name);
  assert.ok(after.includes("canonical_model_id"), "column now present");

  // The exact INSERT the runtime performs (D1-shape wrapper) must now succeed.
  wrapper.prepare(
    "INSERT INTO quality_observations (request_id, route_attempt_id, route_id, provider_id, public_slug, upstream_model, canonical_model_id, task_type, signal_type, value, weight, objective, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind("req-1", 1, 1, 1, "z-ai/glm-5.3-flash", "glm-5.3-flash", "glm-5.3-flash", "chat:casual", "tool_valid", 1, 0.4, 1, "attempt", "2026-09-20T00:00:00Z").run();

  const n = wrapper.prepare("SELECT COUNT(*) AS n FROM quality_observations").first();
  assert.equal(Number(n && n.n), 1, "quality observation recorded");
});

test("migrateQualityIdentity is idempotent and no-ops a modern DB", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE quality_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      canonical_model_id TEXT
    )
  `);
  const wrapper = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      const api = { bind(...p) { api._p = p; return api; } };
      api.run = () => { stmt.run(...(api._p || [])); return { meta: {} }; };
      api.all = () => ({ results: stmt.all(...(api._p || [])) });
      api.first = () => stmt.get(...(api._p || [])) ?? null;
      return api;
    },
  };
  assert.equal(migrateQualityIdentity(wrapper), false, "modern DB: nothing to do");
  assert.equal(migrateQualityIdentity(wrapper), false, "second call still a no-op");
});

test("migratePrices is unchanged and importable alongside the new migration", () => {
  const raw = new DatabaseSync(":memory:");
  const wrapper = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      const api = { bind(...p) { api._p = p; return api; } };
      api.run = () => { stmt.run(...(api._p || [])); return { meta: {} }; };
      api.all = () => ({ results: stmt.all(...(api._p || [])) });
      api.first = () => stmt.get(...(api._p || [])) ?? null;
      return api;
    },
  };
  // An empty prices table simply skips both branches.
  migratePrices(wrapper);
  assert.equal(typeof migratePrices, "function");
});
