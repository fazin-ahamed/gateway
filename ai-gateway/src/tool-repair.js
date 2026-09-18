// Provider-agnostic Tool Repair Layer.
//
// This module never executes tools. It normalizes model-emitted calls against
// the caller's advertised schemas and generates response-adaptive guidance.
// Hashline behavior is enabled only when the client actually exposes a
// hash-anchored read/edit tool; hashes are never invented by the gateway.

const PATH_ALIASES = ["filePath", "file_path", "path", "file", "filename"];
const ANCHOR_ALIASES = ["lineHashes", "line_hashes", "hashes", "anchors", "lineHash", "line_hash"];
const CONTENT_ALIASES = ["content", "text", "newText", "new_text", "replacement", "replaceWith", "patch", "diff"];
const AFTER_ALIASES = ["insertAfter", "insert_after", "after"];
const START_ALIASES = ["startLine", "start_line", "lineStart", "line_start"];
const END_ALIASES = ["endLine", "end_line", "lineEnd", "line_end"];

function norm(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fnOf(tool) {
  const fn = (tool && tool.function) || tool || {};
  return {
    name: String(fn.name || tool && tool.name || "").trim(),
    description: String(fn.description || tool && tool.description || ""),
    parameters: fn.parameters != null ? fn.parameters : tool && tool.parameters
  };
}

function defsOf(tools) {
  return (Array.isArray(tools) ? tools : []).map(fnOf).filter((fn) => fn.name);
}

function propsOf(fn) {
  const p = fn && fn.parameters;
  return p && typeof p === "object" && p.properties && typeof p.properties === "object" ? p.properties : {};
}

function kindOf(fn) {
  const name = norm(fn && fn.name);
  const desc = String(fn && fn.description || "").toLowerCase();
  const keys = Object.keys(propsOf(fn));
  const hashish = name.includes("hashline") || keys.includes("lineHashes") ||
    /content[- ]hash|line[- ]hash|hash[- ]anchor/.test(desc);
  const readish = /(read|view|inspect|cat|getfile)/.test(name) || /read.*file|file.*read/.test(desc);
  const editish = /(edit|patch|replace|modify)/.test(name) || /edit.*file|patch.*file/.test(desc);
  const createish = /(write|create|newfile)/.test(name);
  if (hashish && editish) return "hashline_edit";
  if (hashish && readish) return "hashline_read";
  if (editish) return "edit";
  if (readish) return "read";
  if (createish) return "create";
  return "other";
}

export function inspectToolSurface(tools) {
  const defs = defsOf(tools);
  return {
    defs,
    hashRead: defs.find((fn) => kindOf(fn) === "hashline_read") || null,
    hashEdit: defs.find((fn) => kindOf(fn) === "hashline_edit") || null,
    reads: defs.filter((fn) => kindOf(fn) === "read" || kindOf(fn) === "hashline_read"),
    edits: defs.filter((fn) => kindOf(fn) === "edit" || kindOf(fn) === "hashline_edit"),
    creates: defs.filter((fn) => kindOf(fn) === "create")
  };
}

export function canonicalToolName(name, tools) {
  const raw = String(name || "").trim();
  if (!raw || !Array.isArray(tools) || !tools.length) return raw;
  const defs = defsOf(tools);
  const exact = defs.find((fn) => fn.name === raw);
  if (exact) return exact.name;
  const want = norm(raw);
  const matches = defs.filter((fn) => norm(fn.name) === want);
  return matches.length === 1 ? matches[0].name : raw;
}

function parseArgs(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return { ...raw };
  if (typeof raw !== "string") return {};
  const t = raw.trim();
  if (!t) return {};
  try {
    const v = JSON.parse(t);
    if (typeof v === "string") return parseArgs(v);
    return v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {};
  } catch {
    return null;
  }
}

function targetProp(props, aliases) {
  for (const k of aliases) if (Object.prototype.hasOwnProperty.call(props, k)) return k;
  return null;
}

function moveAlias(args, props, aliases) {
  const target = targetProp(props, aliases);
  if (!target || args[target] !== undefined) return;
  for (const source of aliases) {
    if (source === target || args[source] === undefined) continue;
    args[target] = args[source];
    if (!Object.prototype.hasOwnProperty.call(props, source)) delete args[source];
    return;
  }
}

function normalizeArgs(fn, raw) {
  const args = parseArgs(raw);
  if (!args) return null;
  const props = propsOf(fn);
  if (!Object.keys(props).length) return args;
  moveAlias(args, props, PATH_ALIASES);
  moveAlias(args, props, ANCHOR_ALIASES);
  moveAlias(args, props, CONTENT_ALIASES);
  moveAlias(args, props, AFTER_ALIASES);
  moveAlias(args, props, START_ALIASES);
  moveAlias(args, props, END_ALIASES);
  if (fn.parameters && fn.parameters.additionalProperties === false) {
    for (const k of Object.keys(args)) if (!Object.prototype.hasOwnProperty.call(props, k)) delete args[k];
  }
  return args;
}

export function repairToolCall(call, tools) {
  if (!call) return call;
  const input = call.function || call;
  const name = canonicalToolName(input.name, tools);
  const def = defsOf(tools).find((fn) => fn.name === name) || null;
  const fixed = def ? normalizeArgs(def, input.arguments) : parseArgs(input.arguments);
  const argumentsText = fixed == null
    ? String(input.arguments == null ? "{}" : input.arguments)
    : JSON.stringify(fixed);
  if (call.function) {
    return { ...call, function: { ...call.function, name: name || call.function.name, arguments: argumentsText } };
  }
  return { ...call, name: name || call.name, arguments: argumentsText };
}

export function isHashlineEditTool(name, tools) {
  const canonical = canonicalToolName(name, tools);
  const fn = defsOf(tools).find((d) => d.name === canonical);
  return !!fn && kindOf(fn) === "hashline_edit";
}

export function isRepeatSafeTool(name, tools) {
  const canonical = canonicalToolName(name, tools);
  const fn = defsOf(tools).find((d) => d.name === canonical);
  const kind = fn ? kindOf(fn) : "other";
  return kind === "read" || kind === "hashline_read";
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((p) => p && (p.text || p.content) || "").filter(Boolean).join("\n");
}

export function classifyToolResult(content) {
  const s = textOf(content).toLowerCase();
  if (!s.trim()) return "empty";
  if (/stale|hash mismatch|anchor mismatch|content changed|file changed|outdated anchor|stale read/.test(s)) return "stale_anchor";
  if (/invalid (?:argument|args|parameter)|schema|missing required|required field|validation error|bad request/.test(s)) return "invalid_args";
  if (/not found|no such file|does not exist|unknown path|unknown tool/.test(s)) return "not_found";
  if (/conflict|overlap|cannot apply|patch failed|context mismatch/.test(s)) return "conflict";
  if (/permission denied|forbidden|read-only|not allowed|unauthorized/.test(s)) return "permission";
  if (/error|failed|exception|timed out|timeout/.test(s)) return "error";
  return "success";
}

function callsById(messages) {
  const out = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== "assistant") continue;
    for (const call of m.tool_calls || []) if (call && call.id) out.set(call.id, call);
  }
  return out;
}

