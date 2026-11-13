// Repair of the model's RESPONSE tool calls, for every provider, streaming or
// not. The request-side policy lives in tool-repair.js; this module composes
// json-repair (syntax), tool-schema (types against the advertised schema) and
// the existing name/hashline normalisation.
//
// Hard truncation law: a call whose arguments were not complete JSON before
// repair, in a response that was cut off (finish_reason "length" or a stream
// that ended without a terminal), is NEVER emitted. Closing the braces of a
// half-written edit or shell command and executing it is how data gets lost.
//
// Zero cost when the request advertised no tools or the response has none.

import { repairJson } from "./json-repair.js";
import { coerce } from "./tool-schema.js";
import { canonicalToolName, isHashlineEditTool, repairEditToolArguments } from "./tool-repair.js";

const FIX_KINDS = ["json_syntax", "truncated_closed", "type_coercion", "enum_snap", "name_alias", "unknown_prop_dropped", "required_default"];
const SYNTAX_FIXES = new Set(["code_fence", "comment", "trailing_comma", "missing_colon", "missing_comma", "unquoted_key", "single_quotes", "python_literal", "leading_text", "trailing_text", "bad_escape", "raw_control_char", "unquoted_value", "json_syntax"]);

const state = {
  since: new Date().toISOString(),
  totals: { calls: 0, repaired: 0, dropped_truncated: 0, unrepairable: 0 },
  by_fix: Object.fromEntries(FIX_KINDS.map((k) => [k, 0])),
  recent: []
};

export function getToolRepairStats() {
  return {
    since: state.since,
    totals: { ...state.totals },
    by_fix: { ...state.by_fix },
    recent: state.recent.slice(-50).reverse()
  };
}

export function resetToolRepairStats() {
  state.since = new Date().toISOString();
  for (const k of Object.keys(state.totals)) state.totals[k] = 0;
  for (const k of FIX_KINDS) state.by_fix[k] = 0;
  state.recent.length = 0;
}

function record(result, slug) {
  state.totals.calls++;
  if (result.status === "repaired") state.totals.repaired++;
  else if (result.status === "dropped_truncated") state.totals.dropped_truncated++;
  else if (result.status === "unrepairable") state.totals.unrepairable++;
  for (const f of result.fixes) if (f in state.by_fix) state.by_fix[f]++;
  if (result.status !== "ok") {
    state.recent.push({ at: new Date().toISOString(), tool: result.tool || "", status: result.status, fixes: result.fixes, slug: slug || "" });
    if (state.recent.length > 200) state.recent.splice(0, state.recent.length - 200);
  }
}

function toolDef(tools, name) {
  for (const t of Array.isArray(tools) ? tools : []) {
    const fn = (t && t.function) || t || {};
    if (fn.name === name) return fn;
  }
  return null;
}

function bucket(fixes) {
  const out = new Set();
  for (const f of fixes) out.add(SYNTAX_FIXES.has(f) ? "json_syntax" : f);
  return [...out];
}

// One call in OpenAI shape ({id, type, function:{name, arguments}}).
// Returns { call|null, status, fixes, tool }. status: ok | repaired |
// dropped_truncated | unrepairable (unrepairable calls pass through untouched
// so the client's own error path can tell the model).
export function repairResponseToolCall(call, tools, { truncated = false } = {}) {
  const fn = call && call.function;
  if (!fn) return { call, status: "ok", fixes: [], tool: "" };
  const fixes = [];
  const originalName = String(fn.name || "");
  const name = canonicalToolName(originalName, tools);
  if (name && name !== originalName) fixes.push("name_alias");

  const rawArgs = fn.arguments == null ? "" : typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
  const emptyArgs = rawArgs.trim() === "";
  let parsedOk = false;
  try { JSON.parse(emptyArgs ? "{}" : rawArgs); parsedOk = true; } catch {}

  // Truncation law, evaluated on the ORIGINAL text.
  if (truncated && !parsedOk) {
    return { call: null, status: "dropped_truncated", fixes: [], tool: name };
  }

  let text = emptyArgs ? "{}" : rawArgs;
  let value;
  if (parsedOk) {
    value = JSON.parse(text);
    if (typeof value === "string") {
      const inner = repairJson(value);
      if (inner.ok && inner.value && typeof inner.value === "object") { value = inner.value; fixes.push("json_syntax"); }
    }
  } else {
    const r = repairJson(rawArgs);
    if (!r.ok) return { call, status: "unrepairable", fixes: [], tool: name };
    value = r.value;
    fixes.push(...bucket(r.fixes));
  }

  const def = toolDef(tools, name);
  if (def && def.parameters && value && typeof value === "object") {
    const c = coerce(value, def.parameters);
    value = c.value;
    fixes.push(...c.fixes);
  }

  let next = JSON.stringify(value);
  if (def && isHashlineEditTool(name, tools)) {
    const healed = repairEditToolArguments(name, next, tools);
    if (healed !== next) { next = healed; fixes.push("json_syntax"); }
  }
  const unique = [...new Set(fixes)];
  const status = unique.length ? "repaired" : "ok";
  return {
    call: { ...call, function: { ...fn, name: name || originalName, arguments: unique.length ? next : (emptyArgs ? "{}" : rawArgs) } },
    status,
    fixes: unique,
    tool: name
  };
}

