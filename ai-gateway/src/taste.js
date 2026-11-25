// Optional neurosymbolic taste layer.
//
// Symbolic half: a deterministic critic that checks a finished assistant
// message against rules a program can decide (valid JSON when JSON was asked
// for, tool calls that satisfy the advertised schema, not cut off, not empty,
// plus operator-supplied style regexes). It explains every verdict.
//
// Learned half: per (model, rule) Beta posteriors updated online from those
// verdicts, so "how often does this model satisfy this rule" is measured, not
// assumed. The posterior is reported to operators and never used to reroute
// traffic silently.
//
// Modes: off (default) | annotate (headers and learning only; bodies are never
// touched) | enforce (annotate plus one bounded retry on a hard violation,
// non-stream only).

import { validate } from "./tool-schema.js";
import { repairJson } from "./json-repair.js";

export const MODES = ["off", "annotate", "enforce"];

// weight is how much a rule moves the score and the per-model taste.
export const RULES = {
  non_empty: { hard: true, weight: 1 },
  not_truncated: { hard: true, weight: 1 },
  json_valid: { hard: true, weight: 2 },
  json_repairable: { hard: false, weight: 1 },
  json_schema_ok: { hard: true, weight: 2 },
  tool_calls_valid: { hard: true, weight: 2 },
  reasoning_missing: { hard: false, weight: 0.5 },
  style: { hard: false, weight: 0.25 },
  // The neural half: a decision model scores semantics the symbolic rules
  // cannot see. Soft and lighter than the structural checks, because a judge
  // can be wrong where a parser cannot.
  judge_relevant: { hard: false, weight: 0.75 },
  judge_instruction_following: { hard: false, weight: 0.75 },
  judge_tone: { hard: false, weight: 0.5 }
};

const STYLE_SCAN_LIMIT = 20000;
const MAX_STYLE_RULES = 20;

export function parseStyleRules(value) {
  let list = value;
  if (typeof value === "string") {
    try { list = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list.slice(0, MAX_STYLE_RULES)) {
    if (!r || typeof r.pattern !== "string" || !r.pattern || r.pattern.length > 200) continue;
    const flags = typeof r.flags === "string" && /^[gimsuy]*$/.test(r.flags) ? r.flags.replace(/g/g, "") : "i";
    let re;
    try { re = new RegExp(r.pattern, flags); } catch { continue; }
    const target = r.target === "reasoning" || r.target === "both" ? r.target : "content";
    out.push({ id: String(r.id || r.pattern).slice(0, 48), label: String(r.label || r.id || r.pattern).slice(0, 80), re, target });
  }
  return out;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && (p.text || p.content)) || "").join("");
  return "";
}

function toolDef(tools, name) {
  for (const t of Array.isArray(tools) ? tools : []) {
    const fn = (t && t.function) || t || {};
    if (fn.name === name) return fn;
  }
  return null;
}

