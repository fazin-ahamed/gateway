import { test } from "node:test";
import assert from "node:assert/strict";

import { profileFor, PROFILES } from "../src/profiles/index.js";

const ir = (o) => o;

test("profileFor returns one of the three declared profiles", () => {
  for (const p of [PROFILES.FAST, PROFILES.STANDARD, PROFILES.DEEP])
    assert.ok(p && typeof p.id === "string");
  for (const t of [
    { task: "chat:casual", difficulty: 0.1, verificationNeed: 0.1 },
    { task: "code:generation", difficulty: 0.5, verificationNeed: 0.5 },
    { task: "agent:repo_edit", difficulty: 0.8, verificationNeed: 0.9, tools: { mutation: true } }
  ]) {
    assert.ok(["FAST", "STANDARD", "DEEP"].includes(profileFor(ir(t)).id));
  }
});

test("mutation and high verification need force DEEP", () => {
  assert.equal(profileFor(ir({ task: "agent:repo_edit", difficulty: 0.2, verificationNeed: 0.2, tools: { mutation: true } })).id, "DEEP");
  assert.equal(profileFor(ir({ task: "code:debug", difficulty: 0.5, verificationNeed: 0.9 })).id, "DEEP");
  assert.equal(profileFor(ir({ task: "agent:multi_step", agenticDepth: 0.8 })).id, "DEEP");
});

test("trivial interactive chat-style tasks get FAST", () => {
  const got = profileFor(ir({ task: "chat:casual", difficulty: 0.05, verificationNeed: 0.05, latencyClass: "interactive", tools: {} }));
  assert.equal(got.id, "FAST");
  assert.equal(got.maxRetries, 1);
  assert.equal(got.enableSkills, false);
});

test("batch latency class never returns FAST", () => {
  const got = profileFor(ir({ task: "reasoning:planning", difficulty: 0.15, verificationNeed: 0.2, latencyClass: "batch", tools: {} }));
  assert.notEqual(got.id, "FAST");
});

test("profileFor never picks a model or imports serving policy", () => {
  const got = profileFor(ir({ task: "code:debug", difficulty: 0.4, verificationNeed: 0.6, tools: { required: true } }));
  assert.equal("model" in got, false);
  assert.equal("routes" in got, false);
  assert.equal(got.id, "STANDARD");
});

test("missing or malformed taskIR still resolves to a profile", () => {
  assert.ok(profileFor(ir({})).id);
  assert.ok(profileFor(null).id);
  assert.ok(profileFor(ir({ difficulty: "nope", tools: null })).id);
});
