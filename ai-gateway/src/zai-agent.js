// Modern agent shim for chat.z.ai.
//
// chat.z.ai does not accept OpenAI `tools` / system / assistant / tool roles
// on /api/v2/chat/completions. GLM-Free-API (internal/zbridge/agent.go,
// modern variant) folds the conversation into one user prompt and converts
// the model's <<<TOOL_CALL>>> blocks back into native OpenAI tool_calls.
// This file is a JS port of that protocol. Do not forward raw `tools`.

const START_WORD = "TOOL_CALL";
const END_WORD = "END_TOOL_CALL";
const MIN_BRACKETS = 2;
const MAX_BRACKETS = 4;
const WORST_MARKER_LEN = 2 * MAX_BRACKETS + START_WORD.length;
const STREAM_KEEP = WORST_MARKER_LEN + "```json\n".length + 5;
const MARKER_NONE = -1;
const MARKER_INCOMPLETE = -2;
const NAME_KEYS = ["tool", "tool_name", "function", "function_name", "name"];
const ARG_KEYS = ["arguments", "parameters", "args", "params", "input"];
const MAX_RECENT_EXCHANGES = 6;

const SYSTEM_PREFIX = `<system>
You are an agent with access to the tools listed in <tools>. Your output is parsed by a literal scanner — not a human, not an AI: it recognizes ONLY the exact byte strings below. A tool call in any paraphrased, renamed, restyled or fenced form is NOT executed; the user just sees raw text.

TOOL CALL — exactly this shape, nothing before or after, no code fences:
<<<TOOL_CALL>>>
{"name":"<tool_name>","arguments":{<parameter JSON>}}
<<<END_TOOL_CALL>>>
Both markers are literal constants: copy them character for character, never rename or reimagine them. The JSON has exactly two keys — "name" (a tool from <tools>) and "arguments" (that tool's parameter object); no "tool" key, no flat payloads. Discarded forms include <tool_call> tags, TOOL_CALL_BLOCK, any renamed marker, and any block wrapped in a code fence — with those the tool never runs.

FINAL ANSWER — plain text, no markers, only when no tool is needed.

RULES:
- Never narrate an action in words; the block IS the action. Stop right after <<<END_TOOL_CALL>>> and wait for the <tool_result>.
- Never invent results. Never call a tool not listed in <tools>.
- NO REPEATS: never re-issue a call listed in <already_called>; change the call instead. If the last tool result already answers this step, advance to the next step or give the final answer.
- Task fully done → answer in plain text, no block.
</system>`;

const FINAL_REMINDER = `<output_rules>
Respond with exactly ONE of:
1. A tool call — the shape below copied character for character, markers never renamed, no code fences, no other text:
<<<TOOL_CALL>>>
{"name":"<tool_name>","arguments":{...}}
<<<END_TOOL_CALL>>>
The scanner matches only these exact strings; any other form is dropped as plain text and the tool never runs.
2. Plain text, only when no tool applies.
Never re-issue a call listed in <already_called>.
</output_rules>`;

function hasTools(payload) {
  const t = payload && (payload.tools || payload.functions);
  return Array.isArray(t) && t.length > 0;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") parts.push(part.text);
    else if (typeof part.content === "string") parts.push(part.content);
  }
  return parts.join("\n");
}

function fnOf(tool) {
  const fn = (tool && tool.function) || tool || {};
  return {
    name: String(fn.name || tool && tool.name || "").trim(),
    description: String(fn.description || tool && tool.description || ""),
    parameters: fn.parameters != null ? fn.parameters : tool && tool.parameters
  };
}

function indentJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || "");
  }
}

function renderTools(tools) {
  if (!tools.length) return "(no tools provided)";
  const out = [];
  let n = 0;
  for (const tool of tools) {
    const fn = fnOf(tool);
    if (!fn.name) continue;
    n++;
    let block = "### Tool " + n + ": " + fn.name;
    if (fn.description) block += "\nDescription: " + fn.description;
    if (fn.parameters != null && fn.parameters !== "")
      block += "\nParameters JSON Schema:\n" + indentJson(fn.parameters);
    out.push(block);
  }
  return out.join("\n") || "(no tools provided)";
}

