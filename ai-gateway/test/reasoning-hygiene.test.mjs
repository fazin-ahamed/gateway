import test from "node:test";
import assert from "node:assert/strict";

import { __test as t } from "../src/index.js";

const { stripHistoricalReasoning } = t;

test("a model-swapped conversation does not forward the previous model's private reasoning", () => {
  // Assistant turn produced by model A carries its private scratch work; the
  // next request may route to model B. That reasoning must not travel upstream.
  const payload = {
    model: "model-b",
    messages: [
      { role: "system", content: "be helpful" },
      { role: "user", content: "find the bug" },
      {
        role: "assistant",
        content: "I'll check the router.",
        reasoning_content: "First I should grep for resolveActiveEgress and inspect candidates...",
        reasoning: "dup field",
        thinking: "internal chain of thought",
        analysis: "scratch",
        thinking_blocks: [{ text: "opaque" }],
        reasoning_details: { foo: 1 },
        tool_calls: [{ id: "c1", type: "function", function: { name: "grep", arguments: "{}" } }]
      },
      { role: "tool", tool_call_id: "c1", content: "hit at line 5" }
    ]
  };
  const out = stripHistoricalReasoning(payload);
  const asst = out.messages[2];

  // Every private-reasoning field is gone.
  for (const f of ["reasoning_content", "reasoning", "thinking", "analysis", "thinking_blocks", "reasoning_details"])
    assert.ok(!(f in asst), f + " must be stripped");

  // Real conversation state survives unchanged.
  assert.equal(asst.role, "assistant");
  assert.equal(asst.content, "I'll check the router.");
  assert.deepEqual(asst.tool_calls, [{ id: "c1", type: "function", function: { name: "grep", arguments: "{}" } }]);

  // Other roles are untouched, tool continuity intact.
  assert.equal(out.messages[0].content, "be helpful");
  assert.equal(out.messages[1].content, "find the bug");
  assert.deepEqual(out.messages[3], { role: "tool", tool_call_id: "c1", content: "hit at line 5" });

  // The input payload is not mutated in place (a copy is returned).
  assert.equal("reasoning_content" in payload.messages[2], true, "original payload is not mutated");
});

test("a non-assistant message keeping a 'reasoning' field is left alone", () => {
  // Only assistant turns carry private model reasoning; a user/tool field named
  // 'reasoning' is caller data, not model scratch work, and must survive.
  const payload = {
    messages: [
      { role: "user", content: "q", reasoning: "user's own note" },
      { role: "assistant", content: "a" }
    ]
  };
  const out = stripHistoricalReasoning(payload);
  assert.equal(out.messages[0].reasoning, "user's own note");
});

test("nothing to strip returns the same payload object (no needless copy)", () => {
  const payload = { messages: [{ role: "assistant", content: "a", tool_calls: [] }, { role: "user", content: "b" }] };
  assert.equal(stripHistoricalReasoning(payload), payload, "identity return when no reasoning fields present");
});

test("missing or malformed messages are handled without throwing", () => {
  assert.deepEqual(stripHistoricalReasoning({}), {});
  assert.deepEqual(stripHistoricalReasoning({ messages: null }), { messages: null });
  const withNull = { messages: [null, { role: "assistant", content: "a" }] };
  assert.equal(stripHistoricalReasoning(withNull), withNull, "no reasoning fields -> identity");
});
