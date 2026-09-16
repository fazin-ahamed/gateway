// Browser-backed chat.z.ai transport.
//
// Why this exists: chat.z.ai issues its CAPTCHA proof per completion, and the
// proof cannot be harvested, reused, or derived from the session (measured:
// a proof pulled off the page's own request is already consumed, and a stored
// proof works exactly once). Driving the real page is therefore the only way
// to use this account class without a human pasting a fresh proof each turn --
// the page's own JavaScript mints the proof in the right context.
//
// This runs only where a browser can: the Node host. The Worker build never
// executes it, and importing it there is harmless because playwright is pulled
// in lazily, only when a browser-backed request actually arrives.

const ZAI_BASE_URL = "https://chat.z.ai";
const ZAI_CHAT_URL = ZAI_BASE_URL + "/api/v2/chat/completions";
const ZAI_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const DEFAULT_TURN_TIMEOUT_MS = 120000;
const PAGE_IDLE_CLOSE_MS = 300000;
const MAX_TURNS_PER_PAGE = 60;

// One shared browser process; pages are pooled per credential so a warm session
// (and its captcha continuity) is reused instead of paying a cold start.
const pools = new Map();
let browserPromise = null;

function poolKey(token) {
  return "zai:" + String(token).slice(-24);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (e) {
    try {
      return await import("playwright-core");
    } catch {
      throw new ZaiBrowserUnavailable('playwright is not installed on this host; run "npm install playwright && npx playwright install chromium" (or point BROWSER_EXECUTABLE at an existing Chromium).');
    }
  }
}

export class ZaiBrowserUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "ZaiBrowserUnavailable";
    this.status = 503;
    this.code = "zai_browser_unavailable";
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await loadPlaywright();
      const executablePath = process.env.BROWSER_EXECUTABLE || undefined;
      // Headed but off-screen: chat.z.ai rejects true headless Chromium with
      // F001, the same reason omniRoute drives a headed browser.
      const launch = { headless: false, args: ["--window-position=4000,4000", "--mute-audio", "--no-sandbox", "--disable-dev-shm-usage"] };
      if (executablePath)
        launch.executablePath = executablePath;
      const browser = await chromium.launch(launch);
      browser.on("disconnected", () => {
        browserPromise = null;
        pools.clear();
      });
      return browser;
    })().catch((e) => {
      browserPromise = null;
      throw e instanceof ZaiBrowserUnavailable ? e : new ZaiBrowserUnavailable("could not launch Chromium for the Z.AI browser transport: " + String(e && e.message || e).slice(0, 200));
    });
  }
  return browserPromise;
}

async function getPool(token) {
  const key = poolKey(token);
  const existing = pools.get(key);
  if (existing)
    return existing;
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: ZAI_USER_AGENT, locale: "en-US", viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: "token", value: token, domain: "chat.z.ai", path: "/" }]);
  const pool = { context, page: null, turns: 0, idleTimer: null, lastUsed: Date.now() };
  pools.set(key, pool);
  return pool;
}

async function getPage(pool, token) {
  if (pool.page && pool.turns < MAX_TURNS_PER_PAGE) {
    if (pool.idleTimer) {
      clearTimeout(pool.idleTimer);
      pool.idleTimer = null;
    }
    return pool.page;
  }
  if (pool.page)
    await Promise.resolve(pool.page.close().catch(() => {})).catch(() => {});
  pool.turns = 0;
  const page = await pool.context.newPage();
  // Seed the session the page reads at boot, then reload so it picks it up.
  await page.goto(ZAI_BASE_URL + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate(([t]) => {
    try {
      localStorage.setItem("token", t);
    } catch {
    }
  }, [token]);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  pool.page = page;
  return page;
}

function armIdleClose(pool, key) {
  if (pool.idleTimer)
    clearTimeout(pool.idleTimer);
  pool.idleTimer = setTimeout(async () => {
    try {
      await pool.context.close();
    } catch {
    }
    pools.delete(key);
  }, PAGE_IDLE_CLOSE_MS);
}

/**
 * Fold the caller's conversation into the single prompt this transport sends.
 *
 * The page keeps its own conversation state, so a fresh page per request plus
 * the full folded history keeps every gateway request self-contained (agents
 * resend history anyway). System/developer turns head the prompt.
 */
export function foldPrompt(messages, system) {
  const out = [];
  if (typeof system === "string" && system.trim())
    out.push("SYSTEM:\n" + system.trim());
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m)
      continue;
    const text = textOf(m.content);
    if (!text.trim())
      continue;
    out.push((m.role === "assistant" ? "ASSISTANT" : m.role === "system" || m.role === "developer" ? "SYSTEM" : "USER") + ":\n" + text);
  }
  return out.join("\n\n");
}

function textOf(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object")
      continue;
    if (typeof part.text === "string")
      parts.push(part.text);
    else if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string")
      parts.push("[image: " + part.image_url.url.slice(0, 2048) + "]");
  }
  return parts.join("\n");
}

/**
 * Drive one turn: type the prompt, submit, and capture the page's own
 * completion response. Returns the parsed frame stream as text, which the
 * shared frame parser turns into OpenAI chunks.
 */
export async function runBrowserTurn(token, prompt, options = {}) {
  const timeoutMs = Number(options.turnTimeoutMs) || DEFAULT_TURN_TIMEOUT_MS;
  const key = poolKey(token);
  const pool = await getPool(token);
  const page = await getPage(pool, token);
  let resolveResponse;
  const responsePromise = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  let settled = false;
  const onResponse = async (res) => {
    if (settled || !res.url().includes("/api/v2/chat/completions"))
      return;
    settled = true;
    let body = "";
    try {
      body = await res.text();
    } catch {
    }
    resolveResponse({ status: res.status(), body });
  };
  page.on("response", onResponse);
  try {
    const input = page.locator("#chat-input").first();
    await input.waitFor({ state: "visible", timeout: 30000 });
    await input.fill(prompt);
    const send = page.locator('[aria-label="Send Message"] button:not([disabled])').first();
    await send.click({ timeout: 20000 });
    const result = await Promise.race([
      responsePromise,
      new Promise((resolve) => setTimeout(() => resolve({ status: 0, body: "", timeout: true }), timeoutMs))
    ]);
    pool.turns++;
    pool.lastUsed = Date.now();
    armIdleClose(pool, key);
    if (!result.status && result.timeout)
      throw new Error("the page did not issue a completion within " + timeoutMs + "ms");
    return result;
  } finally {
    page.off("response", onResponse);
  }
}

export async function closeBrowserPools() {
  for (const [key, pool] of pools) {
    try {
      await pool.context.close();
    } catch {
    }
    pools.delete(key);
  }
  const browser = await browserPromise?.catch(() => null);
  if (browser)
    await browser.close().catch(() => {});
  browserPromise = null;
}

export const __browserTest = { foldPrompt, poolKey, ZAI_CHAT_URL };