// request: the chat payload; message/finishReason: the first choice.
export function critique({ request, message, finishReason, styleRules = [] }) {
  const results = []; // { rule, label?, pass }
  const add = (rule, pass, label) => results.push({ rule, pass, label });
  const msg = message || {};
  const text = textOf(msg.content);
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  add("non_empty", text.trim().length > 0 || calls.length > 0);
  add("not_truncated", finishReason !== "length");

  const rf = request && request.response_format;
  if (rf && (rf.type === "json_object" || rf.type === "json_schema")) {
    let parsed;
    let ok = false;
    try { parsed = JSON.parse(text); ok = true; } catch {}
    let repairable = false;
    if (!ok) {
      // json_valid failed; check whether the text is salvageable (fenced,
      // trailing prose, minor syntax). Repairable JSON is a soft violation.
      const r = repairJson(text);
      repairable = r.ok;
    }
    if (ok || repairable) {
      // Repairable JSON downgrades json_valid from hard to soft: the gateway
      // can fix it, so it is not a reason to reject the model's output.
      results.push({ rule: "json_valid", pass: ok, soft_override: !ok && repairable });
      if (!ok && repairable) results.push({ rule: "json_repairable", pass: false });
    } else {
      add("json_valid", false);
    }
    const schema = rf.type === "json_schema" && rf.json_schema && rf.json_schema.schema;
    if (ok && schema) add("json_schema_ok", validate(parsed, schema).length === 0);
  }

  const tools = request && request.tools;
  if (Array.isArray(tools) && tools.length && calls.length) {
    let ok = true;
    for (const call of calls) {
      const fn = call && call.function;
      const def = fn && toolDef(tools, fn.name);
      if (!def) { ok = false; break; }
      let args;
      try { args = JSON.parse(fn.arguments || "{}"); } catch { ok = false; break; }
      if (def.parameters && validate(args, def.parameters).length) { ok = false; break; }
    }
    add("tool_calls_valid", ok);
  }

  // Reasoning presence: when the request asks for thinking, the response must
  // carry reasoning_content. Soft: the answer may still be correct.
  const wantsReasoning = !!(request && (request.reasoning || (request.model || "").includes("thinking")));
  if (wantsReasoning) {
    const reasoning = msg.reasoning_content || msg.reasoning || "";
    add("reasoning_missing", typeof reasoning === "string" && reasoning.trim().length > 0);
  }

  const reasoningText = (msg.reasoning_content || msg.reasoning || "").slice(0, STYLE_SCAN_LIMIT);
  const scan = text.slice(0, STYLE_SCAN_LIMIT);
  for (const rule of styleRules) {
    if (rule.target === "reasoning")
      add("style", !rule.re.test(reasoningText), rule.label);
    else if (rule.target === "both")
      add("style", !rule.re.test(scan) && !rule.re.test(reasoningText), rule.label);
    else
      add("style", !rule.re.test(scan), rule.label);
  }

  let weight = 0;
  let lost = 0;
  const violations = [];
  let hardFailed = false;
  for (const r of results) {
    const meta = RULES[r.rule];
    weight += meta.weight;
    if (!r.pass) {
      lost += meta.weight;
      const hard = meta.hard && !r.soft_override;
      violations.push({ rule: r.rule, severity: hard ? "hard" : "soft", ...(r.label ? { label: r.label } : {}) });
      if (hard) hardFailed = true;
    }
  }
  const score = weight ? Math.max(0, 1 - lost / weight) : 1;
  return { score: Math.round(score * 100) / 100, violations, hard_failed: hardFailed, results };
}

// ---- learned posteriors ----

const ensured = new WeakSet();
export async function ensureTasteSchema(db) {
  if (!db || ensured.has(db)) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS taste_posteriors (slug TEXT NOT NULL, rule TEXT NOT NULL, route TEXT NOT NULL DEFAULT '', account_id TEXT NOT NULL DEFAULT '', alpha REAL NOT NULL DEFAULT 1, beta REAL NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY (slug, rule, route, account_id))"
  ).run();
  // Migrate: SQLite cannot alter a primary key, so an existing table must be
  // rebuilt with account_id in the key.
  try {
    const cols = await db.prepare("PRAGMA table_info(taste_posteriors)").all();
    const names = (cols.results || []).map((c) => c.name);
    if (names.length && !names.includes("account_id")) {
      await db.prepare("ALTER TABLE taste_posteriors RENAME TO taste_posteriors_old").run();
      await db.prepare(
        "CREATE TABLE taste_posteriors (slug TEXT NOT NULL, rule TEXT NOT NULL, route TEXT NOT NULL DEFAULT '', account_id TEXT NOT NULL DEFAULT '', alpha REAL NOT NULL DEFAULT 1, beta REAL NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY (slug, rule, route, account_id))"
      ).run();
      await db.prepare(
        "INSERT INTO taste_posteriors (slug, rule, route, account_id, alpha, beta, updated_at) SELECT slug, rule, route, '', alpha, beta, updated_at FROM taste_posteriors_old"
      ).run();
      await db.prepare("DROP TABLE taste_posteriors_old").run();
    }
  } catch {}
  // Persisted verdict history: one small row per response, used for the
  // per-account trend and the console feed. Same sanitation guarantee as the
  // posteriors: rule names and a score only, never request or response text.
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS taste_verdicts (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL, score REAL NOT NULL, violations TEXT NOT NULL DEFAULT '')"
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_taste_verdicts_account ON taste_verdicts(account_id, at)"
  ).run();
  ensured.add(db);
}

const MAX_VERDICTS_PER_ACCOUNT = 200;

// Persist one verdict for the trend/history views. Fire-and-forget: a failed
// insert must never break a response.
export async function recordVerdict(db, accountId, slug, verdict) {
  if (!db || !slug) return;
  try {
    await ensureTasteSchema(db);
    await db.prepare("INSERT INTO taste_verdicts (at, account_id, slug, score, violations) VALUES (?,?,?,?,?)")
      .bind(new Date().toISOString(), String(accountId || ""), slug, verdict.score, verdict.violations.map((v) => v.rule + (v.label ? ":" + v.label : "")).join(",")).run();
    await db.prepare(
      "DELETE FROM taste_verdicts WHERE account_id=? AND id NOT IN (SELECT id FROM taste_verdicts WHERE account_id=? ORDER BY id DESC LIMIT ?)"
    ).bind(String(accountId || ""), String(accountId || ""), MAX_VERDICTS_PER_ACCOUNT).run();
  } catch {}
}