function exampleCall(tools) {
  for (const tool of tools) {
    const fn = fnOf(tool);
    if (!fn.name) continue;
    return "Example of a correct tool call (this exact shape, with the arguments filled in):\n<<<TOOL_CALL>>>\n" +
      JSON.stringify({ name: fn.name, arguments: {} }) + "\n<<<END_TOOL_CALL>>>";
  }
  return "";
}

function parseArgs(raw) {
  if (raw == null) return "{}";
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return "{}";
    try {
      const parsed = JSON.parse(t);
      return typeof parsed === "string" ? parseArgs(parsed) : JSON.stringify(parsed);
    } catch {
      return JSON.stringify(raw);
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return "{}";
  }
}

function renderToolCallBlock(call) {
  const fn = (call && call.function) || {};
  if (!fn.name) return "";
  let args = fn.arguments;
  try {
    args = typeof args === "string" ? JSON.parse(args) : args;
  } catch {
    args = {};
  }
  return "<<<TOOL_CALL>>>\n" + JSON.stringify({ name: fn.name, arguments: args == null ? {} : args }) + "\n<<<END_TOOL_CALL>>>";
}

function renderAssistant(m) {
  const blocks = [];
  const text = textOf(m.content);
  if (text) blocks.push(text);
  for (const call of m.tool_calls || []) {
    const block = renderToolCallBlock(call);
    if (block) blocks.push(block);
  }
  return "<assistant>\n" + blocks.join("\n") + "\n</assistant>";
}

function renderUser(m) {
  const text = textOf(m.content);
  return text ? "<user>\n" + text + "\n</user>" : "";
}

function renderSystem(m) {
  const text = textOf(m.content);
  return text ? "<system_message>\n" + text + "\n</system_message>" : "";
}

function renderToolResult(m) {
  const attr = m.tool_call_id ? ' call_id="' + m.tool_call_id + '"' : "";
  return "<tool_result" + attr + ">\n" + textOf(m.content) + "\n</tool_result>";
}

function renderMessage(m) {
  const role = String(m && m.role || "user");
  if (role === "system") return renderSystem(m);
  if (role === "user") return renderUser(m);
  if (role === "assistant") return renderAssistant(m);
  if (role === "tool") return renderToolResult(m);
  const text = textOf(m && m.content);
  return text ? "<user role=" + role + ">\n" + text + "\n</user>" : "";
}

function extractToolExchanges(messages) {
  const exchanges = [];
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role === "assistant" && Array.isArray(messages[i].tool_calls) && messages[i].tool_calls.length) {
      const start = i;
      i++;
      while (i < messages.length && messages[i].role === "tool") i++;
      exchanges.push({ start, end: i });
    } else i++;
  }
  if (exchanges.length <= MAX_RECENT_EXCHANGES) return { old: [], recent: messages };
  const split = exchanges[exchanges.length - MAX_RECENT_EXCHANGES].start;
  const old = [];
  for (const ex of exchanges.slice(0, exchanges.length - MAX_RECENT_EXCHANGES)) {
    const names = (messages[ex.start].tool_calls || []).map((c) => c.function && c.function.name).filter(Boolean);
    let summary = "ok";
    if (ex.end > ex.start + 1) {
      let result = textOf(messages[ex.start + 1].content);
      if (result.length > 80) result = result.slice(0, 77) + "...";
      summary = result || "ok";
    }
    old.push({ toolName: names.join(", ") || "tool", summary });
  }
  return { old, recent: messages.slice(split) };
}

function alreadyCalled(messages) {
  const lines = [];
  const seen = new Set();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const call of m.tool_calls || []) {
      const name = call.function && call.function.name;
      if (!name) continue;
      const args = parseArgs(call.function.arguments);
      const key = name + "\n" + args;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push("- " + name + " " + args);
    }
  }
  if (!lines.length) return "";
  return "<already_called>\nCalls already made in this conversation (do NOT re-issue any of them):\n" + lines.join("\n") + "\n</already_called>";
}

