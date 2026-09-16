// Device-token store for the z.ai captcha mint.
//
// Aliyun binds each device token to one verification, so tokens are consumed
// one per completion and then deleted. They are harvested in bulk elsewhere
// (any machine with a browser — see scripts/harvest-zai-tokens.mjs) and copied
// here as a newline-delimited file, which keeps the gateway itself free of
// browser dependencies: pure Node, no packages to install.
//
// File format: one token per line, blank lines and #comments ignored.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_STORE = process.env.ZAI_TOKEN_STORE || resolve(process.cwd(), "data/zai-device-tokens.txt");
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

/**
 * Take one token and remove it from the store. Returns null when exhausted.
 * Serialized through a promise chain so concurrent requests cannot hand out the
 * same token twice.
 */
export function takeDeviceToken(storePath) {
  const path = resolve(storePath || DEFAULT_STORE);
  return withLock(() => {
    const tokens = readTokens(path);
    if (!tokens.length)
      return { token: null, remaining: 0 };
    const token = tokens.shift();
    writeTokens(path, tokens);
    return { token, remaining: tokens.length };
  });
}

export function peekDeviceTokens(storePath) {
  const path = resolve(storePath || DEFAULT_STORE);
  return readTokens(path).length;
}

export function appendDeviceTokens(tokens, storePath) {
  const path = resolve(storePath || DEFAULT_STORE);
  return withLock(() => {
    const existing = readTokens(path);
    const merged = existing.concat(tokens.map((t) => String(t).trim()).filter(Boolean));
    writeTokens(path, merged);
    return merged.length;
  });
}

export const __tokenStoreTest = { readTokens, writeTokens };
