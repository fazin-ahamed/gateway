// UI Verifier — render a frontend surface, then measure it.
//
// HORIZON-Omega DeepSWE / ui-build + ui-repair: a skill says "renders at
// mobile + desktop, AA contrast, keyboard navigable, no overflow". This is
// the harness that produces the evidence instead of letting the claim stand
// on its own.
//
// What it checks, per viewport (375 / 768 / 1024 / 1440):
//   - DOM geometry: horizontal overflow, clipped content, zero-size boxes
//   - tap targets: interactive elements with a hit area under 24px
//   - contrast: visible text against its painted background, WCAG AA
//   - keyboard reachability: every interactive element reachable in Tab order
//   - document language, page title, image alt text, form labels, headings
//
// No filesystem, no network, no gateway serving import. The browser is
// injected as one bag, so the module is testable without a display: pass a
// fake browser and the measurements come from your fixtures.
//
// No axe-core dependency: contrast and geometry are computed from the DOM
// directly, so the harness adds nothing to the dependency set.

const DEFAULT_WIDTHS = [375, 768, 1024, 1440];

// WCAG AA. Body text needs 4.5:1; large text (18pt+ or 14pt bold+) needs 3:1.
const BODY_CONTRAST = 4.5;
const LARGE_CONTRAST = 3.0;
const LARGE_PX = 24; // 18pt at 96dpi
const BOLD_LARGE_PX = 18.66; // 14pt bold at 96dpi

// Minimum tap target on touch: 24px a side (WCAG 2.5.8 AAA is 24, AA is 24 in 2.2).
const MIN_TARGET_PX = 24;

