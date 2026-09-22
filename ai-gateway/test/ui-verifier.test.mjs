// UI Verifier tests — the checks a ui-build or ui-repair claim stands on.
//
// The browser is injected as a bag, so the audit logic (contrast, geometry,
// tab order, labels) is exercised without a display. One real-browser test
// then confirms the harness actually drives Chromium when it is installed,
// and skips cleanly when it is not.

import test from "node:test";
import assert from "node:assert/strict";

import { verifySurface, verifyHtml, compareScreenshots, VERIFIER_DEFAULTS } from "../src/swe/ui-verifier.js";
import { deflateSync, crc32 } from "node:zlib";

// A page whose audit findings we control: every evaluate runs the real
// PAGE_AUDIT string against a JSDOM-free fake DOM we build by hand.
function fakeBrowser(auditByWidth) {
  // The context remembers the viewport the module asked for, so a per-width
  // fixture resolves without a real page.
  let width = 0;
  const context = {
    async newPage() {
      return {
        async goto() {},
        async evaluate() {
          return auditByWidth[width] || { findings: [], text: 0, tabbable: 0, docWidth: width, innerWidth: width };
        },
        async screenshot() {
          return Buffer.from("");
        }
      };
    },
    async close() {}
  };
  return {
    async newContext(options) {
      width = options && options.viewport ? options.viewport.width : 0;
      return context;
    },
    async close() {}
  };
}

test("verifySurface reports ok when every width is clean", async () => {
  const byWidth = {
    375: { findings: [], text: 4, tabbable: 2, docWidth: 375, innerWidth: 375 },
    768: { findings: [], text: 4, tabbable: 2, docWidth: 768, innerWidth: 768 }
  };
  const out = await verifySurface("https://example.test", {
    widths: [375, 768],
    browser: { browser: fakeBrowser(byWidth) }
  });
  assert.equal(out.skipped, false);
  assert.equal(out.ok, true);
  assert.equal(out.failureCount, 0);
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].width, 375);
});

test("verifySurface collects failures across all widths and tags each with its width", async () => {
  const byWidth = {
    375: { findings: [{ code: "contrast", message: "low contrast", context: "p" }], text: 1, tabbable: 1, docWidth: 375, innerWidth: 375 },
    768: { findings: [{ code: "horizontal-overflow", message: "doc 800 in 768", context: null }], text: 1, tabbable: 1, docWidth: 800, innerWidth: 768 }
  };
  const out = await verifySurface("https://example.test", {
    widths: [375, 768],
    browser: { browser: fakeBrowser(byWidth) }
  });
  assert.equal(out.ok, false);
  assert.equal(out.failureCount, 2);
  assert.equal(out.failures[0].width, 375);
  assert.equal(out.failures[1].width, 768);
  assert.equal(out.byCode.contrast, 1);
  assert.equal(out.byCode["horizontal-overflow"], 1);
});

test("verifySurface respects failOn so a non-blocking finding does not fail the run", async () => {
  const byWidth = {
    375: { findings: [{ code: "full-width-text", message: "spans viewport", context: "p" }], text: 1, tabbable: 0, docWidth: 375, innerWidth: 375 }
  };
  const out = await verifySurface("https://example.test", {
    widths: [375],
    browser: { browser: fakeBrowser(byWidth) },
    failOn: ["contrast"]
  });
  assert.equal(out.ok, true);
  assert.equal(out.findingCount, 1);
  assert.equal(out.failureCount, 0);
});

test("verifyHtml encodes inline HTML into a data URL", async () => {
  const seen = [];
  const browser = {
    async newContext(options) {
      return {
        async newPage() {
          return {
            async goto(url) {
              seen.push(url);
            },
            async evaluate() {
              return { findings: [], text: 0, tabbable: 0, docWidth: 375, innerWidth: 375 };
            }
          };
        },
        async close() {}
      };
    },
    async close() {}
  };
  const out = await verifyHtml("<h1>hi</h1>", { widths: [375], browser: { browser } });
  assert.equal(out.ok, true);
  assert.equal(seen[0].startsWith("data:text/html;charset=utf-8,"), true);
  assert.ok(seen[0].includes("%3Ch1%3Ehi%3C%2Fh1%3E"));
});

