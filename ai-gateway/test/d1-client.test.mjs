// Unit tests for the D1 HTTP client (server/d1.mjs) using a stubbed global
// fetch. No real network calls: every request is captured and answered with
// canned Cloudflare response shapes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1Db } from "../../server/d1.mjs";

const ENV = {
  CLOUDFLARE_API_TOKEN: "tok-123",
  CLOUDFLARE_ACCOUNT_ID: "acct-abc",
  D1_DATABASE_ID: "db-uuid",
};
const BASE = "https://api.cloudflare.com/client/v4/accounts/acct-abc/d1/database/db-uuid";

function okQueryResult(rows, meta = {}) {
  return { success: true, result: [{ results: rows, success: true, meta }] };
}

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init };
    try { call.body = JSON.parse(init.body); } catch { call.body = init.body; }
    calls.push(call);
    return handler(call);
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
    async json(status, payload) {
      return { status, json: async () => payload, text: async () => JSON.stringify(payload) };
    },
  };
}

async function withDb(handler, fn) {
  const s = stubFetch(handler);
  try {
    return await fn(createD1Db(ENV), s.calls);
  } finally {
    s.restore();
  }
}

test("prepare().bind() posts to /query with sql, params, and bearer auth", async () => {
  await withDb(
    (call) => ({ status: 200, json: async () => okQueryResult([{ id: 7, slug: "gpt" }]) }),
    async (db, calls) => {
      const row = await db.prepare("SELECT id, slug FROM model_routes WHERE id = ?").bind(7).first();
      assert.deepEqual(row, { id: 7, slug: "gpt" });
      const call = calls[0];
      assert.ok(call.url.startsWith(BASE + "/query"), "URL should hit /query: " + call.url);
      assert.equal(call.init.headers.authorization, "Bearer tok-123");
      assert.equal(call.init.headers["content-type"], "application/json");
      assert.equal(call.body.sql, "SELECT id, slug FROM model_routes WHERE id = ?");
      assert.deepEqual(call.body.params, [7]);
    }
  );
});

test("first() returns null when no rows; all() returns {results}; run() maps meta", async () => {
  await withDb(
    (call) => {
      if (call.body.sql.includes("COUNT")) return { status: 200, json: async () => okQueryResult([]) };
      if (call.body.sql.startsWith("SELECT")) return { status: 200, json: async () => okQueryResult([{ n: 2 }, { n: 5 }]) };
      return { status: 200, json: async () => okQueryResult([], { changes: 3, last_row_id: 42 }) };
    },
    async (db) => {
      assert.equal(await db.prepare("SELECT COUNT(*) n FROM t WHERE k=?").bind("nope").first(), null);
      const all = await db.prepare("SELECT n FROM t").all();
      assert.deepEqual(all, { results: [{ n: 2 }, { n: 5 }] });
      const run = await db.prepare("INSERT INTO t (x) VALUES (?)").bind(1).run();
      assert.deepEqual(run, { meta: { changes: 3, last_row_id: 42 } });
    }
  );
});

test("Cloudflare error shape throws Error with code attached", async () => {
  await withDb(
    () => ({ status: 400, json: async () => ({ success: false, errors: [{ code: 7500, message: "no such table" }] }) }),
    async (db) => {
      await assert.rejects(
        () => db.prepare("SELECT 1").all(),
        (e) => e.message === "no such table" && e.code === 7500
      );
    }
  );
});

test("exec posts to /raw with the sql body", async () => {
  await withDb(
    () => ({ status: 200, json: async () => ({ success: true, result: [{ success: true }] }) }),
    async (db, calls) => {
      await db.exec("CREATE TABLE t (id INTEGER); CREATE INDEX i ON t(id);");
      const call = calls[0];
      assert.ok(call.url.endsWith("/raw"), "exec should POST /raw: " + call.url);
      assert.equal(call.body.sql, "CREATE TABLE t (id INTEGER); CREATE INDEX i ON t(id);");
      assert.ok(!call.body.batch && !call.body.params);
    }
  );
});

