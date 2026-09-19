import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Node-native chat.z.ai session.
//
// The gateway is Node-only, so a Z.AI session can be a real long-lived
// object: a cookie jar, an account-or-guest token, discovered frontend
// version, and single-flight refresh. Cleared when chat.z.ai rotates its
// token so a route does not keep a credential the site already retired.
//
// This needs process memory and a cookie jar, which is why it lives beside the
// Node host rather than inside a stateless request handler.

const ZAI_BASE = "https://chat.z.ai";
const ZAI_GUEST_URL = ZAI_BASE + "/api/v1/auths/guest";
const ZAI_AUTHS_URL = ZAI_BASE + "/api/v1/auths/";
const ZAI_HOME_URL = ZAI_BASE + "/";
const DEFAULT_FE_VERSION = "prod-fe-1.1.93";
const FE_VERSION_TTL_MS = 15 * 60 * 1000;
// Session bootstrap (warm/guest/auth) is a quick handshake, not a generation.
// Bound it so a stonewalled edge fails in seconds instead of riding the
// completion timeout for minutes. Matches the reference's per-call ~20s cap.
const BOOTSTRAP_TIMEOUT_MS = 20000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

export const looksLikeJwt = (value) => {
  if (typeof value !== "string")
    return false;
  const parts = value.trim().split(".");
  return parts.length === 3 && parts[1].length >= 8 && /^[\w-]+$/.test(parts[0]) && /^[\w-]+$/.test(parts[1]) && /^[\w-]+$/.test(parts[2]);
};

export function credentialToken(raw) {
  const nested = findJwt(raw);
  if (nested)
    return nested;
  const trimmed = String(raw == null ? "" : raw).trim();
  if (!trimmed)
    return "";
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);
      const token = json && (json.token || json.accessToken || json.access_token);
      if (typeof token === "string" && token.split(".").length === 3)
        return token.trim();
    } catch {
    }
    return "";
  }
  if (trimmed.split(".").length === 3 && !/[\s;=]/.test(trimmed))
    return trimmed;
  return "";
}

// Tokens arrive nested in whatever shape the site chose this month; walk the
// payload and take the first JWT-shaped string rather than guessing keys.
export function findJwt(value, depth = 0) {
  if (depth > 6 || value == null)
    return "";
  if (looksLikeJwt(value))
    return value.trim();
  if (typeof value === "string") {
    const m = value.match(/[\w-]+\.[\w-]+\.[\w-]+/);
    return m && looksLikeJwt(m[0]) ? m[0] : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findJwt(item, depth + 1);
      if (hit) return hit;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const hit = findJwt(item, depth + 1);
      if (hit) return hit;
    }
  }
  return "";
}

export function userIdFromJwt(token) {
  const payload = String(token || "").split(".")[1];
  if (!payload)
    return "";
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const id = json.id || json.user_id || json.sub;
    if (typeof id === "string" && id)
      return id;
  } catch {
  }
  return "";
}

// Node's undici exposes getSetCookie(); anything else falls back to a split
// that avoids cutting inside an Expires= date.
export function setCookieList(headers) {
  if (!headers)
    return [];
  if (typeof headers.getSetCookie === "function") {
    try {
      const list = headers.getSetCookie();
      if (Array.isArray(list) && list.length)
        return list;
    } catch {
    }
  }
  const raw = typeof headers.get === "function" ? headers.get("set-cookie") : "";
  if (!raw)
    return [];
  return String(raw).split(/,(?=[^;=]+=)/).map((s) => s.trim()).filter(Boolean);
}

export class CookieJar {
  constructor(initial) {
    this.cookies = new Map();
    if (initial)
      for (const [k, v] of Object.entries(initial)) this.cookies.set(k, String(v));
  }
  absorb(headers) {
    for (const line of setCookieList(headers)) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1)
        continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = /max-age=0/i.test(line) || /expires=thu, 01 jan 1970/i.test(line);
      if (!value || expired)
        this.cookies.delete(name);
      else
        this.cookies.set(name, value);
    }
    return this;
  }
  get(name) {
    return this.cookies.get(name) || "";
  }
  header() {
    if (!this.cookies.size)
      return "";
    return [...this.cookies].map(([k, v]) => k + "=" + v).join("; ");
  }
  toJSON() {
    return Object.fromEntries(this.cookies);
  }
}

