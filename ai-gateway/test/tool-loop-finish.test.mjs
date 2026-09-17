import test from "node:test";
import assert from "node:assert/strict";

import {
  guardToolLoopResponse,
  normalizeTerminalFinishReason
} from "../../server/tool-loop-guard.mjs";

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

test("SSE stop after a tool call is rewritten to tool_calls", async () => {
  const source = [
    'data: {"id":"x","model":"grok-4.6","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{}"}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"x","model":"grok-4.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    ''
  ].join("\n");
  const response = new Response(source, { headers: { "content-type": "text/event-stream" } });
  const guarded = guardToolLoopResponse(response, "grok-4.6");
  const text = await guarded.text();
  assert.match(text, /"finish_reason":"tool_calls"/);
  assert.doesNotMatch(text, /"finish_reason":"stop"/);
});

test("SSE missing terminal chunk after a tool call gets tool_calls before DONE", async () => {
  const source = [
    'data: {"id":"x","model":"grok-4.6","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_2","type":"function","function":{"name":"grep","arguments":"{}"}}]},"finish_reason":null}]}',
    '',
    'data: [DONE]',
    ''
  ].join("\n");
  const response = new Response(source, { headers: { "content-type": "text/event-stream" } });
  const guarded = guardToolLoopResponse(response, "grok-4.6");
  const text = await guarded.text();
  const finishAt = text.indexOf('"finish_reason":"tool_calls"');
  const doneAt = text.indexOf("data: [DONE]");
  assert.ok(finishAt >= 0 && finishAt < doneAt, "terminal tool_calls chunk should precede [DONE]");
});

test("partial tool call then an upstream error never ends in tool_calls", async () => {
  const partial = [
    'data: {"id":"x","model":"glm-5.3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_p","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\\""}}]},"finish_reason":null}]}',
    '',
    'data: {"error":{"message":"Upstream stream disconnected","type":"upstream_stream_error","code":"upstream_socket_closed","retryable":true}}',
    '',
    'data: [DONE]',
    ''
  ].join("\n");
  const response = new Response(partial, { headers: { "content-type": "text/event-stream" } });
  const guarded = guardToolLoopResponse(response, "glm-5.3");
  const text = await guarded.text();
  assert.doesNotMatch(text, /"finish_reason":"tool_calls"/);
  assert.match(text, /"code":"upstream_socket_closed"/);
});

test("a mid-stream source failure emits a structured SSE error then DONE", async () => {
  const source = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'));
      controller.error(new Error("ECONNRESET"));
    }
  });
  const response = new Response(source, { headers: { "content-type": "text/event-stream" } });
  const guarded = guardToolLoopResponse(response, "grok-4.6");
  const text = await guarded.text();
  assert.match(text, /"code":"upstream_socket_closed"/);
  assert.match(text, /"retryable":true/);
  assert.match(text, /data: \[DONE\]/);
});