test("batch posts {batch:[{sql,params}]} to /raw and maps results", async () => {
  await withDb(
    () => ({ status: 200, json: async () => ({ success: true, result: [{ results: [{ a: 1 }], success: true, meta: { changes: 1 } }, { results: [], success: true, meta: {} }] }) }),
    async (db, calls) => {
      const out = await db.batch([{ sql: "INSERT INTO t VALUES (?)", params: [1] }, { sql: "SELECT 1" }]);
      assert.deepEqual(out, [
        { results: [{ a: 1 }], meta: { changes: 1 } },
        { results: [], meta: {} },
      ]);
      assert.ok(calls[0].url.endsWith("/raw"));
      assert.deepEqual(calls[0].body.batch, [{ sql: "INSERT INTO t VALUES (?)", params: [1] }, { sql: "SELECT 1", params: [] }]);
    }
  );
});

test("PRAGMA table_info is sent as-is to /query and rows are mapped", async () => {
  await withDb(
    (call) => ({ status: 200, json: async () => okQueryResult([{ cid: 0, name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 }]) }),
    async (db, calls) => {
      const cols = await db.prepare("PRAGMA table_info(providers)").all();
      assert.equal(cols.results[0].name, "id");
      const call = calls[0];
      assert.ok(call.url.startsWith(BASE + "/query"));
      assert.equal(call.body.sql, "PRAGMA table_info(providers)");
      assert.deepEqual(call.body.params, []);
    }
  );
});

test("PRAGMA table_info falls back to pragma_table_info() when D1 rejects it", async () => {
  await withDb(
    (call) => {
      if (call.body.sql.startsWith("PRAGMA")) {
        return { status: 400, json: async () => ({ success: false, errors: [{ code: 7500, message: "unsupported statement" }] }) };
      }
      assert.ok(call.body.sql.includes("FROM pragma_table_info(providers)"), "fallback SQL: " + call.body.sql);
      return { status: 200, json: async () => okQueryResult([{ cid: 2, name: "enabled", type: "INTEGER", notnull: 1, dflt_value: 1, pk: 0 }]) };
    },
    async (db) => {
      const cols = await db.prepare("PRAGMA table_info(providers)").all();
      assert.equal(cols.results[0].name, "enabled");
      assert.equal(cols.results[0].dflt_value, 1);
    }
  );
});

test("createD1Db throws when env is incomplete", () => {
  assert.throws(() => createD1Db({}), /CLOUDFLARE_API_TOKEN/);
  assert.throws(() => createD1Db({ CLOUDFLARE_API_TOKEN: "t" }), /CLOUDFLARE_ACCOUNT_ID/);
  assert.throws(() => createD1Db({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }), /D1_DATABASE_ID/);
});

// ---- round-trip reduction: read cache + write-behind batching ----

test("config SELECTs are served from the TTL cache; request-scoped tables never are", async () => {
  await withDb(
    () => ({ status: 200, json: async () => okQueryResult([{ n: 1 }]) }),
    async (db, calls) => {
      const q = () => db.prepare("SELECT slug FROM model_routes WHERE slug=?").bind("a").first();
      await q(); await q(); await q();
      assert.equal(calls.length, 1, "three identical config reads cost one HTTP call");
      await db.prepare("SELECT * FROM api_keys WHERE key_id=?").bind("k").first();
      await db.prepare("SELECT * FROM api_keys WHERE key_id=?").bind("k").first();
      assert.equal(calls.length, 3, "api_keys (balance, rate state) is never cached");
    }
  );
});

test("a cached row mutated by the caller does not poison later hits", async () => {
  await withDb(
    () => ({ status: 200, json: async () => okQueryResult([{ slug: "a" }]) }),
    async (db) => {
      const q = () => db.prepare("SELECT slug FROM model_routes").first();
      const r = await q();
      r.slug = "mutated";
      assert.equal((await q()).slug, "a");
    }
  );
});

test("an admin write to a config table invalidates the cache", async () => {
  await withDb(
    (call) => ({ status: 200, json: async () => okQueryResult([{ v: 1 }], { changes: 1 }) }),
    async (db, calls) => {
      const q = () => db.prepare("SELECT slug FROM model_routes").first();
      await q(); await q();
      assert.equal(calls.length, 1);
      await db.prepare("UPDATE model_routes SET rank=? WHERE slug=?").bind(1, "a").run();
      await q();
      assert.equal(calls.length, 3, "write + re-read after invalidation");
    }
  );
});

