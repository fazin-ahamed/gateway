// HORIZON-Ω — compute kernel for model: "auto".
// Ranks computational actions (model / compact / reroute / stop) from the
// operator's enabled routes. Never invents luxury slugs.

const LUXURY = /(gpt-6-astra|\bastra\b|claude-fable|fable-5|mythos|gpt-6(?!.*mini)|opus-5|claude-opus-5)/;
const FAMILY = [
  [/glm-5/, "glm"],
  [/deepseek/, "deepseek"],
  [/grok-4/, "grok"],
  [/minimax/, "minimax"],
  [/qwen/, "qwen"],
  [/kimi|moonshot/, "kimi"],
  [/laguna/, "laguna"],
  [/agnes/, "agnes"],
  [/muse/, "muse"]
];

function textOf(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content))
    return m.content.map((p) => p && typeof p.text === "string" ? p.text : "").filter(Boolean).join(" ");
  return "";
}

function lastUserText(payload) {
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
  let last = "";
  for (const m of msgs) {
    if (m && m.role === "user") last = textOf(m);
  }
  return last;
}

function familyOf(slug) {
  const id = String(slug || "").toLowerCase();
  for (const [re, name] of FAMILY) {
    if (re.test(id)) return name;
  }
  return "other";
}

export function isHorizonLuxury(slug) {
  return LUXURY.test(String(slug || "").toLowerCase());
}
export function isTinySlug(id) {
  const s = String(id || "").toLowerCase();
  if (s.includes("minimax")) return false;
  return /(flash|(^|[-_/])lite([^a-z]|$)|(^|[-_/])mini([^a-z]|$)|small|(^|[-_/])air([^a-z]|$)|nano|(^|[-_/])xs([^a-z]|$))/.test(s);
}

export function capabilityTensor(slug) {
  const id = String(slug || "").toLowerCase();
  if (isHorizonLuxury(id))
    return { plan: 0.70, code: 0.72, debug: 0.70, judge: 0.74, tools: 0.70, longctx: 0.88, cheap: 0.05 };
  if (/(glm-5(?!.*flash)|deepseek-v4-pro|grok-4\.6|kimi-k3|kimi-k2\.6)/.test(id))
    return { plan: 0.92, code: 0.96, debug: 0.93, judge: 0.88, tools: 0.94, longctx: 0.84, cheap: 0.72 };
  if (/(minimax-m3|qwen3\.8|qwen3-max|deepseek-v4(?!.*flash)|glm-4\.6)/.test(id))
    return { plan: 0.88, code: 0.91, debug: 0.87, judge: 0.84, tools: 0.90, longctx: 0.86, cheap: 0.78 };
  if (/(glm-5\.3-flash|glm-5-flash|deepseek-v4-flash|qwen3|kimi)/.test(id))
    return { plan: 0.78, code: 0.82, debug: 0.74, judge: 0.70, tools: 0.88, longctx: 0.70, cheap: 0.95 };
  if (/(laguna-s|agnes-3)/.test(id))
    return { plan: 0.72, code: 0.78, debug: 0.70, judge: 0.66, tools: 0.80, longctx: 0.64, cheap: 0.90 };
  if (/(laguna-xs|muse-spark)/.test(id))
    return { plan: 0.60, code: 0.65, debug: 0.55, judge: 0.50, tools: 0.70, longctx: 0.50, cheap: 0.98 };
  return { plan: 0.55, code: 0.55, debug: 0.52, judge: 0.50, tools: 0.55, longctx: 0.55, cheap: 0.60 };
}