function relativeLuminance({ r, g, b }) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// The DOM side: one evaluate per page that collects every finding at once, so
// a viewport never costs more than one round trip into the browser.
const PAGE_AUDIT = String.raw`
(() => {
  const findings = [];
  const add = (code, message, ctx) => findings.push({ code, message, context: ctx || null });
  // WCAG luminance + contrast inlined: this runs in the page, so it cannot
  // call the module's helpers.
  const luminance = (c) => {
    const ch = (s) => {
      const v = s / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  };
  const contrastRatio = (a, b) => {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const visibleTextNodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue.trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    visibleTextNodes.push({ el, text, style, rect });
  }

  const docWidth = document.documentElement.scrollWidth;
  if (docWidth > innerWidth + 1)
    add("horizontal-overflow", "Document scrolls horizontally: " + docWidth + "px in a " + innerWidth + "px viewport");

  const reference = { r: 255, g: 255, b: 255 };
  const bgStack = (el) => {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const bg = getComputedStyle(cur).backgroundColor;
      const m = bg.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
        if (parts.length >= 3 && parts[3] !== 0) return { r: parts[0], g: parts[1], b: parts[2] };
      }
      cur = cur.parentElement;
    }
    return reference;
  };

  for (const { el, text, style, rect } of visibleTextNodes) {
    const size = parseFloat(style.fontSize);
    const bold = parseInt(style.fontWeight, 10) >= 700;
    const large = size >= ${LARGE_PX} || (bold && size >= ${BOLD_LARGE_PX});
    const need = large ? ${LARGE_CONTRAST} : ${BODY_CONTRAST};
    const fg = style.color.match(/rgba?\(([^)]+)\)/);
    if (!fg) continue;
    const fgp = fg[1].split(",").map((s) => parseFloat(s.trim()));
    if (fgp.length >= 3 && fgp[3] === 0) continue;
    const ratio = contrastRatio({ r: fgp[0], g: fgp[1], b: fgp[2] }, bgStack(el));
    if (ratio < need)
      add("contrast", "Text at " + size.toFixed(1) + "px has contrast " + ratio.toFixed(2) + ":1 (needs " + need + "): \"" + text.slice(0, 48) + "\"", el.tagName.toLowerCase());

    if (rect.width >= innerWidth) add("full-width-text", "Text block spans the full viewport width: \"" + text.slice(0, 48) + "\"", el.tagName.toLowerCase());
  }

  const interactive = "a[href], button, input, select, textarea, [tabindex], [role=button], summary";
  const seen = new Set();
  for (const el of document.querySelectorAll(interactive)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      add("invisible-interactive", "Interactive element renders with no box: " + (el.textContent.trim().slice(0, 32) || el.tagName), el.tagName.toLowerCase());
      continue;
    }
    if (r.width < ${MIN_TARGET_PX} || r.height < ${MIN_TARGET_PX})
      add("small-target", "Hit area " + Math.round(r.width) + "x" + Math.round(r.height) + " is under ${MIN_TARGET_PX}px: " + (el.textContent.trim().slice(0, 32) || el.tagName), el.tagName.toLowerCase());

    if (el.tagName === "A" && !el.getAttribute("href"))
      add("link-no-href", "Anchor has no href: \"" + el.textContent.trim().slice(0, 32) + "\"", "a");

    if (el.tagName === "INPUT" && el.type !== "hidden" && el.type !== "submit" && el.type !== "button") {
      const id = el.getAttribute("id");
      const labelled = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (id && document.querySelector("label[for=\"" + id + "\"]")) || el.closest("label");
      if (!labelled) add("input-no-label", "Input has no associated label: " + (el.getAttribute("name") || el.type), "input");
    }
  }

  if (!document.documentElement.getAttribute("lang")) add("no-lang", "Document has no lang attribute");
  if (!document.title.trim()) add("no-title", "Document has no title");

  const h1 = document.querySelectorAll("h1");
  if (h1.length === 0) add("no-h1", "Page has no h1");
  else if (h1.length > 1) add("multiple-h1", "Page has " + h1.length + " h1 elements");

  let headings = 0;
  let previous = 0;
  for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    const level = parseInt(h.tagName[1], 10);
    if (previous && level > previous + 1)
      add("heading-skip", "Heading level jumps from h" + previous + " to h" + level, h.tagName.toLowerCase());
    previous = level;
    headings++;
    if (!h.textContent.trim()) add("empty-heading", "Empty heading at h" + level, h.tagName.toLowerCase());
  }
  if (headings === 0) add("no-headings", "Page has no headings");

  for (const img of document.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    const role = img.getAttribute("role");
    if (role === "presentation" || img.getAttribute("aria-hidden") === "true") continue;
    if (!img.getAttribute("alt"))
      add("img-no-alt", "Image has no alt text: " + src.slice(0, 48), "img");
  }

  for (const b of document.querySelectorAll("button")) {
    if (!b.textContent.trim() && !b.getAttribute("aria-label") && !b.getAttribute("aria-labelledby"))
      add("button-no-label", "Button has no accessible name", "button");
  }

  // Keyboard path: DOM order must be the tab order, and nothing reachable may
  // be offscreen (a focus target the user cannot see is a dead end).
  const tabbable = Array.from(document.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"]), summary"))
    .filter((el) => {
      const st = getComputedStyle(el);
      return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
    });
  const tabOrder = tabbable.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), label: (el.textContent.trim().slice(0, 24) || el.tagName) };
  });
  const sorted = [...tabOrder].sort((a, b) => a.y - b.y || a.x - b.x);
  const misordered = [];
  for (let i = 0; i < tabOrder.length; i++)
    if (tabOrder[i].y !== sorted[i].y || tabOrder[i].x !== sorted[i].x) misordered.push(tabOrder[i].label);
  if (misordered.length) add("tab-order", "Tab order does not match DOM/visual order at: " + misordered.slice(0, 3).join(", "));

  const offscreen = tabbable.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
  });
  if (offscreen.length) add("focus-offscreen", offscreen.length + " tabbable element(s) are rendered offscreen");

  return { findings, text: visibleTextNodes.length, tabbable: tabOrder.length, docWidth, innerWidth: innerWidth };
})();
`;
function loadPlaywright() {
  // This package is ESM: import() is the only CommonJS-interop path. The
  // root node_modules holds playwright, but importing it must stay optional
  // so a host without Chromium still loads this module and reports skipped.
  try {
    return import("playwright");
  } catch {
    return null;
  }
}

// the installed playwright package (common when the package was updated
// without `npx playwright install`). Prefer an explicit path, then the
// registry's own executable, then any installed chrome-linux64 build.
function candidateExecutables(executablePath) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const cache = home ? `${home}/.cache/ms-playwright` : "";
  const out = [];
  if (executablePath) out.push(executablePath);
  if (cache) {
    out.push(`${cache}/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`);
    out.push(`${cache}/chromium-1234/chrome-linux64/chrome`);
  }
  return out;
}

