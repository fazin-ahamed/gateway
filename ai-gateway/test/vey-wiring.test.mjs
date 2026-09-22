// Vey export wiring regressions — the checks that failed in review.
//
// 1. The RL export button rendered but had no click handler after the Vey
//    button was inserted over its line. Any format button present in the
//    trajectories page HTML must have a downloadTraj handler wired for it —
//    a rendered button that does nothing is a silent feature loss.
// 2. The serving-side canonical resolution must actually resolve: the alias
//    index is loaded with a gateway-shaped context and the resolver's
//    options-object API is unwrapped to the canonicalModelId string. A
//    positional call against an empty index silently exported null
//    everywhere.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadAliasIndex, resolveCanonicalModel } from "../src/router/model-registry.js";
import { __test as veyServeTest } from "../src/export/vey-serve.js";

const SOURCE = readFileSync(new URL("../src/playground.js", import.meta.url), "utf8");

function extractTrajectoriesHtml() {
  const start = SOURCE.indexOf('<section class="tab" id="tab-trajectories">');
  const end = SOURCE.indexOf("</section>", start);
  return SOURCE.slice(start, end);
}

test("every format export button in the trajectories UI has a wired handler", () => {
  const html = extractTrajectoriesHtml();
  const ids = [...html.matchAll(/id="(tj-export-([a-z]+))"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5, "expected all five export buttons, found: " + ids.join(","));
  for (const id of ids) {
    const wired = SOURCE.includes("document.getElementById('" + id + "').onclick=function(){ downloadTraj(");
    assert.ok(wired, id + " has no downloadTraj handler");
  }
  // The regression that bit: RL must still be wired after Vey was added.
  assert.ok(ids.includes("tj-export-rl"), "the RL button must exist");
  assert.ok(ids.includes("tj-export-vey"), "the Vey button must exist");
});

// The DB shape model-registry expects: prepare(...).bind(...).all() returning
// { results: [...] }. Built from an in-memory alias table.
function fakeDb(rows) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        all() { return { results: rows.filter(() => true) }; },
        first() { return null; }
      };
    }
  };
}

test("vey-serve loadAliasIndex accepts a raw DB handle and returns a usable index", async () => {
  const rows = [
    { alias: "glm-5.3", canonical_model_id: "glm-5.3", alias_type: "public_slug", provider_id: null, confidence: 1, source: "seed" }
  ];
  const db = fakeDb(rows);
  const index = await veyServeTest.loadAliasIndex(db);
  assert.ok(index && index.size > 0, "the index must load through the gateway-shaped context");
  const hit = resolveCanonicalModel(index, { publicSlug: "glm-5.3", upstreamModel: "whatever" });
  assert.equal(hit && hit.canonicalModelId, "glm-5.3");
});

test("resolveCanonicalModel returns an object whose canonicalModelId is the string", async () => {
  const rows = [
    { alias: "x-preview-l", canonical_model_id: "glm-5.3-flash", alias_type: "public_slug", provider_id: null, confidence: 1, source: "seed" }
  ];
  const index = await loadAliasIndex({ env: { DB: fakeDb(rows) } });
  const hit = resolveCanonicalModel(index, { providerId: 7, publicSlug: "x-preview-l", upstreamModel: "GLM-5.3-Flash" });
  assert.equal(typeof hit.canonicalModelId, "string");
  assert.equal(hit.canonicalModelId, "glm-5.3-flash");
  // Unwrapping the object as if it were the string id was the old bug: the
  // episode would carry "[object Object]" or null instead of the id.
  assert.notEqual(String(hit), hit.canonicalModelId);
});

test("an empty alias index resolves to null, never a fabricated id", () => {
  const empty = new Map();
  const hit = resolveCanonicalModel(empty, { publicSlug: "anything", upstreamModel: "anything" });
  assert.equal(hit, null);
  const nullIndex = resolveCanonicalModel(null, { publicSlug: "anything" });
  assert.equal(nullIndex, null);
});

