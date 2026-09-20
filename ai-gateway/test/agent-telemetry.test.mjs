import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  analyzeAgentLoop,
  fingerprintReasoning,
  reasoningOverlap,
  deriveLogicalTurnId,
  recordAgentLoopEvent
} from "../src/router/agent-telemetry.js";
import { createApp } from "../src/index.js";
import { createDb } from "../../server/db.mjs";

function memDb() {
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return db;
}
const ctxOf = (db) => ({ env: { DB: db } });
const call = (name, args) => ({ id: "c", type: "function", function: { name, arguments: JSON.stringify(args) } });

// ---------- within-request analyzer (pure) ----------

test("first turn: no history, user tail -> first_turn, round 1, no repeats", () => {
  const m = analyzeAgentLoop({
    messages: [{ role: "user", content: "audit the repo" }],
    emittedToolCalls: [call("grep", { pattern: "x" })]
  });
  assert.equal(m.continuation_mode, "first_turn");
  assert.equal(m.agent_round, 1);
  assert.equal(m.tool_calls_emitted, 1);
  assert.equal(m.tool_calls_repeated, 0);
});

test("continuation turn: tool tail -> continuation, round advances with each exchange", () => {
  const m = analyzeAgentLoop({
    messages: [
      { role: "user", content: "audit the repo" },
      { role: "assistant", tool_calls: [call("grep", { pattern: "x" })] },
      { role: "tool", tool_call_id: "c", content: "hit at line 5" }
    ],
    emittedToolCalls: [call("read", { path: "a.js" })]
  });
  assert.equal(m.continuation_mode, "continuation");
  assert.equal(m.agent_round, 2, "one completed exchange -> round 2");
  assert.equal(m.tool_exchanges_in_history, 1);
  assert.equal(m.tool_results_in_history, 1);
  assert.equal(m.tool_calls_repeated, 0, "a new call is not a repeat");
});

test("repeated call: re-issuing an identical prior (name,args) is counted", () => {
  const prior = call("grep", { pattern: "resolveActiveEgress" });
  const m = analyzeAgentLoop({
    messages: [
      { role: "user", content: "find it" },
      { role: "assistant", tool_calls: [prior] },
      { role: "tool", tool_call_id: "c", content: "found" }
    ],
    emittedToolCalls: [call("grep", { pattern: "resolveActiveEgress" })]
  });
  assert.equal(m.tool_calls_emitted, 1);
  assert.equal(m.tool_calls_repeated, 1, "the model redid a call it already made");
});

test("different args to the same tool is NOT a repeat", () => {
  const m = analyzeAgentLoop({
    messages: [
      { role: "user", content: "find it" },
      { role: "assistant", tool_calls: [call("grep", { pattern: "a" })] },
      { role: "tool", tool_call_id: "c", content: "x" }
    ],
    emittedToolCalls: [call("grep", { pattern: "b" })]
  });
  assert.equal(m.tool_calls_repeated, 0);
});

// ---------- reasoning fingerprint + overlap (pure, hash-only) ----------

test("identical opening reasoning -> overlap 1; disjoint -> low; empty -> null", () => {
  const a = fingerprintReasoning("We need to inspect the router statistics before deciding the next step here");
  const b = fingerprintReasoning("We need to inspect the router statistics before deciding the next step here");
  assert.equal(reasoningOverlap(a, b), 1, "identical reasoning fully overlaps");
  const c = fingerprintReasoning("The answer is clearly forty two and requires no further tool usage at all");
  assert.ok(reasoningOverlap(a, c) < 0.2, "disjoint reasoning has low overlap");
  assert.equal(reasoningOverlap(a, []), null, "no comparable reasoning -> null");
  assert.equal(fingerprintReasoning("").length, 0, "empty reasoning -> empty fingerprint");
});

test("fingerprint is hash-only integers, never the reasoning text", () => {
  const fp = fingerprintReasoning("some private chain of thought that must never be stored verbatim");
  assert.ok(Array.isArray(fp) && fp.length > 0);
  assert.ok(fp.every((h) => Number.isInteger(h)), "every entry is an integer hash");
  assert.ok(!JSON.stringify(fp).includes("private"), "no reasoning text leaks into the fingerprint");
});

test("logical turn id is stable across a loop and salt-scoped", () => {
  const round1 = [{ role: "user", content: "audit the repo" }];
  const round2 = [
    { role: "user", content: "audit the repo" },
    { role: "assistant", tool_calls: [call("grep", { pattern: "x" })] },
    { role: "tool", tool_call_id: "c", content: "hit" }
  ];
  assert.equal(deriveLogicalTurnId(round1, "route:7"), deriveLogicalTurnId(round2, "route:7"), "same task+salt -> same turn id across rounds");
  assert.notEqual(deriveLogicalTurnId(round1, "route:7"), deriveLogicalTurnId(round1, "route:9"), "different salt -> different turn");
});

// ---------- durable recorder (in-memory DB) ----------

