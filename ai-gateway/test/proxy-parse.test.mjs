import test from "node:test";
import assert from "node:assert/strict";

import { parseProxyLine, parseProxyImport, proxyIdentity, maskProxy } from "../src/proxy-parse.js";

test("bare host:port uses the default scheme", () => {
  const r = parseProxyLine("1.2.3.4:8080", "http");
  assert.ok(r.ok);
  assert.deepEqual(r.proxy, { scheme: "http", host: "1.2.3.4", port: 8080, username: "", password: "" });
});

test("URI forms carry their own scheme and auth", () => {
  assert.equal(parseProxyLine("socks5h://127.0.0.1:9050").proxy.scheme, "socks5h");
  const auth = parseProxyLine("http://user:pass@1.2.3.4:8080");
  assert.ok(auth.ok);
  assert.equal(auth.proxy.username, "user");
  assert.equal(auth.proxy.password, "pass");
});

test("host:port:user:pass dump form is accepted unambiguously", () => {
  const r = parseProxyLine("1.2.3.4:1080:bob:s3cret", "socks5");
  assert.ok(r.ok);
  assert.equal(r.proxy.username, "bob");
  assert.equal(r.proxy.password, "s3cret");
  assert.equal(r.proxy.scheme, "socks5");
});

test("IPv6 URI is normalized without brackets for storage", () => {
  const r = parseProxyLine("socks5h://[2001:db8::1]:1080");
  assert.ok(r.ok);
  assert.equal(r.proxy.host, "2001:db8::1");
  assert.equal(r.proxy.port, 1080);
});

test("unsupported schemes and malformed lines are rejected, never guessed", () => {
  assert.equal(parseProxyLine("ftp://1.2.3.4:21").ok, false);
  assert.equal(parseProxyLine("1.2.3.4").ok, false);
  assert.equal(parseProxyLine("1.2.3.4:99999").ok, false);
  assert.equal(parseProxyLine("1.2.3.4:0").ok, false);
  assert.equal(parseProxyLine("http://1.2.3.4:8080/path").ok, false);
  assert.equal(parseProxyLine("a:b:c").ok, false);
});

test("import reports accepted / duplicates / invalid and skips comments", () => {
  const text = [
    "# a comment",
    "1.2.3.4:8080",
    "1.2.3.4:8080",              // exact duplicate
    "http://1.2.3.4:8080",       // same identity as bare (http default)
    "socks5://1.2.3.4:8080",     // different scheme -> distinct
    "garbage-line",
    "",
    "5.6.7.8:3128"
  ].join("\n");
  const r = parseProxyImport(text, "http");
  assert.equal(r.accepted.length, 3, "1.2.3.4 http, 1.2.3.4 socks5, 5.6.7.8 http");
  assert.equal(r.duplicates, 2, "the two repeats of the http 1.2.3.4 identity");
  assert.equal(r.invalid.length, 1);
  assert.equal(r.invalid[0].reason, "unrecognized_format");
});

test("identity distinguishes scheme, port, and username", () => {
  const a = { scheme: "http", host: "h", port: 1, username: "u" };
  const b = { scheme: "socks5", host: "h", port: 1, username: "u" };
  const c = { scheme: "http", host: "h", port: 1, username: "v" };
  assert.notEqual(proxyIdentity(a), proxyIdentity(b));
  assert.notEqual(proxyIdentity(a), proxyIdentity(c));
});

test("maskProxy never reveals the password", () => {
  const masked = maskProxy({ scheme: "socks5", host: "1.2.3.4", port: 1080, username: "bob", password: "s3cret" });
  assert.doesNotMatch(masked, /s3cret/);
  assert.match(masked, /bob/);
});
