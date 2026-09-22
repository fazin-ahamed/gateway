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

// The Vey branch used to build the Response and then return nothing. Hono
// sends that as a closed connection with no body, which Firefox reports as
// NS_ERROR_NET_EMPTY_RESPONSE. The endpoint must hand the body back.
test("GET /admin/trajectories-export?format=vey returns the dataset body", async () => {
  const { createApp } = await import("../src/index.js");
  const request = JSON.stringify({ messages: [{ role: "user", content: "go" }] });
  const response = JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  const db = {
    prepare(sql) {
      const text = String(sql);
      return {
        bind() { return this; },
        first() { return null; },
        run() { return { meta: { changes: 0 } }; },
        all() {
          if (text.includes("FROM trajectories"))
            return { results: [{
              id: "req_1", created_at: "2026-01-01T00:00:00.000Z", slug: "glm-5.3",
              stream: 0, status: "ok", http_status: 200, provider: "z-ai", attempts: 1,
              prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost_usd: 0,
              latency_ms: 30, error: null, request_json: request, response_json: response
            }] };
          if (text.includes("FROM route_attempts"))
            return { results: [{
              id: 1, request_id: "req_1", route_id: 7, provider_id: 1, public_slug: "glm-5.3",
              upstream_model: "GLM-5.3", transport: "openai", task_type: "chat", attempt_index: 0,
              success: 1, health_impact: 1, http_status: 200, latency_ms: 30
            }] };
          return { results: [] };
        }
      };
    }
  };
  const app = createApp({ DB: db, ADMIN_TOKEN: "secret" });
  const res = await app.fetch(new Request("http://gw/admin/trajectories-export?format=vey", {
    headers: { authorization: "Bearer secret" }
  }));
  assert.equal(res.status, 200, "a dropped Response is a null body, not a 200");
  const body = await res.text();
  assert.ok(body.length > 0, "the export body must not be empty");
  const line = JSON.parse(body.trim().split("\n")[0]);
  assert.equal(line.schema, "vey.world.v1");
  assert.equal(line.id, "req_1");
  assert.equal(res.headers.get("content-disposition"), "attachment; filename=trajectories-vey.jsonl");
});