test("recorder: round 2 reasoning overlap is computed against round 1 of the same turn", async () => {
  const db = memDb();
  const c = ctxOf(db);
  const goal = { role: "user", content: "audit the routing bug" };
  const reasoning = "We need to inspect the router candidates and the posterior math before deciding";

  // Round 1: first turn, emits a tool call.
  const r1 = await recordAgentLoopEvent(c, {
    requestId: "req1",
    messages: [goal],
    emittedToolCalls: [call("grep", { pattern: "posterior" })],
    reasoning,
    publicSlug: "z-ai/glm-5.3", upstreamModel: "glm-5.3", turnSalt: "route:7"
  });
  assert.equal(r1.continuation_mode, "first_turn");
  assert.equal(r1.reasoning_prefix_overlap, null, "no prior round to compare");

  // Round 2: same turn, nearly identical reasoning (the bug we are measuring).
  const r2 = await recordAgentLoopEvent(c, {
    requestId: "req2",
    messages: [
      goal,
      { role: "assistant", tool_calls: [call("grep", { pattern: "posterior" })] },
      { role: "tool", tool_call_id: "c", content: "candidates.js:142" }
    ],
    emittedToolCalls: [call("read", { path: "candidates.js" })],
    reasoning,
    publicSlug: "z-ai/glm-5.3", upstreamModel: "glm-5.3", turnSalt: "route:7"
  });
  assert.equal(r2.continuation_mode, "continuation");
  assert.equal(r2.logical_turn_id, r1.logical_turn_id, "same logical turn");
  assert.equal(r2.reasoning_prefix_overlap, 1, "repeated reasoning -> full overlap detected");

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_loop_events").all().results[0].n, 2);
  // Body-free: the stored fingerprint carries no reasoning text.
  const stored = db.prepare("SELECT reasoning_fp FROM agent_loop_events ORDER BY id").all().results[0].reasoning_fp;
  assert.ok(!String(stored).includes("inspect"), "no reasoning text persisted");
});

test("recorder: distinct turns do not compare reasoning against each other", async () => {
  const db = memDb();
  const c = ctxOf(db);
  const reasoning = "We should inspect the same thing in both conversations entirely";
  const a = await recordAgentLoopEvent(c, {
    messages: [{ role: "user", content: "task A" }],
    emittedToolCalls: [], reasoning, turnSalt: "route:7"
  });
  const b = await recordAgentLoopEvent(c, {
    messages: [{ role: "user", content: "task B" }],
    emittedToolCalls: [], reasoning, turnSalt: "route:7"
  });
  assert.notEqual(a.logical_turn_id, b.logical_turn_id);
  assert.equal(b.reasoning_prefix_overlap, null, "a different turn has no prior round to overlap with");
});

// ---------- admin aggregation endpoint ----------

test("admin endpoint aggregates repeat-rate and mean overlap by mode and round", async () => {
  const db = memDb();
  const env = { DB: db, ADMIN_TOKEN: "admin" };
  const app = createApp(env);
  const now = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO agent_loop_events
     (request_id, logical_turn_id, public_slug, upstream_model, task_type, agent_round, continuation_mode,
      tool_exchanges_in_history, tool_results_in_history, tool_calls_emitted, tool_calls_repeated,
      reasoning_chars, reasoning_prefix_overlap, reasoning_fp, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  // 2 first-turn rows (no repeats), 2 continuation rows (1 repeat each, overlap 0.5).
  ins.bind("r1", "t1", "s", "m", "", 1, "first_turn", 0, 0, 2, 0, 100, null, null, now).run();
  ins.bind("r2", "t2", "s", "m", "", 1, "first_turn", 0, 0, 1, 0, 100, null, null, now).run();
  ins.bind("r3", "t1", "s", "m", "", 2, "continuation", 1, 1, 2, 1, 100, 0.5, null, now).run();
  ins.bind("r4", "t2", "s", "m", "", 2, "continuation", 1, 1, 2, 1, 100, 0.5, null, now).run();

  const res = await app.fetch(new Request("http://gw/admin/router/agent-loop?hours=24", {
    headers: { authorization: "Bearer admin" }
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.overall.events, 4);
  assert.equal(body.overall.tool_calls_emitted, 7);
  assert.equal(body.overall.tool_calls_repeated, 2);
  // continuation slice: 4 emitted, 2 repeated -> 0.5 repeat-rate, overlap mean 0.5.
  assert.equal(body.by_continuation_mode.continuation.repeat_rate, 0.5);
  assert.equal(body.by_continuation_mode.continuation.mean_reasoning_overlap, 0.5);
  assert.equal(body.by_continuation_mode.first_turn.repeat_rate, 0, "first turns never repeat");
  assert.equal(body.by_continuation_mode.first_turn.mean_reasoning_overlap, null, "no overlap samples on first turns");
  assert.equal(body.by_agent_round["1"].events, 2);
  assert.equal(body.by_agent_round["2"].tool_calls_repeated, 2);
});

test("admin endpoint requires admin auth", async () => {
  const db = memDb();
  const app = createApp({ DB: db, ADMIN_TOKEN: "admin" });
  const res = await app.fetch(new Request("http://gw/admin/router/agent-loop"));
  assert.equal(res.status, 401);
});
