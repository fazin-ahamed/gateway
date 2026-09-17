// Stateful normalizer for chat.z.ai's edit-based SSE protocol.
//
// Z.AI does not always stream append-only deltas. `edit_content` rewrites the
// accumulated snapshot from a JavaScript UTF-16 code-unit offset. OpenAI SSE
// clients cannot retract bytes already emitted, so live streams keep a small
// tail pending and only emit stable prefixes. The implementation mirrors the
// browser semantics while keeping all text operations Unicode-safe.

const DEFAULT_HOLDBACK = 24;

function clampUtf16Index(value, index) {
  let i = Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : 0;
  i = Math.max(0, Math.min(String(value).length, i));
  if (i > 0 && i < String(value).length) {
    const prev = String(value).charCodeAt(i - 1);
    const next = String(value).charCodeAt(i);
    // Never split a UTF-16 surrogate pair. The official browser uses JS
    // substring indexing; clamping to the rune start prevents malformed UTF-8
    // when the rewritten snapshot is later encoded for SSE.
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
      i--;
  }
  return i;
}

export function applyUtf16Edit(current, editIndex, replacement) {
  const text = String(current || "");
  const i = clampUtf16Index(text, editIndex);
  return text.slice(0, i) + String(replacement || "");
}

function commonPrefixUtf16(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  let i = 0;
  const max = Math.min(left.length, right.length);
  while (i < max && left.charCodeAt(i) === right.charCodeAt(i)) i++;
  if (i > 0 && i < left.length) {
    const prev = left.charCodeAt(i - 1);
    const next = left.charCodeAt(i);
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
      i--;
  }
  return i;
}

function holdBackTail(value, count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (!n) return String(value || "");
  const chars = Array.from(String(value || ""));
  if (chars.length <= n) return "";
  return chars.slice(0, chars.length - n).join("");
}

function holdBackPartialDetailsTag(value) {
  const s = String(value || "");
  const i = s.lastIndexOf("<");
  if (i < 0) return s;
  const suffix = s.slice(i);
  if (suffix.length <= "<details".length && "<details".startsWith(suffix))
    return s.slice(0, i);
  if (suffix.length < "</details>".length && "</details>".startsWith(suffix))
    return s.slice(0, i);
  return s;
}

function holdBackPartialQuoteMarker(value) {
  const s = String(value || "");
  if (!s.endsWith(">")) return s;
  const body = s.slice(0, -1);
  if (!body || body.endsWith("\n")) return body;
  return s;
}

function stripReasoning(value) {
  const lines = String(value || "").split("\n").map((line) => line.startsWith("> ") ? line.slice(2) : line);
  return lines.join("\n").trim();
}

export function splitDetails(value) {
  const raw = String(value || "");
  let rest = raw;
  let reasoning = "";
  let content = "";
  for (;;) {
    const idx = rest.indexOf("<details");
    if (idx < 0)
      return { reasoning, content: content + rest, open: false };
    content += rest.slice(0, idx);
    const relativeEnd = rest.slice(idx).indexOf(">");
    if (relativeEnd < 0)
      return { reasoning, content, open: true };
    const afterTag = rest.slice(idx + relativeEnd + 1);
    const close = afterTag.indexOf("</details>");
    if (close < 0)
      return { reasoning: reasoning + afterTag, content, open: true };
    reasoning += afterTag.slice(0, close);
    rest = afterTag.slice(close + "</details>".length);
  }
}

class AppendOnlyEmitter {
  constructor() {
    this.clientView = "";
  }

  delta(target) {
    const next = String(target || "");
    if (next === this.clientView) return "";
    if (next.startsWith(this.clientView)) {
      const out = next.slice(this.clientView.length);
      this.clientView = next;
      return out;
    }
    const cp = commonPrefixUtf16(this.clientView, next);
    if (cp === next.length)
      return ""; // upstream rewound text the client has already received
    const out = next.slice(cp);
    this.clientView = next;
    return out;
  }
}

function frameError(frame, data) {
  const raw = frame?.error ?? data?.error;
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  return String(raw.message || raw.detail || raw.msg || "upstream stream error");
}

function applySnapshot(current, data) {
  if (!data || typeof data !== "object") return { value: current, changed: false };
  if (typeof data.edit_content === "string") {
    const index = data.edit_index == null ? 0 : Number(data.edit_index);
    return { value: applyUtf16Edit(current, index, data.edit_content), changed: true };
  }
  if (typeof data.content === "string")
    return { value: data.content, changed: true };
  if (typeof data.delta_content === "string")
    return { value: current + data.delta_content, changed: true };
  return { value: current, changed: false };
}

