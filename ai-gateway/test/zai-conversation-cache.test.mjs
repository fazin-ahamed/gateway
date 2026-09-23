// The conversation matcher must reuse a chat only on a unique exact prefix and
// bootstrap on anything uncertain. A wrong reuse corrupts a conversation; a
// missed reuse only costs tokens, so every ambiguous case must bootstrap.

import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeMessage,
  contractHash,
  chainHashes,
  scopeKey,
  planConversation,
  reusableOnRoute,
  isFork,
  commitTurn,
  poisonConversation
} from "../src/zai-conversation-cache.js";

const user = (text) => ({ role: "user", content: text });
const asst = (text) => ({ role: "assistant", content: text });

async function candidateFrom(contract, messages, extra = {}) {
  const chain = await chainHashes(contract, messages);
  return {
    id: extra.id || "cv_1",
    messageCount: messages.length,
    chainHash: chain[messages.length],
    contractHash: contract,
    state: "ready",
    revision: 0,
    providerId: 4,
    providerKeyId: 17,
    upstreamChatId: extra.upstreamChatId || "chat_a",
    ...extra
  };
}

test("an exact continuation sends only the new turns", async () => {
  const contract = await contractHash({ system: "be helpful" });
  const committed = [user("m1"), asst("a1"), user("m2"), asst("a2")];
  const cand = await candidateFrom(contract, committed);
  const incoming = [...committed, user("m3")];
  const chain = await chainHashes(contract, incoming);
  const plan = planConversation({ chain, incomingCount: incoming.length, contractHash: contract, candidates: [cand] });
  assert.equal(plan.mode, "continuation");
  assert.equal(plan.upstreamChatId, "chat_a");
  assert.equal(plan.deltaFrom, 4);
  assert.equal(plan.deltaCount, 1, "only the one new message is the delta");
});

test("no candidate is a bootstrap", async () => {
  const contract = await contractHash({ system: "sys" });
  const chain = await chainHashes(contract, [user("hello")]);
  const plan = planConversation({ chain, incomingCount: 1, contractHash: contract, candidates: [] });
  assert.equal(plan.mode, "bootstrap");
  assert.equal(plan.reason, "no_match");
});

test("edited history breaks the prefix and bootstraps", async () => {
  const contract = await contractHash({ system: "sys" });
  const cand = await candidateFrom(contract, [user("original"), asst("a1")]);
  // The client rewrote the first user turn: the chain diverges before the
  // committed point, so nothing matches.
  const incoming = [user("edited"), asst("a1"), user("next")];
  const chain = await chainHashes(contract, incoming);
  const plan = planConversation({ chain, incomingCount: incoming.length, contractHash: contract, candidates: [cand] });
  assert.equal(plan.mode, "bootstrap");
});

test("a changed system contract bootstraps even with identical messages", async () => {
  const messages = [user("m1"), asst("a1")];
  const oldContract = await contractHash({ system: "old" });
  const cand = await candidateFrom(oldContract, messages);
  const newContract = await contractHash({ system: "new" });
  const chain = await chainHashes(newContract, [...messages, user("m2")]);
  const plan = planConversation({ chain, incomingCount: 3, contractHash: newContract, candidates: [cand] });
  assert.equal(plan.mode, "bootstrap", "the contract hash seeds the chain, so a new system prompt cannot match");
});

test("a changed tool contract bootstraps", async () => {
  const a = await contractHash({ system: "s", tools: [{ function: { name: "read", parameters: { type: "object" } } }] });
  const b = await contractHash({ system: "s", tools: [{ function: { name: "read", parameters: { type: "object" } } }, { function: { name: "write" } }] });
  assert.notEqual(a, b, "adding a tool changes the contract hash");
});

test("the tool contract hash is order-independent", async () => {
  const a = await contractHash({ system: "s", tools: [{ function: { name: "read" } }, { function: { name: "write" } }] });
  const b = await contractHash({ system: "s", tools: [{ function: { name: "write" } }, { function: { name: "read" } }] });
  assert.equal(a, b, "tool order must not change identity");
});

test("two distinct chats matching the same prefix are ambiguous and bootstrap", async () => {
  const contract = await contractHash({ system: "sys" });
  const committed = [user("m1"), asst("a1")];
  const one = await candidateFrom(contract, committed, { id: "cv_1", upstreamChatId: "chat_a" });
  const two = await candidateFrom(contract, committed, { id: "cv_2", upstreamChatId: "chat_b" });
  const chain = await chainHashes(contract, [...committed, user("m2")]);
  const plan = planConversation({ chain, incomingCount: 3, contractHash: contract, candidates: [one, two] });
  assert.equal(plan.mode, "bootstrap");
  assert.equal(plan.reason, "ambiguous");
});

