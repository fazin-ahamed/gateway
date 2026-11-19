#!/usr/bin/env node
// Builds the Cloudflare Worker bundle into .edge-build/ WITHOUT touching src/.
//
// The Node entrypoint (server/server.mjs + src/index.js) stays authoritative
// and runnable for rollback. This script:
//   1. copies src/ -> .edge-build/src/ (minus Node-only modules),
//   2. rewrites ../../server/tool-loop-guard.mjs to the pure copy in runtime/,
//   3. replaces the dynamic `await import("undici")` with a null-resolving
//      stub (Workers has no undici; the dispatcher is Node-only tuning),
//   4. strips the /admin/proxies* + /admin/egress/test route blocks
//      (Node-host surfaces; absent => 404 on the Worker),
//   5. emits .edge-build/index.js re-exporting runtime/edge.js default.
//
// scripts/verify-edge-bundle.mjs then scans the output for forbidden modules.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // ai-gateway/
const src = join(root, "src");
const out = join(root, ".edge-build");
const serverRoot = join(root, "..", "server");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Copy src/, excluding the runtime dir itself. Agent-side tooling dirs
// (SWE verifier, skill loader, profiles) are Node-only and unreachable from
// the request path.
const NODE_ONLY_DIRS = ["swe", "skills", "profiles"];
cpSync(src, join(out, "src"), {
  recursive: true,
  filter: (from) => {
    const rel = from.slice(src.length + 1);
    if (!rel) return true;
    if (rel.startsWith("runtime")) return false; // re-added explicitly below
    // Agent-side tooling (SWE verifier, repo sketch, skill loader, profiles)
    // is Node-only and unreachable from the request path; excluded so the
    // bundle scan stays honest about what the Worker actually loads.
    if (NODE_ONLY_DIRS.some((d) => rel === d || rel.startsWith(d + "/"))) return false;
    return true;
  },
});
cpSync(join(src, "runtime"), join(out, "src", "runtime"), { recursive: true });
let guard = readFileSync(join(serverRoot, "tool-loop-guard.mjs"), "utf8");
// server/ relative path -> sibling path inside the bundle (src/tool-repair.js).
guard = guard.replace('"../ai-gateway/src/tool-repair.js"', '"../tool-repair.js"');
if (!guard.includes('"../tool-repair.js"')) throw new Error("build-edge: tool-loop-guard import rewrite failed");
writeFileSync(join(out, "src", "runtime", "tool-loop-guard.mjs"), guard);
for (const f of ["edge.js", "tool-loop-guard.mjs"]) {
  if (!existsSync(join(out, "src", "runtime", f))) throw new Error("build-edge: runtime/" + f + " missing from bundle");
}

// 3. Rewrite the copied index.js.
const idxPath = join(out, "src", "index.js");
let idx = readFileSync(idxPath, "utf8");

idx = idx.replace(
  'import { normalizeTerminalFinishReason } from "../../server/tool-loop-guard.mjs";',
  'import { normalizeTerminalFinishReason } from "./runtime/tool-loop-guard.mjs";'
);
if (!idx.includes("./runtime/tool-loop-guard.mjs")) throw new Error("build-edge: tool-loop-guard import rewrite failed");

// 4. undici dispatcher: Node-only tuning, absent on Workers. Replace the
//    dynamic import with a null-resolving one-liner (guard stays, no-op).
idx = idx.replace(
  'const undici = await import("undici").catch(() => null);',
  'const undici = null;'
);
if (idx.includes('import("undici")')) throw new Error("build-edge: undici dynamic import still present");

// 5. Strip bridge-owned route blocks. Each cut is exact-text so any drift in
//    index.js fails the build instead of silently shipping a route.
function cutBlock(text, startMarker, endMarker) {
  const s = text.indexOf(startMarker);
  if (s === -1) throw new Error("build-edge: start marker not found: " + startMarker.slice(0, 70));
  const e = text.indexOf(endMarker, s);
  if (e === -1) throw new Error("build-edge: end marker not found after start: " + endMarker.slice(0, 70));
  // Keep everything before the route registration and after the block.
  return text.slice(0, s) + "// [edge-build] consumer-web/relay route block removed for Cloudflare\n" + text.slice(e);
}

// /admin/proxies* + /admin/egress/test block: from `app.get("/admin/proxies"`
// up to applyProxyResult — a DB-only helper still referenced by the serving
// path's egress marking. The routes go; the helper stays.
idx = cutBlock(
  idx,
  'app.get("/admin/proxies", async (c) => {',
  'async function applyProxyResult'
);

writeFileSync(idxPath, idx);

// 6. Top-level entry: wrangler `main` points here.
writeFileSync(join(out, "index.js"), 'export { default } from "./src/runtime/edge.js";\n');


console.log("edge bundle built:", join(out, "index.js"));
console.log("routes stripped: /admin/proxies*, /admin/egress/test");

// 7. Local dev test config (workerd smoke). Generated here because build-edge
//    wipes .edge-build/ on every run; generating it in the same step keeps
//    bundle and config from drifting apart. Never used for production deploys.
writeFileSync(join(out, "wrangler.test.jsonc"), JSON.stringify({
  name: "horizon-edge-test",
  main: "../.edge-build/index.js",
  compatibility_date: "2025-09-01",
  compatibility_flags: ["nodejs_compat"],
  observability: { enabled: false },
  d1_databases: [{
    binding: "DB",
    database_name: "horizon-edge",
    database_id: "00000000-0000-0000-0000-000000000000",
    migrations_dir: "../migrations"
  }],
  vars: { UPSTREAM_TIMEOUT_MS: "600000", ADMIN_TOKEN: "edge-admin", PROVIDER_CRYPTO_KEY: "edge-key" }
}, null, 2));
console.log("edge test config written:", join(out, "wrangler.test.jsonc"));