// Recent persisted verdicts for one or more accounts, newest first.
export async function recentVerdictsFor(db, accountIds, limit = 30) {
  if (!db || !accountIds.length) return [];
  await ensureTasteSchema(db);
  const marks = accountIds.map(() => "?").join(",");
  const rows = await db.prepare(
    `SELECT at, account_id, slug, score, violations FROM taste_verdicts WHERE account_id IN (${marks}) ORDER BY id DESC LIMIT ?`
  ).bind(...accountIds, limit).all();
  return (rows.results || []).map((r) => ({
    at: r.at,
    account_id: r.account_id,
    slug: r.slug,
    score: Number(r.score),
    violations: String(r.violations || "").split(",").filter(Boolean)
  }));
}

const DECAY_HALF_LIFE_MS = 30 * 86400000; // 30 days

export async function updatePosteriors(db, slug, results, route, accountId) {
  if (!slug || !results.length) return;
  await ensureTasteSchema(db);
  route = String(route || "");
  accountId = String(accountId || "");
  const at = new Date().toISOString();
  // One row per rule per response; style rules fold into a single "style" row.
  const folded = new Map();
  for (const r of results) {
    const cur = folded.get(r.rule) || { pass: 0, fail: 0 };
    if (r.pass) cur.pass++; else cur.fail++;
    folded.set(r.rule, cur);
  }
  const rules = [...folded.keys()];
  // Read every rule's current posterior up front (concurrently), then write.
  // Each (slug, rule, route, account) key is distinct, so batching the reads
  // before the writes preserves the read-modify-write semantics of the old
  // per-rule loop while collapsing N sequential round trips into one wave.
  const existing = await Promise.all(rules.map((rule) =>
    Promise.resolve(
      db.prepare("SELECT alpha, beta, updated_at FROM taste_posteriors WHERE slug=? AND rule=? AND route=? AND account_id=?")
        .bind(slug, rule, route, accountId).first()
    ).catch(() => null)
  ));
  await Promise.all(rules.map((rule, i) => {
    const prev = existing[i];
    const n = folded.get(rule);
    let alpha = 1, beta = 1;
    if (prev) {
      const ageMs = Date.now() - new Date(prev.updated_at).getTime();
      const halfLives = ageMs / DECAY_HALF_LIFE_MS;
      const decay = Math.pow(0.5, halfLives);
      alpha = 1 + (Number(prev.alpha) - 1) * decay;
      beta = 1 + (Number(prev.beta) - 1) * decay;
    }
    alpha += n.pass;
    beta += n.fail;
    return Promise.resolve(db.prepare(
      "INSERT INTO taste_posteriors (slug, rule, route, account_id, alpha, beta, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(slug, rule, route, account_id) DO UPDATE SET alpha=excluded.alpha, beta=excluded.beta, updated_at=excluded.updated_at"
    ).bind(slug, rule, route, accountId, alpha, beta, at).run()).catch(() => {});
  }));
}

