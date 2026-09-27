import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLAYGROUND_HTML } from "../src/playground.js";

const SRC = readFileSync(new URL("../src/playground.js", import.meta.url), "utf8");

test("the console offers a decision mode next to chat", () => {
  assert.match(PLAYGROUND_HTML, /id="c-mode-chat"/);
  assert.match(PLAYGROUND_HTML, /id="c-mode-decision"/);
  assert.match(PLAYGROUND_HTML, /id="c-dec-state"/);
  assert.match(PLAYGROUND_HTML, /id="c-dec-questions"/);
  assert.match(PLAYGROUND_HTML, /id="c-dec-answers"/);
});

test("the send button has exactly one handler that branches by mode", () => {
  const handlers = SRC.match(/getElementById\('c-send'\)\.(onclick|addEventListener)/g) || [];
  assert.equal(handlers.length, 1, "a second listener would fire both paths");
  assert.match(SRC, /playgroundMode==='decision'.*sendPlaygroundDecision/);
});

test("decision answers render typed results with probabilities", () => {
  const fn = SRC.slice(SRC.indexOf("function renderDecisionAnswers"), SRC.indexOf("async function sendPlaygroundDecision"));
  assert.match(fn, /type==='choice'/);
  assert.match(fn, /type==='score'/);
  assert.match(fn, /probability/);
  assert.match(SRC, /admin\/playground\/systemone/, 'the console must ride the session-authenticated route');
});

test("decision JSON is parsed, not concatenated", () => {
  assert.match(SRC, /JSON\.parse\(document\.getElementById\('c-dec-state'\)\.value\)/);
  assert.match(SRC, /JSON\.parse\(document\.getElementById\('c-dec-questions'\)\.value\)/);
  assert.doesNotMatch(SRC, /c-dec-state'\)\.value\s*\+/);
});

test("the refreshed visual system ships its tokens and motion guards", () => {
  assert.match(PLAYGROUND_HTML, /--shadow-lift/);
  assert.match(PLAYGROUND_HTML, /--violet/);
  assert.doesNotMatch(PLAYGROUND_HTML, /--r-lg:8px/);
  assert.match(PLAYGROUND_HTML, /prefers-reduced-motion/);
  assert.match(PLAYGROUND_HTML, /cubic-bezier\(\.32,\.72,0,1\)/);
  // Motion is transform/opacity only, never layout-triggering.
  const keyframes = PLAYGROUND_HTML.match(/@keyframes\s+pgDecIn\s*\{[^}]+\}/);
  assert.ok(keyframes && !/top:|left:|width:|height:/.test(keyframes[0].split("from")[1] || ""));
});