export function compileTaskIR(payload, cx) {
  const ask = lastUserText(payload);
  const lower = ask.toLowerCase();
  const askWords = lower.split(/\s+/).filter(Boolean).length;
  const hasTools = !!(payload && (payload.tools || payload.functions));
  const images = Number(cx && cx.images) || 0;
  const tokens = Number(cx && cx.estInputTokens) || 0;
  const score = Number(cx && cx.score) || 0;
  const families = [];
  if (images) families.push("vision");
  if (tokens > 40000) families.push("longctx");
  if (/\b(debug|stack trace|root cause|regression|race condition|memory leak)\b/.test(lower))
    families.push("debug");
  if (/\b(refactor|implement|migrate|algorithm|patch|code|function|typescript|python)\b/.test(lower) || /\.\w{1,8}\b/.test(ask))
    families.push("coding");
  const coding = families.includes("coding") || families.includes("debug");
  const toolsFamily = hasTools && (coding || askWords >= 4);
  if (toolsFamily) families.push("tools");
  if (/\b(prove|derive|theorem|integral|proof)\b/.test(lower))
    families.push("math");
  if (!families.length) families.push("chat");
  const difficulty = Math.max(0, Math.min(1, score / 8 + (toolsFamily ? 0.12 : 0) + (images ? 0.08 : 0)));
  const ambiguity = Math.max(0, Math.min(1, (askWords < 6 ? 0.35 : 0.12) + (/\?/.test(ask) ? 0.1 : 0)));
  const decomposition = coding || toolsFamily ? Math.min(1, 0.45 + difficulty) : Math.min(0.4, difficulty);
  const verification = coding || families.includes("math") ? Math.min(1, 0.55 + difficulty) : difficulty * 0.3;
  const toolComplexity = toolsFamily ? Math.min(1, 0.5 + (Array.isArray(payload.tools) ? payload.tools.length : 1) * 0.08) : 0;
  const stages = coding
    ? ["inspect", "diagnose", "modify", "verify"]
    : toolsFamily
      ? ["plan", "act", "verify"]
      : ["answer"];
  return {
    goal: ask.replace(/\s+/g, " ").trim().slice(0, 280) || "(none)",
    families,
    stages,
    difficulty,
    ambiguity,
    decomposition,
    verification,
    toolComplexity,
    latency: tokens > 40000 || difficulty > 0.7 ? "batch" : "interactive",
    success: coding
      ? ["root cause named", "patch proposed", "no silent guess"]
      : toolsFamily
        ? ["tool args valid", "state updated"]
        : ["direct answer"]
  };
}
export function initWorld(payload, taskIR) {
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
  const live = msgs.filter((m) => m && m.role !== "system" && m.role !== "developer");
  const blob = live.map(textOf).join("\n");
  const files = [...new Set((blob.match(/(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,8}/gi) || [])).values()].slice(0, 8);
  const urls = [...new Set((blob.match(/https?:\/\/[^\s)]+/gi) || [])).values()].slice(0, 6);
  const tools = Array.isArray(payload && payload.tools)
    ? payload.tools.map((t) => (t && t.function && t.function.name) || t.name).filter(Boolean).slice(0, 8)
    : [];
  const facts = [];
  const beliefs = [];
  const unknowns = [];
  if (files.length) facts.push({ k: "files", v: files.join(", "), conf: 1, src: "prompt" });
  if (tools.length) facts.push({ k: "tools", v: tools.join(", "), conf: 1, src: "schema" });
  if (taskIR && taskIR.goal) beliefs.push({ k: "goal", v: taskIR.goal, conf: 0.9, src: "compiler" });
  if (taskIR && taskIR.ambiguity > 0.3) unknowns.push("user intent details");
  if (files.length && taskIR && taskIR.families.includes("debug"))
    unknowns.push("failing test output");
  return {
    facts,
    beliefs,
    unknowns,
    artifacts: { files, urls },
    tools,
    turns: live.filter((m) => m.role === "user").length,
    uncertainty: taskIR ? taskIR.ambiguity : 0.2,
    hops: 0
  };
}

export function phaseOf(taskIR) {
  const fam = (taskIR && taskIR.families) || [];
  if (fam.includes("debug")) return "debug";
  if (fam.includes("coding")) return "code";
  if (fam.includes("tools")) return "tools";
  if (fam.includes("longctx")) return "longctx";
  if (fam.includes("vision")) return "plan";
  if (fam.includes("math")) return "plan";
  return "plan";
}

