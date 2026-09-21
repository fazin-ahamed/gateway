// Stream termination invariants for the index.js SSE paths.
//
// Priority-zero stream continuity contract: an interrupted stream (upstream
// disconnect, relay tunnel closed on a non-EOF body read, upstream error
// frame, malformed SSE) must terminate with a RECOGNIZED terminal — a
// finish_reason chunk that is a non-success terminal ("length", never
// "stop") — followed by [DONE]. Nothing else lands on the client wire.
//
// The raw upstream exception is NEVER emitted as an SSE data frame: it can
// carry relay URLs, credentials or internal hostnames. Clients key retries
// off finish_reason, so the terminal chunk alone carries the signal.

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

test("sseUpstreamDisconnect: terminal length chunk -> [DONE], no raw error frame", () => {
  const sse = sseUpstreamDisconnect("relay tunnel closed mid-flight");
  const frames = dataFrames(sse);
  assert.equal(frames.length, 2, "terminal + DONE — nothing else on the wire");

  const term = JSON.parse(frames[0]);
  assert.equal(term.object, "chat.completion.chunk");
  assert.deepEqual(term.choices[0].delta, {});
  assert.equal(term.choices[0].finish_reason, "length", "interrupted stream is a non-success terminal");
  assert.equal(frames[1], "[DONE]");
  assert.ok(/data: \[DONE\]$/.test(sse.trim()), "stream must end with [DONE]");
});

test("sseUpstreamDisconnect: error frame is absent from the client wire", () => {
  const sse = sseUpstreamDisconnect("socket died");
  assert.doesNotMatch(sse, /upstream_socket_closed/);
  assert.doesNotMatch(sse, /upstream_stream_error/);
  assert.doesNotMatch(sse, /"error"/);
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

test("closeSseGracefully enqueues the terminal shape then closes", () => {
  const seen = [];
  const enc = { encode: (s) => s };
  const controller = {
    enqueue: (chunk) => seen.push(chunk),
    close: () => seen.push("<closed>")
  };
  closeSseGracefully(controller, enc, new Error("ECONNRESET after 2 chunks"));
  assert.equal(seen.length, 2, "one enqueue + one close");
  const frames = dataFrames(seen[0]);
  assert.equal(frames.length, 2, "terminal + DONE");
  assert.equal(JSON.parse(frames[0]).choices[0].finish_reason, "length");
  assert.equal(frames[1], "[DONE]");
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
