// Model-integrity probes: does this endpoint actually serve what it claims?
//
// Resellers advertise frontier names (Claude Opus, GPT-5.x, Grok, GLM…) while
// answering with a cheaper open-weights model. The `model` field proves nothing
// when it merely echoes the request, so these probes fingerprint the serving
// stack and compare it with the claim:
//
//   1. /tokenize  raw token IDs  -> exact tokenizer identity (gold standard)
//   2. token-count slope         -> tokenizer family, when /tokenize is absent
//   3. routing                   -> one endpoint answering unrelated slugs
//   4. stack leak                -> response.model that does not echo the request
//   5. output ceiling            -> max_tokens rejection that names a cap / id
//   6. knowledge cutoff          -> dated trivia vs advertised family window
//   7. identity                  -> self-reported name (warn only; promptable)
//   8. declared-limit breach     -> answering past its claimed context window
//   9. determinism               -> temperature 0 + seed should reproduce
//
// Reference token data is embedded (scripts/build-modelprobe-refs.py). Hard
// serving-stack probes (leaked model id, enforced output ceiling, knowledge
// horizon) follow truemodel (https://github.com/pavandoescode/truemodel, MIT).


import { MODELPROBE_REFS } from "./modelprobe-refs.js";

// Slugs a relay would answer under if it were serving anything. Kept short: each
// one costs a request against someone else's account.
export const ROUTING_PROBE_MODELS = [
  "gpt-4o",
  "claude-3-opus",
  "llama-3.1-70b",
  "gemini-1.5-pro",
  "mistral-large",
  "deepseek-v3"
];

// Thresholds. The original had only `count >= 3`; these are the ones the port
// enforces, all structural rather than statistical.
export const PROBE_LIMITS = {
  // |1 - server/ref| within this counts as the measured family.
  maxFamilyDeviation: 0.06,
  // A relay is declared once this many unrelated slugs answer.
  relayModels: 3,
  // Prompts used for the slope measurement (reference used 1..5; 4 points are
  // enough and halve the request count).
  slopeSizes: [1, 3, 5],
  requestTimeoutMs: 30000
};

export const EXPECTED_FAMILY = {
  "gpt-5": "o200k",
  "gpt-4.1": "o200k",
  "gpt-4o": "o200k",
  "gpt-4": "cl100k",
  "gpt-3.5": "cl100k",
  "gpt-3": "r50k",
  "o1": "o200k",
  "o3": "o200k",
  "o4": "o200k",
  "llama": "llama",
  "qwen": "qwen",
  "mistral": "mistral",
  "deepseek": "deepseek",
  "glm": "glm",
  "chatglm": "glm",
  "kimi": "kimi",
  "moonshot": "kimi",
  "minimax": "minimax",
  "gemma": null,
  "gemini": null,
  "claude": null,
  "grok": null,
  "fable": null
};

// Advertised-family training windows, YYYY-MM. Soft evidence only: two late
// facts (or two early misses) before it scores. Adapted from truemodel's registry.
export const CUTOFF_WINDOWS = [
  { match: /gpt-5[.-]?2/i, from: "2025-11", to: "2026-03" },
  { match: /gpt-5[.-]?1/i, from: "2025-08", to: "2025-12" },
  { match: /gpt-5/i, from: "2025-03", to: "2025-08" },
  { match: /gpt-4\.1/i, from: "2024-11", to: "2025-03" },
  { match: /gpt-4o/i, from: "2023-10", to: "2024-06" },
  { match: /gpt-4/i, from: "2023-04", to: "2023-12" },
  { match: /claude.*opus-?5|opus-?5/i, from: "2026-01", to: "2026-04" },
  { match: /claude.*sonnet-?5|sonnet-?5/i, from: "2026-01", to: "2026-04" },
  { match: /claude.*opus-?4|opus-?4/i, from: "2024-10", to: "2025-03" },
  { match: /claude.*sonnet-?4|sonnet-?4/i, from: "2024-10", to: "2025-04" },
  { match: /claude.*haiku/i, from: "2024-08", to: "2025-10" },
  { match: /claude/i, from: "2024-04", to: "2024-08" },
  { match: /gemini-3/i, from: "2025-09", to: "2026-01" },
  { match: /gemini-2\.5/i, from: "2025-01", to: "2025-05" },
  { match: /gemini/i, from: "2024-08", to: "2024-11" },
  { match: /llama-?4/i, from: "2025-01", to: "2025-04" },
  { match: /llama-?3/i, from: "2024-07", to: "2024-12" },
  { match: /deepseek/i, from: "2024-06", to: "2024-12" },
  { match: /grok-?4/i, from: "2025-02", to: "2025-06" },
  { match: /grok/i, from: "2024-04", to: "2024-11" },
  { match: /qwen-?3/i, from: "2024-11", to: "2025-04" },
  { match: /glm/i, from: "2024-09", to: "2025-01" }
];

