import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireZaiChatId,
  releaseZaiChatId,
  zaiSessionPoolStatus,
  resetZaiSessionPools
} from "../src/zai-session-pool.js";
test("a chat id is reused up to the limit, then deleted and replaced once", () => {
  resetZaiSessionPools();
  const key = "provider:1:key:1";
  const deleted = [];
  const cleanup = (id) => deleted.push(id);

  // size=1 makes the lifecycle deterministic: one id serves reuse=3
  // completions, deleted only on the 3rd release, then replaced.
  let firstId = null;
  for (let i = 0; i < 3; i++) {
    const { chatId } = acquireZaiChatId(key, 1, 3);
    if (i === 0) firstId = chatId;
    else assert.equal(chatId, firstId, "same id is reused across round " + i);
    releaseZaiChatId(key, chatId, cleanup);
  }
  // Deletion is best-effort async; give the microtask a beat.
  return new Promise((r) => setTimeout(r, 0)).then(() => {
    assert.deepEqual(deleted, [firstId], "deleted exactly once, after the reuse limit");
    // A 4th acquire yields a DIFFERENT id (the replacement).
    const { chatId: next } = acquireZaiChatId(key, 1, 3);
    assert.notEqual(next, firstId, "post-retirement acquire gets a fresh id");
  });
});

test("reuse=1 preserves legacy delete-every-request behavior", () => {
  resetZaiSessionPools();
  const key = "legacy";
  const deleted = [];
  const { chatId } = acquireZaiChatId(key, 2, 1);
  releaseZaiChatId(key, chatId, (id) => deleted.push(id));
  return new Promise((r) => setTimeout(r, 0)).then(() => {
    assert.deepEqual(deleted, [chatId], "reuse=1 deletes on first release");
  });
});

test("a release with no completion (no cleanup fn) never deletes upstream", () => {
  resetZaiSessionPools();
  const key = "no-completion";
  const { chatId } = acquireZaiChatId(key, 2, 3);
  // completionAttempted=false path passes cleanup=undefined.
  releaseZaiChatId(key, chatId, undefined);
  const st = zaiSessionPoolStatus(key);
  assert.equal(st.retired + st.reused, 1, "the release was accounted for");
});

test("pools are isolated by key: reuse counters never cross accounts", () => {
  resetZaiSessionPools();
  const a = acquireZaiChatId("acct:A", 2, 5).chatId;
  const b = acquireZaiChatId("acct:B", 2, 5).chatId;
  assert.notEqual(a, b);
  releaseZaiChatId("acct:A", a);
  const stA = zaiSessionPoolStatus("acct:A");
  const stB = zaiSessionPoolStatus("acct:B");
  assert.equal(stA.reuseCount, 5);
  assert.equal(stB.inFlight, 1, "B's in-flight id is untouched by A's release");
});

test("status reports reuse budget, ready/in-flight counts, and retirement tally", () => {
  resetZaiSessionPools();
  const key = "status";
  const first = acquireZaiChatId(key, 1, 2);
  let st = zaiSessionPoolStatus(key);
  assert.equal(st.reuseCount, 2);
  assert.equal(st.inFlight, 1);
  assert.ok(Array.isArray(st.readyUses));
  releaseZaiChatId(key, first.chatId);        // uses -> 1, reused
  const again = acquireZaiChatId(key, 1, 2);  // pulls the reused id back
  assert.equal(again.chatId, first.chatId, "reused id comes back at size=1");
  releaseZaiChatId(key, again.chatId);        // uses -> 2, retired
  st = zaiSessionPoolStatus(key);
  assert.ok(st.reused >= 1, "at least one reuse happened");
  assert.ok(st.retired >= 1, "at least one retirement happened");
});
