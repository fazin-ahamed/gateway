import test from "node:test";
import assert from "node:assert/strict";

import { __test } from "../src/index.js";

const normalizeTerminalFinishReason = (...args) => {
  assert.equal(
    typeof __test.normalizeTerminalFinishReason,
    "function",
    "stream protocol normalizer must be exported for regression tests"
  );
  return __test.normalizeTerminalFinishReason(...args);
};

test("missing finish reason after tool calls stays in the agent loop", () => {
  assert.equal(normalizeTerminalFinishReason(null, true, true), "tool_calls");
});

test("provider stop after tool calls is repaired to tool_calls", () => {
  assert.equal(normalizeTerminalFinishReason("stop", true, true), "tool_calls");
});

test("length termination is preserved even when a partial tool call was emitted", () => {
  assert.equal(normalizeTerminalFinishReason("length", true, true), "length");
});

test("plain completed text without a finish reason receives stop", () => {
  assert.equal(normalizeTerminalFinishReason(null, false, true), "stop");
});

test("an unclean EOF is not disguised as a successful stop", () => {
  assert.equal(normalizeTerminalFinishReason(null, false, false), null);
});
