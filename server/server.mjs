// Node entrypoint for hosts like ecli.app (EclipseSystems panel + QEMU Debian
// 13 VM). Serves the shared Hono app from ai-gateway/src, backed by a local
// SQLite file.
//
// Layout:
//   server/            Node host (this file, package.json, db.mjs, env docs)
//   ../ai-gateway/src  shared app code (index.js, playground.js, login.js)
//   ../relay/          optional Go egress relay

import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createDb } from "./db.mjs";
import { guardToolLoopResponse } from "./tool-loop-guard.mjs";
import { configureSessionStore } from "../ai-gateway/src/zai-session.js";

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
const UPSTREAM_TIMEOUT_MS = process.env.UPSTREAM_TIMEOUT_MS || "";

if (!ADMIN_TOKEN) console.warn("[gateway] ADMIN_TOKEN is empty: admin login is disabled.");
if (!PROVIDER_CRYPTO_KEY) console.warn("[gateway] PROVIDER_CRYPTO_KEY is empty: sealed provider keys cannot be opened.");
const db = createDb(DB_PATH);
configureSessionStore(process.env.ZAI_SESSION_STORE || join(dirname(DB_PATH), "zai-sessions.json"));
try {
  const schema = readFileSync(new URL("../ai-gateway/schema.sql", import.meta.url), "utf8");
  db.exec(schema);
} catch (e) {
  console.warn("[gateway] schema auto-apply skipped:", e.message);
}
// Migrations for DBs created before the (slug, kind, period) limit shape.
// into the new shape (preserving old rows as requests/minute + tokens/day).
try {
  const cols = db.prepare("PRAGMA table_info(model_limits)").all();
  if (cols.results && cols.results.length && !cols.results.some((c) => c.name === "kind")) {
    const old = db.prepare("SELECT slug, requests_per_minute, max_total_tokens, updated_at FROM model_limits").all().results || [];
    db.exec("DROP TABLE model_limits");
    db.exec("CREATE TABLE model_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL, limit_value REAL NOT NULL, updated_at TEXT NOT NULL, UNIQUE(slug, kind, period))");
    for (const row of old) {
      if (row.requests_per_minute) db.prepare("INSERT OR IGNORE INTO model_limits (slug, kind, period, limit_value, updated_at) VALUES (?,?,?,?,?)").bind(row.slug, "requests", "minute", row.requests_per_minute, row.updated_at).run();
      if (row.max_total_tokens) db.prepare("INSERT OR IGNORE INTO model_limits (slug, kind, period, limit_value, updated_at) VALUES (?,?,?,?,?)").bind(row.slug, "tokens", "day", row.max_total_tokens, row.updated_at).run();
    }
    console.warn("[gateway] migrated model_limits to (slug,kind,period):", old.length, "rows");
  }
} catch (e) {
  console.warn("[gateway] model_limits migration skipped:", e.message);
}
// Operator off-switch: providers created before this column existed were all
// implicitly enabled. Guarded by pragma_table_info because a duplicate ADD
// COLUMN raises in SQLite.
try {
  const cols = db.prepare("PRAGMA table_info(providers)").all();
  if (cols.results && cols.results.length && !cols.results.some((c) => c.name === "enabled")) {
    db.exec("ALTER TABLE providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
    console.warn("[gateway] migration: added providers.enabled");
  }
} catch (e) {
  console.warn("[gateway] providers.enabled migration skipped:", e.message);
}
// Multi-key providers: add key_strategy column and seed provider_keys
// from the legacy single api_key column when the pool is empty.
try {
  const cols = db.prepare("PRAGMA table_info(providers)").all();
  if (cols.results && cols.results.length && !cols.results.some((c) => c.name === "key_strategy")) {
    db.exec("ALTER TABLE providers ADD COLUMN key_strategy TEXT NOT NULL DEFAULT 'round_robin'");
    console.warn("[gateway] added providers.key_strategy");
  }
  const seeded = db.prepare("SELECT p.id, p.api_key FROM providers p WHERE p.api_key IS NOT NULL AND p.api_key <> '' AND NOT EXISTS (SELECT 1 FROM provider_keys pk WHERE pk.provider_id=p.id)").all().results || [];
  for (const row of seeded) {
    db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)").bind(row.id, row.api_key, "primary", new Date().toISOString().replace(".000", "")).run();
  }
  if (seeded.length)
    console.warn("[gateway] seeded provider_keys from legacy api_key:", seeded.length, "providers");
} catch (e) {
  console.warn("[gateway] provider_keys migration skipped:", e.message);
}
const env = {
  DB: db,
  ADMIN_TOKEN,
  PROVIDER_CRYPTO_KEY,
  KOYEB_RELAY_SECRET,
  KOYEB_RELAY_URL,
  RELAY_BACKEND,
  UPSTREAM_TIMEOUT_MS,
  UPSTREAM_APP_TITLE,
  UPSTREAM_HTTP_REFERER,
};
// The shared module exports createApp(env); the factory binds env per request.
const { createApp } = await import("../ai-gateway/src/index.js");
const app = createApp(env);

const handler = async (req) => {
  const response = await app.fetch(req, env, { waitUntil: () => {} });
  const path = new URL(req.url).pathname;
  if (path === "/v1/chat/completions" || path === "/admin/playground/completions")
    return guardToolLoopResponse(response);
  return response;
};

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
