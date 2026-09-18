import test from "node:test";
import assert from "node:assert/strict";

import { __browserTest } from "../src/zaibrowser.js";
import { __zaiTest } from "../src/zaiweb.js";

const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const jwt = (claims, sig) => [b64u({ alg: "HS256" }), b64u(claims), sig].join(".");

test("validated account identity keeps rotated JWTs in one browser pool", () => {
  const first = jwt({ id: "acct-123", exp: 1 }, "sig-one");
  const rotated = jwt({ id: "acct-123", exp: 2 }, "sig-two");
  const stableId = __zaiTest.browserPoolIdForUserId("acct-123");

  assert.equal(stableId, "uid:acct-123");
  assert.equal(
    __browserTest.poolKey(first, stableId),
    __browserTest.poolKey(rotated, stableId),
    "token rotation must not cold-start a new browser context"
  );
});

test("raw-token pool keys still differ when no stable account identity is supplied", () => {
  const first = jwt({ id: "acct-123" }, "sig-one");
  const rotated = jwt({ id: "acct-123" }, "sig-two");

  assert.notEqual(
    __browserTest.poolKey(first),
    __browserTest.poolKey(rotated),
    "fallback token-scoped pools must remain isolated"
  );
});

test("different ZAI accounts never share a browser pool", () => {
  const a = jwt({ id: "acct-a" }, "sig");
  const b = jwt({ id: "acct-b" }, "sig");

  const aId = __zaiTest.browserPoolIdForUserId("acct-a");
  const bId = __zaiTest.browserPoolIdForUserId("acct-b");

  assert.notEqual(aId, bId);
  assert.notEqual(
    __browserTest.poolKey(a, aId),
    __browserTest.poolKey(b, bId)
  );
});