function mvcOf(cand, taskIR, phase) {
  const t = capabilityTensor(cand.slug);
  const q = Number(t[phase] || t.plan || 0.5);
  const rel = cand.samples >= 3 ? Number(cand.okRate || 1) : 1;
  const gain = Math.max(0, q * rel - 0.45);
  const cost = Math.max(1e-4, Number(cand.cost) || 0.5);
  const lat = Math.max(0.05, (Number(cand.avgMs) || 800) / 1000);
  const tight = cand.ctxTight ? 0.35 : 0;
  const luxuryTax = cand.luxury || isHorizonLuxury(cand.slug) ? 2.5 : 0;
  return gain / (cost + 0.12 * lat + tight + luxuryTax);
}

function complementary(a, b) {
  if (!a || !b || a === b) return 0;
  if (familyOf(a) === familyOf(b)) return 0.15;
  const ta = capabilityTensor(a);
  const tb = capabilityTensor(b);
  let d = 0;
  for (const k of ["code", "debug", "tools", "longctx", "judge"])
    d += Math.abs((ta[k] || 0) - (tb[k] || 0));
  return d;
}

export function generateActions(candidates, taskIR, world) {
  const phase = phaseOf(taskIR);
  const actions = [];
  const eligible = (candidates || []).filter((c) => c && c.slug && !isHorizonLuxury(c.slug) && (c.eligible || c.capable || c.workhorse));
  const pool = eligible.length ? eligible : (candidates || []).filter((c) => c && c.slug && !isHorizonLuxury(c.slug));
  for (const cand of pool) {
    const role = phase === "debug" ? "debug" : phase === "code" ? "code" : "answer";
    actions.push({
      type: "model",
      slug: cand.slug,
      role,
      family: familyOf(cand.slug),
      mvc: mvcOf(cand, taskIR, phase),
      tiny: isTinySlug(cand.slug) || !!cand.tiny,
      workhorse: !!cand.workhorse,
      capable: cand.capable !== false
    });
  }
  if (world && world.turns >= 6)
    actions.push({ type: "compact", slug: null, role: "compact", mvc: 1.8, cost: 0 });
  actions.push({ type: "stop", slug: null, role: "stop", mvc: 0.05, cost: 0 });
  return actions.sort((a, b) => b.mvc - a.mvc);
}

export function pickAction(actions, taskIR) {
  const models = (actions || []).filter((a) => a.type === "model" && a.capable !== false);
  const fam = (taskIR && taskIR.families) || [];
  const reflex = !!(taskIR && taskIR.difficulty < 0.32 && taskIR.toolComplexity < 0.15 && !fam.includes("longctx") && !fam.includes("vision") && !fam.includes("coding") && !fam.includes("debug"));
  if (reflex && models.length) {
    const tinies = models.filter((a) => a.tiny);
    const pool = tinies.length ? tinies : models;
    let best = null;
    for (const a of pool) {
      if (!best || a.cost < best.cost || (a.cost === best.cost && a.mvc > best.mvc))
        best = a;
    }
    return { ...(best || models[0]), speed: "reflex" };
  }
  const strong = models.filter((a) => !a.tiny);
  const pool = ((fam.includes("coding") || fam.includes("debug")) && strong.length) ? strong : models;
  const deliberative = pool[0] || models[0] || (actions || [])[0] || null;
  return deliberative ? { ...deliberative, speed: "deliberative" } : null;
}
export function buildQueue(actions, chosen, limit) {
  const n = Math.max(1, Math.min(3, limit || 2));
  const phase = (chosen && chosen.role === "debug") ? "debug" : (chosen && chosen.role === "code") ? "code" : "plan";
  let models = (actions || []).filter((a) => a.type === "model" && a.slug && a.slug !== (chosen && chosen.slug) && a.capable !== false && !isHorizonLuxury(a.slug));
  const strong = models.filter((a) => !isTinySlug(a.slug) && (capabilityTensor(a.slug)[phase] || 0) >= 0.75);
  if (chosen && !isTinySlug(chosen.slug) && strong.length) models = strong;
  const out = [];
  const used = new Set([familyOf(chosen && chosen.slug)]);
  const rest = models.slice().sort((a, b) => complementary(chosen && chosen.slug, b.slug) - complementary(chosen && chosen.slug, a.slug) || b.mvc - a.mvc);
  for (const a of rest) {
    const fam = familyOf(a.slug);
    if (used.has(fam)) continue;
    out.push(a.slug);
    used.add(fam);
    if (out.length >= n) break;
  }
  if (!out.length) {
    for (const a of models) {
      if (!out.includes(a.slug)) out.push(a.slug);
      if (out.length >= n) break;
    }
  }
  return out;
}

