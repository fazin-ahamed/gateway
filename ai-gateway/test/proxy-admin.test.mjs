import test from "node:test";
import assert from "node:assert/strict";

import { createApp, __test as t } from "../src/index.js";
import { createDb } from "../../server/db.mjs";
import { readFileSync } from "node:fs";

function appWithDb() {
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, ADMIN_TOKEN: "admin", PROVIDER_CRYPTO_KEY: "proxy-test-crypto-key" };
  return { app: createApp(env), db, env };
}
const AUTH = { authorization: "Bearer admin" };

test("import reports accepted/duplicate/invalid and seals passwords (never plaintext in DB)", async () => {
  const { app, db } = appWithDb();
  const text = [
    "1.2.3.4:8080",
    "1.2.3.4:8080",
    "socks5://bob:s3cret@5.6.7.8:1080",
    "garbage",
    "ftp://9.9.9.9:21"
  ].join("\n");
  const res = await app.fetch(new Request("http://gw/admin/proxies/import", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ text, default_scheme: "http" })
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.imported, 2, "1.2.3.4 http + 5.6.7.8 socks5");
  assert.equal(body.duplicates, 1);
  assert.equal(body.invalid, 2);
  // The stored password must be an AES-GCM envelope, never the plaintext.
  const row = db.prepare("SELECT password_enc FROM proxy_pool WHERE host='5.6.7.8'").all().results[0];
  assert.ok(row.password_enc.startsWith("enc:v1:"), "password is sealed");
  assert.doesNotMatch(row.password_enc, /s3cret/);
});

test("GET /admin/proxies never returns the password and masks the endpoint", async () => {
  const { app } = appWithDb();
  await app.fetch(new Request("http://gw/admin/proxies/import", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ text: "socks5://bob:s3cret@5.6.7.8:1080" })
  }));
  const res = await app.fetch(new Request("http://gw/admin/proxies", { headers: AUTH }));
  const body = await res.json();
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /s3cret/, "password must never reach the browser");
  const p = body.proxies[0];
  assert.equal(p.username, "bob");
  assert.equal(p.has_password, true);
  assert.match(p.endpoint, /bob:\u2022\u2022\u2022@5\.6\.7\.8:1080/);
  assert.ok(!("password" in p) && !("password_enc" in p), "no password field of any kind");
});

test("proxy status lifecycle: 3 consecutive failures => dead; a success clears it", async () => {
  const { app, db, env } = appWithDb();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO proxy_pool (scheme, host, port, username, enabled, status, created_at, updated_at) VALUES ('http','1.2.3.4',8080,'',1,'untested',?,?)").bind(now, now).run();
  const id = db.prepare("SELECT id FROM proxy_pool WHERE host='1.2.3.4'").all().results[0].id;
  const c = { env };
  await t.applyProxyResult(c, id, { success: false, failure_class: "connect_timeout" });
  await t.applyProxyResult(c, id, { success: false, failure_class: "connect_timeout" });
  let row = db.prepare("SELECT status, consecutive_failures FROM proxy_pool WHERE id=?").bind(id).all().results[0];
  assert.equal(row.status, "flaky", "two failures is not yet dead");
  await t.applyProxyResult(c, id, { success: false, failure_class: "connect_timeout" });
  row = db.prepare("SELECT status, consecutive_failures FROM proxy_pool WHERE id=?").bind(id).all().results[0];
  assert.equal(row.status, "dead", "third consecutive failure trips dead");
  assert.equal(row.consecutive_failures, 3);
  await t.applyProxyResult(c, id, { success: true, total_ms: 420 });
  row = db.prepare("SELECT status, consecutive_failures, last_latency_ms FROM proxy_pool WHERE id=?").bind(id).all().results[0];
  assert.equal(row.status, "healthy", "one success revives it");
  assert.equal(row.consecutive_failures, 0);
  assert.equal(row.last_latency_ms, 420);
  // A test_runs row is recorded per check.
  const runs = db.prepare("SELECT COUNT(*) AS n FROM proxy_test_runs WHERE proxy_id=?").bind(id).all().results[0].n;
  assert.equal(runs, 4);
});

test("Remove Dead deletes only dead proxies", async () => {
  const { app, db } = appWithDb();
  const now = new Date().toISOString();
  const ins = (host, status) => db.prepare("INSERT INTO proxy_pool (scheme, host, port, username, enabled, status, created_at, updated_at) VALUES ('http',?,8080,'',1,?,?,?)").bind(host, status, now, now).run();
  ins("1.1.1.1", "dead");
  ins("2.2.2.2", "healthy");
  ins("3.3.3.3", "dead");
  const res = await app.fetch(new Request("http://gw/admin/proxies/delete", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ dead: true })
  }));
  const body = await res.json();
  assert.equal(body.deleted, 2);
  const left = db.prepare("SELECT host FROM proxy_pool").all().results;
  assert.equal(left.length, 1);
  assert.equal(left[0].host, "2.2.2.2");
});

test("proxy endpoints require admin", async () => {
  const { app } = appWithDb();
  const res = await app.fetch(new Request("http://gw/admin/proxies"));
  assert.equal(res.status, 401);
});