export const CUTOFF_QUESTIONS = [
  { dated: "2023-03", question: "Which film won Best Picture at the Oscars in March 2023?", answer: /everything\s+everywhere/i },
  { dated: "2023-05", question: "Which city hosted Eurovision in 2023?", answer: /liverpool/i },
  { dated: "2024-08", question: "Which city hosted the 2024 Summer Olympics?", answer: /paris|france/i },
  { dated: "2024-11", question: "Who won the 2024 United States presidential election?", answer: /trump/i },
  { dated: "2025-01", question: "Which app went dark in the United States for about a day in January 2025?", answer: /tiktok/i },
  { dated: "2025-05", question: "Who was elected pope in May 2025?", answer: /leo\s+xiv|prevost/i }
];

const ABSURD_MAX_TOKENS = 9000000;
const OUTPUT_BANDS = [4096, 8192, 16384, 32768, 64000, 65536, 100000, 128000];

export function cutoffWindowFor(model) {
  const id = String(model || "");
  const spec = CUTOFF_WINDOWS.find((s) => s.match.test(id));
  if (!spec) return null;
  return { from: spec.from, to: spec.to };
}

export function parseLimitError(message) {
  const text = String(message || "");
  let cap = null;
  const comparison = /(\d[\d,_]*)\s*>\s*(\d[\d,_]*)/.exec(text);
  if (comparison) cap = Number(comparison[2].replace(/[,_]/g, ""));
  else {
    const stated = /(?:max(?:imum)?(?:\s+(?:allowed|value|is|of))?|at most|<=?)\s*:?\s*(\d[\d,_]*)/i.exec(text);
    if (stated) cap = Number(stated[1].replace(/[,_]/g, ""));
  }
  const named = /(?:for|model)\s+([a-z0-9][a-z0-9._/-]{2,})/i.exec(text);
  return {
    cap: cap && Number.isFinite(cap) && cap > 0 ? cap : null,
    modelId: named ? named[1] : null
  };
}

export function extractLeakedModel(json, requested) {
  const reported = json && (json.model || (json.choices && json.choices[0] && json.choices[0].model));
  if (!reported || typeof reported !== "string") return null;
  const a = String(reported).trim().toLowerCase();
  const b = String(requested || "").trim().toLowerCase();
  if (!a || a === b) return null;
  const aTail = a.split("/").pop();
  const bTail = b.split("/").pop();
  if (aTail && bTail && (aTail === bTail || a.endsWith(bTail) || b.endsWith(aTail))) return null;
  return String(reported).trim();
}

// Model metadata that models.dev tells us to expect, so a claim can be checked
// against measured behaviour rather than taken on trust.
export function expectedFamilyFor(model) {
  const m = String(model || "").toLowerCase();
  const tail = m.split("/").pop();
  let best = null;
  for (const [slug, family] of Object.entries(EXPECTED_FAMILY)) {
    const hit = m.startsWith(slug) || tail.startsWith(slug) || m.includes("/" + slug);
    if (hit && (best === null || slug.length > best[0].length))
      best = [slug, family];
  }
  if (!best)
    return { matched: false, slug: null, family: null, hasReference: false };
  return { matched: true, slug: best[0], family: best[1], hasReference: !!best[1] };
}

/**
 * Exact fingerprint comparison. The server returns the same token IDs our
 * reference table holds when it runs the same tokenizer, so this is an equality
 * test rather than a heuristic.
 */