// Per-account profile for the console: the account's rule means across
// models, plus the weighted taste score, plus a trend of recent scores.
export async function loadAccountTaste(db, accountIds) {
  if (!db || !accountIds.length) return null;
  await ensureTasteSchema(db);
  const marks = accountIds.map(() => "?").join(",");
  const rows = await db.prepare(
    `SELECT slug, rule, alpha, beta FROM taste_posteriors WHERE account_id IN (${marks})`
  ).bind(...accountIds).all();
  const byRule = new Map();
  const byModel = new Map();
  for (const r of rows.results || []) {
    const n = Number(r.alpha) + Number(r.beta) - 2;
    const mean = Number(r.alpha) / (Number(r.alpha) + Number(r.beta));
    const cur = byRule.get(r.rule) || { pass: 0, total: 0 };
    cur.pass += Number(r.alpha) - 1;
    cur.total += n;
    byRule.set(r.rule, cur);
    const m = byModel.get(r.slug) || { rules: {}, samples: 0 };
    m.rules[r.rule] = { mean: Math.round(mean * 1000) / 1000, n };
    m.samples = Math.max(m.samples, n);
    byModel.set(r.slug, m);
  }
  const rules = {};
  let num = 0, den = 0, samples = 0;
  for (const [rule, cur] of byRule) {
    const mean = cur.total ? (1 + cur.pass) / (2 + cur.total) : 0.5;
    // Beta counts decay continuously, so n can sit a hair below the true
    // integer count. Round for display; the mean uses the raw value.
    const n = Math.round(cur.total * 1000) / 1000;
    rules[rule] = { mean: Math.round(mean * 1000) / 1000, n: Math.round(n) };
    const w = RULES[rule] ? RULES[rule].weight : 1;
    num += mean * w;
    den += w;
    samples = Math.max(samples, cur.total);
  }
  samples = Math.round(samples);
  // Trend: average score per hour over the last 48 hours.
  const since = new Date(Date.now() - 48 * 3600000).toISOString();
  const trend = await db.prepare(
    `SELECT substr(at, 1, 13) AS hour, AVG(score) AS avg_score, COUNT(*) AS n FROM taste_verdicts WHERE account_id IN (${marks}) AND at >= ? GROUP BY hour ORDER BY hour`
  ).bind(...accountIds, since).all();
  return {
    taste: den ? Math.round((num / den) * 1000) / 1000 : null,
    samples,
    rules,
    models: Object.fromEntries(byModel),
    trend: (trend.results || []).map((r) => ({ hour: r.hour + ":00:00.000Z", score: Math.round(Number(r.avg_score) * 1000) / 1000, n: Number(r.n) }))
  };
}

// samples are observations beyond the Beta(1,1) prior.
export async function loadTasteReport(db) {
  await ensureTasteSchema(db);
  const rows = await db.prepare("SELECT slug, rule, route, account_id, alpha, beta FROM taste_posteriors ORDER BY slug, rule, route, account_id").all();
  const bySlug = new Map();
  for (const r of rows.results || []) {
    const m = bySlug.get(r.slug) || { slug: r.slug, rules: {}, routes: {}, accounts: {}, num: 0, den: 0, samples: 0 };
    // Decay blurs the discrete observation count by a few nanounits between
    // calls. Round n for display; the mean uses the raw counts.
    const n = Math.round((Number(r.alpha) + Number(r.beta) - 2) * 1000) / 1000;
    const mean = Number(r.alpha) / (Number(r.alpha) + Number(r.beta));
    m.rules[r.rule] = { mean: Math.round(mean * 1000) / 1000, n: Math.round(n) };
    if (r.route) {
      const rm = m.routes[r.route] || { rules: {}, samples: 0 };
      rm.rules[r.rule] = { mean: Math.round(mean * 1000) / 1000, n: Math.round(n) };
      rm.samples = Math.max(rm.samples, n);
      m.routes[r.route] = rm;
    }
    if (r.account_id) {
      const am = m.accounts[r.account_id] || { rules: {}, samples: 0 };
      am.rules[r.rule] = { mean: Math.round(mean * 1000) / 1000, n: Math.round(n) };
      am.samples = Math.max(am.samples, n);
      m.accounts[r.account_id] = am;
    }
    const w = RULES[r.rule] ? RULES[r.rule].weight : 1;
    m.num += mean * w;
    m.den += w;
    m.samples = Math.max(m.samples, n);
    bySlug.set(r.slug, m);
  }
  return [...bySlug.values()].map((m) => ({
    slug: m.slug,
    taste: m.den ? Math.round((m.num / m.den) * 1000) / 1000 : null,
    samples: Math.round(m.samples),
    rules: m.rules,
    routes: m.routes,
    accounts: m.accounts
  }));
}

// ---- recent verdicts (in-memory ring, no bodies) ----

const recent = [];
export function noteVerdict(slug, verdict, accountId) {
  recent.push({ at: new Date().toISOString(), slug, score: verdict.score, violations: verdict.violations.map((v) => v.rule + (v.label ? ":" + v.label : "")), account_id: String(accountId || "") });
  if (recent.length > 200) recent.splice(0, recent.length - 200);
}
export function recentVerdicts() {
  return recent.slice(-50).reverse();
}
export function clearVerdicts() {
  recent.length = 0;
}

