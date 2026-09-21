// RepoSketch — a deterministic repo map. No model, no network.
//
// HORIZON-Omega DeepSWE: before any search/read, the harness knows the
// repo's languages, manifests, workspace layout, test framework and likely
// test commands. Cached by Git HEAD so repeated turns in the same revision
// are free.
//
// All filesystem access is injectable as one bag: tests pass a fake tree,
// production passes nothing and gets node:fs. Nothing in here touches the
// gateway serving path.

import { existsSync as fsExists, readFileSync as fsRead, readdirSync as fsReaddir, statSync as fsStat } from "node:fs";
import { join, sep } from "node:path";

const MAX_SKETCH_DEPTH = 6;
const MAX_ENTRIES = 200;

// If the author wrote a test script, `npm test` is the invocation: it
// delegates to whatever they chose. Anything else is guessing their runner.
const NODE_TEST_COMMAND = "npm test";

const MANIFESTS = [
  { file: "package.json", language: "javascript", testCommand: NODE_TEST_COMMAND },
  { file: "go.mod", language: "go", testCommand: "go test" },
  { file: "Cargo.toml", language: "rust", testCommand: "cargo test" },
  { file: "pyproject.toml", language: "python", testCommand: "pytest" },
  { file: "setup.py", language: "python", testCommand: "pytest" },
  { file: "pom.xml", language: "java", testCommand: "mvn test" },
  { file: "build.gradle", language: "java", testCommand: "./gradlew test" }
];

// Directories whose presence tells the harness where work usually happens.
const IMPORTANT_DIRS = ["src", "test", "tests", "lib", "app", "server", "cmd", "internal", "docs", "scripts", "bin"];

export function sketchRepo(root, { readdirSync = fsReaddir, readFileSync = fsRead, existsSync = fsExists } = {}) {
  const base = String(root || ".");
  if (!existsSync(base))
    return null;

  const languages = new Set();
  const found = {};
  for (const m of MANIFESTS) {
    if (existsSync(join(base, m.file))) {
      languages.add(m.language);
      found[m.file] = true;
    }
  }
  if (existsSync(join(base, "tsconfig.json")))
    languages.add("typescript");
  if (existsSync(join(base, "requirements.txt")))
    languages.add("python");

  const dirs = [];
  const files = [];
  try {
    walk(readdirSync, base, "", dirs, files, 0, new Set());
  } catch {
    // A repo that cannot be walked still yields a sketch from manifests.
  }

  const important = dirs.filter((d) => IMPORTANT_DIRS.includes(d.split(sep).pop()));
  return {
    root: base,
    languages: [...languages],
    manifests: Object.keys(found),
    testFramework: detectTestFramework(base, found, readFileSync),
    testCommand: pickTestCommand(base, found),
    directories: dirs.slice(0, MAX_ENTRIES),
    importantDirectories: important,
    files: files.slice(0, MAX_ENTRIES),
    depth: MAX_SKETCH_DEPTH
  };
}

function detectTestFramework(root, found, readFile) {
  if (found["package.json"]) {
    try {
      const pkg = JSON.parse(readFile(join(root, "package.json"), "utf8"));
      const all = JSON.stringify(pkg);
      if (/vitest/.test(all)) return "vitest";
      if (/\bjest\b/.test(all)) return "jest";
      if (/mocha/.test(all)) return "mocha";
      return "node-test";
    } catch {
      return "node-test";
    }
  }
  if (found["go.mod"]) return "go-test";
  if (found["Cargo.toml"]) return "cargo-test";
  if (found["pyproject.toml"] || found["setup.py"]) return "pytest";
  if (found["pom.xml"] || found["build.gradle"]) return "junit";
  return null;
}

function pickTestCommand(root, found) {
  for (const m of MANIFESTS) {
    if (found[m.file])
      return m.testCommand;
  }
  return null;
}

function walk(readdirSync, base, rel, dirs, files, depth, seen) {
  if (depth > MAX_SKETCH_DEPTH || dirs.length + files.length > MAX_ENTRIES * 2)
    return;
  let entries;
  try {
    entries = readdirSync(join(base, rel));
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e) continue;
    const name = e.name != null ? String(e.name) : String(e);
    if (name.startsWith(".") || name === "node_modules" || name === "vendor")
      continue;
    const next = rel ? rel + sep + name : name;
    const abs = join(base, next);
    if (seen.has(abs)) continue;
    seen.add(abs);
    // Injected dirents carry their own type; strings/statSync are the
    // fallback shapes.
    let isDir;
    if (typeof e.isDirectory === "function") {
      isDir = e.isDirectory();
    } else {
      try {
        isDir = fsStat(abs).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir) {
      dirs.push(next);
      walk(readdirSync, base, next, dirs, files, depth + 1, seen);
    } else {
      files.push(next);
    }
  }
}

// Bounded search: name + content patterns over the sketch's file list,
// capped results. readFile is injectable for tests.
export function searchSketch(sketch, { namePattern = null, contentPattern = null, limit = 20, readFileSync = fsRead } = {}) {
  if (!sketch || !Array.isArray(sketch.files))
    return [];
  const nameRe = namePattern ? new RegExp(namePattern) : null;
  const contentRe = contentPattern ? new RegExp(contentPattern) : null;
  const out = [];
  for (const rel of sketch.files) {
    if (out.length >= limit)
      break;
    if (nameRe && !nameRe.test(rel))
      continue;
    if (contentRe) {
      try {
        if (!contentRe.test(readFileSync(join(sketch.root, rel), "utf8")))
          continue;
      } catch {
        continue;
      }
    }
    out.push(rel);
  }
  return out;
}

// Bounded read: a slice of one file, never the whole repo.
export function readSketchFile(sketch, rel, { start = 0, limit = 400, readFileSync = fsRead } = {}) {
  if (!sketch)
    return null;
  let text;
  try {
    text = readFileSync(join(sketch.root, rel), "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const from = Math.max(0, Number(start) || 0);
  const to = Math.min(lines.length, from + (Number(limit) || 400));
  return {
    path: rel,
    totalLines: lines.length,
    start: from,
    end: to,
    text: lines.slice(from, to).join("\n")
  };
}
