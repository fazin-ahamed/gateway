// Device-token FIFO for the Z.AI CAPTCHA mint.
//
// GLM-Free-API uses SQLite because Aliyun device tokens are single-use and
// concurrent consumers must never receive the same token. The gateway follows
// that design when its DB is available, while retaining the historical
// newline file as an automatic import/fallback for restricted deployments.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_STORE = process.env.ZAI_TOKEN_STORE || resolve(process.cwd(), "data/zai-device-tokens.txt");
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS zai_device_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
)`;
let mutex = Promise.resolve();

function withLock(fn) {
  const run = mutex.then(fn, fn);
  mutex = run.then(() => {}, () => {});
  return run;
}

function readTokens(path) {
  if (!existsSync(path))
    return [];
  const text = readFileSync(path, "utf8");
  return text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function writeTokens(path, tokens) {
  const dir = dirname(path);
  if (!existsSync(dir))
    mkdirSync(dir, { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, tokens.length ? tokens.join("\n") + "\n" : "");
  renameSync(tmp, path);
}

async function ensureTable(db) {
  if (!db || typeof db.exec !== "function")
    return false;
  await Promise.resolve(db.exec(TABLE_SQL));
  return true;
}

async function sqliteCount(db) {
  const row = await Promise.resolve(db.prepare("SELECT COUNT(*) AS n FROM zai_device_tokens").first());
  return Number(row && row.n || 0);
}

async function importLegacyFile(db, storePath) {
  const path = resolve(storePath || DEFAULT_STORE);
  const tokens = readTokens(path);
  if (!tokens.length)
    return 0;
  let added = 0;
  const now = new Date().toISOString();
  for (const token of tokens) {
    const result = await Promise.resolve(
      db.prepare("INSERT OR IGNORE INTO zai_device_tokens (token, created_at) VALUES (?,?)")
        .bind(token, now).run()
    );
    added += Number(result && result.meta && result.meta.changes || 0);
  }
  // The file is a queue, not a backup. Once imported, clear it so already
  // consumed single-use tokens can never reappear after a restart.
  writeTokens(path, []);
  return added;
}

/**
 * Take and permanently consume one token. SQLite is canonical when supplied;
 * otherwise this behaves exactly like the original serialized file queue.
 */
export function takeDeviceToken(storePath, db) {
  const path = resolve(storePath || DEFAULT_STORE);
  return withLock(async () => {
    if (db && await ensureTable(db)) {
      if (await sqliteCount(db) === 0)
        await importLegacyFile(db, path);
      const row = await Promise.resolve(
        db.prepare("SELECT id, token FROM zai_device_tokens ORDER BY id LIMIT 1").first()
      );
      if (!row)
        return { token: null, remaining: 0, source: "sqlite" };
      await Promise.resolve(db.prepare("DELETE FROM zai_device_tokens WHERE id=?").bind(row.id).run());
      return { token: row.token, remaining: Math.max(0, await sqliteCount(db)), source: "sqlite" };
    }

    const tokens = readTokens(path);
    if (!tokens.length)
      return { token: null, remaining: 0, source: "file" };
    const token = tokens.shift();
    writeTokens(path, tokens);
    return { token, remaining: tokens.length, source: "file" };
  });
}

export async function peekDeviceTokens(storePath, db) {
  const path = resolve(storePath || DEFAULT_STORE);
  if (db && await ensureTable(db)) {
    if (await sqliteCount(db) === 0)
      await importLegacyFile(db, path);
    return sqliteCount(db);
  }
  return readTokens(path).length;
}

export function appendDeviceTokens(tokens, storePath, db) {
  const path = resolve(storePath || DEFAULT_STORE);
  const clean = (Array.isArray(tokens) ? tokens : [tokens])
    .map((t) => String(t || "").trim()).filter(Boolean);
  return withLock(async () => {
    if (db && await ensureTable(db)) {
      const now = new Date().toISOString();
      for (const token of clean)
        await Promise.resolve(
          db.prepare("INSERT OR IGNORE INTO zai_device_tokens (token, created_at) VALUES (?,?)")
            .bind(token, now).run()
        );
      return sqliteCount(db);
    }

    const existing = readTokens(path);
    const seen = new Set(existing);
    for (const token of clean) {
      if (seen.has(token)) continue;
      seen.add(token);
      existing.push(token);
    }
    writeTokens(path, existing);
    return existing.length;
  });
}

export const __tokenStoreTest = {
  readTokens,
  writeTokens,
  ensureTable,
  importLegacyFile,
  TABLE_SQL
};
