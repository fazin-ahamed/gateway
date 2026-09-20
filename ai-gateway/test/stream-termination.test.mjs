// Stream termination invariants for the index.js SSE paths.
//
// An interrupted stream (upstream disconnect, upstream error frame, malformed
// SSE) must still terminate with a RECOGNIZED terminal: a structured error
// frame first, then a terminal finish_reason chunk that is a non-success
// terminal ("length", never "stop"), then [DONE]. Clients key retries off
// finish_reason; a bare [DONE] or a clean "stop" reads as a completed turn
// and suppresses them.

import test from "node:test";
import assert from "node:assert/strict";

import { __test as t } from "../src/index.js";

const { sseUpstreamDisconnect, closeSseGracefully } = t;

function dataFrames(sse) {
  return sse
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => f.slice(6));
}

test("sseUpstreamDisconnect: error frame -> terminal length chunk -> [DONE], exactly that order", () => {
  const sse = sseUpstreamDisconnect("socket died");
  const frames = dataFrames(sse);
  assert.equal(frames.length, 3, "error, terminal, DONE — nothing else");

  const err = JSON.parse(frames[0]);
  assert.equal(err.error.code, "upstream_socket_closed");
  assert.equal(err.error.retryable, true);
  assert.equal(err.error.message, "Upstream stream disconnected");

  const term = JSON.parse(frames[1]);
  assert.equal(term.object, "chat.completion.chunk");
  assert.deepEqual(term.choices[0].delta, {});
  assert.equal(term.choices[0].finish_reason, "length", "interrupted stream is a non-success terminal");

  assert.equal(frames[2], "[DONE]");
});

test("an interrupted stream is never disguised as a clean stop", () => {
  const sse = sseUpstreamDisconnect("boom");
  assert.match(sse, /"finish_reason":"length"/);
  assert.doesNotMatch(sse, /"finish_reason":"stop"/);
});

test("sseUpstreamDisconnect never echoes the raw exception", () => {
  const secret = "SECRET_RELAY https://internal-relay.example/path?token=abc";
  const sse = sseUpstreamDisconnect("The socket connection was closed at " + secret);
  assert.doesNotMatch(sse, /SECRET_RELAY/);
  assert.doesNotMatch(sse, /internal-relay/);
  assert.doesNotMatch(sse, /https?:\/\//i);
});

test("closeSseGracefully enqueues the termination shape then closes", () => {
  const seen = [];
  const enc = { encode: (s) => s };
  const controller = {
    enqueue: (chunk) => seen.push(chunk),
    close: () => seen.push("<closed>")
  };
  closeSseGracefully(controller, enc, new Error("ECONNRESET after 2 chunks"));
  assert.equal(seen.length, 2, "one enqueue + one close");
  const frames = dataFrames(seen[0]);
  assert.equal(JSON.parse(frames[0]).error.code, "upstream_socket_closed");
  assert.equal(JSON.parse(frames[1]).choices[0].finish_reason, "length");
  assert.equal(frames[2], "[DONE]");
  assert.equal(seen[1], "<closed>", "controller is closed after the enqueue");
});

test("closeSseGracefully: no controller is a no-op; a broken stream still gets closed", () => {
  const enc = { encode: (s) => s };
  assert.doesNotThrow(() => closeSseGracefully(null, enc, new Error("x")));
  const closed = [];
  const broken = {
    enqueue: () => { throw new Error("stream already torn down"); },
    close: () => closed.push(true)
  };
  assert.doesNotThrow(() => closeSseGracefully(broken, enc, new Error("x")));
  assert.deepEqual(closed, [true], "still attempts to close after enqueue failure");
});
