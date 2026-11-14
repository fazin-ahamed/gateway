// The neural judging half of taste: a decision model scores a finished
// response along dimensions the symbolic rules cannot see (relevance,
// instruction-following, tone). Those calibrated scores feed the same Beta
// posteriors as the rule verdicts.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { judgeWithDecisionModel, JUDGE_QUESTIONS, mergeJudgeIntoResults } from "../src/taste.js";

const goodResponse = "Here is the JSON you asked for: {\"a\": 1}";
const offTopic = "I cannot help with that.";

function fakeDecisionCaller(overrides = {}) {
  const calls = [];
  const fn = async ({ state, questions }) => {
    calls.push({ state, questions });
    if (overrides.fail) return null;
    return {
      relevant: { type: "noul", probability: overrides.relevant ?? 0.9 },
      instruction_following: { type: "noul", probability: overrides.instruction_following ?? 0.85 },
      tone: { type: "noul", probability: overrides.tone ?? 0.8 }
    };
  };
  fn.calls = calls;
  return fn;
}

test("the judge asks calibrated questions about the response plus request shape", async () => {
  const caller = fakeDecisionCaller();
  const out = await judgeWithDecisionModel({
    caller,
    userIntent: "give me json",
    responseText: goodResponse,
    wantsJson: true
  });
  assert.equal(caller.calls.length, 1, "one decision call");
  const { state, questions } = caller.calls[0];
  // The judge sees the response and the structural facts about the request
  // (wanted JSON, had tools), never the raw prompt text.
  assert.equal(state.response, goodResponse);
  assert.equal(state.wants_json, true);
  assert.ok(state.request_shape && typeof state.request_shape === "string", "a structural request summary is sent");
  for (const dim of Object.keys(JUDGE_QUESTIONS)) {
    assert.ok(questions[dim], "question " + dim + " is asked");
  }
  assert.ok(out && out.scores, "scores returned");
  assert.ok(out.scores.relevant > 0.8, "relevant scored high");
});

test("judge scores merge into taste results as soft learned signals", () => {
  const results = [];
  mergeJudgeIntoResults(results, { scores: { relevant: 0.9, instruction_following: 0.2, tone: 0.7 } });
  const byRule = Object.fromEntries(results.map((r) => [r.rule, r]));
  assert.equal(byRule.judge_relevant.pass, true, "high relevance passes");
  assert.equal(byRule.judge_instruction_following.pass, false, "low instruction-following fails");
  assert.equal(byRule.judge_tone.pass, true, "tone passes");
  // Judge signals are soft: they move the score but never hard-fail a response.
  assert.equal(byRule.judge_relevant.hard, undefined, "not marked hard");
});

test("a failing judge degrades to no judge signals, never an error", async () => {
  const caller = fakeDecisionCaller({ fail: true });
  const out = await judgeWithDecisionModel({ caller, userIntent: "x", responseText: goodResponse });
  assert.equal(out, null, "no output when the judge is unreachable");
  const results = [];
  mergeJudgeIntoResults(results, out);
  assert.equal(results.filter((r) => r.rule.startsWith("judge_")).length, 0, "no judge rules added");
});

test("a nonsense response scores lower than a relevant one", async () => {
  // The fake caller returns fixed scores; here we drive it with a low-scoring
  // response to prove the merge reflects what the judge says.
  const caller = fakeDecisionCaller({ relevant: 0.1, instruction_following: 0.1, tone: 0.3 });
  const out = await judgeWithDecisionModel({ caller, userIntent: "x", responseText: offTopic });
  const results = [];
  mergeJudgeIntoResults(results, out);
  const failed = results.filter((r) => r.rule.startsWith("judge_") && !r.pass).map((r) => r.rule);
  assert.ok(failed.includes("judge_relevant"), "irrelevant flagged");
  assert.ok(failed.includes("judge_instruction_following"), "non-compliant flagged");
});

test("the judge state carries request shape, not prompt text", async () => {
  const caller = fakeDecisionCaller();
  await judgeWithDecisionModel({
    caller,
    userIntent: "rewrite my resume to be shorter and punchier please",
    responseText: goodResponse,
    wantsJson: true,
    hasTools: true
  });
  const { state } = caller.calls[0];
  assert.equal(state.wants_json, true);
  assert.equal(state.has_tools, true);
  assert.ok(!JSON.stringify(state).includes("punchier"), "the actual prompt words are not sent");
  assert.ok(!JSON.stringify(state).includes("resume"), "no prompt content words are sent");
});

test("judge posteriors feed the same Beta table as rule verdicts", async () => {
  const db = createDb(":memory:");
  const { updatePosteriors, loadTasteReport } = await import("../src/taste.js");
  const results = [];
  mergeJudgeIntoResults(results, { scores: { relevant: 0.9, instruction_following: 0.85, tone: 0.8 } });
  await updatePosteriors(db, "m", results, "route-a", "acct-1");
  const report = await loadTasteReport(db);
  assert.ok(report[0].rules.judge_relevant, "judge_relevant posterior exists");
  assert.ok(report[0].rules.judge_relevant.mean > 0.5, "high judge score passes");
});
