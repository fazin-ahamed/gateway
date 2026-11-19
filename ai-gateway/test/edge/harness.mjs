// Boots the built edge Worker under REAL workerd via `wrangler dev --local`
// with a private local D1 (migrations applied), and hands tests a base URL.
// Each bootEdge() call is isolated: its own state dir + port, disposed after.
// Requires: npm run build:edge first (writes .edge-build/, incl. the test config).

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const build = join(root, ".edge-build");
const testConfig = join(build, "wrangler.test.jsonc");

let portCounter = 31400;

export function bootEdge() {
  if (!existsSync(join(build, "index.js")) || !existsSync(testConfig)) {
    throw new Error("edge bundle missing - run `npm run build:edge` first");
  }
  const state = mkdtempSync(join(tmpdir(), "horizon-edge-"));
  const port = portCounter++;
  const run = (args) => execFileSync("npx", ["wrangler", ...args, "--persist-to", state, "--config", testConfig], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run(["d1", "migrations", "apply", "horizon-edge", "--local"]);

  const child = spawn("npx", ["wrangler", "dev", "--local", "--persist-to", state, "--config", testConfig, "--port", String(port), "--ip", "127.0.0.1"], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  const base = "http://127.0.0.1:" + port;
  const started = Date.now();

  return {
    base,
    async ready() {
      // Poll the dev server until it answers /health (wrangler dev readiness).
      for (;;) {
        if (Date.now() - started > 60000) throw new Error("wrangler dev not ready in 60s");
        try {
          const res = await fetch(base + "/health", { signal: AbortSignal.timeout(1500) });
          if (res.status === 200) return base;
        } catch {}
        await new Promise((r) => setTimeout(r, 400));
      }
    },
    async dispose() {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      try { child.kill("SIGKILL"); } catch {}
      rmSync(state, { recursive: true, force: true });
    }
  };
}