test("the longest committed prefix wins over a shorter one", async () => {
  const contract = await contractHash({ system: "sys" });
  const full = [user("m1"), asst("a1"), user("m2"), asst("a2")];
  const shortCand = await candidateFrom(contract, full.slice(0, 2), { id: "cv_short", upstreamChatId: "chat_short" });
  const longCand = await candidateFrom(contract, full, { id: "cv_long", upstreamChatId: "chat_long" });
  const incoming = [...full, user("m3")];
  const chain = await chainHashes(contract, incoming);
  const plan = planConversation({ chain, incomingCount: incoming.length, contractHash: contract, candidates: [shortCand, longCand] });
  assert.equal(plan.mode, "continuation");
  assert.equal(plan.upstreamChatId, "chat_long");
  assert.equal(plan.deltaFrom, 4);
});

test("a poisoned conversation is never reused", async () => {
  const contract = await contractHash({ system: "sys" });
  const cand = await candidateFrom(contract, [user("m1")], { state: "poisoned" });
  const chain = await chainHashes(contract, [user("m1"), user("m2")]);
  const plan = planConversation({ chain, incomingCount: 2, contractHash: contract, candidates: [cand] });
  assert.equal(plan.mode, "bootstrap");
});

test("a full re-send with no new turns is a zero-delta continuation", async () => {
  const contract = await contractHash({ system: "sys" });
  const committed = [user("m1"), asst("a1")];
  const cand = await candidateFrom(contract, committed);
  const chain = await chainHashes(contract, committed);
  const plan = planConversation({ chain, incomingCount: committed.length, contractHash: contract, candidates: [cand] });
  assert.equal(plan.mode, "continuation");
  assert.equal(plan.reason, "resend");
  assert.equal(plan.deltaCount, 0);
});

test("a candidate longer than the incoming request cannot match", async () => {
  const contract = await contractHash({ system: "sys" });
  const cand = await candidateFrom(contract, [user("m1"), asst("a1"), user("m2")]);
  const chain = await chainHashes(contract, [user("m1"), asst("a1")]);
  const plan = planConversation({ chain, incomingCount: 2, contractHash: contract, candidates: [cand] });
  assert.equal(plan.mode, "bootstrap", "the client cannot have fewer messages than the committed prefix");
});

test("reuse is refused when the router lands on a different provider or key", async () => {
  const plan = { mode: "continuation", providerId: 4, providerKeyId: 17 };
  assert.equal(reusableOnRoute(plan, { providerId: 4, providerKeyId: 17 }), true);
  assert.equal(reusableOnRoute(plan, { providerId: 9, providerKeyId: 17 }), false, "different provider means the chat is not there");
  assert.equal(reusableOnRoute(plan, { providerId: 4, providerKeyId: 99 }), false, "different key means a different account");
  assert.equal(reusableOnRoute({ mode: "bootstrap" }, { providerId: 4 }), false);
});

test("a second request on the same revision is a fork", async () => {
  const plan = { mode: "continuation", revision: 8 };
  assert.equal(isFork(plan, 8), false, "the first continuation matches the current revision");
  assert.equal(isFork(plan, 9), true, "a later revision means someone else already appended");
});

test("commit advances the prefix and revision; poison flips state", () => {
  const conv = { id: "cv_1", messageCount: 4, chainHash: "h4", revision: 2, state: "ready" };
  const committed = commitTurn(conv, { messageCount: 6, chainHash: "h6", at: "2026-01-01T00:00:00.000Z" });
  assert.equal(committed.messageCount, 6);
  assert.equal(committed.chainHash, "h6");
  assert.equal(committed.revision, 3);
  assert.equal(committed.state, "ready");
  const poisoned = poisonConversation(committed);
  assert.equal(poisoned.state, "poisoned");
  assert.equal(poisoned.messageCount, 6, "poisoning does not rewrite the committed prefix");
});

test("scope keys separate tenants, users, and models but merge an explicit conversation id", () => {
  const a = scopeKey({ apiKey: "k1", user: "alice", canonicalModelId: "glm-5.3" });
  const b = scopeKey({ apiKey: "k1", user: "bob", canonicalModelId: "glm-5.3" });
  const c = scopeKey({ apiKey: "k2", user: "alice", canonicalModelId: "glm-5.3" });
  const d = scopeKey({ apiKey: "k1", user: "alice", canonicalModelId: "glm-5.2" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d, "a different model is a different scope");
  const e1 = scopeKey({ apiKey: "k1", conversationId: "cv_x", canonicalModelId: "glm-5.3" });
  const e2 = scopeKey({ apiKey: "k1", conversationId: "cv_x", canonicalModelId: "glm-5.3" });
  assert.equal(e1, e2);
});

test("canonicalization ignores image bytes but keeps a stable reference and tool identity", () => {
  const withImage = canonicalizeMessage({ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] });
  assert.ok(withImage.includes("look"));
  assert.ok(withImage.includes("[image:"));
  const toolTurn = canonicalizeMessage({ role: "assistant", content: null, tool_calls: [{ id: "t1", function: { name: "read", arguments: "{}" } }] });
  const plainTurn = canonicalizeMessage({ role: "assistant", content: "" });
  assert.notEqual(toolTurn, plainTurn, "a tool call turn is distinct from an empty assistant turn");
});
