import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { createApp } from "../src/index.js";
import { loadSettings, saveSettings, upsertChat, getChat, listChats, deleteChat, validateChatMessages } from "../src/playground-store.js";

function db() {
  const d = createDb(":memory:");
  return d;
}

test("settings persist per account and overwrite in place", async () => {
  const d = db();
  await saveSettings(d, "acct-1", { model: "glm-5.3", temperature: 0.7 });
  await saveSettings(d, "acct-2", { model: "other" });
  await saveSettings(d, "acct-1", { model: "kimi-k2", temperature: 1 });
  assert.deepEqual(await loadSettings(d, "acct-1"), { model: "kimi-k2", temperature: 1 });
  assert.deepEqual(await loadSettings(d, "acct-2"), { model: "other" });
});

test("chats round-trip with messages, title and model; list shows newest first", async () => {
  const d = db();
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there", reasoning: "thought a bit" }
  ];
  const first = await upsertChat(d, "acct-1", "c1", { title: "", model: "glm-5.3", messages });
  assert.equal(first.title, "New chat");
  const again = await upsertChat(d, "acct-1", "c1", { title: "Renamed", model: "glm-5.3", messages });
  assert.equal(again.title, "Renamed");
  const chat = await getChat(d, "acct-1", "c1");
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[1].reasoning, "thought a bit");
  assert.equal(chat.title, "Renamed");
  const list = await listChats(d, "acct-1");
  assert.equal(list.length, 1);
  await deleteChat(d, "acct-1", "c1");
  assert.equal(await getChat(d, "acct-1", "c1"), null);
});

test("one account cannot read another account's chat", async () => {
  const d = db();
  await upsertChat(d, "acct-1", "c1", { title: "Private", model: null, messages: [] });
  assert.equal(await getChat(d, "acct-2", "c1"), null);
  await deleteChat(d, "acct-2", "c1");
  assert.ok(await getChat(d, "acct-1", "c1"), "deleting with the wrong id does nothing");
});

test("message validation rejects unknown roles and caps long content", () => {
  assert.ok(validateChatMessages([{ role: "admin", content: "x" }]).error);
  assert.ok(validateChatMessages("no").error);
  const ok = validateChatMessages([{ role: "user", content: "x".repeat(400000) }]);
  assert.equal(ok.messages[0].content.length, 262144);
});

test("the HTTP surface requires a session and validates input", async () => {
  const d = createDb(":memory:");
  d.exec((await import("node:fs")).readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const app = createApp({ DB: d, ADMIN_TOKEN: "a", PROVIDER_CRYPTO_KEY: "k" });
  const anon = await app.fetch(new Request("http://gw/console/api/playground"));
  assert.equal(anon.status, 401);
  const now = new Date().toISOString();
  d.prepare("INSERT INTO api_keys (key_id,name,active,budget_mode,budget_limit,console_auth,created_at,updated_at) VALUES ('sk-x','x',1,'usd',1e12,0,?,?)").bind(now, now).run();
  const auth = await app.fetch(new Request("http://gw/console/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: "sk-x" }) }));
  const cookie = "gw_client=" + auth.headers.get("set-cookie").match(/gw_client=([^;]+)/)[1];
  const bad = await app.fetch(new Request("http://gw/console/api/playground", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ settings: [1, 2] }) }));
  assert.equal(bad.status, 400);
  await app.fetch(new Request("http://gw/console/api/playground", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ settings: { model: "m" } }) }));
  const save = await app.fetch(new Request("http://gw/console/api/playground/chats", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], title: "T", model: "m" }) }));
  assert.equal(save.status, 201);
  const meta = await save.json();
  const state = await (await app.fetch(new Request("http://gw/console/api/playground", { headers: { cookie } }))).json();
  assert.deepEqual(state.settings, { model: "m" });
  assert.equal(state.chats[0].id, meta.id);
  const chat = await (await app.fetch(new Request("http://gw/console/api/playground/chats/" + meta.id, { headers: { cookie } }))).json();
  assert.equal(chat.messages[0].content, "hi");
  const del = await app.fetch(new Request("http://gw/console/api/playground/chats/" + meta.id, { method: "DELETE", headers: { cookie } }));
  assert.equal(del.status, 200);
});
