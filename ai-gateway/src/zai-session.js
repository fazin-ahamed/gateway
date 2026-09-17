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
const DEFAULT_FE_VERSION = "prod-fe-1.1.92";
const FE_VERSION_TTL_MS = 15 * 60 * 1000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

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
      if (await this._validate(account)) {
        this._adopt(account, "account");
        return this.snapshot();
      }
      this.lastError = "account token rejected";
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
  }

  // Reject a rotated/expired token so the next acquire() rebuilds the session.
  invalidate(reason = "rejected") {
    this.lastError = reason;
    this.token = "";
    this.userId = "";
    this.state = "INVALID";
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
      return rotated;
    }
    return "";
  }

  async _validate(token) {
    try {
      await this._warm();
      const res = await this.fetcher(ZAI_AUTHS_URL, {
        method: "GET",
        headers: this.headers({ Authorization: "Bearer " + token, Accept: "application/json" })
      });
      this.jar.absorb(res.headers);
      return !!res.ok;
    } catch (e) {
      this.lastError = "session validation failed: " + String(e && e.message || e).slice(0, 160);
      return false;
    }
  }

  // Warm the homepage first: the edge hands out cookies the API calls expect,
  // and the same response reveals the current frontend build.
  async _warm() {
    try {
      const res = await this.fetcher(ZAI_HOME_URL, {
        method: "GET",
        headers: { Accept: "text/html", "User-Agent": USER_AGENT }
      });
      this.jar.absorb(res.headers);
      if (this.feVersion && Date.now() - this.lastValidated < FE_VERSION_TTL_MS)
        return res;
      const body = await res.text().catch(() => "");
      const match = body.match(/\/frontend\/(prod-fe-\d+(?:\.\d+)*)\/assets\//);
      this.feVersion = match ? match[1] : this.feVersion || DEFAULT_FE_VERSION;
      return res;
    } catch (e) {
      this.feVersion = this.feVersion || DEFAULT_FE_VERSION;
      this.lastError = "warm request failed: " + String(e && e.message || e).slice(0, 160);
      return null;
    }
  }

  async _bootstrapGuest() {
    await this._warm();
    // 1. Ask the site for a guest session.
    try {
      const res = await this.fetcher(ZAI_GUEST_URL, {
        method: "POST",
        headers: this.headers({ Accept: "application/json", "Content-Type": "application/json" }),
        body: "{}"
      });
      this.jar.absorb(res.headers);
      const body = await res.text().catch(() => "");
      const fromBody = findJwt(body);
      if (fromBody)
        return fromBody;
      const fromCookie = this.jar.get("token");
      if (looksLikeJwt(fromCookie))
        return fromCookie;
    } catch (e) {
      this.lastError = "guest request failed: " + String(e && e.message || e).slice(0, 160);
    }
    // 2. Fall back to the auth status endpoint, which also reports the token.
    try {
      const res = await this.fetcher(ZAI_AUTHS_URL, {
        method: "GET",
        headers: this.headers({ Accept: "application/json" })
      });
      this.jar.absorb(res.headers);
      const body = await res.text().catch(() => "");
      const fromBody = findJwt(body);
      if (fromBody)
        return fromBody;
      const fromCookie = this.jar.get("token");
      if (looksLikeJwt(fromCookie))
        return fromCookie;
    } catch (e) {
      this.lastError = "auth status failed: " + String(e && e.message || e).slice(0, 160);
    }
    return "";
  }
}

// One session per credential identity, kept in process memory: the Node host
// outlives requests, so a warm guest session is reused instead of re-bootstrapped.
const sessions = new Map();

export function sessionFor({ fetcher, credential = "", key } = {}) {
  const id = key || ("cred:" + simpleHash(String(credential || "guest")));
  const existing = sessions.get(id);
  if (existing) {
    existing.fetcher = fetcher || existing.fetcher;
    if (credential && credential !== existing.credential)
      existing.credential = credential;
    return existing;
  }
  const session = new ZaiSession({ fetcher, credential, key: id });
  sessions.set(id, session);
  return session;
}

export function resetSessions() {
  sessions.clear();
}

function simpleHash(value) {
  let h = 5381;
  for (let i = 0; i < value.length; i++)
    h = ((h * 33) ^ value.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export const __sessionTest = { sessions, simpleHash, ZAI_BASE };