export function collectToolFeedback(messages) {
  const calls = callsById(messages);
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== "tool") continue;
    const call = calls.get(m.tool_call_id) || null;
    const text = textOf(m.content);
    out.push({
      callId: m.tool_call_id || "",
      toolName: call && call.function && call.function.name || "",
      kind: classifyToolResult(text),
      text: text.slice(0, 500)
    });
  }
  return out;
}

function recovery(item, surface) {
  const n = item.toolName || "tool";
  if (item.kind === "stale_anchor")
    return "- " + n + " reported stale/hash-mismatched state. " +
      (surface.hashRead ? "Re-read the affected region with " + surface.hashRead.name + ", copy NEW line:hash anchors, then rebuild the edit." : "Re-read current file state before retrying; do not reuse stale coordinates.");
  if (item.kind === "invalid_args") return "- " + n + " rejected its arguments. Rebuild from the exact advertised JSON schema; do not replay the same payload.";
  if (item.kind === "not_found") return "- " + n + " could not find its target. Verify/search/read the target before the next action.";
  if (item.kind === "conflict") return "- " + n + " hit an edit conflict. Re-read and re-anchor/recompute instead of replaying the patch.";
  if (item.kind === "permission") return "- " + n + " was denied. Do not keep retrying the same operation; choose an allowed path or report the blocker.";
  if (item.kind === "error") return "- " + n + " failed. Treat the tool_result as new state and materially change the next call.";
  return "";
}

export function buildToolRepairPolicy(messages, tools) {
  const surface = inspectToolSurface(tools);
  const lines = [];
  if (surface.hashEdit) {
    lines.push("<tool_repair_policy mode=\"hashline\">");
    lines.push("EDIT SAFETY:");
    if (surface.hashRead) {
      lines.push("- For existing files, use " + surface.hashRead.name + " before " + surface.hashEdit.name + ".");
      lines.push("- Copy line:hash anchors from the MOST RECENT read result. Never invent hashes; never reuse anchors after that file changes.");
    } else {
      lines.push("- Use only hash anchors present in recent tool output/context; never invent hashes.");
    }
    lines.push("- Prefer hash-anchored replace/insert/delete over fragile line numbers or guessed string replacement.");
    lines.push("- On stale/hash mismatch/conflict: re-read only the affected region, obtain fresh anchors, rebuild the edit, then retry.");
    lines.push("- Batch independent non-overlapping edits when supported. Verify with a read/test after mutation.");
    if (surface.edits.some((fn) => fn.name !== surface.hashEdit.name))
      lines.push("- When both ordinary and hashline edit tools exist, prefer " + surface.hashEdit.name + " for existing-file changes.");
    lines.push("</tool_repair_policy>");
  } else if (surface.edits.length) {
    lines.push("<tool_repair_policy mode=\"native\">");
    lines.push("- No real hashline edit tool is advertised, so do NOT fabricate hash anchors.");
    lines.push("- Read current context before editing; on mismatch/conflict, re-read and recompute instead of replaying stale text/coordinates.");
    lines.push("- Follow the exact advertised edit schema and verify after mutation.");
    lines.push("</tool_repair_policy>");
  }
  const fb = collectToolFeedback(messages).map((x) => recovery(x, surface)).filter(Boolean);
  if (fb.length) {
    lines.push("<tool_feedback>");
    lines.push("Tool results below are live state. Adapt the next action:");
    lines.push(...fb.slice(-6));
    lines.push("</tool_feedback>");
  }
  return lines.join("\n");
}

export function applyToolRepairPolicyToPayload(payload) {
  if (!payload || !Array.isArray(payload.messages)) return payload;
  const tools = payload.tools || payload.functions || [];
  const policy = buildToolRepairPolicy(payload.messages, tools);
  if (!policy) return payload;
  const marker = "<gateway_tool_repair>";
  const guidance = marker + "\n" + policy + "\n</gateway_tool_repair>";
  const messages = payload.messages.slice();
  const existing = messages.findIndex((m) => m && (m.role === "developer" || m.role === "system") && typeof m.content === "string" && m.content.includes(marker));
  if (existing >= 0) messages[existing] = { ...messages[existing], content: guidance };
  else messages.unshift({ role: "system", content: guidance });
  return { ...payload, messages };
}
