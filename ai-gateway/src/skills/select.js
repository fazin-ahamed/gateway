// Local skill selection. No model call. Max one primary and one helper.
// Chat / writing / math / research / vision without UI keywords → no skill.

import { SKILL_CATALOG } from "./catalog.js";

const UI_RE = /\b(ui|css|html|react|jsx|tsx|vue|svelte|tailwind|component|layout|a11y|accessib|wcag|screenshot|figma|css.?grid|flexbox)\b/i;
const REPAIR_RE = /\b(fix|broken|mismatch|overflow|a11y|accessib|regress|repair|wrong.?layout)\b/i;
const FRONTEND_TASKS = new Set(["code:frontend", "ui:build", "ui:repair", "ui:design_to_code", "ui:visual_match"]);

function byPrefix(task) {
  const t = String(task || "");
  return SKILL_CATALOG.find((s) => s.taskPrefixes.some((p) => t === p || t.startsWith(p + ":") || t.startsWith(p)));
}

function uiSkill(taskIR) {
  const f = (taskIR && taskIR.features) || {};
  // extractFeatures emits sessionBlob (the joined non-system text); lastUser/text are defensive fallbacks.
  const text = String(f.sessionBlob || f.lastUser || f.text || "");
  const task = String(taskIR && taskIR.task || "");
  const looksUi = FRONTEND_TASKS.has(task) || UI_RE.test(text) || UI_RE.test(task);
  if (!looksUi) return null;
  // code:review is a UI task only when the request text says it is.
  if (REPAIR_RE.test(text) || task === "ui:repair" || task === "ui:visual_match")
    return SKILL_CATALOG.find((s) => s.id === "ui-repair") || null;
  return SKILL_CATALOG.find((s) => s.id === "ui-build") || null;
}

export function selectSkills(taskIR) {
  const task = String(taskIR && taskIR.task || "");
  if (!task || task.startsWith("chat:") || task.startsWith("writing:") || task.startsWith("math:") || task.startsWith("research:") || task.startsWith("data:") || task.startsWith("reasoning:"))
    return { primary: null, helper: null, reason: "no-skill domain" };

  const ui = uiSkill(taskIR);
  const mapped = byPrefix(task);
  // Only a specific-intent mapping overrides lexical UI detection: a debug
  // request is a debug request even if the broken thing is a React layout.
  // Generic mappings (code:generation, code:architecture, agent:*) yield to it.
  let primary = mapped && mapped.id === "swe-debug" ? mapped : (ui || mapped);
  if (!primary)
    return { primary: null, helper: null, reason: "no matching skill" };

  let helper = null;
  const need = Number(taskIR && taskIR.verificationNeed) || 0;
  if (primary.id === "swe-feature" && need > 0.45) {
    helper = SKILL_CATALOG.find((s) => s.id === "swe-debug") || null;
  } else if (primary.id === "ui-build" && need > 0.45) {
    helper = SKILL_CATALOG.find((s) => s.id === "ui-repair") || null;
  }
  if (helper && helper.id === primary.id) helper = null;

  return {
    primary: { id: primary.id, version: primary.version, description: primary.description },
    helper: helper ? { id: helper.id, version: helper.version, description: helper.description } : null,
    reason: helper ? primary.id + "+" + helper.id : primary.id
  };
}
