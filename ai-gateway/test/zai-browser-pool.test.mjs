import test from "node:test";
import assert from "node:assert/strict";

import { __browserTest } from "../src/zaibrowser.js";
import { __zaiTest } from "../src/zaiweb.js";

const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const jwt = (claims, sig) => [b64u({ alg: "HS256" }), b64u(claims), sig].join(".");

test("rotated JWTs for the same ZAI account share one browser pool identity", () => {
  const first = jwt({ id: "acct-123", exp: 1 }, "sig-one");
  const rotated = jwt({ id: "acct-123", exp: 2 }, "sig-two");

  const firstId = __zaiTest.browserPoolIdForToken(first);
  const rotatedId = __zaiTest.browserPoolIdForToken(rotated);

  assert.equal(firstId, "uid:acct-123");
  assert.equal(rotatedId, firstId);
  assert.equal(
    __browserTest.poolKey(first, firstId),
    __browserTest.poolKey(rotated, rotatedId),
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

  const aId = __zaiTest.browserPoolIdForToken(a);
  const bId = __zaiTest.browserPoolIdForToken(b);

  assert.notEqual(aId, bId);
  assert.notEqual(
    __browserTest.poolKey(a, aId),
    __browserTest.poolKey(b, bId)
  );
});
