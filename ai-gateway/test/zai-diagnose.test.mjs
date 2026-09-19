import test from "node:test";
import assert from "node:assert/strict";

import { createApp, __test as t } from "../src/index.js";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";

// A minimal well-formed JWT (header.payload.sig) with an id claim.
function jwt(id) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return b64({ alg: "ES256", typ: "JWT" }) + "." + b64({ id, email: "x@example.com" }) + ".sig";
}

async function seededApp() {
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, ADMIN_TOKEN: "admin", PROVIDER_CRYPTO_KEY: "diag-crypto-key" };
  const app = createApp(env);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers (id, name, base_url, fmt, transport, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(1, "Z.AI web chat (pure HTTP)", "https://chat.z.ai", "zaiminted", "direct", 1, 1, "round_robin", now).run();
  // Seal an account token as the provider credential, same as the live path.
  const sealed = await t.sealProviderKey(env, JSON.stringify({ token: jwt("acct-42") }));
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)").bind(1, sealed, "primary", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)").bind("glm-5.3-flash", 1, "x-preview-l").run();
  return { app, db, env };
}
const AUTH = { authorization: "Bearer admin" };

test("GET /admin/zai/diagnose reports per-phase status and adopts the account token, no token leak", async () => {
  const { app } = await seededApp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === "https://chat.z.ai/")
      return new Response("<html>/frontend/prod-fe-1.2.3/assets/x.js</html>", { status: 200 });
    // account path adopts directly; no auth probe needed, but answer anyway.
    return new Response(JSON.stringify({ token: jwt("acct-42") }), { status: 200 });
  };
  try {
    const res = await app.fetch(new Request("http://gw/admin/zai/diagnose", { headers: AUTH }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true, "diagnostic reached a usable session");
    assert.equal(body.account_token_supplied, true);
    assert.equal(body.provider, "Z.AI web chat (pure HTTP)");
    assert.equal(body.fmt, "zaiminted");
    const warm = body.steps.find((s) => s.step === "warm");
    const acquire = body.steps.find((s) => s.step === "acquire");
    assert.ok(warm && warm.ok, "warm phase ran");
    assert.equal(warm.fe_version, "prod-fe-1.2.3", "frontend version discovered");
    assert.ok(acquire && acquire.ok);
    assert.equal(acquire.source, "account", "supplied account token adopted directly");
    assert.match(acquire.user_id, /^acct-42/);
    // Redaction: the full JWT must never appear anywhere in the report.
    assert.doesNotMatch(JSON.stringify(body), /\.sig/, "no raw token in the report");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("diagnose surfaces the failing phase when warm is stonewalled", async () => {
  const { app } = await seededApp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNRESET stonewalled"); };
  try {
    const res = await app.fetch(new Request("http://gw/admin/zai/diagnose", { headers: AUTH }));
    const body = await res.json();
    // warm swallows its own error (best-effort), so acquire is where a
    // token-less failure surfaces; with an account token it still adopts.
    // Here the account token is present, so it should still adopt despite warm
    // failing — proving warm is non-fatal when a token exists.
    assert.equal(body.account_token_supplied, true);
    assert.equal(body.ok, true, "account token adopts even when warm is stonewalled");
    const warm = body.steps.find((s) => s.step === "warm");
    assert.ok(warm.ok, "warm is best-effort and reported, not thrown");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("diagnose requires admin", async () => {
  const { app } = await seededApp();
  const res = await app.fetch(new Request("http://gw/admin/zai/diagnose"));
  assert.equal(res.status, 401);
});

test("POST /admin/egress/test probes a URL through the helper, metadata only", async () => {
  const { app, env } = await seededApp();
  // Seed a pool proxy with a sealed password so we can test proxy_id resolution.
  const now = new Date().toISOString();
  const sealed = await t.sealProviderKey(env, "s3cret");
  env.DB.prepare("INSERT INTO proxy_pool (scheme, host, port, username, password_enc, enabled, status, created_at, updated_at) VALUES ('socks5h','p.example',1080,'bob',?,1,'healthy',?,?)").bind(sealed, now, now).run();
  const pid = env.DB.prepare("SELECT id FROM proxy_pool WHERE host='p.example'").all().results[0].id;
  const realFetch = globalThis.fetch;
  const prevProxy = process.env.ZAI_UTLS_PROXY;
  process.env.ZAI_UTLS_PROXY = "http://127.0.0.1:8477";
  let reachBody = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/healthz")) return new Response('{"ok":true}', { status: 200 });
    if (u.endsWith("/reach-egress")) {
      reachBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ success: true, http_status: 403, connect_ms: 40, tunnel_ms: 60, tls_ms: 55, total_ms: 200 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  try {
    const res = await app.fetch(new Request("http://gw/admin/egress/test", {
      method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://chat.z.ai/", proxy_id: pid })
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.success, true);
    assert.equal(body.result.http_status, 403);
    assert.match(body.via, /proxy #/);
    // The helper received the decrypted proxy URL, but the admin response must not.
    assert.match(reachBody.proxy, /bob:s3cret@p\.example:1080/, "helper gets the real proxy");
    assert.doesNotMatch(JSON.stringify(body), /s3cret/, "admin response never carries the password");
  } finally {
    globalThis.fetch = realFetch;
    if (prevProxy === undefined) delete process.env.ZAI_UTLS_PROXY; else process.env.ZAI_UTLS_PROXY = prevProxy;
  }
});

test("POST /admin/egress/test rejects non-https and requires admin", async () => {
  const { app } = await seededApp();
  const noauth = await app.fetch(new Request("http://gw/admin/egress/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://x/" }) }));
  assert.equal(noauth.status, 401);
  const bad = await app.fetch(new Request("http://gw/admin/egress/test", { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ url: "ftp://x/" }) }));
  assert.equal(bad.status, 400);
});