export class ZaiSession {
  constructor({ fetcher, credential = "", key = "default" } = {}) {
    if (typeof fetcher !== "function")
      throw new Error("ZaiSession requires a fetcher(url, init)");
    this.key = key;
    this.fetcher = fetcher;
    this.credential = String(credential || "");
    this.jar = new CookieJar();
    this.token = "";
    this.userId = "";
    this.feVersion = "";
    this.source = "none"; // account | guest | none
    this.generation = 0;
    this.lastValidated = 0;
    this.lastError = "";
    this.state = "EMPTY"; // EMPTY | VALID | REFRESHING | INVALID
    this.refreshing = null;
  }

  status() {
    return {
      key: this.key,
      state: this.state,
      source: this.source,
      hasToken: !!this.token,
      userId: this.userId,
      feVersion: this.feVersion,
      generation: this.generation,
      cookies: this.jar.cookies.size,
      lastValidated: this.lastValidated,
      lastError: this.lastError
    };
  }

  // Everything a request needs to look like one browser session.
  headers(extra) {
    const headers = {
      "User-Agent": USER_AGENT,
      Origin: ZAI_BASE,
      Referer: ZAI_BASE + "/",
      ...extra
    };
    const cookie = this.jar.header();
    if (cookie)
      headers.Cookie = cookie;
    if (this.token)
      headers.Authorization = "Bearer " + this.token;
    if (this.feVersion)
      headers["X-FE-Version"] = this.feVersion;
    return headers;
  }

  async acquire() {
    if (this.state === "VALID" && this.token)
      return this.snapshot();
    const refreshed = await this.refresh("acquire");
    if (refreshed && refreshed.token)
      return refreshed;
    throw Object.assign(
      new Error("no usable Z.AI session: guest bootstrap failed and no account token was supplied"),
      { status: 503, code: "zai_credentials" }
    );
  }

  snapshot() {
    return {
      token: this.token,
      userId: this.userId,
      feVersion: this.feVersion,
      source: this.source,
      cookies: this.jar.toJSON(),
      generation: this.generation
    };
  }