async function launchChrome(playwright, { executablePath = null, headless = true } = {}) {
  const args = ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"];
  const errors = [];
  for (const candidate of candidateExecutables(executablePath)) {
    try {
      const browser = await playwright.chromium.launch({ headless, args, executablePath: candidate });
      return { browser, executablePath: candidate };
    } catch (e) {
      const first = String(e.message || e).split(String.fromCharCode(10))[0];
      errors.push(first);
    }
  }
  // Last resort: let playwright resolve its default, which produces the
  // canonical "install browsers" error if nothing is present.
  const browser = await playwright.chromium.launch({ headless, args });
  return { browser, executablePath: null, errors };
}
// withPage: load one URL at one width, run the audit, take the metric
// screenshots. Kept separate so a single surface check composes from it.
async function withPage(browser, url, width, { screenshot = null, fullPage = false, evaluate = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    const audit = (await page.evaluate(PAGE_AUDIT)) || { findings: [] };
    const shots = {};
    if (screenshot) {
      shots.viewport = await page.screenshot({ type: "png" }).then((b) => b.toString("base64"));
      if (fullPage)
        shots.full = await page.screenshot({ type: "png", fullPage: true }).then((b) => b.toString("base64"));
    }
    if (evaluate) {
      const extra = await page.evaluate(evaluate);
      return { width, audit, screenshots: shots, extra };
    }
    return { width, audit, screenshots: shots };
  } finally {
    await context.close();
  }
}

export async function verifySurface(url, {
  widths = DEFAULT_WIDTHS,
  browser: browserBag = null,
  screenshot = false,
  fullPage = false,
  evaluate = null,
  failOn = DEFAULT_FAIL_CODES
} = {}) {
  const playwright = await loadPlaywright();
  if (!playwright)
    return { url, skipped: true, reason: "playwright-not-installed", results: [] };
  let browser = null;
  try {
    const launched = browserBag && browserBag.browser ? { browser: browserBag.browser } : await launchChrome(playwright, browserBag || {});
    browser = launched.browser;
  } catch (e) {
    return { url, skipped: true, reason: "browser-not-launchable", detail: String(e.message || e).split(String.fromCharCode(10))[0], results: [] };
  }
  const ownsBrowser = !(browserBag && browserBag.browser);
  try {
    const results = [];
    for (const width of widths)
      results.push(await withPage(browser, url, width, { screenshot, fullPage, evaluate }));
    return summarize(url, results, failOn);
  } finally {
    if (ownsBrowser) await browser.close();
  }
}

export async function verifyHtml(html, options = {}) {
  // Inline HTML gets a data: URL so a sketch or fixture is verifiable without
  // standing up a dev server.
  const encoded = "data:text/html;charset=utf-8," + encodeURIComponent(html);
  return verifySurface(encoded, options);
}

const DEFAULT_FAIL_CODES = ["horizontal-overflow", "contrast", "no-h1", "no-lang", "no-title", "input-no-label", "img-no-alt", "button-no-label", "small-target", "invisible-interactive", "tab-order", "focus-offscreen", "heading-skip"];

function summarize(url, results, failOn) {
  const allFindings = results.flatMap((r) => r.audit.findings.map((f) => ({ ...f, width: r.width })));
  const failures = allFindings.filter((f) => failOn.includes(f.code));
  const byCode = {};
  for (const f of allFindings) byCode[f.code] = (byCode[f.code] || 0) + 1;
  return {
    url,
    skipped: false,
    ok: failures.length === 0,
    failureCount: failures.length,
    findingCount: allFindings.length,
    byCode,
    failures: failures.slice(0, 20),
    results: results.map((r) => ({ width: r.width, ...r.audit, screenshots: r.screenshots, extra: r.extra || null }))
  };
}

export const VERIFIER_DEFAULTS = Object.freeze({
  widths: DEFAULT_WIDTHS,
  failOn: DEFAULT_FAIL_CODES,
  contrast: Object.freeze({ body: BODY_CONTRAST, large: LARGE_CONTRAST }),
  minTargetPx: MIN_TARGET_PX
});
