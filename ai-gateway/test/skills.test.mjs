import { test } from "node:test";
import assert from "node:assert/strict";

import { SKILL_BY_ID, selectSkills, loadSkill, __resetSkillCache } from "../src/skills/index.js";

const ir = (task, extra = {}) => ({ task, features: { lastUser: "" }, ...extra });

test("selectSkills maps TaskIR prefixes to skills", () => {
  assert.equal(selectSkills(ir("code:debug")).primary.id, "swe-debug");
  assert.equal(selectSkills(ir("code:generation")).primary.id, "swe-feature");
  assert.equal(selectSkills(ir("agent:repo_edit")).primary.id, "swe-feature");
  assert.equal(selectSkills(ir("code:architecture")).primary.id, "swe-feature");
  assert.equal(selectSkills(ir("agent:multi_step")).primary.id, "swe-feature");
});

test("selectSkills returns no skill for chat domain", () => {
  for (const t of ["chat:casual", "chat:knowledge", "math:simple", "writing:creative", "research:lookup"]) {
    const got = selectSkills(ir(t));
    assert.equal(got.primary, null, t);
    assert.equal(got.helper, null, t);
  }
});

test("selectSkills yields at most one primary plus one helper", () => {
  for (const t of ["code:debug", "code:generation", "agent:repo_edit", "chat:casual"]) {
    const got = selectSkills(ir(t, { verificationNeed: 0.9 }));
    const n = (got.primary ? 1 : 0) + (got.helper ? 1 : 0);
    assert.ok(n <= 2, t);
    if (got.primary && got.helper) assert.notEqual(got.primary.id, got.helper.id, t);
  }
});

test("selectSkills attaches helper only on high verification need", () => {
  assert.equal(selectSkills(ir("code:generation", { verificationNeed: 0.2 })).helper, null);
  const deep = selectSkills(ir("code:generation", { verificationNeed: 0.8 }));
  assert.equal(deep.helper.id, "swe-debug");
});

test("selectSkills unknown task without UI keywords yields nothing", () => {
  const got = selectSkills(ir("vision:reasoning"));
  assert.equal(got.primary, null);
});

test("loadSkill returns null for unknown id", () => {
  assert.equal(loadSkill("nope-not-a-skill"), null);
});

test("loadSkill returns body and cache reuses until mtime changes", () => {
  __resetSkillCache();
  const a = loadSkill("swe-debug");
  assert.ok(a && typeof a.body === "string" && a.body.length > 100);
  const b = loadSkill("swe-debug");
  assert.equal(a.body, b.body);
  __resetSkillCache();
  const c = loadSkill("swe-debug");
  assert.equal(a.body, c.body);
  assert.ok(c.body.length < 6000, "skill body should stay under ~6k chars");
});

test("every catalog entry has a loadable SKILL.md", () => {
  for (const s of SKILL_BY_ID.keys()) {
    const got = loadSkill(s);
    assert.ok(got, `SKILL.md missing for ${s}`);
  }
});
