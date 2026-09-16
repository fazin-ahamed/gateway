// Standalone Node entrypoint for hosts like ecli.app (EclipseSystems panel +
// QEMU Debian 13 VM) where there is no Cloudflare Workers runtime. It serves
// the same Hono app as the Worker, backed by a local SQLite file.
//
// Layout:
//   server/            Node host (this file, package.json, db.mjs, env docs)
//   ../ai-gateway/src  shared app code (index.js, playground.js, login.js)
//   ../relay/          optional Go egress relay (same as Worker transport)

import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { createDb } from "./db.mjs";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.DB_PATH || "./data/gateway.db";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const PROVIDER_CRYPTO_KEY = process.env.PROVIDER_CRYPTO_KEY || "";
const KOYEB_RELAY_SECRET = process.env.KOYEB_RELAY_SECRET || "";
const KOYEB_RELAY_URL = process.env.KOYEB_RELAY_URL || "";
const RELAY_BACKEND = process.env.RELAY_BACKEND || "koyeb";
const UPSTREAM_APP_TITLE = process.env.UPSTREAM_APP_TITLE || "AI Gateway";
const UPSTREAM_HTTP_REFERER = process.env.UPSTREAM_HTTP_REFERER || "";

if (!ADMIN_TOKEN) console.warn("[gateway] ADMIN_TOKEN is empty: admin login is disabled.");
if (!PROVIDER_CRYPTO_KEY) console.warn("[gateway] PROVIDER_CRYPTO_KEY is empty: sealed provider keys cannot be opened.");

const db = createDb(DB_PATH);
try {
  const schema = readFileSync(new URL("../ai-gateway/schema.sql", import.meta.url), "utf8");
  db.exec(schema);
} catch (e) {
  console.warn("[gateway] schema auto-apply skipped:", e.message);
}
// providers.enabled was added after launch; CREATE TABLE IF NOT EXISTS cannot
// add a column to an existing table, so apply it here, once, guarded by the
// column's presence (a duplicate ADD COLUMN raises in SQLite).
try {
  const cols = db.prepare("SELECT name FROM pragma_table_info('providers')").all().results || [];
  if (!cols.some((c) => c.name === "enabled")) {
    db.exec("ALTER TABLE providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
    console.log("[gateway] migration: added providers.enabled");
  }
} catch (e) {
  console.warn("[gateway] providers.enabled migration skipped:", e.message);
}
const env = {
  DB: db,
  ADMIN_TOKEN,
  PROVIDER_CRYPTO_KEY,
  KOYEB_RELAY_SECRET,
  KOYEB_RELAY_URL,
  RELAY_BACKEND,
  UPSTREAM_APP_TITLE,
  UPSTREAM_HTTP_REFERER,
};
// The shared worker module exports createApp(env); the factory binds env
// per request so the same code runs on Workers and Node.
const { createApp } = await import("../ai-gateway/src/index.js");
const app = createApp(env);


const handler = async (req) => app.fetch(req, env, { waitUntil: () => {} });

console.log(`[gateway] listening on http://${HOST}:${PORT} (db=${DB_PATH})`);
// Huge-context requests upload megabytes of JSON and slow models take
// minutes before first byte. Node's defaults (requestTimeout 300s,
// headersTimeout 60s) kill the socket mid-stream — the "socket closed
// unexpectedly" error. Raise them; errors still surface eventually.
serve({
  fetch: handler,
  port: PORT,
  hostname: HOST,
  requestTimeout: 3600000,
  headersTimeout: 120000,
  keepAliveTimeout: 7200000,
  maxRequestBodySize: 512 * 1024 * 1024,
});
