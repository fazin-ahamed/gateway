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
const ZAI_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
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

function poolKey(token) {
  try {
    return "zai:" + sha256hexSync(token).slice(0, 32);
  } catch {
    return "zai:" + String(token).length + ":" + String(token).slice(0, 8);
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

async function getPool(token) {
  const key = poolKey(token);
  const existing = pools.get(key);
  if (existing)
    return existing;
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: ZAI_USER_AGENT, locale: "en-US", viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: "token", value: token, domain: "chat.z.ai", path: "/" }]);
  const pool = { context, page: null, lock: Promise.resolve(), idleTimer: null, lastUsed: Date.now() };
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
async function openFreshPage(pool, token) {
  if (pool.idleTimer) {
    clearTimeout(pool.idleTimer);
    pool.idleTimer = null;
  }
  if (pool.page)
    await Promise.resolve(pool.page.close().catch(() => {})).catch(() => {});
  const page = await pool.context.newPage();
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
  return withLock(pool, async () => {
    const page = await openFreshPage(pool, token);
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
      // FeiLin/Aliyun captcha iframes sit on top of the composer. Wait them
      // out (or a login wall) before typing, otherwise fill succeeds and
      // click times out on a covered send button.
      await page.waitForFunction(() => {
        const overlay = document.querySelector(".nc_wrapper, #aliyunCaptcha-window-embed, iframe[src*='captcha'], iframe[src*='aliyun']");
        const login = document.querySelector("input[type='password'], button[type='submit'][class*='login']");
        const box = document.querySelector("#chat-input");
        return !!box && !overlay && !login;
      }, null, { timeout: 45000 }).catch(() => {});
      await input.click({ timeout: 10000 });
      await input.fill("");
      await input.fill(prompt);
      const send = page.locator("#send-message-button").first();
      await send.waitFor({ state: "visible", timeout: 15000 });
      await page.waitForFunction(() => {
        const btn = document.querySelector("#send-message-button");
        if (!btn || btn.disabled) return false;
        const r = btn.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && (top === btn || btn.contains(top) || top.closest("#send-message-button"));
      }, null, { timeout: 20000 }).catch(() => {});
      await send.click({ timeout: 10000, force: true });
      const result = await Promise.race([
        responsePromise,
        new Promise((resolve) => setTimeout(() => resolve({ status: 0, body: "", timeout: true }), timeoutMs))
      ]);
      pool.lastUsed = Date.now();
      if (!result.status && result.timeout)
        throw new Error("the page did not issue a completion within " + timeoutMs + "ms");
      // chat.z.ai rotates its session token during turns; pull the current one
      // so the stored credential ages with the browser, not against it.
      let recovered = "";
      try {
        const cookies = await pool.context.cookies("https://chat.z.ai");
        const tok = cookies.find((CK) => CK.name === "token");
        if (tok && tok.value && tok.value !== token)
          recovered = tok.value;
      } catch {
      }
      result.recovered = recovered || null;
      return result;
    } finally {
      page.off("response", onResponse);
      await Promise.resolve(page.close().catch(() => {})).catch(() => {});
      pool.page = null;
      armIdleClose(pool, key);
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
