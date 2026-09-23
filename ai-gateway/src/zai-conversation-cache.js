// Conversation-affinity matcher for the chat.z.ai delta path — PURE.
//
// No database, no network, no serving import. It decides whether an incoming
// OpenAI request is an exact continuation of a chat.z.ai conversation the
// gateway already owns (so only the new turns need to be sent) or a fresh
// bootstrap (send the whole normalized context to a new upstream chat_id).
//
// The rule is fail-safe: reuse only on a UNIQUE exact committed-prefix match
// of a rolling hash chain. Anything uncertain — no match, ambiguous match,
// edited history, a changed system/tool contract, a poisoned conversation —
// falls back to bootstrap. A wrong reuse would corrupt a conversation; a
// missed reuse only costs the tokens we send today, so the bias is deliberate.
//
// Hashing is SHA-256 via crypto.subtle, the same primitive zaiweb already uses
// for request signing, so this runs unchanged on the worker and the Node host.

const NUL = "\u0000";

async function sha256hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Text of one message, matching the chat.z.ai prompt view: role + visible
// text, plus the tool identity/calls so a tool turn is distinct from a plain
// one. Image parts collapse to a stable reference, never the raw bytes.
export function canonicalizeMessage(message) {
  const m = message && typeof message === "object" ? message : {};
  const parts = [];
  const content = m.content;
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object")
        continue;
      if (part.type === "text" || part.type === "input_text") {
        const text = part.text ?? part.content;
        if (typeof text === "string")
          parts.push(text);
      } else if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
        parts.push("[image:" + part.image_url.url.slice(0, 2048) + "]");
      }
    }
  }
  const shape = {
    role: String(m.role || ""),
    text: parts.join("\n"),
    name: m.name ? String(m.name) : null,
    tool_call_id: m.tool_call_id ? String(m.tool_call_id) : null,
    tool_calls: Array.isArray(m.tool_calls)
      ? m.tool_calls.map((tc) => ({
          id: tc && tc.id ? String(tc.id) : null,
          name: tc && tc.function && tc.function.name ? String(tc.function.name) : null,
          arguments: tc && tc.function && typeof tc.function.arguments === "string" ? tc.function.arguments : ""
        }))
      : null
  };
  return stableJson(shape);
}

// The contract is everything a turn silently depends on: the system/developer
// instructions and the tool schemas. Changing it must force a rebootstrap, so
// it is hashed separately and seeds the chain as H0.
export async function contractHash({ system = null, tools = null } = {}) {
  const sys = typeof system === "string" ? system : (system == null ? "" : stableJson(system));
  const toolList = Array.isArray(tools)
    ? tools
        .map((t) => (t && t.function ? { name: String(t.function.name || ""), parameters: t.function.parameters ?? null, description: t.function.description ?? null } : t))
        .slice()
        .sort((a, b) => String(a && a.name).localeCompare(String(b && b.name)))
    : null;
  return sha256hex(stableJson({ system: sys, tools: toolList }));
}

// Rolling hash chain. chain[0] is the contract hash (H0); chain[i] covers the
// contract plus the first i messages, so a stored conversation of k messages
// is a prefix of the incoming request exactly when chain[k] === its chainHash.
export async function chainHashes(contractHashValue, messages) {
  const chain = [String(contractHashValue || "")];
  let prev = chain[0];
  for (const message of Array.isArray(messages) ? messages : []) {
    prev = await sha256hex(prev + NUL + canonicalizeMessage(message));
    chain.push(prev);
  }
  return chain;
}

// A conversation is matched only within its tenant, optional user, and the
// canonical model identity. Two callers on one API key are only merged when
// they share an explicit user or conversation id; otherwise the model scope
// still separates by identity, never globally.
export function scopeKey({ apiKey = "", user = null, conversationId = null, canonicalModelId = null } = {}) {
  return [
    "k:" + String(apiKey || ""),
    "u:" + String(user || ""),
    "c:" + String(conversationId || ""),
    "m:" + String(canonicalModelId || "")
  ].join("|");
}