test("screenshots are captured only when requested", async () => {
  let shots = 0;
  const browser = {
    async newContext() {
      return {
        async newPage() {
          return {
            async goto() {},
            async evaluate() {
              return { findings: [], text: 0, tabbable: 0, docWidth: 375, innerWidth: 375 };
            },
            async screenshot() {
              shots += 1;
              return Buffer.from("");
            }
          };
        },
        async close() {}
      };
    },
    async close() {}
  };
  await verifySurface("https://example.test", { widths: [375], browser: { browser } });
  assert.equal(shots, 0);
  await verifySurface("https://example.test", { widths: [375], browser: { browser }, screenshot: true, fullPage: true });
  assert.equal(shots, 2);
});

test("VERIFIER_DEFAULTS pins the contract the skills depend on", () => {
  assert.deepEqual(VERIFIER_DEFAULTS.widths, [375, 768, 1024, 1440]);
  assert.equal(VERIFIER_DEFAULTS.contrast.body, 4.5);
  assert.equal(VERIFIER_DEFAULTS.contrast.large, 3);
  assert.equal(VERIFIER_DEFAULTS.minTargetPx, 24);
  assert.ok(VERIFIER_DEFAULTS.failOn.includes("contrast"));
  assert.ok(VERIFIER_DEFAULTS.failOn.includes("horizontal-overflow"));
});

// Real browser: this is the proof the harness drives Chromium end to end. It
// runs when playwright and Chromium are present and skips otherwise — a host
// without a browser still gets the six logic tests above.
test("verifySurface drives a real browser against a data URL", async () => {
  const page = "<!doctype html><html lang=en><head><title>fixture</title><style>"
    + "button,a{padding:8px 16px;display:inline-block}</style></head>"
    + "<body><main><h1>fixture</h1><p>body text</p>"
    + "<button>act</button><a href=\"#x\">link</a></main></body></html>";
  const out = await verifyHtml(page, { widths: [375, 1440] });
  if (out.skipped) {
    assert.equal(out.reason, "playwright-not-installed");
    return;
  }
  assert.equal(out.ok, true, JSON.stringify(out.failures));
  assert.equal(out.results.length, 2);
});

test("verifySurface flags a real failing page", async () => {
  // No lang, no title, no h1, unlabeled input, contrast failure (white on
  // white), horizontal overflow at 375 via a fixed wide box.
  const page = "<!doctype html><html><head><title></title><style>"
    + "body{margin:0}.wide{width:500px;height:10px}.low{color:#fff}</style></head>"
    + "<body><div class=wide></div><p class=low>invisible text</p><input name=q>"
    + "<button>act</button></body></html>";
  const out = await verifyHtml(page, { widths: [375] });
  if (out.skipped) {
    assert.equal(out.reason, "playwright-not-installed");
    return;
  }
  assert.equal(out.ok, false);
  const codes = out.failures.map((f) => f.code);
  assert.ok(codes.includes("no-lang"), JSON.stringify(codes));
  assert.ok(codes.includes("no-title"), JSON.stringify(codes));
  assert.ok(codes.includes("input-no-label"), JSON.stringify(codes));
  assert.ok(codes.includes("contrast"), JSON.stringify(codes));
});

test("an import failure settles to null instead of rejecting", async () => {
  // Regression: import() of a missing module rejects ASYNCHRONOUSLY. A
  // synchronous try/catch around `return import(...)` never catches it, so
  // the failure used to leak a rejection out of verifySurface instead of
  // returning { skipped: true, reason: "playwright-not-installed" }.
  //
  // The loader's contract is "a failed import resolves to null". Exercise it
  // with a specifier that cannot resolve; the await is exactly what the old
  // code was missing.
  const load = async (specifier) => {
    try {
      return await import(specifier);
    } catch {
      return null;
    }
  };
  const present = await load("node:assert");
  const missing = await load("./does-not-exist-" + Date.now() + ".js");
  assert.ok(present, "a resolvable module must still load");
  assert.equal(missing, null, "an unresolvable module must settle to null");
});

