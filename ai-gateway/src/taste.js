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
  style: { hard: false, weight: 0.25 }
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
  ensured.add(db);
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
  for (const [rule, n] of folded) {
    // Decay old evidence toward the prior before adding new observations.
    const existing = await db.prepare("SELECT alpha, beta, updated_at FROM taste_posteriors WHERE slug=? AND rule=? AND route=? AND account_id=?")
      .bind(slug, rule, route, accountId).first();
    let alpha = 1, beta = 1;
    if (existing) {
      const ageMs = Date.now() - new Date(existing.updated_at).getTime();
      const halfLives = ageMs / DECAY_HALF_LIFE_MS;
      const decay = Math.pow(0.5, halfLives);
      alpha = 1 + (Number(existing.alpha) - 1) * decay;
      beta = 1 + (Number(existing.beta) - 1) * decay;
    }
    alpha += n.pass;
    beta += n.fail;
    await db.prepare(
      "INSERT INTO taste_posteriors (slug, rule, route, account_id, alpha, beta, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(slug, rule, route, account_id) DO UPDATE SET alpha=excluded.alpha, beta=excluded.beta, updated_at=excluded.updated_at"
    ).bind(slug, rule, route, accountId, alpha, beta, at).run();
  }
}

// samples are observations beyond the Beta(1,1) prior.
export async function loadTasteReport(db) {
  await ensureTasteSchema(db);
  const rows = await db.prepare("SELECT slug, rule, route, account_id, alpha, beta FROM taste_posteriors ORDER BY slug, rule, route, account_id").all();
  const bySlug = new Map();
  for (const r of rows.results || []) {
    const m = bySlug.get(r.slug) || { slug: r.slug, rules: {}, routes: {}, accounts: {}, num: 0, den: 0, samples: 0 };
    const n = Number(r.alpha) + Number(r.beta) - 2;
    const mean = Number(r.alpha) / (Number(r.alpha) + Number(r.beta));
    m.rules[r.rule] = { mean: Math.round(mean * 1000) / 1000, n };
    if (r.route) {
      const rm = m.routes[r.route] || { rules: {}, samples: 0 };
      rm.rules[r.rule] = { mean: Math.round(mean * 1000) / 1000, n };
      rm.samples = Math.max(rm.samples, n);
      m.routes[r.route] = rm;
    }
    if (r.account_id) {
      const am = m.accounts[r.account_id] || { rules: {}, samples: 0 };
      am.rules[r.rule] = { mean: Math.round(mean * 1000) / 1000, n };
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
    samples: m.samples,
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
