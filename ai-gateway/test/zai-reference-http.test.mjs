import test from "node:test";
import assert from "node:assert/strict";

import { __zaiTest, callZaiWeb, modelCatalogEntry } from "../src/zaiweb.js";
import { configureSessionStore, resetSessions } from "../src/zai-session.js";
import { resetRegistries } from "../src/zai-models.js";
import { zaiWaf } from "../src/zai-waf.js";
import {
  acquireZaiChatId,
  releaseZaiChatId,
  resetZaiSessionPools,
  zaiSessionPoolStatus
} from "../src/zai-session-pool.js";
import {
  __zaiVisionTest,
  isPublicImageAddress,
  processZaiVisionMessages
} from "../src/zai-vision.js";

test("reference HTTP model id keeps public glm slug instead of browser alias", () => {
  assert.equal(__zaiTest.referenceHttpModelId("zai/glm-5.3-flash"), "glm-5.3-flash");
  assert.equal(__zaiTest.referenceHttpModelId("x-preview-l"), "glm-5.3-flash");
});

test("reference completion body stays minimal and supports files + advanced search", () => {
  const body = __zaiTest.buildReferenceCompletionBody({
    captchaVerifyParam: "proof",
    chatId: "chat-1",
    messages: [{ role: "user", content: "hello" }],
    modelId: "glm-5.3-flash",
    prompt: "hello",
    thinking: { enabled: true, effort: "high", effortSupported: true },
    features: { webSearchEnabled: false, advancedSearchEnabled: true },
    files: [{ id: "file-1" }]
  });
  assert.equal(body.model, "glm-5.3-flash");
  assert.equal(body.chat_id, "chat-1");
  assert.equal(body.signature_prompt, "hello");
  assert.equal(body.stream, true);
  assert.equal(body.captcha_verify_param, "proof");
  assert.deepEqual(body.mcp_servers, ["advanced-search"]);
  assert.deepEqual(body.files, [{ id: "file-1" }]);
  assert.equal(body.features.enable_thinking, true);
  assert.equal(Object.prototype.hasOwnProperty.call(body.features, "auto_web_search"), false, "advanced search must not silently enable normal web search");
  assert.equal(body.features.web_search, false);
  assert.equal(body.features.image_generation, false);

  for (const legacy of ["params", "extra", "variables", "id", "current_user_message_id", "background_tasks"])
    assert.equal(Object.prototype.hasOwnProperty.call(body, legacy), false, "legacy field leaked: " + legacy);
});

test("normal web search and advanced-search MCP stay independent", () => {
  const normal = __zaiTest.buildReferenceCompletionBody({
    captchaVerifyParam: "proof",
    chatId: "chat-web",
    messages: [{ role: "user", content: "search" }],
    modelId: "glm-5.3",
    prompt: "search",
    thinking: { enabled: true, effort: "high", effortSupported: true },
    features: { webSearchEnabled: true, advancedSearchEnabled: false },
    files: []
  });
  assert.equal(normal.features.auto_web_search, true);
  assert.equal(Object.prototype.hasOwnProperty.call(normal, "mcp_servers"), false);

  const resolved = __zaiTest.resolveFeatures({ advancedSearch: true }, false);
  assert.equal(resolved.advancedSearchEnabled, true);
  assert.equal(resolved.webSearchEnabled, false);
});

test("canonical HTTP adapter succeeds without /chats/new and deletes only the referenced chat", async () => {
  resetSessions();
  resetRegistries();
  resetZaiSessionPools();
  configureSessionStore("");
  zaiWaf.recordSuccess();

  const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const token = [b64u({ alg: "HS256" }), b64u({ id: "acct-e2e" }), "sig"].join(".");
  const credential = JSON.stringify({ token, captcha_verify_param: "proof-e2e" });
  const calls = [];
  let completionBody = null;

  const fetcher = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = String(init.method || "GET").toUpperCase();
    calls.push(method + " " + u.pathname);
    if (u.pathname === "/" && method === "GET")
      return new Response('<script src="/frontend/prod-fe-9.9.9/assets/x.js"></script>', { status: 200 });
    if (u.pathname === "/api/v1/auths/" && method === "GET")
      return new Response(JSON.stringify({ id: "acct-e2e" }), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/models" && method === "GET")
      return new Response(JSON.stringify([{ id: "glm-5.3", capabilities: { thinking: true } }]), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/v2/chat/completions" && method === "POST") {
      completionBody = JSON.parse(String(init.body || "{}"));
      const stream =
        "data: " + JSON.stringify({ data: { delta_content: "works", phase: "answer" } }) + "\n" +
        "data: " + JSON.stringify({ data: { done: true, phase: "done" } }) + "\n";
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (u.pathname.startsWith("/api/v1/chats/") && method === "DELETE")
      return new Response("true", { status: 200 });
    return new Response("unexpected", { status: 500 });
  };

  const shaped = await callZaiWeb(
    {},
    { upstream_model: "glm-5.3", zai_session_key: "e2e-http" },
    credential,
    { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] },
    false,
    fetcher
  );
  const body = JSON.parse(await shaped.response.text());
  assert.equal(body.choices[0].message.content, "works");
  assert.ok(completionBody);
  assert.match(completionBody.chat_id, /^[0-9a-f-]{36}$/i);
  assert.equal(completionBody.captcha_verify_param, "proof-e2e");
  assert.equal(calls.some((x) => x.includes("/api/v1/chats/new")), false);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.filter((x) => x.startsWith("DELETE /api/v1/chats/")).length, 1);
  zaiWaf.recordSuccess();
});

