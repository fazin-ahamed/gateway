// FIFO device-token pool for the Z.AI CAPTCHA mint.
//
// Runtime storage now follows GLM-Free-API's proven SQLite queue design.
// The old newline file remains a backwards-compatible import/fallback path so
// existing deployments can upgrade without losing harvested tokens.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_STORE = process.env.ZAI_TOKEN_STORE || resolve(process.cwd(), "data/zai-device-tokens.txt");
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS zai_device_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
)`;
let mutex = Promise.resolve();
const migratedFiles = new Set();

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

async function dbCount(db) {
  const row = await Promise.resolve(db.prepare("SELECT COUNT(*) AS n FROM zai_device_tokens").first());
  return Number(row && row.n || 0);
}

async function migrateLegacyFile(db, storePath) {
  if (!db || !storePath)
    return 0;
  const path = resolve(storePath);
  const key = path;
  if (migratedFiles.has(key))
    return 0;
  migratedFiles.add(key);
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
  // The file is a queue, not a backup. Empty it after migration so consumed
  // tokens cannot be resurrected on restart and reused against Aliyun.
  writeTokens(path, []);
  return added;
}

function optsOf(input) {
  if (typeof input === "string" || input == null)
    return { storePath: input || DEFAULT_STORE, db: null };
  return {
    db: input.db || null,
    storePath: input.storePath || DEFAULT_STORE
  };
}

/**
 * Atomically take and consume one device token. SQLite is preferred; if no DB
 * is supplied, retain the legacy file queue behavior.
 */
export function takeDeviceToken(input) {
  const { db, storePath } = optsOf(input);
  return withLock(async () => {
    if (db && await ensureTable(db)) {
      if (await dbCount(db) === 0)
        await migrateLegacyFile(db, storePath);
      const row = await Promise.resolve(
        db.prepare("SELECT id, token FROM zai_device_tokens ORDER BY id LIMIT 1").first()
      );
      if (!row)
        return { token: null, remaining: 0, source: "sqlite" };
      await Promise.resolve(db.prepare("DELETE FROM zai_device_tokens WHERE id=?").bind(row.id).run());
      return { token: row.token, remaining: Math.max(0, await dbCount(db)), source: "sqlite" };
    }

    const path = resolve(storePath || DEFAULT_STORE);
    const tokens = readTokens(path);
    if (!tokens.length)
      return { token: null, remaining: 0, source: "file" };
    const token = tokens.shift();
    writeTokens(path, tokens);
    return { token, remaining: tokens.length, source: "file" };
  });
}

export async function peekDeviceTokens(input) {
  const { db, storePath } = optsOf(input);
  if (db && await ensureTable(db)) {
    if (await dbCount(db) === 0)
      await migrateLegacyFile(db, storePath);
    return dbCount(db);
  }
  return readTokens(resolve(storePath || DEFAULT_STORE)).length;
}

export function appendDeviceTokens(tokens, input) {
  const { db, storePath } = optsOf(input);
  const clean = (Array.isArray(tokens) ? tokens : [tokens]).map((t) => String(t || "").trim()).filter(Boolean);
  return withLock(async () => {
    if (db && await ensureTable(db)) {
      let added = 0;
      const now = new Date().toISOString();
      for (const token of clean) {
        const result = await Promise.resolve(
          db.prepare("INSERT OR IGNORE INTO zai_device_tokens (token, created_at) VALUES (?,?)")
            .bind(token, now).run()
        );
        added += Number(result && result.meta && result.meta.changes || 0);
      }
      return { added, total: await dbCount(db), source: "sqlite" };
    }

    const path = resolve(storePath || DEFAULT_STORE);
    const existing = readTokens(path);
    const seen = new Set(existing);
    let added = 0;
    for (const token of clean) {
      if (seen.has(token)) continue;
      seen.add(token);
      existing.push(token);
      added++;
    }
    writeTokens(path, existing);
    return { added, total: existing.length, source: "file" };
  });
}

export const __tokenStoreTest = { readTokens, writeTokens, optsOf, migrateLegacyFile, TABLE_SQL };
