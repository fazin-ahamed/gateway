import test from "node:test";
import assert from "node:assert/strict";

import {
  CookieJar,
  ZaiSession,
  findJwt,
  looksLikeJwt,
  resetSessions,
  sessionFor,
  setCookieList,
  userIdFromJwt
} from "../src/zai-session.js";
import {
  ZaiModelRegistry,
  normalizeModels,
  resetRegistries
} from "../src/zai-models.js";
import { __zaiTest } from "../src/zaiweb.js";

const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const jwt = (claims, sig = "sig") => [b64u({ alg: "HS256" }), b64u(claims), sig].join(".");

function headersWithSetCookie(...values) {
  const headers = new Headers();
  for (const value of values) headers.append("set-cookie", value);
  return headers;
}

test("cookie jar keeps live cookies and drops expired ones", () => {
  const jar = new CookieJar({ seed: "1" });
  jar.absorb(headersWithSetCookie(
    "token=abc; Path=/; HttpOnly",
    "edge=xyz; Path=/; Max-Age=60",
    "seed=; Path=/; Max-Age=0"
  ));
  assert.equal(jar.get("token"), "abc");
  assert.equal(jar.get("edge"), "xyz");
  assert.equal(jar.get("seed"), "");
  assert.equal(jar.header(), "token=abc; edge=xyz");
});

test("set-cookie parsing survives an Expires date", () => {
  const list = setCookieList(headersWithSetCookie(
    "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
    "b=2; Path=/"
  ));
  assert.equal(list.length, 2);
  const jar = new CookieJar().absorb(headersWithSetCookie("a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/", "b=2; Path=/"));
  assert.equal(jar.get("a"), "1");
  assert.equal(jar.get("b"), "2");
});

test("findJwt finds a nested token and rejects ordinary strings", () => {
  const token = jwt({ id: "u1" });
  assert.equal(findJwt({ data: { user: { access: { token } } } }), token);
  assert.equal(findJwt({ token: "not-a-jwt" }), "");
  assert.equal(looksLikeJwt(token), true);
  assert.equal(looksLikeJwt("hello"), false);
});

test("userIdFromJwt decodes the payload", () => {
  assert.equal(userIdFromJwt(jwt({ id: "user-42" })), "user-42");
  assert.equal(userIdFromJwt(jwt({ sub: "user-99" })), "user-99");
  assert.equal(userIdFromJwt("garbage"), "");
});

test("guest bootstrap builds a session with cookies and a token", async () => {
  const token = jwt({ id: "guest-1" });
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    const path = new URL(String(url)).pathname;
    if (path === "/")
      return new Response("<html>/frontend/prod-fe-1.2.3/assets/x.js</html>", { status: 200, headers: headersWithSetCookie("edge=warm; Path=/") });
    if (path === "/api/v1/auths/guest")
      return new Response(JSON.stringify({ data: { token } }), { status: 200, headers: headersWithSetCookie("token=" + token + "; Path=/") });
    return new Response("{}", { status: 200 });
  };
  const session = new ZaiSession({ fetcher, key: "t-guest" });
  const acquired = await session.acquire();
  assert.equal(acquired.token, token);
  assert.equal(acquired.userId, "guest-1");
  assert.equal(acquired.source, "guest");
  assert.equal(session.state, "VALID");
  assert.equal(session.feVersion, "prod-fe-1.2.3");
  assert.ok(session.jar.get("edge"), "warm cookie retained");
  const headers = session.headers({ Accept: "application/json" });
  assert.equal(headers.Authorization, "Bearer " + token);
  assert.match(headers.Cookie, /edge=warm/);
  assert.equal(headers["X-FE-Version"], "prod-fe-1.2.3");
  assert.ok(calls.some((u) => u.includes("/api/v1/auths/guest")));
});

test("concurrent acquires share one guest bootstrap", async () => {
  const token = jwt({ id: "guest-2" });
  let guestCalls = 0;
  const fetcher = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/auths/guest") {
      guestCalls++;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ token }), { status: 200 });
    }
    if (path === "/")
      return new Response("<html></html>", { status: 200 });
    return new Response("{}", { status: 200 });
  };
  const session = new ZaiSession({ fetcher, key: "t-single" });
  const results = await Promise.all([session.acquire(), session.acquire(), session.acquire()]);
  assert.equal(guestCalls, 1, "guest endpoint hit once, got " + guestCalls);
  for (const r of results) assert.equal(r.token, token);
});

