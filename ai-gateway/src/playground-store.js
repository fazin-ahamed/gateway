// Playground state per console account: one settings row and saved chats
// with their messages. Scoped by the account's key id; a session for a
// plain key without an account uses that key's id the same way.
//
// Bodies live here because the user explicitly saves them in their own
// playground, unlike trajectories, which are operator telemetry. Retention is
// simple: delete chats the user deletes, nothing else touches this table.

export const PLAYGROUND_MESSAGE_CAP = 256 * 1024;

const ensured = new WeakSet();

export async function ensurePlaygroundStore(db) {
  if (!db || ensured.has(db)) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS console_playground_state (account_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS console_playground_chats (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, title TEXT NOT NULL, messages_json TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_pg_chats_account ON console_playground_chats(account_id, updated_at)").run();
  ensured.add(db);
}

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text || "");
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

export async function loadSettings(db, accountId) {
  await ensurePlaygroundStore(db);
  const row = await db.prepare("SELECT settings_json FROM console_playground_state WHERE account_id=?").bind(accountId).first();
  return parseJson(row && row.settings_json, {});
}

export async function saveSettings(db, accountId, settings) {
  await ensurePlaygroundStore(db);
  const at = new Date().toISOString();
  await db.prepare(
    "INSERT INTO console_playground_state (account_id, settings_json, updated_at) VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at"
  ).bind(accountId, JSON.stringify(settings || {}), at).run();
}

export function validateChatMessages(messages) {
  if (!Array.isArray(messages)) return { error: "messages must be an array" };
  const out = [];
  for (const m of messages.slice(0, 500)) {
    if (!m || typeof m !== "object") return { error: "each message must be an object" };
    const role = String(m.role || "");
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") return { error: "unknown message role " + role };
    const content = typeof m.content === "string" ? m.content : m.content == null ? "" : JSON.stringify(m.content);
    const entry = { role, content: content.slice(0, PLAYGROUND_MESSAGE_CAP) };
    if (Array.isArray(m.tool_calls)) entry.tool_calls = m.tool_calls.slice(0, 20);
    if (typeof m.reasoning === "string") entry.reasoning = m.reasoning.slice(0, PLAYGROUND_MESSAGE_CAP);
    out.push(entry);
  }
  return { messages: out };
}

export async function listChats(db, accountId) {
  await ensurePlaygroundStore(db);
  const rows = await db.prepare(
    "SELECT id, title, model, created_at, updated_at FROM console_playground_chats WHERE account_id=? ORDER BY updated_at DESC LIMIT 100"
  ).bind(accountId).all();
  return (rows.results || []).map((r) => ({ id: r.id, title: r.title, model: r.model || null, created_at: r.created_at, updated_at: r.updated_at }));
}

export async function getChat(db, accountId, id) {
  await ensurePlaygroundStore(db);
  const row = await db.prepare("SELECT * FROM console_playground_chats WHERE account_id=? AND id=?").bind(accountId, id).first();
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    model: row.model || null,
    messages: parseJson(row.messages_json, []),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function upsertChat(db, accountId, id, { title, model, messages }) {
  await ensurePlaygroundStore(db);
  const existing = await db.prepare("SELECT id, title, created_at FROM console_playground_chats WHERE account_id=? AND id=?").bind(accountId, id).first();
  const now = new Date().toISOString();
  const finalTitle = (title || "").trim().slice(0, 80) || (existing ? existing.title : "New chat");
  if (existing) {
    await db.prepare("UPDATE console_playground_chats SET title=?, model=?, messages_json=?, updated_at=? WHERE account_id=? AND id=?")
      .bind(finalTitle, model || null, JSON.stringify(messages), now, accountId, id).run();
    return { id, title: finalTitle, created_at: existing.created_at, updated_at: now };
  }
  await db.prepare("INSERT INTO console_playground_chats (id, account_id, title, messages_json, model, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, accountId, finalTitle, JSON.stringify(messages), model || null, now, now).run();
  return { id, title: finalTitle, created_at: now, updated_at: now };
}

export async function deleteChat(db, accountId, id) {
  await ensurePlaygroundStore(db);
  await db.prepare("DELETE FROM console_playground_chats WHERE account_id=? AND id=?").bind(accountId, id).run();
}
