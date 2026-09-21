// Progressive-disclosure skill catalog. The selector sees only this table;
// SKILL.md bodies are loaded on demand by loadSkill(). Freeze-safe: this
// module is not imported by index.js / horizon.js / policies.js.

export const SKILL_CATALOG = [
  {
    id: "swe-debug",
    version: 1,
    description: "Locate and fix a failing test, crash, or stack trace in an existing repo.",
    taskPrefixes: ["code:debug"],
    helperFor: ["swe-feature"]
  },
  {
    id: "swe-feature",
    version: 1,
    description: "Add or change behavior in an existing repo with targeted verification.",
    taskPrefixes: ["code:generation", "code:architecture", "agent:repo_edit", "agent:multi_step"],
    helperFor: []
  },
  {
    id: "ui-build",
    version: 1,
    description: "Implement a frontend surface from a design or existing design system.",
    taskPrefixes: ["code:frontend", "ui:build", "ui:design_to_code"],
    helperFor: []
  },
  {
    id: "ui-repair",
    version: 1,
    description: "Fix layout, visual mismatch, or accessibility failures in existing UI.",
    taskPrefixes: ["ui:repair", "ui:visual_match"],
    helperFor: ["ui-build"]
  }
];

export const SKILL_BY_ID = new Map(SKILL_CATALOG.map((s) => [s.id, s]));
