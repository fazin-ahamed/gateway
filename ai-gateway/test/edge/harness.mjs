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

export function bootEdge({ legacyZai = false } = {}) {
  if (!existsSync(join(build, "index.js")) || !existsSync(testConfig)) {
    throw new Error("edge bundle missing - run `npm run build:edge` first");
  }
  const state = mkdtempSync(join(tmpdir(), "horizon-edge-"));
  const port = portCounter++;
  const run = (args) => execFileSync("npx", ["wrangler", ...args, "--persist-to", state, "--config", testConfig], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run(["d1", "migrations", "apply", "horizon-edge", "--local"]);
  if (legacyZai) seedLegacyZai(state);

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

function seedLegacyZai(state) {
  const cmd = (sql) => execFileSync("npx", ["wrangler", "d1", "execute", "horizon-edge", "--local", "--persist-to", state, "--config", testConfig, "--command", sql], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  cmd("INSERT INTO providers (name, base_url, fmt, created_at) VALUES ('Legacy ZAI','https://chat.z.ai','zaiweb','2026-10-08T00:00:00Z')");
  cmd("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES ((SELECT id FROM providers WHERE name='Legacy ZAI'),'sealed:x','legacy',1,'2026-10-08T00:00:00Z')");
  cmd("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES ('glm-legacy',(SELECT id FROM providers WHERE name='Legacy ZAI'),'glm-5.3',1,1)");
  cmd("INSERT INTO api_keys (key_id,name,budget_mode,budget_limit,allowed_models,created_at,updated_at) VALUES ('sk-zai-legacy','zai legacy','usd',5,'glm-legacy','2026-10-08T00:00:00Z','2026-10-08T00:00:00Z')");
}
