// Agent-loop repetition telemetry — body-free instrumentation that quantifies
// whether the Z.AI agent shim is making the model redo work across tool rounds.
//
// The gateway is stateless per HTTP request and each agent round is a SEPARATE
// /v1/chat/completions call. Two classes of metric follow from that:
//
//   within-request (stateless): computed from the incoming messages + the
//     model's emitted tool calls. `tool_calls_repeated` is the objective
//     measure of the exact failure the continuation-prompt fix targets — the
//     model re-issuing a call already made and answered earlier in the loop.
//
//   cross-round (durable): `reasoning_prefix_overlap` compares this round's
//     opening reasoning against the PREVIOUS round's. Clients strip
//     reasoning_content from assistant history, so the prior round only exists
//     if the gateway stored it. We persist a HASH-ONLY fingerprint (never the
//     reasoning text) keyed by a stable logical-turn id, and read the prior
//     row at write time. No in-memory Map: Workers isolates are not durable.

// --- within-request metrics -------------------------------------------------

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

function argsKey(raw) {
  if (raw == null) return "{}";
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return "{}";
    try {
      return JSON.stringify(JSON.parse(t));
    } catch {
      return t;
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return "{}";
  }
}

function callKey(call) {
  const fn = (call && call.function) || call || {};
  const name = String(fn.name || "").trim();
  if (!name) return null;
  return name + "\n" + argsKey(fn.arguments);
}

// One agent round's worth of state, derived purely from the request history and
// the tool calls the model just emitted. `emittedToolCalls` is the parsed
// tool_calls array of THIS response (never the wire text).
export function analyzeAgentLoop({ messages, emittedToolCalls } = {}) {
  const msgs = Array.isArray(messages) ? messages : [];
  const emitted = Array.isArray(emittedToolCalls) ? emittedToolCalls : [];

  // Prior tool calls in history and how many produced a result.
  const priorKeys = new Set();
  let toolExchanges = 0;
  let toolResults = 0;
  for (const m of msgs) {
    if (!m) continue;
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      toolExchanges++;
      for (const call of m.tool_calls) {
        const k = callKey(call);
        if (k) priorKeys.add(k);
      }
    } else if (m.role === "tool") {
      toolResults++;
    }
  }

  const last = (() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]) return msgs[i];
    }
    return null;
  })();
  const continuation = !!(last && last.role === "tool");

  // A repeated call is one the model emits now whose (name, args) already
  // appears earlier in the loop — the "solve it again" signature.
  let emittedCount = 0;
  let repeated = 0;
  const emittedKeys = new Set();
  for (const call of emitted) {
    const k = callKey(call);
    if (!k) continue;
    emittedCount++;
    if (priorKeys.has(k) || emittedKeys.has(k)) repeated++;
    emittedKeys.add(k);
  }

  return {
    continuation_mode: continuation ? "continuation" : "first_turn",
    // Round 1 is the first model turn; each completed tool exchange advances it.
    agent_round: toolExchanges + 1,
    tool_exchanges_in_history: toolExchanges,
    tool_results_in_history: toolResults,
    tool_calls_emitted: emittedCount,
    tool_calls_repeated: repeated
  };
}

// --- reasoning fingerprint (hash-only, body-free) ---------------------------

const SHINGLE_WORDS = 3;   // word-level 3-shingles
const OPENING_CHARS = 600; // only the opening of the reasoning is compared
const MAX_SHINGLES = 128;  // cap the stored set so a row stays small

// FNV-1a 32-bit — deterministic, no crypto, adequate for shingle identity.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function normalizeReasoning(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Sorted, de-duplicated array of shingle hashes over the opening of the
// reasoning. Returns [] for empty/too-short reasoning. The text itself is
// never returned or stored.
export function fingerprintReasoning(text) {
  const norm = normalizeReasoning(text).slice(0, OPENING_CHARS);
  if (!norm) return [];
  const words = norm.split(" ").filter(Boolean);
  if (words.length < SHINGLE_WORDS) {
    // Too short to shingle: hash the whole opening as a single token so
    // identical short reasonings still register as fully overlapping.
    return [hash32(norm)];
  }
  const set = new Set();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
    set.add(hash32(words.slice(i, i + SHINGLE_WORDS).join(" ")));
    if (set.size >= MAX_SHINGLES) break;
  }
  return [...set].sort((a, b) => a - b);
}

