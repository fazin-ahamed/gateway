import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDb } from "../../server/db.mjs";
import { createApp } from "../src/index.js";

async function signIn(headers) {
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id,name,active,budget_mode,budget_limit,console_auth,created_at,updated_at) VALUES ('sk-x','x',1,'usd',1e12,0,?,?)").bind(now, now).run();
  const app = createApp({ DB: db, ADMIN_TOKEN: "a", PROVIDER_CRYPTO_KEY: "k" });
  const res = await app.fetch(new Request("http://gw/console/auth", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ api_key: "sk-x" }) }));
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie");
}

test("behind a TLS proxy the session cookie is Secure; plain HTTP stays usable", async () => {
  assert.match(await signIn({ "x-forwarded-proto": "https" }), /; Secure/);
  assert.doesNotMatch(await signIn({}), /Secure/);
  assert.doesNotMatch(await signIn({ "x-forwarded-proto": "http" }), /Secure/);
});
