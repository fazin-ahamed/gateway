import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
// Browser-backed chat.z.ai transport.
//
// Why this exists: chat.z.ai issues its CAPTCHA proof per completion, and the
// proof cannot be harvested, reused, or derived from the session (measured:
// a proof pulled off the page's own request is already consumed, and a stored
// proof works exactly once). Driving the real page is therefore the only way
// to use this account class without a human pasting a fresh proof each turn --
// the page's own JavaScript mints the proof in the right context.
//
// Playwright is imported lazily, only when a browser-backed request actually
// arrives, so hosts without Chromium still serve every other provider.

const ZAI_BASE_URL = "https://chat.z.ai";
const ZAI_CHAT_URL = ZAI_BASE_URL + "/api/v2/chat/completions";
const COMPOSER_SELS = ["#chat-input", "textarea#chat-input", "textarea[placeholder]", "[contenteditable='true']", "div[contenteditable='true']"];
const SEND_SELS = ["#send-message-button", '[aria-label="Send Message"] button', 'button[type="submit"]'];
const DEFAULT_TURN_TIMEOUT_MS = 120000;
const PAGE_IDLE_CLOSE_MS = 300000;

// One shared browser process; contexts are pooled per credential. Each
// gateway request gets a fresh page so chat.z.ai history cannot leak
// across OpenAI-compatible turns. A per-pool mutex serializes fill/click.
const pools = new Map();
let browserPromise = null;
let xvfbProc = null;

function sha256hexSync(str) {
  return createHash("sha256").update(String(str)).digest("hex");
}

function poolKey(token, stableId = "") {
  const basis = stableId ? "stable:" + String(stableId) : "token:" + String(token);
  try {
    return "zai:" + sha256hexSync(basis).slice(0, 32);
  } catch {
    return "zai:" + basis.length + ":" + basis.slice(0, 8);
  }
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

function displaySocket(display) {
  const n = String(display || "").replace(/^:/, "");
  return "/tmp/.X11-unix/X" + n;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Prefer a real display (operator X or leftover Xvfb). If none, do not fail
// the request: Chrome's new headless (--headless=new) needs no X server and
// is not the old headless that chat.z.ai F001-rejected.
async function ensureDisplay() {
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
    return process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  const display = process.env.ZAI_XVFB_DISPLAY || ":99";
  if (existsSync(displaySocket(display))) {
    process.env.DISPLAY = display;
    return display;
  }
  let xvfb;
  try {
    xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"], {
      stdio: "ignore",
      detached: true
    });
  } catch {
    return "";
  }
  xvfb.on("error", () => {});
  xvfb.unref();
  xvfbProc = xvfb;
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (existsSync(displaySocket(display))) {
      process.env.DISPLAY = display;
      return display;
    }
    if (xvfb.exitCode != null)
      return "";
    await sleep(50);
  }
  return "";
}

function launchOptions(executablePath, headed) {
  const args = ["--mute-audio", "--no-sandbox", "--disable-dev-shm-usage"];
  if (headed) {
    args.push("--window-position=4000,4000");
    return { headless: false, args, executablePath };
  }
  // Chrome 112+ new headless: full browser, no X. Old `--headless` is the
  // F001 fingerprint; this flag is the replacement.
  args.push("--headless=new", "--disable-gpu", "--hide-scrollbars");
  return { headless: true, args, executablePath };
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const display = await ensureDisplay();
      const { chromium } = await loadPlaywright();
      const executablePath = process.env.BROWSER_EXECUTABLE || undefined;
      const headed = !!(display || process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
      const launch = launchOptions(executablePath, headed);
      if (!launch.executablePath)
        delete launch.executablePath;
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

async function syncPoolToken(pool, token) {
  if (!pool || !token || pool.token === token)
    return;
  pool.token = token;
  await pool.context.addCookies([{ name: "token", value: token, domain: "chat.z.ai", path: "/" }]).catch(() => {});
  if (pool.page && !pool.page.isClosed()) {
    await pool.page.evaluate((t) => {
      try { localStorage.setItem("token", t); } catch {}
    }, token).catch(() => {});
  }
}

async function getPool(token, stableId = "") {
  const key = poolKey(token, stableId);
  const existing = pools.get(key);
  if (existing) {
    await syncPoolToken(existing, token);
    return existing;
  }
  const browser = await getBrowser();
  const chromMajor = String(browser.version() || "150").split(".")[0];
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chromMajor + ".0.0.0 Safari/537.36";
  const context = await browser.newContext({
    userAgent: ua,
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1280, height: 800 },
    screen: { width: 1920, height: 1080 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" }
  });
  await context.addCookies([{ name: "token", value: token, domain: "chat.z.ai", path: "/" }]);
  try {
    const { buildStealthScript } = await import("../../scripts/zai-harvest-stealth.js");
    await context.addInitScript({ content: buildStealthScript(chromMajor) });
  } catch {
  }
  const pool = {
    context,
    page: null,
    lock: Promise.resolve(),
    idleTimer: null,
    lastUsed: Date.now(),
    token,
    key,
    stableId: String(stableId || "")
  };
  pools.set(key, pool);
  return pool;
}
function withLock(pool, fn) {
  const prev = pool.lock || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  pool.lock = prev.then(() => gate, () => gate);
  return prev.catch(() => {}).then(fn).finally(() => release());
}
async function startNewChat(page) {
  const sels = [
    '[aria-label="New Chat"]',
    '[aria-label="New chat"]',
    'button:has-text("New Chat")',
    'a[href="/"]',
    'button:has-text("New conversation")'
  ];
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      await loc.click({ timeout: 2500 }).catch(() => {});
      return;
    }
  }
}