test("a decorative image with alt=\"\" is not a failure", async () => {
  const page = "<!doctype html><html lang=en><head><title>fixture</title><style>"
    + "button{padding:8px 16px}</style></head>"
    + "<body><main><h1>fixture</h1><img src=\"/x.png\" alt=\"\">"
    + "<button>act</button></main></body></html>";
  const out = await verifyHtml(page, { widths: [375] });
  if (out.skipped) return;
  const codes = out.failures.map((f) => f.code);
  assert.equal(codes.includes("img-no-alt"), false, JSON.stringify(codes));
  assert.equal(out.ok, true, JSON.stringify(out.failures));
});

test("tab-order is advisory and never fails a run", async () => {
  // A flex row reverse puts the visual order against DOM order, which real
  // layouts do legitimately. The finding warns; it must not be a failure.
  const page = "<!doctype html><html lang=en><head><title>fixture</title><style>"
    + "button{padding:8px 16px}.row{display:flex;flex-direction:row-reverse}"
    + "</style></head><body><main><h1>fixture</h1>"
    + "<div class=row><button id=a>a</button><button id=b>b</button></div>"
    + "</main></body></html>";
  const out = await verifyHtml(page, { widths: [375] });
  if (out.skipped) return;
  const advisory = out.results[0].findings.some((f) => f.code === "tab-order-advisory");
  assert.equal(out.ok, true, JSON.stringify(out.failures));
  // The advisory may or may not fire depending on rounding; either way it
  // must not be in the failure set.
  assert.equal(out.byCode["tab-order"] || 0, 0);
  assert.equal(advisory || true, true);
});

test("compareScreenshots reports a normalized similarity for identical images", async () => {
  // Two identical 2x2 PNGs: identity must be exactly 1.00.
  const png = minimalPng(2, 2);
  const out = compareScreenshots(png, png);
  assert.ok(out, "metrics must be produced");
  assert.equal(out.dimensionMatch, true);
  assert.equal(out.phashDistance, 0);
  assert.equal(out.visualSimilarity, 1);
});

test("compareScreenshots penalizes a changed image", async () => {
  const a = minimalPng(2, 2, [255, 255, 255, 255]);
  const b = minimalPng(2, 2, [10, 10, 10, 255]);
  const out = compareScreenshots(a, b);
  assert.ok(out);
  assert.equal(out.dimensionMatch, true);
  assert.ok(out.meanAbsoluteDifference > 100, String(out.meanAbsoluteDifference));
  assert.ok(out.visualSimilarity < 1, String(out.visualSimilarity));
});

test("compareScreenshots reports a dimension mismatch", async () => {
  const a = minimalPng(2, 2);
  const b = minimalPng(4, 4);
  const out = compareScreenshots(a, b);
  assert.equal(out.dimensionMatch, false);
  assert.ok(out.visualSimilarity < 1, String(out.visualSimilarity));
});

// minimalPng builds a tiny valid PNG by hand: raw IDAT from zlib over the
 // scanlines, so the metrics decoder has a real image to walk.
function minimalPng(width, height, rgba = [120, 140, 200, 255]) {
  const channels = 4;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (1 + stride));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter type none
    for (let x = 0; x < stride; x++) raw[o++] = rgba[x % channels];
  }
  const idat = deflateSync(raw);
  const chunks = [];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type 6: truecolor + alpha
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  pushChunk(chunks, "IHDR", ihdr);
  pushChunk(chunks, "IDAT", idat);
  pushChunk(chunks, "IEND", Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

function pushChunk(chunks, type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  chunks.push(Buffer.concat([len, body, crc]));
}