  // Single-flight: concurrent callers share one refresh instead of racing.
  async refresh(reason = "manual") {
    if (this.refreshing)
      return this.refreshing;
    this.refreshing = this._refresh(reason).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async _refresh(reason) {
    this.state = "REFRESHING";
    const account = credentialToken(this.credential);
    if (account) {
      // Trust a supplied account token: warm best-effort for cookies and the
      // frontend version, then adopt it directly. The completion call is the
      // real validator — a 401 there already triggers a refresh. Gating
      // adoption on a separate /auths/ probe returning 200 threw away valid
      // account JWTs whenever that probe was WAF-challenged or non-200, then
      // fell through to guest bootstrap ("no account token" — misleading).
      await this._warm().catch(() => {});
      this._adopt(account, "account");
      return this.snapshot();
    }
    const guest = await this._bootstrapGuest();
    if (guest) {
      this._adopt(guest, "guest");
      return this.snapshot();
    }
    this.state = "INVALID";
    this.token = "";
    this.userId = "";
    this.lastError = this.lastError || "guest bootstrap produced no token (" + reason + ")";
    return null;
  }

  _adopt(token, source) {
    this.token = token;
    this.userId = userIdFromJwt(token);
    this.source = source;
    this.generation++;
    this.lastValidated = Date.now();
    this.lastError = "";
    this.state = "VALID";
    scheduleSave();
  }

  // Reject a rotated/expired token so the next acquire() rebuilds the session.
  invalidate(reason = "rejected") {
    this.lastError = reason;
    this.token = "";
    this.userId = "";
    this.state = "INVALID";
    scheduleSave();
  }

  // Called after any response; chat.z.ai reissues its session cookie as it works.
  noteResponse(headers) {
    this.jar.absorb(headers);
    const rotated = this.jar.get("token");
    if (rotated && looksLikeJwt(rotated) && rotated !== this.token) {
      this.token = rotated;
      this.userId = userIdFromJwt(rotated) || this.userId;
      this.source = this.source === "none" ? "guest" : this.source;
      this.generation++;
      scheduleSave();
      return rotated;
    }
    if (this.jar.cookies.size)
      scheduleSave();
    return "";
  }
  hydrate(row) {
    if (!row || typeof row !== "object")
      return this;
    if (row.cookies)
      this.jar = new CookieJar(row.cookies);
    if (typeof row.token === "string" && looksLikeJwt(row.token)) {
      this.token = row.token;
      this.userId = row.userId || userIdFromJwt(row.token);
      this.source = row.source || "guest";
      this.state = this.token ? "VALID" : this.state;
    }
    if (typeof row.feVersion === "string")
      this.feVersion = row.feVersion;
    if (Number(row.lastValidated))
      this.lastValidated = Number(row.lastValidated);
    if (Number(row.generation))
      this.generation = Number(row.generation);
    return this;
  }
  persistRow() {
    return {
      token: this.token,
      userId: this.userId,
      feVersion: this.feVersion,
      source: this.source,
      cookies: this.jar.toJSON(),
      lastValidated: this.lastValidated,
      generation: this.generation
    };
  }

  // Fetch + full body read under ONE deadline. upstreamFetch's own timer only
  // guards time-to-headers; a fast-headers/slow-body stall would otherwise ride
  // the 600s generation ceiling. The session owns an AbortController armed
  // until res.text() resolves, composed into the fetch via init.signal.
  async _boundedText(url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BOOTSTRAP_TIMEOUT_MS);
    try {
      const res = await this.fetcher(url, { ...init, signal: ctrl.signal, timeoutMs: BOOTSTRAP_TIMEOUT_MS });
      this.jar.absorb(res.headers);
      const body = await res.text().catch(() => "");
      return { res, body };
    } finally {
      clearTimeout(timer);
    }
  }

  // Warm the homepage first: the edge hands out cookies the API calls expect,
  // and the same response reveals the current frontend build.
  async _warm() {
    try {
      const { body } = await this._boundedText(ZAI_HOME_URL, {
        method: "GET",
        headers: { Accept: "text/html", "User-Agent": USER_AGENT }
      });
      if (this.feVersion && Date.now() - this.lastValidated < FE_VERSION_TTL_MS)
        return;
      const match = body.match(/\/frontend\/(prod-fe-\d+(?:\.\d+)*)\/assets\//);
      this.feVersion = match ? match[1] : this.feVersion || DEFAULT_FE_VERSION;
    } catch (e) {
      this.feVersion = this.feVersion || DEFAULT_FE_VERSION;
      this.lastError = "warm request failed: " + String(e && e.message || e).slice(0, 160);
    }
  }

  async _guestPost() {
    try {
      const { body } = await this._boundedText(ZAI_GUEST_URL, {
        method: "POST",
        headers: this.headers({ Accept: "application/json", "Content-Type": "application/json" }),
        body: "{}"
      });
      const fromBody = findJwt(body);
      if (fromBody)
        return fromBody;
      const fromCookie = this.jar.get("token");
      return looksLikeJwt(fromCookie) ? fromCookie : "";
    } catch (e) {
      this.lastError = "guest request failed: " + String(e && e.message || e).slice(0, 160);
      return "";
    }
  }

  async _authStatus() {
    try {
      const { body } = await this._boundedText(ZAI_AUTHS_URL, {
        method: "GET",
        headers: this.headers({ Accept: "application/json" })
      });
      const fromBody = findJwt(body);
      if (fromBody)
        return fromBody;
      const fromCookie = this.jar.get("token");
      return looksLikeJwt(fromCookie) ? fromCookie : "";
    } catch (e) {
      this.lastError = "auth status failed: " + String(e && e.message || e).slice(0, 160);
      return "";
    }
  }

  // Mirror the reference bootstrap exactly: warm, guest POST, auth GET, then a
  // SECOND guest POST fallback (the reference retries the POST when the token
  // is still empty). Guest mode is a first-class path — no account token
  // required.
  async _bootstrapGuest() {
    await this._warm();
    const first = await this._guestPost();
    if (first)
      return first;
    const auth = await this._authStatus();
    if (auth)
      return auth;
    const second = await this._guestPost();
    if (second)
      return second;
    return "";
  }
}

// One session per credential identity, kept in process memory and optionally
// mirrored to a JSON file so a restart does not re-bootstrap every guest.
const sessions = new Map();
let storePath = "";
let storeSecret = "";
let saveTimer = null;
let storeCache = null;

function defaultStorePath() {
  const db = process.env.DB_PATH || "./data/gateway.db";
  return join(dirname(db), "zai-sessions.json");
}

function storeEncryptionKey() {
  if (!storeSecret)
    return null;
  return createHash("sha256").update("zai-session-store-v1\0", "utf8").update(storeSecret, "utf8").digest();
}

function encodeStore(rows) {
  const key = storeEncryptionKey();
  if (!key)
    throw new Error("Z.AI session persistence key is not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(rows), "utf8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    data: data.toString("base64url")
  });
}

