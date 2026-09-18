import test from "node:test";
import assert from "node:assert/strict";

import { __browserTest } from "../src/zaibrowser.js";
import { __zaiTest } from "../src/zaiweb.js";

const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const jwt = (claims, sig) => [b64u({ alg: "HS256" }), b64u(claims), sig].join(".");

test("rotated JWTs share a warm browser only under trusted provider-key identity", () => {
  const first = jwt({ id: "acct-123", exp: 1 }, "sig-one");
  const rotated = jwt({ id: "acct-123", exp: 2 }, "sig-two");
  const trusted = "provider:7:key:13";

  assert.equal(
    __browserTest.poolKey(first, trusted),
    __browserTest.poolKey(rotated, trusted),
    "server-controlled identity should survive upstream token rotation"
  );
});

test("untrusted JWT claims never select browser pool identity", () => {
  const spoofed = jwt({ id: "victim-account" }, "attacker");
  assert.equal(__zaiTest.browserPoolIdForRoute({}), "");
  assert.equal(
    __zaiTest.browserPoolIdForRoute({ zai_session_key: "provider:7:key:13" }),
    "provider:7:key:13"
  );
  // Without a trusted route identity the browser falls back to token-scoped
  // isolation; merely spoofing the JWT id cannot collide with another token.
  assert.notEqual(
    __browserTest.poolKey(spoofed),
    __browserTest.poolKey(jwt({ id: "victim-account" }, "different-token"))
  );
});

test("different provider credentials never share a browser pool", () => {
  const token = jwt({ id: "same-upstream-account" }, "sig");
  assert.notEqual(
    __browserTest.poolKey(token, "provider:7:key:13"),
    __browserTest.poolKey(token, "provider:7:key:14")
  );
});