export function scoreFingerprint(serverIds, refIds) {
  if (!Array.isArray(serverIds) || !Array.isArray(refIds) || !serverIds.length || !refIds.length)
    return null;
  let same = 0;
  const n = Math.max(serverIds.length, refIds.length);
  for (let i = 0; i < Math.min(serverIds.length, refIds.length); i++)
    if (serverIds[i] === refIds[i])
      same++;
  const prefix = (() => {
    let i = 0;
    while (i < serverIds.length && i < refIds.length && serverIds[i] === refIds[i])
      i++;
    return i;
  })();
  return {
    identical: same === serverIds.length && same === refIds.length,
    overlap: same / n,
    prefix,
    serverLen: serverIds.length,
    refLen: refIds.length
  };
}

/** Slope of a size->count series, in tokens per repetition. */
export function seriesSlope(counts, sizes) {
  if (!Array.isArray(counts) || counts.length < 2)
    return null;
  const first = counts[0];
  const last = counts[counts.length - 1];
  const span = sizes[sizes.length - 1] - sizes[0];
  if (!span)
    return null;
  return (last - first) / span;
}

/**
 * Compare the server's measured slope with every reference family.
 * Returns families sorted by closeness, plus the best fit only when it is
 * within PROBE_LIMITS.maxFamilyDeviation — a poor fit is reported as such
 * instead of naming the least-bad family.
 */
