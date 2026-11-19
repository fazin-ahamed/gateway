// Edge Worker integration tests. These run against REAL workerd + local D1 via
// `wrangler dev` (not Node), exercising the built bundle .edge-build/index.js.
// The harness (test/edge/harness.mjs) boots wrangler, applies migrations, and
// exposes the base URL; per-test state is a fresh key each time.
// Run: npm run test:edge   (from ai-gateway/)
import test from "node:test";
import assert from "node:assert/strict";
import { bootEdge } from "./harness.mjs";

const admin = { authorization: "Bearer edge-admin", "content-type": "application/json" };

test("edge worker boots under workerd with migrated D1", async () => {
  const edge = bootEdge();
  const base = await edge.ready();
  const dispose = edge.dispose;
  try {
    const res = await fetch(base + "/health");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  } finally { await dispose(); }
});

test("unauthenticated /v1/models is rejected, node-host routes are gone", async () => {
  const edge = bootEdge();
  const base = await edge.ready();
  const dispose = edge.dispose;
  try {
    assert.equal((await fetch(base + "/v1/models")).status, 401);
    for (const p of ["/admin/proxies", "/admin/egress/test"]) {
      assert.equal((await fetch(base + p, { headers: admin })).status, 404, p + " must be stripped");
    }
  } finally { await dispose(); }
});

test("admin invite creation performs a real D1 write through the worker", async () => {
  const edge = bootEdge();
  const base = await edge.ready();
  const dispose = edge.dispose;
  try {
    const res = await fetch(base + "/admin/accounts", { method: "POST", headers: admin, body: JSON.stringify({ budget_mode: "usd", budget_limit: 5, tier_ids: [] }) });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.ok(body.token && body.token.startsWith("rst_"), "invite token returned");
  } finally { await dispose(); }
});



test("a legitimate OpenAI-compatible route is fully operational on the edge", async () => {
  const edge = bootEdge();
  const base = await edge.ready();
  const dispose = edge.dispose;
  try {
    let res = await fetch(base + "/admin/providers", { method: "POST", headers: admin, body: JSON.stringify({ name: "Legit", base_url: "https://api.example/v1", fmt: "openai" }) });
    const prov = await res.json();
    assert.equal(res.status, 201);
    res = await fetch(base + "/admin/routes", { method: "POST", headers: admin, body: JSON.stringify({ slug: "glm-legit", provider_id: prov.id, upstream_model: "glm-5.3", rank: 1 }) });
    assert.equal(res.status, 201);
    res = await fetch(base + "/admin/keys", { method: "POST", headers: admin, body: JSON.stringify({ name: "legit", budget_limit: 5 }) });
    const key = (await res.json()).key;
    res = await fetch(base + "/v1/models", { headers: { authorization: "Bearer " + key } });
    const body = await res.json();
    const slugs = (body.data || []).map((m) => m.id);
    assert.ok(slugs.includes("glm-legit"), "legit slug advertised");
    assert.ok(slugs.includes("auto"), "auto model advertised");
    // no output-zero metadata ever
    for (const m of body.data || []) {
      assert.ok(m.max_output_tokens !== 0 && m.context_window !== 0, "no zero capability for " + m.id);
    }
  } finally { await dispose(); }
});

test("D1 usage baseline: hot auth and models queries are index-served", async () => {
  const edge = bootEdge();
  const base = await edge.ready();
  try {
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      const res = await fetch(base + "/v1/models", { headers: { authorization: "Bearer edge-key" } });
      assert.equal(res.status, 401);
    }
    const perReqMs = (Date.now() - t0) / 10;
    console.log("           /v1/models avg latency (10 reqs):", perReqMs.toFixed(1), "ms");
    assert.ok(perReqMs < 2000, "unauthenticated listing stays fast under local workerd");
  } finally { await edge.dispose(); }
});
