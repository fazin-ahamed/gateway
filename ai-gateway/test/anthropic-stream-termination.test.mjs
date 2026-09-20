// Anthropic adapter stream-termination invariants (index.js wrapAnthropicStream).
//
// The finish-reason contract must hold on the Anthropic path too, not just Z.AI:
//  - a stream carrying a real stop_reason forwards it verbatim (no synthesis);
//  - the known upstream quirk — message_stop WITHOUT a stop_reason-bearing
//    message_delta — is a CLEAN protocol end -> synthesize "stop";
//  - a truncated upstream EOF (no message_stop at all) is an interrupted
//    generation -> synthesize finish_reason "length", NEVER "stop";
//  - a thrown upstream read terminates through the shared error shape
//    (error frame -> terminal "length" -> [DONE]) with no exception echo.

import test from "node:test";
import assert from "node:assert/strict";

import { __test as t } from "../src/index.js";

const { wrapAnthropicStream, fromAnthropicStreamChunk } = t;

const enc = new TextEncoder();

function upstream(frames, { fail = false } = {}) {
  return {
    body: new ReadableStream({
      start(controller) {
        for (const f of frames)
          controller.enqueue(enc.encode(f));
        if (fail)
          controller.error(new Error("ECONNRESET mid-stream (secret-relay.example)"));
        else
          controller.close();
      }
    })
  };
}

async function readAll(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

function dataFrames(sse) {
  return sse.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => f.slice(6));
}

const textDelta = (s) =>
  "data: " + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: s } }) + "\n\n";
const stopReasonFrame = (sr) =>
  "data: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: sr }, usage: { output_tokens: 1 } }) + "\n\n";
const messageStopFrame = () => "data: " + JSON.stringify({ type: "message_stop" }) + "\n\n";

function terminals(frames) {
  return frames
    .filter((f) => f !== "[DONE]")
    .map((f) => JSON.parse(f))
    .filter((c) => c.choices && c.choices[0] && c.choices[0].finish_reason);
}

test("a clean stream forwards the upstream stop_reason and does not synthesize", async () => {
  const res = wrapAnthropicStream(upstream([textDelta("hello"), stopReasonFrame("end_turn"), messageStopFrame()]), "claude-x");
  const frames = dataFrames(await readAll(res));
  const stops = terminals(frames);
  assert.equal(stops.length, 1, "exactly one terminal chunk");
  assert.equal(stops[0].choices[0].finish_reason, "stop");
  assert.equal(frames[frames.length - 1], "[DONE]");
});

test("message_stop without a stop_reason (the known quirk) synthesizes a clean stop", async () => {
  const res = wrapAnthropicStream(upstream([textDelta("hello"), messageStopFrame()]), "claude-x");
  const frames = dataFrames(await readAll(res));
  const stops = terminals(frames);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].choices[0].finish_reason, "stop", "protocol completed -> clean stop");
  assert.equal(frames[frames.length - 1], "[DONE]");
});

test("a truncated EOF (no message_stop) synthesizes length, never stop", async () => {
  const res = wrapAnthropicStream(upstream([textDelta("partial gen")]), "claude-x");
  const sse = await readAll(res);
  assert.match(sse, /"finish_reason":"length"/, "interrupted generation gets the non-success terminal");
  assert.doesNotMatch(sse, /"finish_reason":"stop"/);
  assert.match(sse, /\[DONE\]/);
});

test("max_tokens stop_reason maps to length verbatim", async () => {
  const res = wrapAnthropicStream(upstream([textDelta("hello"), stopReasonFrame("max_tokens")]), "claude-x");
  const frames = dataFrames(await readAll(res));
  const stops = terminals(frames);
  assert.equal(stops.length, 1, "real finish_reason seen -> no extra synthesized chunk");
  assert.equal(stops[0].choices[0].finish_reason, "length");
});

test("an upstream throw terminates with the shared error shape, never a clean stop", async () => {
  const res = wrapAnthropicStream(upstream([textDelta("hi")], { fail: true }), "claude-x");
  const sse = await readAll(res);
  const frames = dataFrames(sse);
  const err = JSON.parse(frames[0]);
  assert.equal(err.error.code, "upstream_socket_closed");
  assert.equal(err.error.retryable, true);
  const term = JSON.parse(frames[1]);
  assert.equal(term.choices[0].finish_reason, "length");
  assert.equal(frames[2], "[DONE]");
  assert.doesNotMatch(sse, /"finish_reason":"stop"/);
  assert.doesNotMatch(sse, /secret-relay/, "no raw exception echo");
});

test("fromAnthropicStreamChunk maps tool_use to tool_calls; unknown stop_reason is not a finish", () => {
  const tool = fromAnthropicStreamChunk({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }, "m");
  assert.equal(tool.choices[0].finish_reason, "tool_calls");
  const unknown = fromAnthropicStreamChunk({ type: "message_delta", delta: { stop_reason: "weird" }, usage: {} }, "m");
  assert.ok(!unknown.choices[0].finish_reason, "unknown stop_reason must not fabricate a finish_reason");
  const stop = fromAnthropicStreamChunk({ type: "message_stop" }, "m");
  assert.equal(stop, null, "message_stop maps to no chunk");
});