test("an account token is validated and preferred over guest", async () => {
  const token = jwt({ id: "acct-7" });
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    const path = new URL(String(url)).pathname;
    if (path === "/")
      return new Response("<html></html>", { status: 200 });
    if (path === "/api/v1/auths/")
      return new Response(JSON.stringify({ id: "acct-7" }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
  const session = new ZaiSession({ fetcher, credential: token, key: "t-account" });
  const acquired = await session.acquire();
  assert.equal(acquired.source, "account");
  assert.equal(acquired.userId, "acct-7");
  assert.ok(!calls.some((u) => u.includes("/auths/guest")), "guest bootstrap not needed");
});

test("a rejected account token falls back to guest", async () => {
  const guest = jwt({ id: "guest-3" });
  const fetcher = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/")
      return new Response("<html></html>", { status: 200 });
    if (path === "/api/v1/auths/guest")
      return new Response(JSON.stringify({ token: guest }), { status: 200 });
    if (path === "/api/v1/auths/")
      return new Response("{}", { status: 401 });
    return new Response("{}", { status: 200 });
  };
  const session = new ZaiSession({ fetcher, credential: jwt({ id: "stale" }), key: "t-fallback" });
  const acquired = await session.acquire();
  assert.equal(acquired.source, "guest");
  assert.equal(acquired.userId, "guest-3");
});

test("a rotated cookie token is adopted and exported", async () => {
  const first = jwt({ id: "guest-4" });
  const rotated = jwt({ id: "guest-4" }, "rotated");
  const session = new ZaiSession({ fetcher: async () => new Response("{}", { status: 200 }), key: "t-rotate" });
  session._adopt(first, "guest");
  const before = session.generation;
  const seen = session.noteResponse(headersWithSetCookie("token=" + rotated + "; Path=/"));
  assert.equal(seen, rotated);
  assert.equal(session.token, rotated);
  assert.ok(session.generation > before, "generation advanced");
});

test("invalidate forces a rebuild on the next acquire", async () => {
  const first = jwt({ id: "guest-5" });
  const second = jwt({ id: "guest-5" }, "second");
  let issued = 0;
  const fetcher = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/auths/guest") {
      issued++;
      return new Response(JSON.stringify({ token: issued === 1 ? first : second }), { status: 200 });
    }
    if (path === "/")
      return new Response("<html></html>", { status: 200 });
    return new Response("{}", { status: 200 });
  };
  const session = new ZaiSession({ fetcher, key: "t-invalidate" });
  assert.equal((await session.acquire()).token, first);
  session.invalidate("401");
  assert.equal(session.state, "INVALID");
  assert.equal((await session.acquire()).token, second);
  assert.equal(issued, 2);
});

test("sessionFor reuses one session per credential", () => {
  resetSessions();
  const fetcher = async () => new Response("{}", { status: 200 });
  const a = sessionFor({ fetcher, credential: "cred-a" });
  const b = sessionFor({ fetcher, credential: "cred-a" });
  const c = sessionFor({ fetcher, credential: "cred-b" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  resetSessions();
});

test("normalizeModels reads rows out of an unknown payload shape", () => {
  const catalog = normalizeModels({
    data: {
      list: [
        { id: "glm-5.3", display_name: "GLM-5.3", capabilities: { thinking: true, vision: false, context_length: 1000000, max_tokens: 32000 } },
        { model: "glm-5.3-flash", enabled: false, capabilities: { reasoning: true, vision: true } }
      ]
    }
  });
  assert.equal(catalog.size, 2);
  const glm = catalog.get("glm-5.3");
  assert.equal(glm.reasoning, true);
  assert.equal(glm.attachment, false);
  assert.equal(glm.limit.context, 1000000);
  assert.equal(glm.available, true);
  const flash = catalog.get("glm-5.3-flash");
  assert.equal(flash.available, false);
  assert.equal(flash.attachment, true);
});

test("registry marks an unseen model unavailable for the account", async () => {
  resetRegistries();
  const fetcher = async () => new Response(JSON.stringify([{ id: "glm-5.3", capabilities: { thinking: true } }]), { status: 200 });
  const registry = new ZaiModelRegistry({
    fetcher,
    fallback: (id) => ({ id: "zai-web/" + id, reasoning: true, toolCall: false, attachment: false, modalities: { input: ["text"] }, limit: { context: 98304, output: 16384 } })
  });
  const known = await registry.resolve("glm-5.3");
  assert.equal(known.available, true);
  assert.equal(known.source, "live");
  assert.equal(known.limit.context, 98304, "fallback fills omitted context");
  const unknown = await registry.resolve("glm-5.2");
  assert.equal(unknown.available, false, "model the account cannot see is unavailable");
});

test("registry falls back when the live call fails", async () => {
  const fetcher = async () => { throw new Error("network down"); };
  const registry = new ZaiModelRegistry({
    fetcher,
    fallback: (id) => ({ id: "zai-web/" + id, reasoning: true, toolCall: false, attachment: false, modalities: { input: ["text"] }, limit: { context: 98304, output: 16384 } })
  });
  const entry = await registry.resolve("glm-5.3");
  assert.equal(entry.source, "fallback");
  assert.equal(entry.available, true);
  assert.ok(registry.status().error.length > 0);
});

test("a WAF/edge block is classified apart from a provider error", () => {
  assert.equal(__zaiTest.isWafChallenge(403, "<html><body>Aliyun WAF</body></html>"), true);
  assert.equal(__zaiTest.isWafChallenge(503, '{"error":{"code":"F001"}}'), true);
  assert.equal(__zaiTest.isWafChallenge(500, '{"error":{"message":"model overloaded"}}'), false);
  assert.equal(__zaiTest.isWafChallenge(502, "upstream timeout"), false);
});