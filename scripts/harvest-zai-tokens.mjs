// Harvest chat.z.ai device tokens for the zai captcha mint.
//
//   node scripts/harvest-zai-tokens.mjs --token "<chat.z.ai localStorage token>" --count 300
//
// Run this on any machine with a browser (this host), NOT on the gateway host —
// the gateway stays browser-free. It writes the token file, which you then copy
// to the gateway:
//
//   scp data/zai-device-tokens.txt <gateway-host>:~/gateway/data/
//
// Why a separate step: chat.z.ai gates completions behind Aliyun's captcha, and
// each proof is verified with a device token that Aliyun issues to the page and
// accepts exactly once. Bulk-harvesting them here means the gateway can mint
// proofs with pure HTTP and never needs a browser.
//
// Requires playwright (npm install playwright && npx playwright install chromium)
// or an existing Chromium via BROWSER_EXECUTABLE.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = String(process.argv[i]).replace(/^--/, "");
  args.set(key, process.argv[i + 1]);
}
const token = args.get("token") || process.env.ZAI_TOKEN || "";
const count = Number(args.get("count") || 300);
const out = resolve(args.get("out") || "data/zai-device-tokens.txt");
const headed = args.get("headed") === "true";

if (!token) {
  console.error("need the chat.z.ai session token: --token <jwt> (or ZAI_TOKEN)");
  process.exit(2);
}

// playwright's ESM entry exposes chromium directly, but a CJS path passed via
// PLAYWRIGHT_MODULE lands it under .default — accept either.
function chromiumFrom(mod) {
  return (mod && mod.chromium) || (mod && mod.default && mod.default.chromium) || null;
}

let chromium = null;
try {
  chromium = chromiumFrom(await import("playwright"));
} catch {
  // ESM ignores NODE_PATH, so allow pointing at an existing install outright.
  const explicit = process.env.PLAYWRIGHT_MODULE;
  if (explicit) {
    try {
      chromium = chromiumFrom(await import(explicit));
    } catch (e) {
      console.error("could not import playwright from PLAYWRIGHT_MODULE=" + explicit + ": " + e.message);
      process.exit(2);
    }
  }
}
if (!chromium) {
  console.error('playwright is not installed here. Run: npm install playwright && npx playwright install chromium');
  console.error("Or set PLAYWRIGHT_MODULE=/path/to/playwright/index.js if it lives elsewhere.");
  process.exit(2);
}

const { buildStealthScript } = await import(new URL("./zai-harvest-stealth.js", import.meta.url).href);

const browser = await chromium.launch({
  headless: !headed,
  executablePath: process.env.BROWSER_EXECUTABLE || undefined,
  args: ["--window-position=4000,4000", "--mute-audio", "--no-sandbox", "--disable-dev-shm-usage"]
});
const chromMajor = browser.version().split(".")[0];
// Fingerprint parity with the reference collector: a coherent Windows Chrome
// identity plus the stealth script injected before any page JS (including the
// captcha iframes). Without this Aliyun refuses to mint a usable device token.
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromMajor}.0.0.0 Safari/537.36`;
const context = await browser.newContext({
  userAgent: UA,
  locale: "en-US",
  timezoneId: "America/New_York",
  colorScheme: "light",
  deviceScaleFactor: 1,
  viewport: { width: 1920, height: 1080 },
  screen: { width: 1920, height: 1440 },
  extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" }
});
await context.addInitScript({ content: buildStealthScript(chromMajor) });
await context.addCookies([{ name: "token", value: token, domain: "chat.z.ai", path: "/" }]);
const page = await context.newPage();

console.log("loading chat.z.ai ...");
await page.goto("https://chat.z.ai/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.evaluate(([t]) => {
  try {
    localStorage.setItem("token", t);
  } catch {
  }
}, [token]);
await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(5000);

// Human-ish warm-up, then a real submit: the captcha widget only initializes
// once the page actually tries to send a message.
await page.mouse.move(700, 400);
await page.waitForTimeout(250);
await page.mouse.wheel(0, 200);
await page.waitForTimeout(200);
await page.mouse.wheel(0, -120);
// Dismiss whatever the site put over the composer: an announcement/onboarding
// overlay sits above it on some accounts and swallows the click.
async function dismissOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const blocked = await page.evaluate(() => {
      const input = document.querySelector("#chat-input");
      if (!input)
        return false;
      const box = input.getBoundingClientRect();
      const atPoint = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return !!(atPoint && !input.contains(atPoint) && !atPoint.contains(input));
    }).catch(() => false);
    if (!blocked)
      return true;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
    // Clicking a top-centre dead spot closes most modals without activating
    // anything inside them.
    await page.mouse.click(640, 200).catch(() => {});
    await page.waitForTimeout(400);
  }
  return false;
}

const input = page.locator("#chat-input").first();
await input.waitFor({ state: "visible", timeout: 30000 });
await dismissOverlays(page);
await input.click({ timeout: 30000 });
await page.keyboard.type("__");
await page.waitForTimeout(400);
await page.locator('[aria-label="Send Message"] button:not([disabled])').first().click({ timeout: 20000 });
console.log("submitted; waiting for the Aliyun SDK ...");

let ready = false;
for (let i = 0; i < 40; i++) {
  ready = await page.evaluate(() => !!(window.z_um && typeof window.z_um.getToken === "function")).catch(() => false);
  if (ready)
    break;
  await page.waitForTimeout(1000);
}
if (!ready) {
  console.error("window.z_um.getToken never appeared — the page did not initialize the captcha widget");
  await browser.close().catch(() => {});
  process.exit(1);
}

console.log("collecting", count, "tokens ...");
const tokens = await page.evaluate(async (n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const value = window.z_um.getToken();
    out.push(value && typeof value.then === "function" ? await value : value);
    if (i % 25 === 0)
      await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}, count);
const usable = tokens.filter((t) => typeof t === "string" && t.length > 60);
await browser.close().catch(() => {});

const dir = dirname(out);
if (!existsSync(dir))
  mkdirSync(dir, { recursive: true });
if (!existsSync(out))
  writeFileSync(out, "");
// Append only what is not already stored, so repeated runs top the file up.
const existing = new Set(existsSync(out) ? (await import("node:fs")).readFileSync(out, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : []);
const fresh = usable.filter((t) => !existing.has(t));
appendFileSync(out, fresh.map((t) => t + "\n").join(""));
console.log(`harvested ${usable.length}, added ${fresh.length} new -> ${out}`);
console.log(`store now holds ${existing.size + fresh.length} tokens`);
console.log(`copy it to the gateway host: scp ${out} <gateway-host>:~/gateway/data/`);