export function planHorizon({ payload, candidates, picked, need, reqTokens, cx }) {
  const taskIR = compileTaskIR(payload, cx || { score: need, estInputTokens: reqTokens, images: 0 });
  const world = initWorld(payload, taskIR);
  const actions = generateActions(candidates || [], taskIR, world);
  let chosen = pickAction(actions, taskIR);
  if (!chosen && picked)
    chosen = { type: "model", slug: picked.slug, role: "answer", mvc: 0, speed: "deliberative" };
  if (!chosen || chosen.type !== "model") {
    if (picked && !isHorizonLuxury(picked.slug))
      chosen = { type: "model", slug: picked.slug, role: "answer", mvc: 0, speed: "deliberative" };
  }
  const queue = chosen && chosen.type === "model" ? buildQueue(actions, chosen, chosen.speed === "reflex" ? 1 : 2) : [];
  const compact = actions.some((a) => a.type === "compact" && a.mvc > (chosen && chosen.mvc || 0));
  return {
    slug: (chosen && chosen.slug) || (picked && picked.slug) || null,
    role: (chosen && chosen.role) || "answer",
    speed: (chosen && chosen.speed) || "deliberative",
    mvc: chosen ? Number(chosen.mvc) || 0 : 0,
    queue,
    taskIR,
    world,
    compact: !!compact || (Number(reqTokens) > 24000),
    hopsMax: (chosen && chosen.speed === "reflex") ? 1 : 1 + queue.length,
    phase: phaseOf(taskIR)
  };
}

export function observeFailure(plan, failedSlug, why) {
  const next = (plan.queue || []).filter((s) => s && s !== failedSlug);
  const world = { ...(plan.world || {}), hops: ((plan.world && plan.world.hops) || 0) + 1 };
  world.facts = (world.facts || []).concat([{ k: "failed_route", v: failedSlug + ":" + String(why || "error").slice(0, 80), conf: 1, src: "runtime" }]);
  return {
    ...plan,
    slug: next[0] || null,
    queue: next.slice(1),
    world,
    speed: "deliberative",
    role: plan.phase === "debug" ? "debug" : "repair"
  };
}

export function shouldStop(plan) {
  if (!plan) return true;
  if (!plan.slug) return true;
  const hops = (plan.world && plan.world.hops) || 0;
  if (hops >= (plan.hopsMax || 1)) return true;
  return false;
}

export function renderHorizonState(plan) {
  const ir = plan && plan.taskIR || {};
  const w = plan && plan.world || {};
  const lines = [
    "You are an actuator of HORIZON-Ω. Stay inside the current computational stage.",
    "TASKIR:",
    "- goal: " + (ir.goal || "(none)"),
    "- families: " + ((ir.families || []).join(", ") || "chat"),
    "- stages: " + ((ir.stages || []).join(" → ") || "answer"),
    "- difficulty: " + Number(ir.difficulty || 0).toFixed(2) + "  verify: " + Number(ir.verification || 0).toFixed(2),
    "- success: " + ((ir.success || []).join("; ") || "answer"),
    "WORLD:",
    (w.facts || []).map((f) => "- fact " + f.k + "=" + f.v + " (" + f.conf + ")").join("\n"),
    (w.beliefs || []).map((f) => "- belief " + f.k + "=" + f.v + " (" + f.conf + ")").join("\n"),
    (w.unknowns || []).length ? "- unknown: " + w.unknowns.join("; ") : "",
    "ACTION: " + (plan.role || "answer") + " via " + (plan.slug || "?") + " [" + (plan.speed || "deliberative") + " mvc=" + Number(plan.mvc || 0).toFixed(2) + "]",
    plan.queue && plan.queue.length ? "- reroute_if_fail: " + plan.queue.join(", ") : "",
    "Rules: do not promote beliefs to facts. Prefer the cheapest action that can falsify a claim. If context was compacted, trust TASKIR/WORLD over forgotten turns."
  ];
  return lines.filter(Boolean).join("\n");
}