function decodeStore(raw) {
  const parsed = JSON.parse(String(raw || "{}"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return {};
  if (parsed.v !== 1 || parsed.alg !== "aes-256-gcm")
    return parsed; // legacy plaintext store; next successful save migrates it
  const key = storeEncryptionKey();
  if (!key)
    throw new Error("encrypted Z.AI session store cannot be opened without a key");
  const iv = Buffer.from(String(parsed.iv || ""), "base64url");
  const tag = Buffer.from(String(parsed.tag || ""), "base64url");
  const data = Buffer.from(String(parsed.data || ""), "base64url");
  if (iv.length !== 12 || tag.length !== 16 || !data.length)
    throw new Error("invalid Z.AI session store envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  const rows = JSON.parse(plain);
  return rows && typeof rows === "object" && !Array.isArray(rows) ? rows : {};
}

function loadStore() {
  if (storeCache)
    return storeCache;
  if (!storePath) {
    storeCache = {};
    return storeCache;
  }
  try {
    storeCache = decodeStore(readFileSync(storePath, "utf8")) || {};
  } catch {
    // Wrong/missing keys and corrupt files fail closed: do not expose or
    // overwrite secrets until a fresh session is established.
    storeCache = {};
  }
  return storeCache;
}

function scheduleSave() {
  if (!storePath || !storeSecret)
    return;
  if (saveTimer)
    return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 250);
}

export function persistNow() {
  if (!storePath || !storeSecret)
    return;
  const rows = {};
  for (const [id, session] of sessions)
    if (session.token || session.jar.cookies.size)
      rows[id] = session.persistRow();
  let tmp = "";
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    const body = encodeStore(rows);
    tmp = storePath + ".tmp-" + process.pid + "-" + randomBytes(6).toString("hex");
    writeFileSync(tmp, body, { mode: 0o600, flag: "w" });
    renameSync(tmp, storePath);
    storeCache = rows;
  } catch {
    if (tmp) {
      try { rmSync(tmp, { force: true }); } catch {}
    }
  }
}

export function configureSessionStore(path, secret = "") {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  storePath = path || "";
  storeSecret = String(secret || "");
  storeCache = null;
}

export function sessionFor({ fetcher, credential = "", key } = {}) {
  const id = key || ("cred:" + simpleHash(String(credential || "guest")));
  const existing = sessions.get(id);
  if (existing) {
    existing.fetcher = fetcher || existing.fetcher;
    if (credential && credential !== existing.credential) {
      existing.credential = credential;
      existing.invalidate("credential changed");
    }
    return existing;
  }
  const session = new ZaiSession({ fetcher, credential, key: id });
  const saved = loadStore()[id];
  if (saved)
    session.hydrate(saved);
  sessions.set(id, session);
  return session;
}

export function resetSessions() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  sessions.clear();
  storeCache = null;
}

function simpleHash(value) {
  let h = 5381;
  for (let i = 0; i < value.length; i++)
    h = ((h * 33) ^ value.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export const __sessionTest = { sessions, simpleHash, ZAI_BASE, defaultStorePath, loadStore, encodeStore, decodeStore };