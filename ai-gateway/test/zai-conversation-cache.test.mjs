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
  postTurnCommitState,
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

test("scope keys use a non-secret tenant and refuse reuse for anonymous shared-key callers", () => {
  // No affinity id and not a single-user key: no scope, so no persistent reuse.
  assert.equal(scopeKey({ tenantId: "key_1", canonicalModelId: "glm-5.3" }), null,
    "two users on one key with no conversation id must not share a scope");
  // An explicit affinity id (conversation id or stable user id) scopes safely.
  const a = scopeKey({ tenantId: "key_1", affinityId: "cv_alice", canonicalModelId: "glm-5.3" });
  const b = scopeKey({ tenantId: "key_1", affinityId: "cv_bob", canonicalModelId: "glm-5.3" });
  const c = scopeKey({ tenantId: "key_2", affinityId: "cv_alice", canonicalModelId: "glm-5.3" });
  const d = scopeKey({ tenantId: "key_1", affinityId: "cv_alice", canonicalModelId: "glm-5.2" });
  assert.notEqual(a, b, "different conversations do not share");
  assert.notEqual(a, c, "different tenants do not share");
  assert.notEqual(a, d, "a different model is a different scope");
  assert.equal(a, scopeKey({ tenantId: "key_1", affinityId: "cv_alice", canonicalModelId: "glm-5.3" }), "the same identity is stable");
  // A key explicitly marked single-user may opt into implicit affinity.
  const implicit = scopeKey({ tenantId: "key_solo", canonicalModelId: "glm-5.3", allowImplicitAffinity: true });
  assert.ok(implicit && implicit.includes("implicit"));
  // The raw bearer secret must never appear in the persisted scope.
  assert.equal(a.includes("sk-"), false);
});

test("canonicalization digests the full image reference and keeps tool identity distinct", async () => {
  const withImage = await canonicalizeMessage({ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] });
  assert.ok(withImage.includes("look"));
  assert.ok(withImage.includes("[image:"));
  assert.equal(withImage.includes("AAAA"), false, "raw image bytes are not carried, only a digest");
  const toolTurn = await canonicalizeMessage({ role: "assistant", content: null, tool_calls: [{ id: "t1", function: { name: "read", arguments: "{}" } }] });
  const plainTurn = await canonicalizeMessage({ role: "assistant", content: "" });
  assert.notEqual(toolTurn, plainTurn, "a tool call turn is distinct from an empty assistant turn");
});

test("two large images sharing a long prefix do not canonicalize identically", async () => {
  const base = "data:image/png;base64," + "A".repeat(4096);
  const one = await canonicalizeMessage({ role: "user", content: [{ type: "image_url", image_url: { url: base + "XX" } }] });
  const two = await canonicalizeMessage({ role: "user", content: [{ type: "image_url", image_url: { url: base + "YY" } }] });
  assert.notEqual(one, two, "the full reference is digested, so a shared 2KB prefix is not a collision");
});

test("the committed prefix includes the generated assistant turn, so the next delta excludes it", async () => {
  const contract = await contractHash({ system: "sys" });
  // Request 1: client sends [U1], model answers A1.
  const req1 = [user("U1")];
  const commit1 = await postTurnCommitState({ contractHash: contract, incomingMessages: req1, assistantMessage: asst("A1") });
  assert.equal(commit1.messageCount, 2, "commit covers U1 AND the generated A1");

  const cand = {
    id: "cv_1", messageCount: commit1.messageCount, chainHash: commit1.chainHash,
    contractHash: contract, state: "ready", revision: 1,
    providerId: 4, providerKeyId: 17, upstreamChatId: "chat_a"
  };

  // Request 2: the client replays [U1, A1, U2]. The delta must be exactly [U2],
  // never [A1, U2] — the upstream chat already holds A1.
  const req2 = [user("U1"), asst("A1"), user("U2")];
  const chain2 = await chainHashes(contract, req2);
  const plan = planConversation({ chain: chain2, incomingCount: req2.length, contractHash: contract, candidates: [cand] });
  assert.equal(plan.mode, "continuation");
  assert.equal(plan.deltaFrom, 2, "the committed prefix is U1+A1");
  assert.equal(plan.deltaCount, 1, "only U2 is sent; A1 is not re-sent");
});

test("committing only the incoming messages would wrongly re-send the assistant answer", async () => {
  const contract = await contractHash({ system: "sys" });
  // The WRONG commit: store just [U1] (message_count 1). This pins the bug the
  // post-turn helper prevents.
  const wrongChain = await chainHashes(contract, [user("U1")]);
  const wrongCand = {
    id: "cv_bad", messageCount: 1, chainHash: wrongChain[1], contractHash: contract,
    state: "ready", revision: 1, providerId: 4, providerKeyId: 17, upstreamChatId: "chat_a"
  };
  const req2 = [user("U1"), asst("A1"), user("U2")];
  const chain2 = await chainHashes(contract, req2);
  const bad = planConversation({ chain: chain2, incomingCount: req2.length, contractHash: contract, candidates: [wrongCand] });
  assert.equal(bad.deltaCount, 2, "the buggy commit would resend [A1, U2] — this is the duplication the helper avoids");
});

test("tool contract identity is order-independent even for duplicate names and non-function tools", async () => {
  const t1 = { function: { name: "run", parameters: { type: "object", properties: { a: {} } } } };
  const t2 = { function: { name: "run", parameters: { type: "object", properties: { b: {} } } } };
  const t3 = { type: "retrieval" };
  const a = await contractHash({ system: "s", tools: [t1, t2, t3] });
  const b = await contractHash({ system: "s", tools: [t3, t2, t1] });
  assert.equal(a, b, "sorting by the full normalized definition keeps identity stable");
  const different = await contractHash({ system: "s", tools: [t1, t3] });
  assert.notEqual(a, different, "dropping a same-named variant still changes the contract");
});