// Decide bootstrap vs continuation from the candidate rows already scoped to
// this tenant/user/model. Candidates are body-free rows:
//   { id, messageCount, chainHash, contractHash, state, providerId, providerKeyId, upstreamChatId }
//
// A candidate is eligible only when it is ready (not poisoned), its contract
// matches, its committed prefix is no longer than the incoming request, and
// the chain hash at that prefix length matches exactly. The longest eligible
// prefix wins; a tie between distinct chats is ambiguous and forces bootstrap.
export function planConversation({ chain, incomingCount, contractHash: contractHashValue, candidates = [] } = {}) {
  const eligible = [];
  for (const c of candidates) {
    if (!c || c.state !== "ready")
      continue;
    if (String(c.contractHash) !== String(contractHashValue))
      continue;
    const k = Number(c.messageCount);
    if (!Number.isInteger(k) || k < 0 || k > incomingCount)
      continue;
    if (!chain[k] || String(chain[k]) !== String(c.chainHash))
      continue;
    eligible.push(c);
  }
  if (!eligible.length)
    return { mode: "bootstrap", reason: "no_match" };

  let best = -1;
  for (const c of eligible)
    best = Math.max(best, Number(c.messageCount));
  const top = eligible.filter((c) => Number(c.messageCount) === best);
  const distinct = new Set(top.map((c) => String(c.upstreamChatId)));
  if (distinct.size > 1)
    return { mode: "bootstrap", reason: "ambiguous" };

  const match = top[0];
  return {
    mode: "continuation",
    reason: best === incomingCount ? "resend" : "delta",
    conversationId: match.id,
    upstreamChatId: match.upstreamChatId,
    providerId: match.providerId,
    providerKeyId: match.providerKeyId,
    revision: Number(match.revision) || 0,
    committedMessages: best,
    deltaFrom: best,
    deltaCount: incomingCount - best
  };
}

// A cached chat belongs to the provider/key that created it. If the router
// lands on a different provider or key, its server-side state is not there:
// reuse would send a delta into the wrong chat, so it must rebootstrap.
export function reusableOnRoute(plan, { providerId, providerKeyId } = {}) {
  if (!plan || plan.mode !== "continuation")
    return false;
  if (plan.providerId != null && providerId != null && Number(plan.providerId) !== Number(providerId))
    return false;
  if (plan.providerKeyId != null && providerKeyId != null && Number(plan.providerKeyId) !== Number(providerKeyId))
    return false;
  return true;
}

// Two requests continuing the same revision must not both append to one
// upstream chat. The first keeps it; the second is a fork and rebootstraps.
export function isFork(plan, currentRevision) {
  if (!plan || plan.mode !== "continuation")
    return false;
  return Number(plan.revision) !== Number(currentRevision);
}

// Advance committed state ONLY after a clean terminal. The new prefix is the
// full incoming length, so the next turn's delta is measured from here.
export function commitTurn(conversation, { messageCount, chainHash, at }) {
  return {
    ...conversation,
    messageCount: Number(messageCount),
    chainHash: String(chainHash),
    revision: (Number(conversation && conversation.revision) || 0) + 1,
    state: "ready",
    lastUsedAt: at || null
  };
}

// An interrupted stream (EOF, premature close, partial tool call, cancel,
// upstream error) leaves the upstream chat in an unknown state. Poison it so
// the next request rebootstraps on a fresh chat rather than trusting it.
export function poisonConversation(conversation) {
  return { ...conversation, state: "poisoned" };
}

// Stable stringify with sorted keys so hashing does not depend on property
// order. Arrays keep order; their elements are normalized too.
function stableJson(value) {
  if (Array.isArray(value))
    return "[" + value.map((v) => stableJson(v)).join(",") + "]";
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export const __test = { sha256hex, stableJson };
