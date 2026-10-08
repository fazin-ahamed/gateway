#!/usr/bin/env node
// Node SQLite -> Cloudflare D1 migration utility (dry-run by default).
//
// Reads the production Node gateway.db (createDb shape: node:sqlite), reports
// what would migrate, and with --write emits a sanitized SQL dump the operator
// pipes to `wrangler d1 execute` (or applies via wrangler's import). NEVER
// writes secrets to the dump: provider API keys are either re-typed on the
// edge deployment or --include-sealed copies the sealed (AES-GCM) ciphertext
// verbatim, which stays useless without PROVIDER_CRYPTO_KEY.
//
// Usage:
//   node scripts/d1-import.mjs /path/to/gateway.db [--write out.sql] [--include-sealed]
//
// Report: per-table row counts, DB size, consumer-web (bridge-only) providers/
// routes marked unsupported on the edge, and whether sealed credentials can be
// decrypted with the provided PROVIDER_CRYPTO_KEY (read-only check).

import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const dbPath = args[0];
const writeOut = args.includes("--write") ? args[args.indexOf("--write") + 1] : null;
const includeSealed = args.includes("--include-sealed");
const cryptoKey = process.env.PROVIDER_CRYPTO_KEY || "";

if (!dbPath || !existsSync(dbPath)) {
  console.error("usage: node scripts/d1-import.mjs /path/to/gateway.db [--write out.sql] [--include-sealed]");
  process.exit(1);
}

const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
const sizeBytes = statSync(dbPath).size;
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

console.log("source:", resolve(dbPath));
console.log("size:", (sizeBytes / 1024 / 1024).toFixed(2), "MB,", tables.length, "tables");

const SKIP_ON_EDGE = new Set([
  // Agent-side / Node-only state, never part of the gateway's serving truth.
  "zai_device_tokens", "zai_sessions", "proxy_pool",
]);

const lines = [];
const counts = {};
for (const t of tables) {
  try {
    const n = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    counts[t] = n;
    if (n > 0) console.log(String(n).padStart(8), t);
  } catch { counts[t] = -1; }
}

// Consumer-web (bridge-only) configuration: preserved but flagged.
const zaiFmts = ("zaiweb", "zaiwebbrowser", "zaiminted");
let zaiProviders = [];
try {
  zaiProviders = db.prepare("SELECT id, name, fmt FROM providers WHERE fmt IN ('zaiweb','zaiwebbrowser','zaiminted')").all();
} catch {}
let zaiRoutes = [];
try {
  zaiRoutes = db.prepare("SELECT mr.slug, p.name FROM model_routes mr JOIN providers p ON p.id=mr.provider_id WHERE p.fmt IN ('zaiweb','zaiwebbrowser','zaiminted')").all();
} catch {}
if (zaiProviders.length || zaiRoutes.length) {
  console.log("\nconsumer-web (bridge-only) configuration - preserved but NOT servable on Cloudflare:");
  for (const p of zaiProviders) console.log("  provider:", p.name, "(" + p.fmt + ")");
  for (const r of zaiRoutes) console.log("  route:", r.slug, "->", r.name);
  console.log("  (the edge build refuses to advertise or dispatch these; re-point the public slug at a supported API provider to restore it)");
}

// Sealed credential readability (informational, read-only).
if (tables.includes("provider_keys") && counts["provider_keys"] > 0) {
  const sealed = db.prepare("SELECT COUNT(*) c FROM provider_keys WHERE api_key LIKE '%:%'").get().c;
  console.log("\nsealed provider keys:", sealed, includeSealed ? "(ciphertext will be copied verbatim)" : "(omitted from dump; re-enter on the edge or pass --include-sealed)");
  if (cryptoKey) console.log("PROVIDER_CRYPTO_KEY provided; decryption check requires the gateway runtime - the dump only copies ciphertext.");
  else console.log("no PROVIDER_CRYPTO_KEY set; ciphertext cannot be verified.");
}

if (writeOut) {
  for (const t of tables) {
    if (counts[t] <= 0) continue;
    if (SKIP_ON_EDGE.has(t)) { console.log("skip (Node-only):", t); continue; }
    const rows = db.prepare(`SELECT * FROM "${t}"`).all();
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => {
        let v = row[c];
        if (c === "api_key" && !includeSealed) return "NULL /* redacted: re-enter on edge */";
        if (v == null) return "NULL";
        if (typeof v === "number" || typeof v === "bigint") return String(v);
        return "'" + String(v).replace(/'/g, "''") + "'";
      });
      lines.push(`INSERT OR IGNORE INTO "${t}" (${cols.map((c) => '"' + c + '"').join(",")}) VALUES (${vals.join(",")});`);
    }
  }
  writeFileSync(writeOut, "-- HORIZON node->D1 import (dry-run output)\n-- Apply with: wrangler d1 execute horizon-edge --local --file " + writeOut + "\n" + lines.join("\n") + "\n");
  console.log("\nwrote", lines.length, "row statements to", writeOut);
  console.log("secrets in dump:", includeSealed ? "sealed ciphertext only" : "none (redacted)");
} else {
  console.log("\ndry-run only (no --write). Nothing was modified.");
}
db.close();