// Critique appended to the retry so the model knows exactly what to fix.
export function retryCritique(verdict) {
  const hard = verdict.violations.filter((v) => v.severity === "hard").map((v) => v.rule);
  const lines = {
    non_empty: "The previous answer was empty.",
    not_truncated: "The previous answer was cut off by the length limit. Be more concise and finish the answer.",
    json_valid: "The previous answer was not valid JSON. Reply with a single valid JSON value and nothing else.",
    json_schema_ok: "The previous JSON did not match the required schema. Follow the schema exactly.",
    tool_calls_valid: "The previous tool call did not match the tool's schema. Call a listed tool with arguments that satisfy its parameters."
  };
  return hard.map((r) => lines[r]).filter(Boolean).join(" ");
}

// ---- the neural judging half ----
//
// The symbolic rules decide what a program can check. A decision model
// (SubQ, or any systemone provider) judges what they cannot: was the answer
// actually about the request, did it do what was asked, is the tone right.
// Its scores are calibrated probabilities, so they feed the SAME Beta
// posteriors as the rule verdicts - one learned channel, two kinds of signal.
//
// The judge sees a sanitized state: a short task summary and the response
// text. The raw user prompt is never sent upstream, so a conversation's
// private content never leaves through the judging side door.

export const JUDGE_QUESTIONS = {
  relevant: {
    type: "noul",
    instructions: "Is this a substantive, coherent, on-point response for the kind of task described, rather than a refusal, deflection, boilerplate, or nonsense?",
    criteria: {
      true: "Substantive and coherent for the task shape",
      false: "A refusal, deflection, boilerplate, or incoherent content"
    }
  },
  instruction_following: {
    type: "noul",
    instructions: "Given the request shape (format and tool availability), does the response conform: valid structure when structured output was wanted, tool calls well-formed when tools were offered?",
    criteria: {
      true: "Conforms to the requested format and tool contract",
      false: "Wrong format, malformed structure, or ignores the tool contract"
    }
  },
  tone: {
    type: "noul",
    instructions: "Is the tone appropriate: professional where needed, not sycophantic, not padded, no filler or boilerplate openers?",
    criteria: {
      true: "Appropriate register, concise, no filler",
      false: "Sycophantic, padded, condescending, or off-register"
    }
  }
};

const JUDGE_PASS_THRESHOLD = 0.5;
const JUDGE_RESPONSE_CAP = 6000;

// Build the sanitized judging state. The judge gets the response text plus
// the STRUCTURE of the request (did it want JSON, tools, a format), never the
// prompt's content words. Relevance is judged on response quality and
// instruction-following on the shape, so private prompt text never leaves
// through the judging side door.
function judgeState({ responseText, wantsJson, hasTools }) {
  const resp = String(responseText || "").slice(0, JUDGE_RESPONSE_CAP);
  const shapeParts = [];
  shapeParts.push(wantsJson ? "structured JSON output was requested" : "free-form text was requested");
  shapeParts.push(hasTools ? "the task offered tools the answer could call" : "no tools were offered");
  return {
    request_shape: shapeParts.join("; "),
    wants_json: !!wantsJson,
    has_tools: !!hasTools,
    response: resp
  };
}

// Ask the decision model to score the response. `caller` is injected by the
// gateway so this module never touches provider config, keys, or egress.
// Returns { scores: {dim: probability} } or null when the judge is absent or
// unreachable - judging is best-effort and must never break a response.
export async function judgeWithDecisionModel({ caller, responseText, wantsJson, hasTools }) {
  if (typeof caller !== "function") return null;
  const state = judgeState({ responseText, wantsJson, hasTools });
  if (!state.response.trim()) return null;
  let answers;
  try {
    answers = await caller({ state, questions: JUDGE_QUESTIONS });
  } catch {
    return null;
  }
  if (!answers || typeof answers !== "object") return null;
  const scores = {};
  for (const dim of Object.keys(JUDGE_QUESTIONS)) {
    const a = answers[dim];
    const p = a && typeof a === "object" ? Number(a.probability ?? a.noul) : Number(a);
    if (Number.isFinite(p)) scores[dim] = Math.max(0, Math.min(1, p > 1 ? p / 100 : p));
  }
  return Object.keys(scores).length ? { scores, state } : null;
}

// Turn judge scores into soft taste results. A score at or above the
// threshold passes; below it fails. These fold into updatePosteriors exactly
// like the rule verdicts, so "how often is this model relevant for this
// account" is measured the same way as "how often is its JSON valid".
export function mergeJudgeIntoResults(results, judged) {
  if (!judged || !judged.scores) return results;
  for (const [dim, p] of Object.entries(judged.scores)) {
    results.push({ rule: "judge_" + dim, pass: p >= JUDGE_PASS_THRESHOLD, judge_score: Math.round(p * 1000) / 1000 });
  }
  return results;
}
