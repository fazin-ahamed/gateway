// Client-console backend: an API key exchanges once for an HttpOnly cookie,
// and every /console/api/* call attributes to that key. The dashboard must
// never hold the sk- secret after sign-in.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";
import { __test as gw } from "../src/index.js";

async function consoleGateway() {
  const { createApp } = await import("../src/index.js");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key-please-change", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind("sk-console", "console-test", 1, "usd", 1e9, now, now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(1, "P", "http://p.local", "direct", "openai", 1, 1, "round_robin", now).run();
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)")
    .bind(1, await gw.sealProviderKey(env, "sec"), "primary", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)")
    .bind("glm-5.3", 1, "g").run();
  // Real ledger rows the console must aggregate. The overview reads
  // request_summaries, not trajectories: capture-off must change nothing.
  const ins = db.prepare("INSERT INTO request_summaries (request_id, key_id, model_kind, public_slug, created_at, finished_at, status, http_status, headers_ms, ttft_ms, latency_ms, total_tokens, cost_usd, attempts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  ins.bind("req_a", "sk-console", "chat", "glm-5.3", day(0), day(0), "ok", 200, 300, 640, 842, 1800, 0.002, 1).run();
  ins.bind("req_b", "sk-console", "chat", "glm-5.3", day(1), day(1), "ok", 200, 350, 900, 1210, 2400, 0.003, 1).run();
  ins.bind("req_c", "sk-console", "chat", "glm-5.3", day(2), day(2), "fail", 503, null, null, 4020, 0, 0, 1).run();
  // Another key's traffic must never leak into this console.
  ins.bind("req_x", "sk-someone-else", "chat", "glm-5.3", day(0), day(0), "ok", 200, null, null, 1, 999999, 999, 1).run();
  return { app: createApp(env), db };
}

function cookieFrom(res) {
  const set = res.headers.get("set-cookie");
  assert.ok(set, "sign-in must set the session cookie");
  assert.match(set, /HttpOnly/, "the session cookie must not be readable from JS");
  assert.match(set, /Path=\/console/, "the cookie is scoped to the console");
  const m = set.match(/gw_client=([^;]+)/);
  assert.ok(m, "the cookie must be gw_client");
  return "gw_client=" + m[1];
}

test("an API key signs in once and every console call rides the session cookie", async () => {
  const { app } = await consoleGateway();
  const auth = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "sk-console" })
  }));
  assert.equal(auth.status, 200);
  const cookie = cookieFrom(auth);
  assert.match(auth.headers.get("set-cookie") || "", /HttpOnly/);

  const me = await app.fetch(new Request("http://gw/console/api/me", { headers: { cookie } }));
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.key.key_id, "sk-console");
  assert.equal(meBody.key.name, "console-test");
});

test("a bad key is refused and the API requires the cookie", async () => {
  const { app } = await consoleGateway();
  const bad = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "sk-wrong" })
  }));
  assert.equal(bad.status, 401);

  const noCookie = await app.fetch(new Request("http://gw/console/api/overview?days=7"));
  assert.equal(noCookie.status, 401, "without a session the API refuses");

  const forged = await app.fetch(new Request("http://gw/console/api/me", { headers: { cookie: "gw_client=bogus" } }));
  assert.equal(forged.status, 401, "an unknown session is rejected");
});

test("overview aggregates only this key's traffic with real numbers", async () => {
  const { app } = await consoleGateway();
  const auth = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: "sk-console" })
  }));
  const cookie = cookieFrom(auth);

  const res = await app.fetch(new Request("http://gw/console/api/overview?days=7", { headers: { cookie } }));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.totals.requests, 3, "three requests in the window");
  assert.equal(body.totals.tokens, 4200, "1800 + 2400 + 0");
  assert.ok(Math.abs(body.totals.spend_usd - 0.005) < 1e-9);
  assert.equal(body.totals.p95_ttft_ms, 900, "p95 of the two real ttft samples");
  assert.equal(body.series.length, 7, "seven days of series, zero-filled");
  assert.equal(body.recent.length, 3);
  assert.equal(body.recent.find((r) => r.id === "req_x"), undefined, "another key's traffic never appears");
  assert.equal(body.recent.find((r) => r.id === "req_a").ttft_ms, 640, "recent rows carry their real ttft");
});

test("the model list reflects the key and includes decision models on their own endpoint", async () => {
  const { app, db } = await consoleGateway();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(2, "TypeSafe", "https://up2.local", "direct", "systemone", 1, 1, "round_robin", now).run();
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)")
    .bind(2, await gw.sealProviderKey(db ? { PROVIDER_CRYPTO_KEY: "test-crypto-key-please-change" } : null, "sec2"), "primary", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled, model_kind, wire_format) VALUES (?,?,?,0,1,'decision','systemone')")
    .bind("jev", 2, "jev-latest").run();

  const auth = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: "sk-console" })
  }));
  const cookie = cookieFrom(auth);
  const res = await app.fetch(new Request("http://gw/console/api/models", { headers: { cookie } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const glm = body.data.find((m) => m.id === "glm-5.3");
  assert.ok(glm, "the key's chat model is listed");
  assert.equal(glm.model_kind, "chat");
  const jev = body.data.find((m) => m.id === "jev");
  assert.ok(jev, "the decision model is listed");
  assert.equal(jev.model_kind, "decision");
  assert.equal(jev.endpoint, "/v1/systemone");
  assert.equal(jev.protocol, "systemone");
});

test("request drill-down returns body-free facts for the drawer", async () => {
  const { app } = await consoleGateway();
  const auth = await app.fetch(new Request("http://gw/console/auth", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: "sk-console" })
  }));
  const cookie = cookieFrom(auth);
  const res = await app.fetch(new Request("http://gw/console/api/requests/req_a", { headers: { cookie } }));
  assert.equal(res.status, 200);
  const detail = await res.json();
  assert.equal(detail.id, "req_a");
  assert.equal(detail.ttft_ms, 640);
  assert.equal(detail.headers_ms, 300);
  assert.equal(detail.slug, "glm-5.3");
  // A request belonging to another key must 404, not leak.
  const foreign = await app.fetch(new Request("http://gw/console/api/requests/req_x", { headers: { cookie } }));
  assert.equal(foreign.status, 404);
});
