import test from "node:test";
import assert from "node:assert/strict";

import { __zaiTest, modelCatalogEntry } from "../src/zaiweb.js";
import { ZaiModelRegistry } from "../src/zai-models.js";
import { takeDeviceToken } from "../src/zai-tokens.js";
import { createDb } from "../../server/db.mjs";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    features: { webSearchEnabled: true, advancedSearchEnabled: true },
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
  assert.equal(body.features.auto_web_search, true);
  assert.equal(body.features.web_search, false);
  assert.equal(body.features.image_generation, false);

  for (const legacy of ["params", "extra", "variables", "id", "current_user_message_id", "background_tasks"])
    assert.equal(Object.prototype.hasOwnProperty.call(body, legacy), false, "legacy field leaked: " + legacy);
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

test("ZAI catalog advertises pure-HTTP vision but browser fallback does not", () => {
  const flash = modelCatalogEntry("glm-5.3-flash", "zaiminted");
  assert.equal(flash.toolCall, true);
  assert.equal(flash.attachment, true);
  assert.deepEqual(flash.modalities.input, ["text", "image"]);

  const browser = modelCatalogEntry("glm-5.3-flash", "zaiwebbrowser");
  assert.equal(browser.toolCall, true);
  assert.equal(browser.attachment, false);
  assert.deepEqual(browser.modalities.input, ["text"]);
});

test("live explicit vision=false overrides static flash vision fallback", async () => {
  const registry = new ZaiModelRegistry({
    fetcher: async () => new Response(JSON.stringify([
      { id: "x-preview-l", capabilities: { thinking: true, vision: false } }
    ]), { status: 200, headers: { "content-type": "application/json" } }),
    fallback: (id) => modelCatalogEntry(id, "zaiminted")
  });
  const resolved = await registry.resolve("glm-5.3-flash");
  assert.equal(resolved.available, true);
  assert.equal(resolved.attachment, false);
  assert.deepEqual(resolved.modalities.input, ["text"]);
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

test("vision SSRF guard rejects private and IPv4-mapped private addresses", () => {
  for (const ip of [
    "127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254",
    "::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1"
  ])
    assert.equal(isPublicImageAddress(ip), false, ip);
  assert.equal(isPublicImageAddress("1.1.1.1"), true);
  assert.equal(isPublicImageAddress("::ffff:8.8.8.8"), true);
  assert.equal(isPublicImageAddress("2606:4700:4700::1111"), true);
});

test("data URL decoder enforces image metadata without temp files", () => {
  const tiny = Buffer.from([1, 2, 3]).toString("base64");
  const image = __zaiVisionTest.decodeDataUrl("data:image/webp;base64," + tiny);
  assert.equal(image.data.length, 3);
  assert.equal(image.contentType, "image/webp");
  assert.equal(image.filename, "image.webp");
});


test("vision upload forwards response headers for session token/cookie rotation", async () => {
  let seen = "";
  const tiny = Buffer.from([1, 2, 3]).toString("base64");
  await processZaiVisionMessages([{
    role: "user",
    content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + tiny } }]
  }], {
    token: "jwt",
    onResponse: (headers) => { seen = headers.get("set-cookie") || ""; },
    fetchImpl: async () => new Response(JSON.stringify({ id: "file-rotate", filename: "x.png" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "token=rotated.jwt.value; Path=/"
      }
    })
  });
  assert.match(seen, /token=rotated\.jwt\.value/);
});

test("SQLite device-token FIFO imports legacy file once and consumes in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zai-token-"));
  const file = join(dir, "tokens.txt");
  const db = createDb(join(dir, "gateway.db"));
  writeFileSync(file, "tok-a\ntok-b\n");

  const a = await takeDeviceToken(file, db);
  assert.equal(a.token, "tok-a");
  assert.equal(a.remaining, 1);
  assert.equal(a.source, "sqlite");
  assert.equal(readFileSync(file, "utf8"), "");

  const b = await takeDeviceToken(file, db);
  assert.equal(b.token, "tok-b");
  assert.equal(b.remaining, 0);

  const empty = await takeDeviceToken(file, db);
  assert.equal(empty.token, null);
});
