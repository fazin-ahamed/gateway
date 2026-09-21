// Failure Capsule tests — the handoff a stalled attempt leaves behind.
// These assert what the next attempt receives, not how the text is stored.

import test from "node:test";
import assert from "node:assert/strict";

import { openCapsule, noteCapsule, sealCapsule, renderCapsule, CAPSULE_LIMITS } from "../src/swe/failure-capsule.js";

test("openCapsule keeps the handoff fields and drops nothing into prose", () => {
  const capsule = openCapsule({
    goal: "stop the leak",
    hypothesis: "the catch emits the raw frame",
    filesInspected: ["src/index.js"],
    filesChanged: ["src/zaiweb.js"],
    tests: ["node --test test/stream-termination.test.mjs"],
    failure: "frame still contains upstream_socket_closed",
    ruledOut: ["the relay close path"],
    unknowns: ["whether the guard catch emits too"]
  });
  assert.equal(capsule.status, "open");
  assert.equal(capsule.goal, "stop the leak");
  assert.deepEqual(capsule.filesChanged, ["src/zaiweb.js"]);
  assert.deepEqual(capsule.unknowns, ["whether the guard catch emits too"]);
});

test("openCapsule fills missing fields with empty values instead of inventing them", () => {
  const capsule = openCapsule({});
  assert.equal(capsule.goal, "");
  assert.equal(capsule.hypothesis, "");
  assert.equal(capsule.failure, "");
  assert.deepEqual(capsule.filesInspected, []);
  assert.deepEqual(capsule.ruledOut, []);
  assert.deepEqual(capsule.unknowns, []);
});

test("list fields accept one string, dedupe repeats, and stay inside the cap", () => {
  const many = Array.from({ length: CAPSULE_LIMITS.maxItems + 5 }, (_, i) => `file-${i}.js`);
  const capsule = openCapsule({
    filesInspected: ["src/index.js", "src/index.js", ...many]
  });
  assert.equal(capsule.filesInspected[0], "src/index.js");
  assert.equal(capsule.filesInspected.length, CAPSULE_LIMITS.maxItems);
  assert.equal(new Set(capsule.filesInspected).size, capsule.filesInspected.length);
});

test("text fields collapse whitespace and clip past the cap", () => {
  const capsule = openCapsule({ failure: "  boom\n\n  at   src/index.js  " + "x".repeat(CAPSULE_LIMITS.maxText) });
  assert.ok(!capsule.failure.includes("\n"));
  assert.ok(capsule.failure.startsWith("boom at src/index.js"));
  assert.equal(capsule.failure.length, CAPSULE_LIMITS.maxText);
  assert.ok(capsule.failure.endsWith("…"));
});

test("noteCapsule appends observations and refuses to blank a field with an empty patch", () => {
  const opened = openCapsule({ goal: "stop the leak", ruledOut: ["the relay"] });
  const noted = noteCapsule(opened, { goal: "", ruledOut: ["the relay", "the sse helper"], unknowns: "guard catch" });
  assert.equal(noted.goal, "stop the leak");
  assert.deepEqual(noted.ruledOut, ["the relay", "the sse helper"]);
  assert.deepEqual(noted.unknowns, ["guard catch"]);
  assert.equal(opened.ruledOut.length, 1);
});

test("sealCapsule marks only a verified outcome as done", () => {
  const opened = openCapsule({ goal: "stop the leak", failure: "still leaks" });
  assert.equal(sealCapsule(opened, "verified").status, "verified");
  assert.equal(sealCapsule(opened).status, "failed");
  assert.equal(sealCapsule(opened, "gave-up").status, "failed");
  assert.equal(sealCapsule(opened, "verified").failure, "still leaks");
  assert.equal(opened.status, "open");
});

test("renderCapsule omits empty sections and keeps every filled one", () => {
  const text = renderCapsule(sealCapsule(openCapsule({
    goal: "stop the leak",
    filesChanged: ["src/zaiweb.js"],
    failure: "frame still contains upstream_socket_closed",
    ruledOut: ["the relay close path"]
  }), "failed"));
  assert.match(text, /^status: failed/);
  assert.match(text, /goal: stop the leak/);
  assert.match(text, /files changed:\n- src\/zaiweb\.js/);
  assert.match(text, /failure: frame still contains upstream_socket_closed/);
  assert.match(text, /ruled out:\n- the relay close path/);
  assert.equal(text.includes("hypothesis"), false);
  assert.equal(text.includes("unknowns"), false);
});