function renderRecent(messages) {
  let out = "";
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    let isLastUser = false;
    if (m.role === "user") {
      isLastUser = true;
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].role === "user") { isLastUser = false; break; }
      }
    }
    if (isLastUser) { i++; continue; }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out += "<tool_exchange>\n" + renderAssistant(m) + "\n";
      i++;
      while (i < messages.length && messages[i].role === "tool") {
        out += renderToolResult(messages[i]) + "\n";
        i++;
      }
      out += "</tool_exchange>\n";
      continue;
    }
    const rendered = renderMessage(m);
    if (rendered) out += rendered + "\n";
    i++;
  }
  return out;
}

export function buildAgentPrompt(messages, tools) {
  const msgs = Array.isArray(messages) ? messages : [];
  const toolList = Array.isArray(tools) ? tools : [];
  let out = SYSTEM_PREFIX + "\n\n<tools>\n" + renderTools(toolList) + "\n</tools>\n\n";
  const example = exampleCall(toolList);
  if (example) out += example + "\n\n";
  const { old, recent } = extractToolExchanges(msgs);
  if (old.length) {
    out += "<history_summary>\nPreviously completed tool calls:\n";
    old.forEach((ex, i) => { out += (i + 1) + ". " + ex.toolName + " → " + ex.summary + "\n"; });
    out += "</history_summary>\n\n";
  }
  if (recent.length) out += "<recent>\n" + renderRecent(recent) + "</recent>\n\n";
  const already = alreadyCalled(msgs);
  if (already) out += already + "\n\n";
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === "user") {
      const text = textOf(msgs[i].content);
      if (text) out += "<current_task>\n" + text + "\n</current_task>\n\n";
      break;
    }
  }
  return out + FINAL_REMINDER;
}

export function applyAgentShim(payload) {
  if (!hasTools(payload)) return { active: false, payload, prompt: "" };
  const tools = payload.tools || payload.functions || [];
  const prompt = buildAgentPrompt(payload.messages || [], tools);
  return {
    active: true,
    prompt,
    payload: {
      ...payload,
      messages: [{ role: "user", content: prompt }],
      tools: undefined,
      functions: undefined,
      tool_choice: undefined
    }
  };
}

function bracketRunBack(s, i, ch) {
  let n = 0;
  while (i - n - 1 >= 0 && s[i - n - 1] === ch) n++;
  return n;
}

function bracketRunForward(s, ch) {
  let n = 0;
  while (n < s.length && s[n] === ch) n++;
  return n;
}

function findAgentMarker(s, word, final) {
  let from = 0;
  for (;;) {
    const j = s.indexOf(word, from);
    if (j < 0) return [MARKER_NONE, 0];
    const lead = bracketRunBack(s, j, "<");
    if (lead < MIN_BRACKETS || lead > MAX_BRACKETS) {
      from = j + word.length;
      continue;
    }
    const after = s.slice(j + word.length);
    const trail = bracketRunForward(after, ">");
    if (trail > MAX_BRACKETS) {
      from = j + word.length;
      continue;
    }
    if (trail === after.length && !final) return [MARKER_INCOMPLETE, 0];
    if (trail >= MIN_BRACKETS) return [j - lead, lead + word.length + trail];
    from = j + word.length;
  }
}

function findAgentSpans(text) {
  const spans = [];
  let pos = 0;
  for (;;) {
    const [s, slen] = findAgentMarker(text.slice(pos), START_WORD, true);
    if (s < 0) return spans;
    const bodyStart = pos + s + slen;
    const [e, elen] = findAgentMarker(text.slice(bodyStart), END_WORD, true);
    if (e < 0) return spans;
    spans.push({ start: pos + s, bodyStart, bodyEnd: bodyStart + e, end: bodyStart + e + elen });
    pos = bodyStart + e + elen;
  }
}

