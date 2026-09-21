// Execution profiles. Pure: no model picking, no policies.js import, not
// imported by the serving path. Freeze-safe — off by default at the boundary.

const PROFILES = Object.freeze({
  FAST: {
    id: "FAST",
    maxRetries: 1,
    enableSkills: false,
    verificationDepth: "assert"
  },
  STANDARD: {
    id: "STANDARD",
    maxRetries: 2,
    enableSkills: true,
    verificationDepth: "module"
  },
  DEEP: {
    id: "DEEP",
    maxRetries: 3,
    enableSkills: true,
    verificationDepth: "suite"
  }
});

// Order matters: the first matching gate wins. Mirrors compileTaskIR's own
// cheap-signal ordering (lexical features + capability floors).
export function profileFor(taskIR) {
  const t = taskIR || {};
  const difficulty = Number(t.difficulty) || 0;
  const verificationNeed = Number(t.verificationNeed) || 0;
  const agenticDepth = Number(t.agenticDepth) || 0;
  const tools = t.tools || {};
  const interactive = t.latencyClass !== "batch";

  // Anything that mutates a repo or carries real consequences gets DEEP.
  if (tools.mutation || agenticDepth > 0.6 || verificationNeed > 0.75) return PROFILES.DEEP;
  // Long-context or batch-criticality work is not a quick turn.
  if (!interactive || difficulty > 0.6) return PROFILES.DEEP;
  // Trivial, well-scoped, verifiable in one check.
  if (difficulty < 0.2 && verificationNeed < 0.3 && !tools.required) return PROFILES.FAST;
  return PROFILES.STANDARD;
}

export { PROFILES };