test("open WAF circuit fails before session/model traffic", async () => {
  resetSessions();
  resetRegistries();
  configureSessionStore("");
  zaiWaf.recordSuccess();
  zaiWaf.recordBlock("test");
  let calls = 0;
  const fetcher = async () => {
    calls++;
    throw new Error("network must not be touched while breaker is open");
  };
  try {
    await assert.rejects(
      callZaiWeb(
        {},
        { upstream_model: "glm-5.3", zai_session_key: "blocked-e2e" },
        JSON.stringify({ token: "x.y.z", captcha_verify_param: "proof" }),
        { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] },
        false,
        fetcher
      ),
      (err) => err && err.code === "zai_waf"
    );
    assert.equal(calls, 0);
  } finally {
    zaiWaf.recordSuccess();
  }
});

test("reference signature prompt is all message text in order", () => {
  assert.equal(
    __zaiTest.referencePrompt([
      { role: "system", content: "system rules" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: [{ type: "text", text: "next" }] }
    ]),
    "system rules\n\nhello\n\nhi\n\nnext"
  );
});

test("ZAI catalog advertises gateway-emulated tools and real flash vision", () => {
  const flash = modelCatalogEntry("glm-5.3-flash");
  assert.equal(flash.toolCall, true);
  assert.equal(flash.attachment, true);
  assert.deepEqual(flash.modalities.input, ["text", "image"]);
});

test("throwaway chat-id pool is local, replenished, and cleanup is async", async () => {
  resetZaiSessionPools();
  const a = acquireZaiChatId("acct", 2);
  const b = acquireZaiChatId("acct", 2);
  assert.notEqual(a.chatId, b.chatId);
  assert.equal(zaiSessionPoolStatus("acct").ready, 2);

  let cleaned = "";
  releaseZaiChatId("acct", a.chatId, async (id) => { cleaned = id; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cleaned, a.chatId);
});

test("vision pipeline uploads data URLs and rewrites image_url to the ZAI file id", async () => {
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(String(url), "https://chat.z.ai/api/v1/files/");
    assert.equal(init.method, "POST");
    assert.match(String(init.headers.Authorization), /^Bearer /);
    return new Response(JSON.stringify({
      id: "file-123",
      filename: "image.png",
      meta: { size: 4 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const tiny = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const result = await processZaiVisionMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64," + tiny } }
      ]
    }
  ], { token: "jwt", fetchImpl: mockFetch });

  assert.equal(calls.length, 1);
  assert.equal(result.messages[0].content[1].image_url.url, "file-123");
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].id, "file-123");
  assert.equal(result.files[0].type, "image");
  assert.equal(result.imageParts[0].image_url.url, "file-123");
});

test("vision SSRF guard rejects non-public addresses", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1"])
    assert.equal(isPublicImageAddress(ip), false, ip);
  assert.equal(isPublicImageAddress("1.1.1.1"), true);
  assert.equal(isPublicImageAddress("2606:4700:4700::1111"), true);
});

test("data URL decoder enforces image metadata without temp files", () => {
  const tiny = Buffer.from([1, 2, 3]).toString("base64");
  const image = __zaiVisionTest.decodeDataUrl("data:image/webp;base64," + tiny);
  assert.equal(image.data.length, 3);
  assert.equal(image.contentType, "image/webp");
  assert.equal(image.filename, "image.webp");
});
