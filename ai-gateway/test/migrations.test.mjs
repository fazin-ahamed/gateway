import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateQualityIdentity, migratePrices, migrateRouteAttemptsV2, migrateZaiConversations } from "../../server/migrations.mjs";


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

test("migrateRouteAttemptsV2 adds headers_ms to a legacy route_attempts table", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE route_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    public_slug TEXT NOT NULL,
    started_at TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0,
    ttft_ms INTEGER,
    latency_ms INTEGER
  )`);
  const wrapper = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      const api = { bind(...p) { api._p = p; return api; } };
      api.run = () => { stmt.run(...(api._p || [])); return { meta: {} }; };
      api.all = () => ({ results: stmt.all(...(api._p || [])) });
      api.first = () => stmt.get(...(api._p || [])) ?? null;
      return api;
    }
  };
  const before = raw.prepare("PRAGMA table_info(route_attempts)").all().map((c) => c.name);
  assert.ok(!before.includes("headers_ms"));
  const added = migrateRouteAttemptsV2(wrapper);
  assert.ok(added.includes("headers_ms"));
  raw.prepare("INSERT INTO route_attempts (request_id, public_slug, started_at, headers_ms, ttft_ms) VALUES (?,?,?,?,?)").run("r1", "m", "t", 640, null);
  const row = raw.prepare("SELECT headers_ms, ttft_ms FROM route_attempts").get();
  assert.equal(row.headers_ms, 640);
  assert.equal(row.ttft_ms, null, "header time must not be stored as first-token time");
  assert.deepEqual(migrateRouteAttemptsV2(wrapper), [], "a second run adds nothing");
  raw.close();
});

test("migrateZaiConversations creates the affinity table and its match index, idempotently", () => {
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
    }
  };
  assert.equal(migrateZaiConversations(wrapper), true);
  const cols = raw.prepare("PRAGMA table_info(zai_conversations)").all().map((c) => c.name);
  assert.ok(cols.includes("upstream_chat_id") && cols.includes("chain_hash") && cols.includes("state"));
  // The exact runtime insert must succeed.
  raw.prepare("INSERT INTO zai_conversations (id, tenant_key, contract_hash, provider_id, provider_key_id, upstream_chat_id, message_count, chain_hash, created_at, last_used_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("cv_1", "k:sk|u:|c:|m:glm-5.3", "hc", 4, 17, "chat_a", 6, "h6", "t", "t", "t2");
  const row = raw.prepare("SELECT state, revision FROM zai_conversations WHERE id=?").get("cv_1");
  assert.equal(row.state, "ready");
  assert.equal(row.revision, 0);
  const idx = raw.prepare("PRAGMA index_list(zai_conversations)").all().map((i) => i.name);
  assert.ok(idx.includes("idx_zai_conv_match"));
  assert.equal(migrateZaiConversations(wrapper), true, "a second run is a no-op");
  raw.close();
});
