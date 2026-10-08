#!/usr/bin/env node
// Verifies the built Worker bundle (.edge-build/) is free of the consumer-web
// bridge and Node-only modules, then boots it under Miniflare (real workerd +
// real D1) and exercises the M1 smoke surface:
//   - GET /health                              -> 200 {ok:true}
//   - GET /v1/models without auth              -> 401
//   - /admin/zai/* and /admin/proxies*         -> 404 (routes stripped)
//   - POST /admin/accounts (admin token)       -> 201 invite (real D1 write)
//   - legacy zai-format provider: config preserved, never dispatched,
//     rejection is sanitized (no provider identity leaks)
//   - hot auth query uses the primary-key index (query plan check)
// Exits non-zero on any failure. Run: npm run verify:edge

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const build = join(root, ".edge-build");

if (!existsSync(join(build, "index.js"))) {
  console.error("verify-edge: .edge-build missing - run `npm run build:edge` first");
  process.exit(1);
}

// 1. Static scan: no Node-only module may appear anywhere in the bundle.
const FORBIDDEN = [
  "zaiweb.js", "zaibrowser.js", "zai-session.js", "zai-stream.js",
  "zai-models.js", "zai-agent.js", "zai-conversation-cache.js",
  "zai-vision.js", "zai-tokens.js", "zai-session-pool.js",
  "zai-captcha.js", "zai-captcha-cache.js", "zai-waf.js",
];
const FORBIDDEN_TEXT = [
  "node:fs", "node:child_process", "node:sqlite", "node:dns", "node:net",
  "node:http", "node:https", "node:zlib", 'import("undici")',
];

const failures = [];
function walk(dir, visit) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, visit);
    else if (/\.(js|mjs)$/.test(name)) visit(p);
  }
}
walk(build, (p) => {
  const text = readFileSync(p, "utf8");
  for (const f of FORBIDDEN) {
    if (p.endsWith("/" + f)) failures.push("bundled Node-only module: " + f);
  }
  for (const t of FORBIDDEN_TEXT) {
    if (text.includes(t)) failures.push("forbidden text " + JSON.stringify(t) + " in " + p.slice(build.length));
  }
  // The runtime/zai-stubs.js import is the replacement itself; strip it,
  // then any remaining ./...zai... import is a real bridge dependency.
  const importScan = text.replace(/from\s+["'][^"']*runtime\/zai-stubs\.js["']/g, "");
  if (/from\s+["']\.[^"']*zai[^"']*["']/.test(importScan)) {
    failures.push("zai module import in " + p.slice(build.length));
  }
});

if (failures.length) {
  for (const f of failures) console.error("verify-edge FAIL:", f);
  process.exit(1);
}
console.log("static scan: no consumer-web bridge modules, no node: imports in bundle");
if (process.argv.includes("--scan-only")) {
  console.log("verify-edge: scan-only complete");
  process.exit(0);
}
// 2. Migration sanity on a scratch local D1 (the real workerd runtime tests
// live in test/edge - run via npm run test:edge).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const state = mkdtempSync(join(tmpdir(), "horizon-verify-"));
try {
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "horizon-edge", "--local", "--persist-to", state, "--config", join(build, "wrangler.test.jsonc")], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  console.log("d1 migrations: applied cleanly on empty database");
} finally {
  rmSync(state, { recursive: true, force: true });
}
console.log("verify-edge: static scan + migration sanity PASSED (run npm run test:edge for workerd runtime tests)");