export function matchFamilies(serverSlope) {
  const rows = [];
  for (const family of MODELPROBE_REFS.families) {
    const sizes = MODELPROBE_REFS.slope_sizes;
    const counts = sizes.map((s) => family.slopes[String(s)]);
    const refSlope = seriesSlope(counts, sizes);
    if (!refSlope)
      continue;
    const ratio = serverSlope / refSlope;
    rows.push({
      key: family.key,
      label: family.label,
      source: family.source,
      refSlope,
      ratio: Math.round(ratio * 1e4) / 1e4,
      deviation: Math.round(Math.abs(1 - ratio) * 1e4) / 1e4
    });
  }
  rows.sort((a, b) => a.deviation - b.deviation);
  const best = rows[0] || null;
  const withinTolerance = !!best && best.deviation <= PROBE_LIMITS.maxFamilyDeviation;
  return { rows, best: withinTolerance ? best : null, closest: best, withinTolerance };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
function endpoint(base) {
  return String(base || "").replace(/\/+$/, "");
}

async function postJson(url, headers, body, timeoutMs, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
    }
    return { status: res.status, json, text: text.slice(0, 400), headers: res.headers };
  } catch (e) {
    return { status: 0, error: String(e && e.message || e), json: null, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

function chat(base, model, key, content, extra, opts) {
  return postJson(endpoint(base) + "/chat/completions", key ? { Authorization: "Bearer " + key } : {}, {
    model,
    messages: [{ role: "user", content }],
    stream: false,
    ...extra
  }, (opts && opts.timeoutMs) || PROBE_LIMITS.requestTimeoutMs, opts && opts.fetchImpl);
}

function contentOf(body) {
  try {
    return body.choices[0].message.content || "";
  } catch {
    return "";
  }
}

function classifyStatus(status) {
  if (status === 0)
    return "transport-error";
  if (status === 200 || status === 201)
    return "ok";
  if (status === 401 || status === 403)
    return "auth-blocked";
  if (status === 429)
    return "rate-limited";
  if (status >= 500)
    return "upstream-down";
  return "http-" + status;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------
export async function probeBasic(base, model, key, opts) {
  const res = await chat(base, model, key, "ping", { max_tokens: 1, temperature: 0 }, opts);
  const status = classifyStatus(res.status);
  return { status, http: res.status, detail: res.error || res.text.slice(0, 200) };
}

/** Raw token IDs when the endpoint exposes a vLLM-style tokenizer route. */
export async function probeTokenize(base, model, key, opts) {
  const text = MODELPROBE_REFS.fingerprint_strings[0];
  const res = await postJson(endpoint(base) + "/tokenize", key ? { Authorization: "Bearer " + key } : {}, { model, text }, (opts && opts.timeoutMs) || PROBE_LIMITS.requestTimeoutMs, opts && opts.fetchImpl);
  if (res.status !== 200 || !res.json)
    return { available: false, reason: res.error || res.text.slice(0, 120) || ("HTTP " + res.status) };
  const ids = res.json.tokens || res.json.input_ids || res.json.token_ids;
  if (!Array.isArray(ids) || !ids.length)
    return { available: false, reason: "no token ids in response" };
  const scores = MODELPROBE_REFS.families.map((family) => {
    const score = scoreFingerprint(ids, family.fingerprints[0]);
    return score ? { key: family.key, label: family.label, ...score } : null;
  }).filter(Boolean).sort((a, b) => (b.identical - a.identical) || (b.overlap - a.overlap));
  const exact = scores.filter((s) => s.identical);
  return {
    available: true,
    ids,
    scores: scores.slice(0, 5),
    exactMatches: exact.map((s) => s.key),
    bestGuess: scores.length ? scores[0].key : null
  };
}

/** Tokenizer family from how the server counts tokens across prompt sizes. */
export async function probeUsageSlope(base, model, key, opts) {
  const sizes = PROBE_LIMITS.slopeSizes;
  const counts = [];
  for (const size of sizes) {
    const text = MODELPROBE_REFS.probe_text.repeat(size - 1) + MODELPROBE_REFS.probe_text;
    const res = await chat(base, model, key, text, { max_tokens: 1, temperature: 0 }, opts);
    if (res.status !== 200 || !res.json)
      return { ok: false, reason: res.error || ("HTTP " + res.status) };
    const promptTokens = res.json.usage && res.json.usage.prompt_tokens;
    if (typeof promptTokens !== "number")
      return { ok: false, reason: "response carried no usage.prompt_tokens (relays often strip it)" };
    counts.push(promptTokens);
  }
  const serverSlope = seriesSlope(counts, sizes);
  if (!serverSlope || serverSlope <= 0)
    return { ok: false, reason: "prompt_tokens did not grow with prompt size", counts };
  const match = matchFamilies(serverSlope);
  return { ok: true, counts, sizes, server_slope: serverSlope, ...match };
}

/** Does one endpoint answer under unrelated model names? Strongest relay tell. */
export async function probeRouting(base, model, key, opts) {
  const answered = [];
  for (const slug of ROUTING_PROBE_MODELS) {
    if (slug === model)
      continue;
    const res = await chat(base, slug, key, "Reply with one word: ok", { max_tokens: 2, temperature: 0 }, opts);
    if (res.status === 200)
      answered.push(slug);
  }
  return {
    distinct_models_served: answered,
    count: answered.length,
    is_relay: answered.length >= PROBE_LIMITS.relayModels
  };
}

export async function probeIdentity(base, model, key, opts) {
  const prompt = "Answer strictly as: MODEL=<your exact model name>; CUTOFF=<your training data cutoff date>. Nothing else.";
  const res = await chat(base, model, key, prompt, { max_tokens: 40, temperature: 0 }, opts);
  if (res.status !== 200)
    return { ok: false, reason: "HTTP " + res.status };
  const reply = contentOf(res.json).trim().slice(0, 200);
  const name = (reply.match(/MODEL\s*=\s*([^;]+)/i) || [])[1];
  const cutoff = (reply.match(/CUTOFF\s*=\s*([^;]+)/i) || [])[1];
  return { ok: true, reply, reported_model: name ? name.trim() : null, reported_cutoff: cutoff ? cutoff.trim() : null };
}

/**
 * Declared-limit breach: push a prompt past the context window the claim
 * advertises. A model that accepts far more than it claims is not the model that
 * was advertised — but acceptance alone is not a breach when the prompt we could
 * build stayed below the claim, so the measured count decides.
 */
export async function probeDeclaredLimit(base, model, key, declaredInputTokens, opts) {
  if (!declaredInputTokens || declaredInputTokens > 2000000)
    return { ok: false, reason: "no usable declared input limit" };
  const chars = Math.max(4000, Math.floor(declaredInputTokens * 1.15) * 4);
  const res = await chat(base, model, key, "x".repeat(chars), { max_tokens: 1, temperature: 0 }, opts);
  const usage = res.json && res.json.usage;
  const promptTokens = (usage && usage.prompt_tokens) || null;
  if (res.status !== 200)
    return { ok: true, accepted: false, breached: false, http: res.status, detail: res.error || res.text.slice(0, 140) };
  const breached = typeof promptTokens === "number" && promptTokens > declaredInputTokens;
  return { ok: true, accepted: true, breached, http: res.status, prompt_tokens: promptTokens, declared: declaredInputTokens };
}

export async function probeDeterminism(base, model, key, opts) {
  const prompt = "List exactly 5 prime numbers above 100, comma separated.";
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const res = await chat(base, model, key, prompt, { max_tokens: 20, temperature: 0, seed: 12345 }, opts);
    if (res.status !== 200)
      return { ok: false, reason: "HTTP " + res.status };
    runs.push(contentOf(res.json).trim().slice(0, 120));
  }
  return { ok: true, run1: runs[0], run2: runs[1], reproducible: runs[0] === runs[1] };
}

/**
 * Provider headers that give a relay away before any behavioural probe:
 * a proxy/router in front, or a gateway naming a different upstream.
 */
export async function probeHeaders(base, model, key, opts) {
  const res = await chat(base, model, key, "ping", { max_tokens: 1, temperature: 0 }, opts);
  if (res.status !== 200 || !res.headers)
    return { ok: false };
  const interesting = {};
  for (const name of ["server", "via", "x-served-by", "x-upstream", "x-provider", "x-proxy", "x-cache", "cf-ray", "x-manus-proxy-mode", "x-request-id"]) {
    const value = res.headers.get(name);
    if (value)
      interesting[name] = value;
  }
  const headers = {};
  if (res.headers.forEach)
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
  return { ok: true, interesting, all: Object.keys(headers).slice(0, 40) };
}

/** Response.model that does not merely echo the request — a serving-stack leak. */
export async function probeStackLeak(base, model, key, opts) {
  const res = await chat(base, model, key, "Reply with: OK", { max_tokens: 4, temperature: 0 }, opts);
  if (res.status !== 200)
    return { ok: false, reason: "HTTP " + res.status };
  const leaked = extractLeakedModel(res.json, model);
  return { ok: true, reported: res.json && res.json.model || null, leaked };
}

/**
 * Output ceiling: ask for an absurd max_tokens. Vendors that reject (Anthropic
 * shape, some OpenAI-compat gateways) often name the cap and the resolved id
 * in the error. Silent clamp / accept is recorded, not scored.
 */
export async function probeOutputCeiling(base, model, key, opts) {
  const absurd = await chat(base, model, key, "Reply with: OK", { max_tokens: ABSURD_MAX_TOKENS, temperature: 0 }, opts);
  const message = (absurd.json && absurd.json.error && absurd.json.error.message) || absurd.error || absurd.text || "";
  const stated = parseLimitError(message);
  if (absurd.status === 200)
    return { ok: true, unvalidated: true, ceiling: null, leakedId: stated.modelId, detail: "accepted max_tokens " + ABSURD_MAX_TOKENS };
  if (absurd.status !== 400 && absurd.status !== 422)
    return { ok: false, reason: "HTTP " + absurd.status, detail: message.slice(0, 160) };
  if (stated.cap)
    return { ok: true, unvalidated: false, ceiling: stated.cap, leakedId: stated.modelId, detail: message.slice(0, 200) };
  let lo = 0, hi = OUTPUT_BANDS.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = OUTPUT_BANDS[mid];
    const attempt = await chat(base, model, key, "Reply with: OK", { max_tokens: value, temperature: 0 }, opts);
    if (attempt.status === 200) { best = value; lo = mid + 1; }
    else if (attempt.status === 400 || attempt.status === 422) hi = mid - 1;
    else break;
  }
  return { ok: true, unvalidated: false, ceiling: best, leakedId: stated.modelId, detail: best ? ("accepts up to " + best) : "rejected every known output band" };
}

function monthNum(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || "").trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return Number(m[1]) * 12 + (month - 1);
}