function extractCall(obj) {
  let name = "";
  let nameKey = "";
  for (const k of NAME_KEYS) {
    if (typeof obj[k] === "string" && obj[k].trim()) {
      name = obj[k].trim();
      nameKey = k;
      break;
    }
  }
  if (!nameKey) return null;
  for (const k of ARG_KEYS) {
    if (obj[k] != null) {
      const args = typeof obj[k] === "string" ? obj[k] : JSON.stringify(obj[k]);
      return { name, args };
    }
  }
  const rest = {};
  for (const [k, v] of Object.entries(obj)) if (k !== nameKey) rest[k] = v;
  return { name, args: JSON.stringify(Object.keys(rest).length ? rest : {}) };
}

function looseParse(body) {
  let raw = String(body || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    const call = extractCall(obj);
    if (!call || !call.name) return null;
    return { name: call.name, arguments: parseArgs(call.args) };
  } catch {
    return null;
  }
}

function randomCallId() {
  return "call_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export function parseAgentToolCalls(text) {
  const spans = findAgentSpans(String(text || ""));
  const calls = [];
  for (const span of spans) {
    const parsed = looseParse(text.slice(span.bodyStart, span.bodyEnd));
    if (!parsed) continue;
    let args = parsed.arguments;
    if (String(parsed.name).toLowerCase().includes("edit") || String(parsed.name).toLowerCase() === "hashline") {
      let trimmed = typeof args === "string" ? args.trim() : JSON.stringify(args);
      if (trimmed.startsWith("[") && trimmed.includes("#")) {
        args = JSON.stringify({ input: trimmed });
      }
    }
    calls.push({
      id: randomCallId(),
      type: "function",
      function: { name: parsed.name, arguments: args }
    });
  }
  return calls;
}

export function stripAgentToolCalls(text) {
  const src = String(text || "");
  const spans = findAgentSpans(src);
  if (!spans.length) return src.trim();
  let kept = "";
  let prev = 0;
  for (const span of spans) {
    kept += src.slice(prev, span.start);
    prev = span.end;
  }
  kept += src.slice(prev);
  return kept.trim();
}

function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function skipLeadingFence(s) {
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  if (!s.startsWith("```", i)) return 0;
  let j = i + 3;
  if (s.startsWith("json", j)) j += 4;
  while (j < s.length && (s[j] === " " || s[j] === "\t")) j++;
  if (j < s.length && s[j] !== "\n" && s[j] !== "\r") return 0;
  if (j < s.length && s[j] === "\r") j++;
  if (j < s.length && s[j] === "\n") j++;
  return j;
}

function jsonStringValueAt(s, pos) {
  while (pos < s.length && isSpace(s[pos])) pos++;
  if (s[pos] !== ":") return null;
  pos++;
  while (pos < s.length && isSpace(s[pos])) pos++;
  if (s[pos] !== '"') return null;
  pos++;
  let start = pos;
  while (pos < s.length) {
    if (s[pos] === "\\") { pos += 2; continue; }
    if (s[pos] === '"') return s.slice(start, pos);
    pos++;
  }
  return null;
}

function streamExtractName(body) {
  let searchEnd = body.length;
  for (const k of ARG_KEYS) {
    const i = body.indexOf('"' + k + '"');
    if (i >= 0 && i < searchEnd) searchEnd = i;
  }
  const region = body.slice(0, searchEnd);
  for (const k of NAME_KEYS) {
    const keyIdx = region.indexOf('"' + k + '"');
    if (keyIdx < 0) continue;
    const v = jsonStringValueAt(region, keyIdx + k.length + 2);
    if (v) return v;
  }
  return "";
}

function streamFindArgs(body) {
  for (const k of ARG_KEYS) {
    const keyIdx = body.indexOf('"' + k + '"');
    if (keyIdx < 0) continue;
    let pos = keyIdx + k.length + 2;
    while (pos < body.length && isSpace(body[pos])) pos++;
    if (pos >= body.length) return { state: "pending" };
    if (body[pos] !== ":") return { state: "nonobject" };
    pos++;
    while (pos < body.length && isSpace(body[pos])) pos++;
    if (pos >= body.length) return { state: "pending" };
    if (body[pos] !== "{") return { state: "nonobject" };
    return { state: "object", pos };
  }
  return { state: "pending" };
}

