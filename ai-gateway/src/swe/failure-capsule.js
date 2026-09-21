// Failure Capsule — the compact handoff a stalled attempt leaves behind.
//
// HORIZON-Omega DeepSWE: when a turn ends without verified success, the next
// attempt must inherit the goal, the hypothesis, the files already touched,
// the tests already run, the exact failure, what was ruled out, and what is
// still unknown. Not the chain of thought, not the transcript.
//
// Pure data. No filesystem, no network, no model call, and no import from
// the gateway serving path. The caller decides where a capsule is stored.

const MAX_ITEMS = 12;
const MAX_TEXT = 280;

const FIELDS = [
  "goal",
  "hypothesis",
  "filesInspected",
  "filesChanged",
  "tests",
  "failure",
  "ruledOut",
  "unknowns"
];

const LIST_FIELDS = ["filesInspected", "filesChanged", "tests", "ruledOut", "unknowns"];

function clip(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= MAX_TEXT)
    return value;
  return value.slice(0, MAX_TEXT - 1).trimEnd() + "…";
}

function items(value) {
  const list = Array.isArray(value) ? value : (value == null || value === "" ? [] : [value]);
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const text = clip(entry);
    if (!text || seen.has(text))
      continue;
    seen.add(text);
    out.push(text);
    if (out.length === MAX_ITEMS)
      break;
  }
  return out;
}

// openCapsule(input): a fresh capsule. Missing fields become empty, never
// invented. Text is clipped and list entries are deduped so a capsule cannot
// grow into a transcript. A sealed status (verified/failed) is carried
// through: render and note must not silently reopen a frozen handoff.
const SEALED_STATUS = ["verified", "failed"];

export function openCapsule(input = {}) {
  const capsule = {
    status: SEALED_STATUS.includes(input.status) ? input.status : "open"
  };
  for (const field of FIELDS)
    capsule[field] = LIST_FIELDS.includes(field) ? items(input[field]) : clip(input[field]);
  return capsule;
}

// noteCapsule(capsule, patch): append observations. List fields grow (still
// bounded and deduped); text fields are replaced only when the patch carries
// a non-empty value, so a partial note cannot blank the goal.
export function noteCapsule(capsule, patch = {}) {
  const next = openCapsule(capsule);
  for (const field of FIELDS) {
    if (patch[field] == null || patch[field] === "")
      continue;
    next[field] = LIST_FIELDS.includes(field)
      ? items([...next[field], ...items(patch[field])])
      : clip(patch[field]);
  }
  return next;
}

// sealCapsule(capsule, outcome): freeze the handoff. "verified" is the only
// outcome that marks the attempt done; anything else stays a failure the
// next attempt must read. Sealing drops nothing — it only sets the status.
export function sealCapsule(capsule, outcome = "failed") {
  const next = openCapsule(capsule);
  next.status = outcome === "verified" ? "verified" : "failed";
  return next;
}

// renderCapsule(capsule): the text form handed to the next attempt. One
// section per field, empty sections omitted, hard-capped so it cannot
// balloon into the prior turn's reasoning.
export function renderCapsule(capsule) {
  const source = openCapsule(capsule);
  const lines = [`status: ${source.status}`];
  const write = (label, value) => {
    if (Array.isArray(value)) {
      if (value.length === 0)
        return;
      lines.push(`${label}:`);
      for (const entry of value)
        lines.push(`- ${entry}`);
      return;
    }
    if (value)
      lines.push(`${label}: ${value}`);
  };
  write("goal", source.goal);
  write("hypothesis", source.hypothesis);
  write("files inspected", source.filesInspected);
  write("files changed", source.filesChanged);
  write("tests", source.tests);
  write("failure", source.failure);
  write("ruled out", source.ruledOut);
  write("unknowns", source.unknowns);
  return lines.join("\n");
}

export const CAPSULE_LIMITS = Object.freeze({ maxItems: MAX_ITEMS, maxText: MAX_TEXT });