function extractNumberedAnswer(text, item) {
  const marker = new RegExp("^\\**\\s*" + item + "\\**\\s*[:.)]");
  const line = String(text || "").split("\n").map((l) => l.trim()).find((l) => marker.test(l));
  if (!line) return "";
  return line.replace(new RegExp(marker.source + "\\s*\\**\\s*"), "").trim();
}

export function gradeCutoff(answers, questions, window) {
  let correct = 0, lateCorrect = 0, earlyWrong = 0, knownThrough = null;
  const from = window && monthNum(window.from);
  const to = window && monthNum(window.to);
  questions.forEach((q, i) => {
    const dated = monthNum(q.dated);
    if (dated === null) return;
    const answer = answers[i] || "";
    const isCorrect = answer !== "" && q.answer.test(answer);
    if (isCorrect) {
      correct++;
      if (knownThrough === null || dated > knownThrough) knownThrough = dated;
      if (to != null && dated > to + 2) lateCorrect++;
    } else if (from != null && dated < from - 6) {
      earlyWrong++;
    }
  });
  return { answers, correct, lateCorrect, earlyWrong, knownThrough, window };
}

/** Dated trivia vs advertised family window. Soft: two items before it fails. */
export async function probeKnowledgeCutoff(base, model, key, opts) {
  const window = cutoffWindowFor(model);
  const numbered = CUTOFF_QUESTIONS.map((q, i) => (i + 1) + ". " + q.question).join("\n");
  const template = CUTOFF_QUESTIONS.map((_, i) => (i + 1) + ": <answer>").join("\n");
  const prompt = "Answer all " + CUTOFF_QUESTIONS.length + " items. Use exactly this format, one item per line, nothing else:\n\n" + template + "\n\n" + numbered;
  const res = await chat(base, model, key, prompt, { max_tokens: 220, temperature: 0 }, opts);
  if (res.status !== 200)
    return { ok: false, reason: "HTTP " + res.status, window };
  const text = contentOf(res.json);
  const answers = CUTOFF_QUESTIONS.map((_, i) => extractNumberedAnswer(text, i + 1));
  return { ok: true, window, ...gradeCutoff(answers, CUTOFF_QUESTIONS, window) };
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
export function buildVerdict(input) {
  const { model, basic, tokenize, slope, routing, identity, limit, determinism, headers, leak, ceiling, cutoff } = input;
  const signals = [];
  const expected = expectedFamilyFor(model);
  let inconclusive = false;
  let relay = false;
  let mismatch = false;
  let stackMismatch = false;

  if (basic.status !== "ok") {
    signals.push({ kind: "basic", level: "inconclusive", text: basic.status + (basic.detail ? " — " + basic.detail : "") });
    inconclusive = true;
  }
  const relayByCount = !!(routing && (routing.is_relay || routing.count >= PROBE_LIMITS.relayModels));
  if (relayByCount) {
    relay = true;
    signals.push({ kind: "routing", level: "alert", text: "serves " + routing.count + " unrelated model slugs: " + routing.distinct_models_served.join(", ") });
  } else if (routing && routing.count > 0) {
    signals.push({ kind: "routing", level: "warn", text: "also answered as " + routing.distinct_models_served.join(", ") });
  }

  if (leak && leak.ok && leak.leaked) {
    stackMismatch = true;
    signals.push({ kind: "leak", level: "alert", text: "response.model is \"" + leak.leaked + "\", not the requested " + model });
  } else if (leak && leak.ok && leak.reported) {
    signals.push({ kind: "leak", level: "info", text: "response.model echoes \"" + leak.reported + "\" — no independent leak" });
  }

  if (ceiling && ceiling.ok && ceiling.leakedId && String(ceiling.leakedId).toLowerCase() !== String(model).toLowerCase().split("/").pop()) {
    stackMismatch = true;
    signals.push({ kind: "ceiling", level: "alert", text: "limit error named " + ceiling.leakedId + (ceiling.ceiling ? " (cap " + ceiling.ceiling + ")" : "") });
  } else if (ceiling && ceiling.ok && ceiling.unvalidated) {
    signals.push({ kind: "ceiling", level: "info", text: ceiling.detail || "endpoint does not enforce max_tokens" });
  } else if (ceiling && ceiling.ok && ceiling.ceiling) {
    signals.push({ kind: "ceiling", level: "info", text: "enforced output cap " + ceiling.ceiling + (ceiling.leakedId ? " for " + ceiling.leakedId : "") });
  }

  let measuredFamily = null;
  if (tokenize && tokenize.available) {
    if (tokenize.exactMatches.length) {
      measuredFamily = tokenize.exactMatches[0];
      signals.push({ kind: "tokenize", level: "info", text: "token IDs match " + tokenize.exactMatches.join("/") + " exactly (" + tokenize.ids.length + " ids)" });
    } else {
      signals.push({ kind: "tokenize", level: "warn", text: "token IDs matched no reference exactly; closest " + tokenize.bestGuess + " (" + Math.round((tokenize.scores[0] || {}).overlap * 100) + "% overlap)" });
    }
  } else if (tokenize && tokenize.available === false) {
    signals.push({ kind: "tokenize", level: "info", text: "/tokenize unavailable (" + tokenize.reason + ")" });
  }

  if (slope && slope.ok) {
    if (!measuredFamily && slope.best)
      measuredFamily = slope.best.key;
    if (slope.best) {
      signals.push({ kind: "slope", level: "info", text: "token-count slope " + slope.server_slope + " ~ " + slope.best.label + " (ratio " + slope.best.ratio + ")" });
    } else {
      signals.push({
        kind: "slope",
        level: "warn",
        text: "token-count slope " + slope.server_slope + " fits no reference family (closest " + (slope.closest ? slope.closest.label + " at " + slope.closest.ratio : "none") + ")"
      });
    }
  } else if (slope && slope.ok === false) {
    signals.push({ kind: "slope", level: "info", text: "slope not measurable — " + slope.reason });
  }

  if (expected.matched && expected.hasReference && measuredFamily) {
    if (measuredFamily !== expected.family) {
      mismatch = true;
      signals.push({ kind: "claim", level: "alert", text: "claimed " + expected.slug + " (expects " + expected.family + ") but tokens are " + measuredFamily });
    } else {
      signals.push({ kind: "claim", level: "ok", text: "tokens match the claim (" + expected.family + ")" });
    }
  } else if (expected.matched && !expected.hasReference) {
    signals.push({ kind: "claim", level: "info", text: expected.slug + " has no public reference tokenizer; judging by routing, identity and limits instead" });
  } else if (!expected.matched) {
    signals.push({ kind: "claim", level: "info", text: "slug is not in the reference catalog; only generic signals apply" });
  }

  if (cutoff && cutoff.ok && cutoff.window) {
    if (cutoff.lateCorrect >= 2) {
      signals.push({ kind: "cutoff", level: "warn", text: "knew " + cutoff.lateCorrect + " facts dated after the advertised window " + cutoff.window.from + "…" + cutoff.window.to });
    } else if (cutoff.earlyWrong >= 2) {
      signals.push({ kind: "cutoff", level: "warn", text: "missed " + cutoff.earlyWrong + " facts comfortably inside " + cutoff.window.from + "…" + cutoff.window.to });
    } else {
      signals.push({ kind: "cutoff", level: "ok", text: "knowledge horizon is consistent with " + cutoff.window.from + "…" + cutoff.window.to + " (" + cutoff.correct + "/" + CUTOFF_QUESTIONS.length + ")" });
    }
  } else if (cutoff && cutoff.ok && !cutoff.window) {
    signals.push({ kind: "cutoff", level: "info", text: "no cutoff window for this slug (" + cutoff.correct + " dated facts known)" });
  }

  if (identity && identity.ok && identity.reported_model) {
    const claimed = String(model || "").toLowerCase();
    const reported = identity.reported_model.toLowerCase();
    const stem = claimed.split(/[/:]/).pop().split("-").slice(0, 2).join("-");
    if (stem && !reported.includes(stem) && reported !== claimed) {
      signals.push({ kind: "identity", level: "warn", text: "model calls itself \"" + identity.reported_model + "\" while claiming " + model });
    } else {
      signals.push({ kind: "identity", level: "ok", text: "self-report: " + identity.reported_model + (identity.reported_cutoff ? " (cutoff " + identity.reported_cutoff + ")" : "") });
    }
  }

  if (limit && limit.ok && limit.breached) {
    signals.push({ kind: "limit", level: "alert", text: "accepted " + limit.prompt_tokens + " prompt tokens against a declared limit of " + limit.declared });
  } else if (limit && limit.ok && limit.accepted === false) {
    signals.push({ kind: "limit", level: "ok", text: "refused an over-limit prompt (HTTP " + limit.http + ")" });
  } else if (limit && limit.ok && limit.accepted) {
    signals.push({ kind: "limit", level: "info", text: "accepted " + (limit.prompt_tokens || "?") + " tokens, within the declared " + limit.declared });
  }

  if (determinism && determinism.ok) {
    signals.push({ kind: "determinism", level: determinism.reproducible ? "ok" : "warn", text: determinism.reproducible ? "temperature 0 is reproducible" : "temperature 0 is not reproducible" });
  }

  if (headers && headers.ok && headers.interesting && acrossRelayHints(headers.interesting).length) {
    signals.push({ kind: "headers", level: "info", text: "upstream headers: " + acrossRelayHints(headers.interesting).join(", ") });
  }

  let verdict;
  if (inconclusive) {
    verdict = "INCONCLUSIVE";
  } else if (relay) {
    verdict = "MULTI-MODEL RELAY";
  } else if (mismatch) {
    verdict = "TOKENIZER MISMATCH";
  } else if (stackMismatch) {
    verdict = "STACK LEAK";
  } else if (!measuredFamily && !(slope && slope.ok)) {
    verdict = "UNVERIFIED";
  } else {
    verdict = "CONSISTENT WITH CLAIM";
  }
  return { verdict, signals, expected, measured_family: measuredFamily };
}

function acrossRelayHints(interesting) {
  const hints = [];
  for (const [name, value] of Object.entries(interesting)) {
    if (/proxy|upstream|served-by|via|gateway/i.test(name) || /proxy|router|relay/i.test(String(value)))
      hints.push(name + ": " + String(value).slice(0, 40));
  }
  return hints;
}

/**
 * Run every probe against one endpoint. `declaredInputTokens` comes from the
 * model catalog when it is known, so the limit probe has something to test.
 */
export async function runProbes({ base, model, key, declaredInputTokens, options = {} }) {
  const opts = { timeoutMs: options.timeoutMs || PROBE_LIMITS.requestTimeoutMs, fetchImpl: options.fetchImpl };
  const started = Date.now();
  const basic = await probeBasic(base, model, key, opts);
  const result = { model, base, basic, started };
  if (basic.status !== "ok") {
    // A blocked probe is not evidence of faking; even the cheap probes are
    // skipped so the caller sees INCONCLUSIVE rather than a false accusation.
    Object.assign(result, buildVerdict({ model, basic: { status: basic.status, detail: basic.detail } }));
    result.elapsed_ms = Date.now() - started;
    return result;
  }
  const [routing, headers, tokenize, leak] = await Promise.all([
    probeRouting(base, model, key, opts),
    probeHeaders(base, model, key, opts),
    options.skipTokenize ? Promise.resolve({ available: false, reason: "skipped" }) : probeTokenize(base, model, key, opts),
    probeStackLeak(base, model, key, opts)
  ]);
  const slope = await probeUsageSlope(base, model, key, opts);
  const identity = await probeIdentity(base, model, key, opts);
  const limit = declaredInputTokens ? await probeDeclaredLimit(base, model, key, declaredInputTokens, opts) : { ok: false, reason: "no declared input limit" };
  const [determinism, ceiling, cutoff] = await Promise.all([
    probeDeterminism(base, model, key, opts),
    probeOutputCeiling(base, model, key, opts),
    probeKnowledgeCutoff(base, model, key, opts)
  ]);
  const verdict = buildVerdict({ model, basic, tokenize, slope, routing, identity, limit, determinism, headers, leak, ceiling, cutoff });
  return { ...result, tokenize, slope, routing, identity, limit, determinism, headers, leak, ceiling, cutoff, ...verdict, elapsed_ms: Date.now() - started };
}

export const __modelprobeTest = { seriesSlope, matchFamilies, classifyStatus, contentOf, scoreFingerprint, PROBE_LIMITS, parseLimitError, extractLeakedModel, gradeCutoff, cutoffWindowFor };