test("telemetry writes are batched into one /raw call and flushed on demand", async () => {
  await withDb(
    () => ({ status: 200, json: async () => ({ success: true, result: [] }) }),
    async (db, calls) => {
      for (let i = 0; i < 5; i++) {
        const r = await db.prepare("INSERT INTO model_usage (slug, kind, bucket, value) VALUES (?,?,?,?)").bind("s", "tokens", "b" + i, i).run();
        assert.equal(r.meta.changes, 1);
      }
      await db.prepare("UPDATE router_stats SET n=n+1 WHERE id=?").bind(1).run();
      assert.equal(calls.length, 0, "nothing hits the network until the flush");
      await db.flush();
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.endsWith("/raw"));
      assert.equal(calls[0].body.batch.length, 6);
      assert.deepEqual(calls[0].body.batch[0].params, ["s", "tokens", "b0", 0]);
    }
  );
});

test("a read of a table with queued writes flushes first (read-your-writes)", async () => {
  await withDb(
    (call) => ({ status: 200, json: async () => call.url.endsWith("/raw") ? { success: true, result: [] } : okQueryResult([{ n: 1 }]) }),
    async (db, calls) => {
      await db.prepare("INSERT OR IGNORE INTO request_summaries (request_id) VALUES (?)").bind("r1").run();
      await db.prepare("SELECT COUNT(*) AS n FROM request_summaries").first();
      assert.equal(calls.length, 2);
      assert.ok(calls[0].url.endsWith("/raw"), "queued insert lands before the read");
      assert.ok(calls[1].url.endsWith("/query"));
    }
  );
});

test("money and DELETE writes stay synchronous and report real meta", async () => {
  await withDb(
    () => ({ status: 200, json: async () => okQueryResult([], { changes: 3, last_row_id: 9 }) }),
    async (db, calls) => {
      const spend = await db.prepare("UPDATE api_keys SET used_usd=used_usd+? WHERE key_id=?").bind(1, "k").run();
      assert.equal(calls.length, 1, "api_keys update is awaited, not deferred");
      assert.deepEqual(spend.meta, { changes: 3, last_row_id: 9 });
      const purge = await db.prepare("DELETE FROM trajectories").run();
      assert.equal(calls.length, 2);
      assert.equal(purge.meta.changes, 3);
      const att = await db.prepare("INSERT INTO route_attempts (a) VALUES (?)").bind(1).run();
      assert.equal(att.meta.last_row_id, 9, "route_attempts last_row_id feeds quality observations");
    }
  );
});

test("the per-request provider status stamp is deferred, and does not flush the config cache", async () => {
  await withDb(
    (call) => ({ status: 200, json: async () => call.url.endsWith("/raw") ? { success: true, result: [] } : okQueryResult([{ id: 1 }]) }),
    async (db, calls) => {
      const read = () => db.prepare("SELECT id FROM providers WHERE id=?").bind(1).first();
      await read();
      await db.prepare("UPDATE providers SET last_status=?, last_checked=? WHERE id=?").bind(200, "t", 1).run();
      // Admin edits (name, enabled) are not deferred: they return meta.changes.
      await read();
      assert.equal(calls.length, 2, "one providers read + one flush for the queued stamp; second read is cached");
      assert.ok(calls[1].url.endsWith("/raw"));
    }
  );
});

test("a failed batch retries each statement alone so one bad row cannot drop the rest", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await withDb(
      (call) => {
        if (call.url.endsWith("/raw")) return { status: 400, json: async () => ({ success: false, errors: [{ code: 1, message: "batch failed" }] }) };
        if (call.body.params[0] === "bad") return { status: 400, json: async () => ({ success: false, errors: [{ code: 2, message: "constraint" }] }) };
        return { status: 200, json: async () => okQueryResult([], { changes: 1 }) };
      },
      async (db, calls) => {
        await db.prepare("INSERT INTO model_usage (slug, kind, bucket, value) VALUES (?,?,?,?)").bind("good1", "t", "b", 1).run();
        await db.prepare("INSERT INTO model_usage (slug, kind, bucket, value) VALUES (?,?,?,?)").bind("bad", "t", "b", 1).run();
        await db.prepare("INSERT INTO model_usage (slug, kind, bucket, value) VALUES (?,?,?,?)").bind("good2", "t", "b", 1).run();
        await db.flush();
        const solo = calls.filter((c) => c.url.endsWith("/query")).map((c) => c.body.params[0]);
        assert.deepEqual(solo, ["good1", "bad", "good2"]);
        assert.equal(db.stats.dropped, 1);
      }
    );
  } finally {
    console.warn = origWarn;
  }
});