function endMarkerPrefix(s) {
  const L = bracketRunForward(s, "<");
  if (L > MAX_BRACKETS) return { state: "no" };
  const rest = s.slice(L);
  let k = 0;
  while (k < rest.length && k < END_WORD.length && rest[k] === END_WORD[k]) k++;
  if (k === 0) return { state: rest.length === 0 ? "maybe" : "no" };
  if (L < MIN_BRACKETS) return { state: "no" };
  if (k < END_WORD.length) return { state: k === rest.length ? "maybe" : "no" };
  const after = rest.slice(END_WORD.length);
  const trail = bracketRunForward(after, ">");
  if (trail > MAX_BRACKETS) return { state: "no" };
  if (trail < MIN_BRACKETS && trail === after.length) return { state: "maybe" };
  if (trail < MIN_BRACKETS) return { state: "no" };
  return { state: "complete", len: L + END_WORD.length + trail };
}

function runeSafeCut(s) {
  let n = s.length;
  while (n > 0 && n > s.length - 3) {
    try {
      const slice = s.slice(0, n);
      if (!/[\uD800-\uDBFF]$/.test(slice)) return n;
    } catch {}
    n--;
  }
  return n;
}

export class AgentStreamInterceptor {
  constructor() {
    this.buffer = "";
    this.offset = 0;
    this.callIndex = 0;
    this.pendingSep = false;
    this.inCall = false;
    this.tcBlockStart = 0;
    this.tcName = "";
    this.tcNameFound = false;
    this.tcArgsFound = false;
    this.tcArgsPos = 0;
    this.tcArgsStreamed = 0;
    this.tcBraceDepth = 0;
    this.tcInString = false;
    this.tcEscapeNext = false;
    this.tcArgsDone = false;
    this.tcFallback = false;
  }

  feed(chunk) {
    this.buffer += chunk;
    return this.drain(false);
  }

  finish() {
    return this.drain(true);
  }

  finishCall() {
    this.inCall = false;
    this.pendingSep = true;
    this.tcName = "";
    this.tcNameFound = false;
    this.tcArgsFound = false;
    this.tcArgsPos = 0;
    this.tcArgsStreamed = 0;
    this.tcBraceDepth = 0;
    this.tcInString = false;
    this.tcEscapeNext = false;
    this.tcArgsDone = false;
    this.tcFallback = false;
  }

  emitArgs(argsText, emitEnd, headerIdx, toolCalls) {
    if (emitEnd <= this.tcArgsStreamed) return;
    const frag = argsText.slice(this.tcArgsStreamed, emitEnd);
    this.tcArgsStreamed = emitEnd;
    if (headerIdx >= 0) {
      toolCalls[headerIdx].function.arguments = frag;
      return;
    }
    toolCalls.push({ index: this.callIndex, function: { arguments: frag } });
  }