async function firstVisible(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false))
        return loc;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function pageDump(page) {
  let url = "", title = "", body = "";
  try { url = page.url(); } catch {}
  try { title = await page.title(); } catch {}
  try {
    body = await page.evaluate(() => (document.body && document.body.innerText || "").slice(0, 240));
  } catch {}
  return "url=" + url + " title=" + title + " body=" + JSON.stringify(body);
}

async function ensurePage(pool) {
  if (pool.idleTimer) {
    clearTimeout(pool.idleTimer);
    pool.idleTimer = null;
  }
  if (pool.page && !pool.page.isClosed()) {
    try {
      const input = await firstVisible(pool.page, COMPOSER_SELS, 2000);
      if (input) {
        await startNewChat(pool.page);
        return pool.page;
      }
    } catch {
    }
    await pool.page.close().catch(() => {});
    pool.page = null;
  }
  const page = await pool.context.newPage();
  // Keep localStorage in sync with the latest rotated token for every new page.
  await page.addInitScript((t) => {
    try { localStorage.setItem("token", t); } catch {}
  }, pool.token).catch(() => {});
  // On cold start, chat.z.ai CDN / TLS negotiation or SPA hydration occasionally
  // stalls before domcontentloaded or networkidle. Retry once in-place with 'load'
  // and commit-level navigation so first requests don't fail immediately.
  let loaded = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(ZAI_BASE_URL + "/", { waitUntil: "commit", timeout: 25000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 35000 }).catch(() => {});
      // Wait for any composer selector or main app container to mount
      const ready = await firstVisible(page, [...COMPOSER_SELS, "main", "#app", "#root"], 15000);
      if (ready) {
        loaded = true;
        break;
      }
    } catch (e) {
      if (attempt === 1) {
        const where = await pageDump(page).catch(() => "");
        throw new ZaiBrowserUnavailable("chat.z.ai initial navigation stalled. " + where);
      }
      await page.waitForTimeout(1000);
    }
  }
  pool.page = page;
  return page;
}
function armIdleClose(pool) {
  if (pool.idleTimer)
    clearTimeout(pool.idleTimer);
  pool.idleTimer = setTimeout(async () => {
    try {
      await pool.context.close();
    } catch {
    }
    if (pools.get(pool.key) === pool)
      pools.delete(pool.key);
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
async function dismissOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const blocked = await page.evaluate(() => {
      const input = document.querySelector("#chat-input");
      if (!input) return false;
      const box = input.getBoundingClientRect();
      const atPoint = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return !!(atPoint && !input.contains(atPoint) && !atPoint.contains(input));
    }).catch(() => false);
    if (!blocked) return true;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    await page.mouse.click(640, 200).catch(() => {});
    await page.waitForTimeout(300);
  }
  return false;
}

export async function runBrowserTurn(token, prompt, options = {}) {
  const timeoutMs = Number(options.turnTimeoutMs) || DEFAULT_TURN_TIMEOUT_MS;
  const stableId = String(options.poolId || "");
  const pool = await getPool(token, stableId);
  return withLock(pool, async () => {
    const page = await ensurePage(pool);
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
      const input = await firstVisible(page, COMPOSER_SELS, 15000);
      if (!input)
        throw new Error("composer never appeared (" + (await pageDump(page)) + ")");
      await dismissOverlays(page);
      // Direct focus / JS input prevents Playwright click timeouts when an invisible
      // or floating element intercepts the hit test.
      await input.focus().catch(() => {});
      await input.click({ timeout: 3000, force: true }).catch(() => {});
      await page.evaluate(({ prompt }) => {
        const el = document.querySelector("#chat-input") || document.querySelector("textarea");
        if (!el) return;
        el.value = prompt;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, { prompt }).catch(() => {});
      if (typeof input.fill === "function") {
        await input.fill(prompt).catch(() => {});
      }
      const send = await firstVisible(page, SEND_SELS, 8000);
      if (!send)
        throw new Error("send button never appeared (" + (await pageDump(page)) + ")");
      await page.evaluate(() => {
        const btn = document.querySelector("#send-message-button") || document.querySelector('[aria-label="Send Message"] button');
        if (btn) btn.click();
      }).catch(() => {});
      await send.click({ timeout: 5000, force: true }).catch(() => {});
      const result = await Promise.race([
        responsePromise,
        new Promise((resolve) => setTimeout(() => resolve({ status: 0, body: "", timeout: true }), timeoutMs))
      ]);
      pool.lastUsed = Date.now();
      if (!result.status && result.timeout)
        throw new Error("the page did not issue a completion within " + timeoutMs + "ms");
      let recovered = "";
      try {
        const cookies = await pool.context.cookies("https://chat.z.ai");
        const tok = cookies.find((CK) => CK.name === "token");
        if (tok && tok.value && tok.value !== token)
          recovered = tok.value;
      } catch {
      }
      result.recovered = recovered || null;
      if (recovered)
        await syncPoolToken(pool, recovered);
      return result;
    } finally {
      page.off("response", onResponse);
      armIdleClose(pool);
    }
  });
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

export const __browserTest = { foldPrompt, poolKey, withLock, ZAI_CHAT_URL };
