// The auto-update watcher only installs console deps when node_modules is
// missing, and it runs its own functions from the shell that started it, so
// a dependency added in a later commit is never installed on a host that
// already had node_modules. This runs before every build and installs when
// a declared dependency is absent, so the build fixes its own tree.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Presence of the package directory, not entry-point resolution: some
// packages (Svelte libraries) expose only conditional exports and have no
// plain Node entry, so require.resolve reports them missing when installed.
const missing = [];
for (const name of Object.keys(pkg.dependencies || {})) {
  if (!existsSync(join(root, "node_modules", name, "package.json")))
    missing.push(name);
}
if (!missing.length) process.exit(0);

console.log(`ensure-deps: missing ${missing.join(", ")}; running npm install`);
const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
  cwd: root,
  stdio: "inherit"
});
process.exit(r.status ?? 1);