// Non-stream: repair message.tool_calls in a chat.completion body (string in,
// string out). Untouched text is returned when nothing changed.
export function repairResponseBody(bodyText, tools, slug) {
  if (!Array.isArray(tools) || !tools.length) return { text: bodyText, fixes: [] };
  let obj;
  try { obj = JSON.parse(bodyText); } catch { return { text: bodyText, fixes: [] }; }
  const choices = obj && Array.isArray(obj.choices) ? obj.choices : null;
  if (!choices) return { text: bodyText, fixes: [] };
  const allFixes = new Set();
  let touched = false;
  for (const ch of choices) {
    const msg = ch && ch.message;
    if (!msg || !Array.isArray(msg.tool_calls) || !msg.tool_calls.length) continue;
    const truncated = ch.finish_reason === "length";
    const kept = [];
    for (const call of msg.tool_calls) {
      const r = repairResponseToolCall(call, tools, { truncated });
      record(r, slug);
      if (r.call === null) { touched = true; continue; }
      if (r.status === "repaired") { touched = true; r.fixes.forEach((f) => allFixes.add(f)); }
      kept.push(r.call);
    }
    if (kept.length !== msg.tool_calls.length || touched) {
      if (kept.length) msg.tool_calls = kept;
      else delete msg.tool_calls;
    }
  }
  return touched ? { text: JSON.stringify(obj), fixes: [...allFixes] } : { text: bodyText, fixes: [] };
}

// Stream: collects tool_call deltas and returns the repaired calls once the
// upstream is finished. Text and reasoning deltas are not buffered.
export class StreamToolAssembler {
  constructor(tools, slug) {
    this.tools = tools;
    this.slug = slug;
    this.slots = [];
  }

  static enabledFor(tools) {
    return Array.isArray(tools) && tools.length > 0;
  }

  // Takes a chunk delta's tool_calls array.
  ingest(deltaCalls) {
    for (const tc of deltaCalls) {
      if (!tc) continue;
      const idx = typeof tc.index === "number" ? tc.index : this.slots.length;
      const slot = this.slots[idx] || (this.slots[idx] = { id: null, type: "function", function: { name: "", arguments: "" } });
      if (tc.id) slot.id = tc.id;
      if (tc.function && tc.function.name) slot.function.name += tc.function.name;
      if (tc.function && typeof tc.function.arguments === "string") slot.function.arguments += tc.function.arguments;
    }
  }

  get pending() {
    return this.slots.some(Boolean);
  }

  // Returns { calls: [{index, ...call}], dropped }. Drains every slot collected
  // so far in one shot; a slot ingested after finish_reason is still pending
  // and is flushed by the caller's terminal branch, never re-flushed here.
  finish({ truncated }) {
    const calls = [];
    let dropped = 0;
    const slots = this.slots;
    this.slots = [];
    for (const slot of slots) {
      if (!slot) continue;
      const r = repairResponseToolCall(slot, this.tools, { truncated });
      record(r, this.slug);
      if (r.call === null) { dropped++; continue; }
      calls.push({ index: calls.length, ...r.call });
    }
    return { calls, dropped };
  }
}