export function createZaiFrameNormalizer(options = {}) {
  const holdback = options.holdback == null ? DEFAULT_HOLDBACK : Math.max(0, Math.trunc(Number(options.holdback) || 0));
  let fullText = "";
  let phaseReasoning = "";
  let terminal = false;
  let sawDetails = false;
  const contentEmitter = new AppendOnlyEmitter();
  const reasoningEmitter = new AppendOnlyEmitter();

  const flushPhaseReasoning = (final) => {
    if (!phaseReasoning) return [];
    let target = phaseReasoning;
    if (!final) target = holdBackPartialQuoteMarker(holdBackTail(target, holdback));
    const delta = reasoningEmitter.delta(target);
    return delta ? [{ content: "", reasoning: delta, done: false }] : [];
  };

  const flushSnapshot = (final) => {
    const events = [];
    const parts = splitDetails(fullText);
    let reasoning = stripReasoning(parts.reasoning);
    let content = parts.content;

    if (!final && parts.open) {
      reasoning = holdBackTail(reasoning, holdback);
      reasoning = holdBackPartialDetailsTag(reasoning);
      reasoning = holdBackPartialQuoteMarker(reasoning);
    }
    const reasoningDelta = reasoningEmitter.delta(reasoning);
    if (reasoningDelta)
      events.push({ content: "", reasoning: reasoningDelta, done: false });

    if (!final) {
      content = holdBackTail(content, holdback);
      content = holdBackPartialDetailsTag(content);
    }
    const contentDelta = contentEmitter.delta(content);
    if (contentDelta)
      events.push({ content: contentDelta, reasoning: "", done: false });
    return events;
  };

  const finish = () => {
    if (terminal) return [];
    const events = sawDetails ? flushSnapshot(true) : flushPhaseReasoning(true).concat(fullText ? (() => {
      const d = contentEmitter.delta(fullText);
      return d ? [{ content: d, reasoning: "", done: false }] : [];
    })() : []);
    terminal = true;
    events.push({ content: "", reasoning: "", done: true });
    return events;
  };

  const push = (raw) => {
    if (terminal || !raw || typeof raw !== "object") return [];
    const frame = raw;
    const data = frame.data && typeof frame.data === "object" ? frame.data : frame;
    const err = frameError(frame, data);
    if (err) {
      terminal = true;
      return [{ content: "", reasoning: "", done: true, error: err }];
    }

    // Already OpenAI-shaped frames are genuine append-only deltas; do not
    // reinterpret them as Z.AI snapshots.
    const choices = Array.isArray(frame.choices) ? frame.choices : null;
    if (choices && choices.length) {
      const delta = choices[0].delta || {};
      const events = [];
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content)
        events.push({ content: "", reasoning: delta.reasoning_content, done: false });
      if (typeof delta.content === "string" && delta.content)
        events.push({ content: delta.content, reasoning: "", done: false });
      if (choices[0].finish_reason != null) {
        terminal = true;
        events.push({ content: "", reasoning: "", done: true });
      }
      return events;
    }

    const phase = String(data.phase || "").toLowerCase();
    const hasDetailsInFrame = [data.content, data.delta_content, data.edit_content].some((v) => typeof v === "string" && v.includes("<details"));
    if (hasDetailsInFrame) sawDetails = true;

    const events = [];
    if (phase === "thinking" && !sawDetails) {
      const next = applySnapshot(phaseReasoning, data);
      phaseReasoning = next.value;
      if (next.changed) events.push(...flushPhaseReasoning(false));
    } else {
      // When a legacy `phase:thinking` sequence transitions into answer text,
      // release its held tail before the first answer byte.
      if (phaseReasoning && !sawDetails)
        events.push(...flushPhaseReasoning(true));
      const next = applySnapshot(fullText, data);
      fullText = next.value;
      if (fullText.includes("<details")) sawDetails = true;
      if (next.changed) {
        if (sawDetails) events.push(...flushSnapshot(false));
        else {
          let target = holdBackPartialDetailsTag(holdBackTail(fullText, holdback));
          const d = contentEmitter.delta(target);
          if (d) events.push({ content: d, reasoning: "", done: false });
        }
      }
    }

    const done = data.done === true || phase === "done" || phase === "finish" || String(frame.type || "") === "chat:completion:finish";
    if (done) events.push(...finish());
    return events;
  };

  return { push, finish };
}
