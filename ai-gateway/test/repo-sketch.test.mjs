// RepoSketch tests — deterministic repo map, bounded search and read.
// Every filesystem call goes through one injected bag. Nothing here
// touches the real disk, including the missing-root case.

import test from "node:test";
import assert from "node:assert/strict";

import { sketchRepo, searchSketch, readSketchFile } from "../src/swe/repo-sketch.js";

const NL = String.fromCharCode(10);

const fakeTree = {
  "package.json": JSON.stringify({ scripts: { test: "node --test test/*.test.mjs" }, devDependencies: {} }),
  "tsconfig.json": "{}",
  src: {
    "index.js": "export function main() { return 1; }" + NL,
    "util.js": "export const x = 42;" + NL
  },
  test: {
    "index.test.mjs": "import { test } from 'node:test';" + NL
  },
  docs: {
    "readme.md": "# hi" + NL
  },
  node_modules: {
    "noise.js": "nope" + NL
  },
  ".git": {
    HEAD: "ref: refs/heads/main" + NL
  }
};

function lookup(tree, parts) {
  let node = tree;
  for (const p of parts) {
    if (node === undefined || typeof node !== "object" || node === null)
      return undefined;
    node = node[p];
  }
  return node;
}

function makeFs(tree, root = "/fake") {
  const rootParts = String(root).split(/[\\/]+/).filter(Boolean);
  function nodeAt(path) {
    const parts = String(path).split(/[\\/]+/).filter(Boolean);
    const under = rootParts.every((p, i) => parts[i] === p);
    if (!under)
      return undefined;
    return lookup(tree, parts.slice(rootParts.length));
  }
  return {
    existsSync(path) {
      return nodeAt(path) !== undefined;
    },
    readFileSync(path) {
      const node = nodeAt(path);
      if (typeof node !== "string")
        throw new Error("not a file: " + path);
      return node;
    },
    readdirSync(path) {
      const node = nodeAt(path);
      if (node === undefined)
        throw new Error("no such dir: " + path);
      if (typeof node !== "object" || node === null)
        throw new Error("not a directory: " + path);
      return Object.keys(node).map((name) => ({
        name,
        isDirectory: () => typeof node[name] === "object" && node[name] !== null
      }));
    }
  };
}

function sketch(tree, root = "/fake") {
  return sketchRepo(root, makeFs(tree, root));
}

test("sketchRepo detects languages, manifests and the test framework", () => {
  const sk = sketch(fakeTree);
  assert.ok(sk);
  assert.ok(sk.languages.includes("javascript"));
  assert.ok(sk.languages.includes("typescript"));
  assert.ok(sk.manifests.includes("package.json"));
  assert.equal(sk.testFramework, "node-test");
  // A test script is always invoked as `npm test`, even when the script
  // itself starts with `node --test`. The script delegates; we do not guess.
  assert.equal(sk.testCommand, "npm test");
});

test("sketchRepo names vitest, jest and mocha from package.json text", () => {
  const vitest = sketch({ "package.json": JSON.stringify({ devDependencies: { vitest: "1.0.0" } }) });
  assert.equal(vitest.testFramework, "vitest");
  assert.equal(vitest.testCommand, "npm test");
  const jest = sketch({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) });
  assert.equal(jest.testFramework, "jest");
  const mocha = sketch({ "package.json": JSON.stringify({ devDependencies: { mocha: "10.0.0" } }) });
  assert.equal(mocha.testFramework, "mocha");
});

test("sketchRepo picks the manifest's own test command for non-node repos", () => {
  const go = sketch({ "go.mod": "module example" + NL });
  assert.deepEqual(go.languages, ["go"]);
  assert.equal(go.testFramework, "go-test");
  assert.equal(go.testCommand, "go test");
  const rust = sketch({ "Cargo.toml": "[package]" + NL });
  assert.equal(rust.testCommand, "cargo test");
  const py = sketch({ "pyproject.toml": "[project]" + NL });
  assert.equal(py.testFramework, "pytest");
  assert.equal(py.testCommand, "pytest");
});

test("sketchRepo walks directories and skips noise", () => {
  const sk = sketch(fakeTree);
  const joined = sk.directories.join(",");
  assert.match(joined, /src/);
  assert.match(joined, /test/);
  assert.ok(!/node_modules/.test(joined), "node_modules never walked");
  assert.ok(!sk.files.some((f) => f.startsWith(".") || f.includes("noise")), "dot dirs and vendor noise skipped");
});

test("sketchRepo surfaces important directories", () => {
  const sk = sketch(fakeTree);
  assert.ok(sk.importantDirectories.some((d) => d.includes("src")));
  assert.ok(sk.importantDirectories.some((d) => d.includes("test")));
  assert.ok(sk.importantDirectories.some((d) => d.includes("docs")));
});

test("sketchRepo returns null for a missing root", () => {
  const fs = makeFs(fakeTree);
  assert.equal(sketchRepo("/definitely-not-here", fs), null);
});

test("sketchRepo keeps manifest facts when the tree cannot be walked", () => {
  const tree = { "go.mod": "module example" + NL + NL + "go 1.22" + NL };
  const fs = makeFs(tree);
  fs.readdirSync = () => { throw new Error("permission denied"); };
  const sk = sketchRepo("/fake", fs);
  assert.deepEqual(sk.languages, ["go"]);
  assert.deepEqual(sk.manifests, ["go.mod"]);
  assert.equal(sk.testCommand, "go test");
  assert.deepEqual(sk.directories, []);
  assert.deepEqual(sk.files, []);
});

test("searchSketch matches by name pattern", () => {
  const sk = sketch(fakeTree);
  const hits = searchSketch(sk, { namePattern: "\\.js$", ...makeFs(fakeTree) });
  assert.ok(hits.some((h) => h.includes("index.js")));
  assert.ok(hits.every((h) => h.endsWith(".js")));
});

test("searchSketch matches by content through the injected reader", () => {
  const fs = makeFs(fakeTree);
  let reads = 0;
  const readFileSync = (path, enc) => {
    reads += 1;
    return fs.readFileSync(path, enc);
  };
  const sk = sketch(fakeTree);
  const hits = searchSketch(sk, { contentPattern: "function main", readFileSync });
  assert.ok(hits.some((h) => h.includes("index.js")));
  assert.ok(reads > 0, "content search reads through the injected function, not disk");
});

test("searchSketch respects the result limit", () => {
  const sk = sketch(fakeTree);
  assert.equal(searchSketch(sk, { limit: 1, ...makeFs(fakeTree) }).length, 1);
});

test("readSketchFile returns a bounded slice from the injected reader", () => {
  const fs = makeFs(fakeTree);
  const sk = sketch(fakeTree);
  const out = readSketchFile(sk, "src/index.js", { start: 0, limit: 1, readFileSync: fs.readFileSync });
  assert.ok(out);
  assert.equal(out.start, 0);
  assert.equal(out.end, 1);
  assert.equal(out.text.split(NL).length, 1);
  assert.ok(out.totalLines >= out.end);
  assert.equal(out.path, "src/index.js");
});

test("readSketchFile returns null for a missing file", () => {
  const sk = sketch(fakeTree);
  assert.equal(readSketchFile(sk, "nope.js", makeFs(fakeTree)), null);
});