// Jaccard similarity of two fingerprint arrays: |A∩B| / |A∪B|. null when either
// side is empty (no comparable reasoning). Range 0..1.
export function reasoningOverlap(fpA, fpB) {
  const a = Array.isArray(fpA) ? fpA : [];
  const b = Array.isArray(fpB) ? fpB : [];
  if (!a.length || !b.length) return null;
  const setB = new Set(b);
  let inter = 0;
  for (const x of a) if (setB.has(x)) inter++;
  const union = a.length + b.length - inter;
  if (!union) return null;
  return inter / union;
}

// --- stable logical-turn id -------------------------------------------------

// A tool loop is a sequence of requests sharing the same original task. The
// first user message is stable across the whole loop; salt with a caller/route
// scope so two callers with identical opening text never collide.
export function deriveLogicalTurnId(messages, salt = "") {
  const msgs = Array.isArray(messages) ? messages : [];
  let firstUser = "";
  for (const m of msgs) {
    if (m && m.role === "user") {
      const t = textOf(m.content);
      if (t) { firstUser = t; break; }
    }
  }
  const basis = String(salt || "") + "\u0000" + firstUser.slice(0, 2000);
  return "turn_" + hash32(basis).toString(16).padStart(8, "0");
}


// --- durable recording ------------------------------------------------------

// Write one agent-loop event. Reads the previous round's fingerprint for the
// same logical turn to compute reasoning_prefix_overlap, then stores THIS
// round's fingerprint for the next round to compare against. Best-effort:
// telemetry must never break the serving path. Returns the computed metrics
// (with overlap) or null on failure.
export async function recordAgentLoopEvent(c, {
  requestId = null,
  messages,
  emittedToolCalls,
  reasoning = "",
  publicSlug = null,
  upstreamModel = null,
  taskType = "",
  turnSalt = ""
} = {}) {
  try {
    if (!c || !c.env || !c.env.DB) return null;
    const metrics = analyzeAgentLoop({ messages, emittedToolCalls });
    const turnId = deriveLogicalTurnId(messages, turnSalt);
    const fp = fingerprintReasoning(reasoning);
    const reasoningChars = String(reasoning || "").length;

    // Prior round of THIS turn, if any — the only durable state we read.
    let overlap = null;
    if (fp.length) {
      const prev = await c.env.DB.prepare(
        "SELECT reasoning_fp FROM agent_loop_events WHERE logical_turn_id=? AND reasoning_fp IS NOT NULL ORDER BY id DESC LIMIT 1"
      ).bind(turnId).all();
      const prevRow = prev && prev.results && prev.results[0];
      if (prevRow && prevRow.reasoning_fp) {
        let prevFp = null;
        try { prevFp = JSON.parse(prevRow.reasoning_fp); } catch {}
        overlap = reasoningOverlap(fp, prevFp);
      }
    }

    await c.env.DB.prepare(
      `INSERT INTO agent_loop_events
       (request_id, logical_turn_id, public_slug, upstream_model, task_type, agent_round,
        continuation_mode, tool_exchanges_in_history, tool_results_in_history, tool_calls_emitted,
        tool_calls_repeated, reasoning_chars, reasoning_prefix_overlap, reasoning_fp, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      requestId, turnId, publicSlug, upstreamModel, String(taskType || ""), metrics.agent_round,
      metrics.continuation_mode, metrics.tool_exchanges_in_history, metrics.tool_results_in_history,
      metrics.tool_calls_emitted, metrics.tool_calls_repeated, reasoningChars,
      overlap, fp.length ? JSON.stringify(fp) : null, new Date().toISOString()
    ).run();
    return { ...metrics, reasoning_prefix_overlap: overlap, logical_turn_id: turnId };
  } catch (e) {
    return null;
  }
}