import test from "node:test";
import assert from "node:assert/strict";

import { applyUtf16Edit, createZaiFrameNormalizer, splitDetails } from "../src/zai-stream.js";
import { __test as zaiTest } from "../src/zaiweb.js";

function collect(normalizer, frames) {
  const out = [];
  for (const frame of frames) out.push(...normalizer.push(frame));
  out.push(...normalizer.finish());
  return out;
}

function sseSource(frames) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}

test("edit_content uses UTF-16 offsets without splitting a surrogate pair", () => {
  assert.equal(applyUtf16Edit("A😀B", 3, "C"), "A😀C");
  assert.equal(applyUtf16Edit("A😀B", 2, "X"), "AX");
});

test("tail holdback absorbs a normal edit_content backtrack", () => {
  const n = createZaiFrameNormalizer({ holdback: 2 });
  const events = collect(n, [
    { data: { delta_content: "hello wor" } },
    { data: { edit_index: 6, edit_content: "world" } }
  ]);
  const text = events.map((e) => e.content || "").join("");
  assert.equal(text, "hello world");
  assert.doesNotMatch(text, /worworld/);
});

test("details reasoning is emitted before answer content when the block closes", () => {
  const n = createZaiFrameNormalizer({ holdback: 4 });
  const events = collect(n, [
    { data: { content: "<details type=\"reasoning\">\n> think carefully" } },
    { data: { content: "<details type=\"reasoning\">\n> think carefully\n</details>answer" } }
  ]);
  const reasoningIndex = events.findIndex((e) => e.reasoning);
  const contentIndex = events.findIndex((e) => e.content);
  assert.ok(reasoningIndex >= 0);
  assert.ok(contentIndex > reasoningIndex);
  assert.equal(events.map((e) => e.reasoning || "").join(""), "think carefully");
  assert.equal(events.map((e) => e.content || "").join(""), "answer");
});

test("splitDetails holds an incomplete opener and separates a closed block", () => {
  assert.deepEqual(splitDetails("hello<det"), { reasoning: "", content: "hello<det", open: false });
  assert.deepEqual(splitDetails("hello<details type=\"reasoning\""), { reasoning: "", content: "hello", open: true });
  const out = splitDetails("<details type=\"reasoning\">why</details>answer");
  assert.deepEqual(out, { reasoning: "why", content: "answer", open: false });
});

test("OpenAI-shaped ZAI SSE starts with role only and never leaks provider identity on stream error", async () => {
  assert.equal(typeof zaiTest?.toOpenAiStream, "function");
  const source = sseSource([
    { choices: [{ delta: { content: "hello" }, finish_reason: null }] },
    { error: { message: "Z.ai chat.z.ai SECRET_PROVIDER_RELbackend" } }
  ]);
  const text = await new Response(zaiTest.toOpenAiStream(source, "public-model", "test-id")).text();
  assert.doesNotMatch(text, /z\.ai|chat\.z\.ai|SECRET_PROVIDER|relbackend/i);
  const payloads = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  const firstChoice = payloads.find((p) => Array.isArray(p.choices));
  assert.deepEqual(firstChoice.choices[0].delta, { role: "assistant" });
  assert.ok(payloads.some((p) => p.error?.code === "upstream_stream_error"));
  assert.equal(payloads.some((p) => p.choices?.[0]?.finish_reason === "stop" && payloads.some((x) => x.error)), false, "an errored stream must not also claim a successful stop");
});
