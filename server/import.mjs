// One-shot import runner for hosts without the sqlite3 CLI (ecli.app AIO egg).
// Usage (on the server, from the repo root):
//   node --env-file=.env server/import.mjs ~/ecli-import.sql
// Applies the file inside a transaction. Exits non-zero on any error.
import { readFileSync } from "node:fs";
import { createDb } from "./db.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node import.mjs <file.sql>");
  process.exit(2);
}
const dbPath = process.env.DB_PATH || "./server/data/gateway.db";
const db = createDb(dbPath);
const sql = readFileSync(file, "utf8");
db.exec("BEGIN;");
try {
  db.exec(sql);
  db.exec("COMMIT;");
} catch (e) {
  try { db.exec("ROLLBACK;"); } catch {}
  console.error("import failed:", e.message);
  process.exit(1);
}
const counts = db.prepare(
  "SELECT (SELECT COUNT(*) FROM providers) p, (SELECT COUNT(*) FROM model_routes) r, (SELECT COUNT(*) FROM api_keys) k"
).first();
console.log("import ok:", JSON.stringify(counts));