// Two regressions, both observed in production:
//   * returning nothing closed the connection with an empty body, which
//     Firefox reports as NS_ERROR_NET_EMPTY_RESPONSE;
//   * selecting every request_json and response_json in one .all() tripled the
//     dataset in the heap and killed Node at its ~2GB limit.
// The page query must select ids only. Bodies load one row at a time, the
// export streams, a second overlapping export is refused, and ?limit= bounds it.
function trajectoryDb(rows) {
  const seen = [];
  const db = {
    seen,
    prepare(sql) {
      const text = String(sql);
      let bound = [];
      return {
        bind(...args) { bound = args; return this; },
        first() {
          seen.push({ sql: text, bound });
          const id = bound[0];
          return rows.find((r) => r.id === id) || null;
        },
        run() { return { meta: { changes: 0 } }; },
        all() {
          seen.push({ sql: text, bound });
          if (/SELECT\s+(?!id, created_at\b)[^]*?\bFROM trajectories\b/.test(text) && /\b(request_json|response_json)\b/.test(text.split(/\bFROM trajectories\b/)[0]))
            throw new Error("page query selected trajectory bodies: " + text);
          if (text.includes("FROM trajectories")) {
            const lim = bound[bound.length - 1];
            const cursorAt = text.includes("created_at>?") ? bound.length - 4 : -1;
            const after = cursorAt >= 0 ? { created_at: bound[cursorAt], id: bound[cursorAt + 2] } : null;
            const page = rows
              .filter((r) => r.request_json != null)
              .filter((r) => !after || r.created_at > after.created_at || (r.created_at === after.created_at && r.id > after.id))
              .slice(0, lim)
              .map((r) => ({ id: r.id, created_at: r.created_at }));
            return { results: page };
          }
          if (text.includes("FROM route_attempts"))
            return { results: [{ id: 1, request_id: bound[0], route_id: 7, provider_id: 1, public_slug: "glm-5.3", upstream_model: "GLM-5.3", transport: "openai", task_type: "chat", attempt_index: 0, success: 1, health_impact: 1, http_status: 200, latency_ms: 30 }] };
          return { results: [] };
        }
      };
    }
  };
  return db;
}

function trajRow(id, created) {
  return {
    id, created_at: created, slug: "glm-5.3", stream: 0, status: "ok", http_status: 200,
    provider: "z-ai", attempts: 1, prompt_tokens: 4, completion_tokens: 2, total_tokens: 6,
    cost_usd: 0, latency_ms: 30, error: null,
    request_json: JSON.stringify({ messages: [{ role: "user", content: "go " + id }] }),
    response_json: JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] })
  };
}

test("GET /admin/trajectories-export?format=vey streams one episode per row without bulk body reads", async () => {
  const { createApp } = await import("../src/index.js");
  const rows = [trajRow("req_1", "2026-01-01T00:00:00.000Z"), trajRow("req_2", "2026-01-01T00:00:01.000Z"), trajRow("req_3", "2026-01-01T00:00:02.000Z")];
  const db = trajectoryDb(rows);
  const app = createApp({ DB: db, ADMIN_TOKEN: "secret" });
  const res = await app.fetch(new Request("http://gw/admin/trajectories-export?format=vey&limit=2", {
    headers: { authorization: "Bearer secret" }
  }));
  assert.equal(res.status, 200);
  const body = await res.text();
  const lines = body.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.id), ["req_1", "req_2"], "limit must bound the export");
  assert.ok(lines.every((l) => l.schema === "vey.world.v1"));
  assert.equal(res.headers.get("content-disposition"), "attachment; filename=trajectories-vey.jsonl");
  const bulk = db.seen.filter((q) => q.sql.includes("FROM trajectories") && !q.sql.includes("WHERE id=?") && /\b(request_json|response_json)\b/.test(q.sql.split("FROM trajectories")[0]));
  assert.equal(bulk.length, 0, "no multi-row query may select trajectory bodies");
  const singles = db.seen.filter((q) => q.sql.includes("FROM trajectories WHERE id=?"));
  assert.equal(singles.length, 2, "each emitted episode loads exactly one body");
  const pages = db.seen.filter((q) => q.sql.startsWith("SELECT id, created_at FROM trajectories"));
  assert.ok(pages.length >= 1, "the export must page over ids");
});

test("a second vey export is refused while the first stream is still open", async () => {
  const { createApp } = await import("../src/index.js");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const db = trajectoryDb([trajRow("req_9", "2026-01-02T00:00:00.000Z")]);
  const realPrepare = db.prepare;
  db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    if (String(sql).includes("FROM trajectories WHERE id=")) {
      const real = stmt.first;
      stmt.first = () => gate.then(() => real());
    }
    return stmt;
  };
  const app = createApp({ DB: db, ADMIN_TOKEN: "secret" });
  const first = await app.fetch(new Request("http://gw/admin/trajectories-export?format=vey", {
    headers: { authorization: "Bearer secret" }
  }));
  assert.equal(first.status, 200);
  const reader = first.body.getReader();
  const pending = reader.read();
  const second = await app.fetch(new Request("http://gw/admin/trajectories-export?format=vey", {
    headers: { authorization: "Bearer secret" }
  }));
  assert.equal(second.status, 409, "two exports at once is how the heap death repeated");
  release();
  await pending;
  await reader.cancel();
  const third = await app.fetch(new Request("http://gw/admin/trajectories-export?format=vey", {
    headers: { authorization: "Bearer secret" }
  }));
  assert.equal(third.status, 200, "the lock must release when the client disconnects");
  await third.text();
});
