// Wave 3: taste layer depth - reasoning presence, json_repairable salvage,
// style rule targets.

import test from "node:test";
import assert from "node:assert/strict";
import { critique, parseStyleRules } from "../src/taste.js";
import { repairJson } from "../src/json-repair.js";

const ask = (over = {}) => ({ messages: [{ role: "user", content: "hi" }], ...over });
const msg = (content, extra = {}) => ({ role: "assistant", content, ...extra });

test("reasoning presence: a model that should think but didn't", () => {
  // When the request has reasoning enabled (e.g. via a header or a model that
  // advertises thinking), the response should carry reasoning_content.
  const req = ask({ reasoning: { enabled: true } });
  const withThinking = critique({ request: req, message: msg("Answer", { reasoning_content: "Let me think..." }), finishReason: "stop" });
  assert.equal(withThinking.violations.some((v) => v.rule === "reasoning_missing"), false, "reasoning present, no violation");
  const withoutThinking = critique({ request: req, message: msg("Answer"), finishReason: "stop" });
  assert.ok(withoutThinking.violations.some((v) => v.rule === "reasoning_missing"), "missing reasoning is a violation");
  assert.equal(withoutThinking.hard_failed, false, "reasoning is a soft rule, not hard");
});

test("reasoning presence: not checked when reasoning is not requested", () => {
  const req = ask();
  const v = critique({ request: req, message: msg("Answer"), finishReason: "stop" });
  assert.equal(v.violations.some((vv) => vv.rule === "reasoning_missing"), false, "no reasoning rule when not requested");
});

test("json_repairable: fenced JSON is salvageable, raw prose is not", () => {
  const req = ask({ response_format: { type: "json_object" } });
  const fenced = critique({ request: req, message: msg('```json\n{"a":1}\n```'), finishReason: "stop" });
  assert.ok(fenced.violations.some((v) => v.rule === "json_valid"), "fenced JSON fails strict json_valid");
  assert.ok(fenced.violations.some((v) => v.rule === "json_repairable"), "but it is repairable");
  assert.equal(fenced.hard_failed, false, "repairable JSON is not a hard failure");

  const prose = critique({ request: req, message: msg("The answer is 42"), finishReason: "stop" });
  assert.ok(prose.violations.some((v) => v.rule === "json_valid"), "prose fails json_valid");
  assert.equal(prose.violations.some((v) => v.rule === "json_repairable"), false, "prose is not repairable");
  assert.equal(prose.hard_failed, true, "unrepairable JSON is a hard failure");
});

test("style rules can target reasoning content separately", () => {
  const rules = parseStyleRules([{ id: "dash", pattern: "\\u2014", label: "em dash", target: "reasoning" }]);
  const v = critique({ request: ask(), message: msg("clean answer", { reasoning_content: "a \u2014 b" }), finishReason: "stop", styleRules: rules });
  assert.ok(v.violations.some((vv) => vv.rule === "style" && vv.label === "em dash"), "style rule fires on reasoning content");
  const clean = critique({ request: ask(), message: msg("clean answer", { reasoning_content: "no dash" }), finishReason: "stop", styleRules: rules });
  assert.equal(clean.violations.length, 0, "no violation when reasoning is clean");
});

test("style rules default to content target", () => {
  const rules = parseStyleRules([{ id: "dash", pattern: "\\u2014", label: "em dash" }]);
  const v = critique({ request: ask(), message: msg("a \u2014 b"), finishReason: "stop", styleRules: rules });
  assert.ok(v.violations.some((vv) => vv.rule === "style"), "default target is content");
});

test("style rules with target both scan content and reasoning", () => {
  const rules = parseStyleRules([{ id: "dash", pattern: "\\u2014", label: "em dash", target: "both" }]);
  const inContent = critique({ request: ask(), message: msg("a \u2014 b"), finishReason: "stop", styleRules: rules });
  assert.ok(inContent.violations.some((vv) => vv.rule === "style"));
  const inReasoning = critique({ request: ask(), message: msg("clean", { reasoning_content: "a \u2014 b" }), finishReason: "stop", styleRules: rules });
  assert.ok(inReasoning.violations.some((vv) => vv.rule === "style"));
});