  drain(final) {
    const content = [];
    const toolCalls = [];
    for (;;) {
      if (this.pendingSep) {
        for (;;) {
          while (this.offset < this.buffer.length && isSpace(this.buffer[this.offset])) this.offset++;
          const n = skipLeadingFence(this.buffer.slice(this.offset));
          if (!n) break;
          this.offset += n;
        }
        this.pendingSep = false;
      }
      if (this.inCall) {
        if (!this.drainToolCall(final, content, toolCalls)) break;
        continue;
      }
      const rest = this.buffer.slice(this.offset);
      const [start, markerLen] = findAgentMarker(rest, START_WORD, final);
      if (start < 0) {
        if (final) {
          if (rest) { content.push(rest); this.offset = this.buffer.length; }
          break;
        }
        const keep = STREAM_KEEP;
        if (rest.length > keep) {
          let cut = rest.length - keep;
          while (cut > 0 && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
          if (cut > 0) { content.push(rest.slice(0, cut)); this.offset += cut; }
        }
        break;
      }
      if (start > 0) {
        const piece = rest.slice(0, start).replace(/(?:\r?\n)[ \t]*```(?:json)?[ \t]*$/i, "");
        if (piece) content.push(piece);
        this.offset += start;
      }
      this.inCall = true;
      this.tcBlockStart = this.offset;
      this.offset += markerLen;
    }
    return { content: content.join(""), toolCalls };
  }

  drainToolCall(final, content, toolCalls) {
    let headerIdx = -1;
    for (;;) {
      const body = this.buffer.slice(this.offset);
      if (this.tcFallback) {
        const [idx, markerLen] = findAgentMarker(body, END_WORD, final);
        if (idx < 0) {
          if (!final) return false;
          this.offset = this.buffer.length;
          this.finishCall();
          return true;
        }
        const end = this.offset + idx;
        const parsed = looseParse(this.buffer.slice(this.offset, end));
        if (parsed) {
          toolCalls.push({
            index: this.callIndex,
            id: randomCallId(),
            type: "function",
            function: { name: parsed.name, arguments: parsed.arguments }
          });
          this.callIndex++;
        } else {
          content.push(this.buffer.slice(this.tcBlockStart, end + markerLen));
        }
        this.offset = end + markerLen;
        this.finishCall();
        return true;
      }
      if (!this.tcNameFound) {
        const name = streamExtractName(body);
        if (name) {
          this.tcName = name;
          this.tcNameFound = true;
        } else {
          const [idx] = findAgentMarker(body, END_WORD, final);
          if (idx >= 0 || final) { this.tcFallback = true; continue; }
          return false;
        }
      }
      if (!this.tcArgsFound) {
        const found = streamFindArgs(body);
        if (found.state === "object") {
          this.tcArgsFound = true;
          this.tcArgsPos = this.offset + found.pos;
          toolCalls.push({
            index: this.callIndex,
            id: randomCallId(),
            type: "function",
            function: { name: this.tcName, arguments: "" }
          });
          headerIdx = toolCalls.length - 1;
        } else if (found.state === "nonobject") {
          this.tcFallback = true;
          continue;
        } else {
          const [idx] = findAgentMarker(body, END_WORD, final);
          if (idx >= 0 || final) { this.tcFallback = true; continue; }
          return false;
        }
      }
      if (!this.tcArgsDone) {
        const argsText = this.buffer.slice(this.tcArgsPos);
        let i = this.tcArgsStreamed;
        let truncatedAt = -1;
        let truncatedLen = 0;
        scan: while (i < argsText.length) {
          const c = argsText[i];
          if (this.tcEscapeNext) { this.tcEscapeNext = false; i++; continue; }
          if (c === "\\") { this.tcEscapeNext = true; i++; continue; }
          if (c === '"') { this.tcInString = !this.tcInString; i++; continue; }
          if (!this.tcInString) {
            if (c === "<") {
              const pref = endMarkerPrefix(argsText.slice(i));
              if (pref.state === "complete") { truncatedAt = i; truncatedLen = pref.len; break scan; }
              if (pref.state === "maybe" && !final) {
                this.emitArgs(argsText, i, headerIdx, toolCalls);
                return false;
              }
              i++;
              continue;
            }
            if (c === "{") this.tcBraceDepth++;
            else if (c === "}") {
              this.tcBraceDepth--;
              if (this.tcBraceDepth === 0) { i++; this.tcArgsDone = true; break scan; }
            }
          }
          i++;
        }
        let emitEnd = i;
        if (!this.tcArgsDone && truncatedAt < 0) emitEnd = runeSafeCut(argsText.slice(0, i));
        if (truncatedAt >= 0) emitEnd = truncatedAt;
        this.emitArgs(argsText, emitEnd, headerIdx, toolCalls);
        if (this.tcArgsDone) this.offset = this.tcArgsPos + this.tcArgsStreamed;
        else if (truncatedAt >= 0) {
          this.offset = this.tcArgsPos + truncatedAt + truncatedLen;
          this.callIndex++;
          this.finishCall();
          return true;
        } else return false;
      }
      const rest = this.buffer.slice(this.offset);
      const [idx, markerLen] = findAgentMarker(rest, END_WORD, final);
      if (idx < 0) {
        if (final) {
          this.offset = this.buffer.length;
          this.callIndex++;
          this.finishCall();
          return true;
        }
        return false;
      }
      this.offset += idx + markerLen;
      this.callIndex++;
      this.finishCall();
      return true;
    }
  }
}

export { hasTools };
