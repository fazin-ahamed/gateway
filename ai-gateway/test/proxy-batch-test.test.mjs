import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";

async function seededApp() {
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, ADMIN_TOKEN: "admin", PROVIDER_CRYPTO_KEY: "px-crypto-key" };
  const app = createApp(env);
  return { app, db, env };
}

function seedProxy(db, { host, port = 8080, scheme = "http", status = "untested" }) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO proxy_pool (scheme, host, port, username, enabled, status, created_at, updated_at) VALUES (?,?,?,'',1,?,?,?)")
    .bind(scheme, host, port, status, now, now).run();
  return db.prepare("SELECT id FROM proxy_pool WHERE host=?").bind(host).all().results[0].id;
}

// Parse an SSE body into the array of data-event objects.
async function readSse(res) {
  const text = await res.text();
  const events = [];
  for (const frame of text.split("\n\n")) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (line) { try { events.push(JSON.parse(line.slice(5).trim())); } catch {} }
  }
  return events;
}

const AUTH = { authorization: "Bearer admin", "content-type": "application/json" };

test("POST /admin/proxies/test streams one result event per proxy plus start/done", async () => {
  const { app, db, env } = await seededApp();
  const good = seedProxy(db, { host: "good.example" });
  const bad = seedProxy(db, { host: "bad.example" });
  // Mock the uTLS helper: /healthz online, /check-egress verdict by host.
  const realFetch = globalThis.fetch;
  const prev = process.env.ZAI_UTLS_PROXY;
  process.env.ZAI_UTLS_PROXY = "http://127.0.0.1:8477";
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/healthz")) return new Response('{"ok":true}', { status: 200 });
    if (u.endsWith("/check-egress")) {
      const body = JSON.parse(init.body);
      const ok = body.proxy.includes("good.example");
      return new Response(JSON.stringify(ok
        ? { success: true, connect_ms: 30, tunnel_ms: 40, tls_ms: 35, total_ms: 120 }
        : { success: false, failure_class: "connect_timeout" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  try {
    const res = await app.fetch(new Request("http://gw/admin/proxies/test", {
      method: "POST", headers: AUTH, body: JSON.stringify({ stream: true, concurrency: 5 })
    }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const events = await readSse(res);
    const start = events.find((e) => e.type === "start");
    const results = events.filter((e) => e.type === "result");
    const done = events.find((e) => e.type === "done");
    assert.equal(start.total, 2, "start announces the pool size");
    assert.equal(results.length, 2, "one result event per proxy");
    assert.ok(events.some((e) => e.type === "eof"), "stream ends with eof");
    // Each result carries the post-update row snapshot the UI repaints from.
    const goodEv = results.find((e) => e.id === good);
    const badEv = results.find((e) => e.id === bad);
    assert.equal(goodEv.success, true);
    assert.equal(goodEv.status, "healthy");
    assert.equal(goodEv.last_latency_ms, 120);
    assert.equal(badEv.success, false);
    assert.equal(badEv.status, "flaky", "first failure is flaky, not dead");
    assert.equal(badEv.last_failure_class, "connect_timeout");
    assert.equal(done.tested, 2);
    assert.equal(done.healthy, 1);
    // The health rows were actually persisted, matching the streamed snapshots.
    const goodRow = db.prepare("SELECT status FROM proxy_pool WHERE id=?").bind(good).all().results[0];
    assert.equal(goodRow.status, "healthy");
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env.ZAI_UTLS_PROXY; else process.env.ZAI_UTLS_PROXY = prev;
  }
});

test("POST /admin/proxies/test non-stream still returns a JSON summary", async () => {
  const { app, db } = await seededApp();
  seedProxy(db, { host: "one.example" });
  const realFetch = globalThis.fetch;
  const prev = process.env.ZAI_UTLS_PROXY;
  process.env.ZAI_UTLS_PROXY = "http://127.0.0.1:8477";
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/healthz")) return new Response('{"ok":true}', { status: 200 });
    if (u.endsWith("/check-egress")) return new Response(JSON.stringify({ success: true, total_ms: 90 }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  };
  try {
    const res = await app.fetch(new Request("http://gw/admin/proxies/test", {
      method: "POST", headers: AUTH, body: JSON.stringify({})
    }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const body = await res.json();
    assert.deepEqual(body, { tested: 1, healthy: 1, dead: 0 });
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env.ZAI_UTLS_PROXY; else process.env.ZAI_UTLS_PROXY = prev;
  }
});

test("POST /admin/proxies/test requires admin", async () => {
  const { app } = await seededApp();
  const res = await app.fetch(new Request("http://gw/admin/proxies/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(res.status, 401);
});
