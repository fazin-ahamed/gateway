// TaskIR V2 — one local compiler for model: "auto".
//
// Replaces the duplicate keyword tables in promptComplexity() and
// horizon.compileTaskIR(). No GPU, no extra model call. Features are
// cheap lexical/metadata signals; a tiny linear scorer picks one of
// ~30 task labels. Low confidence stays on the label, it just reports it.

const TASKS = [
  "chat:casual",
  "chat:knowledge",
  "writing:rewrite",
  "writing:creative",
  "writing:professional",
  "code:generation",
  "code:debug",
  "code:review",
  "code:architecture",
  "agent:tool_single",
  "agent:multi_step",
  "agent:repo_edit",
  "research:lookup",
  "research:synthesis",
  "math:simple",
  "math:proof",
  "math:competition",
  "reasoning:logic",
  "reasoning:planning",
  "data:extract",
  "data:analysis",
  "vision:ocr_like",
  "vision:reasoning"
];

function textOf(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content))
    return m.content.map((p) => p && typeof p.text === "string" ? p.text : "").filter(Boolean).join(" ");
  return "";
}

export function lastUserText(payload) {
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
  let last = "";
  for (const m of msgs) {
    if (m && m.role === "user") last = textOf(m);
  }
  return last;
}

export function extractFeatures(payload) {
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
  const live = msgs.filter((m) => m && m.role !== "system" && m.role !== "developer");
  const blob = live.map(textOf).join("\n");
  const ask = lastUserText(payload);
  const askLower = ask.toLowerCase();
  const tools = payload && (payload.tools || payload.functions);
  const toolCount = Array.isArray(tools) ? tools.length : (tools ? 1 : 0);
  let imageCount = 0;
  let textChars = 0;
  let systemChars = 0;
  for (const m of msgs) {
    const c = m && m.content;
    const add = (part) => {
      if (typeof part === "string") return part.length;
      if (part && typeof part.text === "string") return part.text.length;
      return 0;
    };
    if (typeof c === "string") {
      if (m.role === "system" || m.role === "developer") systemChars += c.length;
      else textChars += c.length;
    } else if (Array.isArray(c)) {
      for (const p of c) {
        const n = add(p);
        if (m.role === "system" || m.role === "developer") systemChars += n;
        else textChars += n;
        if (p && (p.type === "image_url" || p.type === "image")) imageCount++;
      }
    }
  }
  let toolSchemaChars = 0;
  try {
    if (tools) toolSchemaChars = JSON.stringify(tools).length;
  } catch {}
  const turns = live.filter((m) => m && m.role === "user").length;
  const words = ask.trim() ? ask.trim().split(/\s+/).length : 0;
  const files = (ask.match(/(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,8}/gi) || []).length;
  const urls = (ask.match(/https?:\/\/[^\s)]+/gi) || []).length;
  const semanticTokens = Math.ceil(ask.length / 4) + imageCount * 500;
  const contextTokens = Math.ceil((textChars + systemChars + toolSchemaChars) / 4) + imageCount * 500;
  const hasImplement = /\b(implement|build a|create a|code a|develop a)\b/i.test(ask);
  const asksTools = /\b(use (the )?tools?|call \w+|search the web|browse|run (the )?tests?|patch|edit the file|look this up)\b/i.test(askLower)
    || hasImplement && toolCount > 0 && files > 0;
  return {
    words,
    turns,
    tokens: semanticTokens,
    semanticTokens,
    contextTokens,
    toolCount,
    toolsAvailable: toolCount,
    toolsRequired: asksTools,
    imageCount,
    files,
    urls,
    hasCodeFence: /```/.test(ask),
    hasDiff: /^(diff --git|@@ |\+{3} |\-{3} )/m.test(ask),
    hasStack: /\b(stack trace|traceback|typeerror|nullpointer|panic:|exception in)\b/i.test(askLower),
    hasFilePath: files > 0,
    hasJson: /```json|\{\s*"[^"]+"\s*:/.test(ask),
    hasMath: /[=∑∫√∞]|\\frac|\b(integral|theorem|prove|derive|lemma)\b/i.test(askLower),
    hasProof: /\b(prove|proof|qed|induction)\b/i.test(askLower),
    hasContest: /\b(olympiad|imo|contest|competition math)\b/i.test(askLower),
    hasDebug: /\b(debug|root cause|regression|race condition|memory leak|repro)\b/i.test(askLower),
    hasArch: /\b(architecture|refactor|migrate|system design)\b/i.test(askLower),
    hasImplement,
    hasReview: /\b(review|pr\b|pull request|lgtm|nit:)\b/i.test(askLower),
    hasRewrite: /\b(rewrite|rephrase|edit this|make this)\b/i.test(askLower),
    hasCreative: /\b(story|poem|lyrics|fiction|screenplay)\b/i.test(askLower),
    hasProse: /\b(email|memo|cover letter|proposal|professional)\b/i.test(askLower),
    hasExtract: /\b(extract|parse|json schema|csv|table)\b/i.test(askLower),
    hasAnalysis: /\b(analy[sz]e|trend|correlat|statist)/i.test(askLower),
    hasLookup: /\b(who is|what is|when did|cite|source|look up)\b/i.test(askLower),
    hasSynth: /\b(compare|synthesi[sz]e|survey|literature)\b/i.test(askLower),
    hasPlan: /\b(plan|roadmap|step by step|break down)\b/i.test(askLower),
    hasOcr: imageCount > 0 && /\b(read|ocr|transcribe|text in (the )?image)\b/i.test(askLower),
    shortAsk: words > 0 && words < 4 && semanticTokens < 4000 && !imageCount,
    sessionBlob: blob
  };
}

function scores(f) {
  const s = Object.fromEntries(TASKS.map((t) => [t, 0]));
  s["chat:casual"] = 0.8 + (f.shortAsk ? 2.2 : 0) + (f.words < 8 && !f.hasCodeFence ? 0.6 : 0);
  s["chat:knowledge"] = 0.4 + (f.hasLookup ? 2.4 : 0) + (f.words > 6 && !f.hasCodeFence ? 0.5 : 0);
  s["writing:rewrite"] = f.hasRewrite ? 3.2 : 0.1;
  s["writing:creative"] = f.hasCreative ? 3.0 : 0.05;
  s["writing:professional"] = f.hasProse ? 2.8 : 0.05;
  s["code:generation"] = (f.hasImplement ? 3.2 : 0) + (f.hasCodeFence && !f.hasDebug && !f.hasReview ? 1.6 : 0) + (f.hasFilePath && f.hasImplement ? 0.8 : 0);
  s["code:debug"] = (f.hasDebug ? 3.4 : 0) + (f.hasStack ? 2.6 : 0);
  s["code:review"] = f.hasReview ? 3.1 : (f.hasDiff ? 1.8 : 0.05);
  s["code:architecture"] = f.hasArch ? 3.3 : 0.05;
  s["agent:tool_single"] = f.toolsRequired && f.toolsAvailable === 1 ? 2.4 : (f.toolsRequired && f.toolsAvailable > 0 && f.toolsAvailable < 4 ? 1.1 : 0);
  s["agent:multi_step"] = f.toolsRequired && f.toolsAvailable >= 4 ? 2.8 : (f.toolsRequired && f.toolsAvailable >= 2 ? 1.4 : 0);
  s["agent:repo_edit"] = (f.toolsRequired && (f.hasFilePath || f.hasDiff) ? 3.2 : 0) + (f.hasFilePath && f.hasDebug ? 1.2 : 0);
  s["research:lookup"] = f.hasLookup && f.urls ? 2.6 : (f.hasLookup ? 1.4 : 0.1);
  s["research:synthesis"] = f.hasSynth ? 3.0 : 0.05;
  s["math:simple"] = f.hasMath && !f.hasProof && !f.hasContest ? 2.4 : 0.05;
  s["math:proof"] = f.hasProof ? 3.4 : 0.02;
  s["math:competition"] = f.hasContest ? 3.5 : 0.02;
  s["reasoning:logic"] = (!f.hasCodeFence && f.words > 20 ? 0.8 : 0.1);
  s["reasoning:planning"] = f.hasPlan ? 2.6 : 0.1;
  s["data:extract"] = f.hasExtract || f.hasJson ? 2.5 : 0.05;
  s["data:analysis"] = f.hasAnalysis ? 2.7 : 0.05;
  s["vision:ocr_like"] = f.hasOcr ? 3.6 : (f.imageCount && f.words < 12 ? 1.2 : 0);
  s["vision:reasoning"] = f.imageCount && !f.hasOcr ? 2.8 : 0;
  if (f.imageCount) {
    s["chat:casual"] -= 1.5;
    s["code:generation"] -= 0.4;
  }
  if (f.contextTokens > 40000) {
    s["code:architecture"] += 0.4;
    s["agent:repo_edit"] += 0.5;
    s["chat:casual"] -= 1;
  }
  return s;
}

export function classifyTask(payload) {
  const f = extractFeatures(payload);
  const table = scores(f);
  let best = TASKS[0];
  let bestScore = -Infinity;
  let second = -Infinity;
  for (const task of TASKS) {
    const n = table[task];
    if (n > bestScore) {
      second = bestScore;
      bestScore = n;
      best = task;
    } else if (n > second) {
      second = n;
    }
  }
  const confidence = Math.max(0, Math.min(1, (bestScore - Math.max(0, second)) / (Math.abs(bestScore) + 1)));
  return { task: best, confidence, features: f };
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

export function compileTaskIR(payload) {
  const { task, confidence, features: f } = classifyTask(payload);
  const [domain, operation] = task.split(":");
  const coding = task.startsWith("code:") || task === "agent:repo_edit";
  const agent = task.startsWith("agent:");
  const math = task.startsWith("math:");
  const vision = task.startsWith("vision:");
  const difficulty = clamp01(
    (f.tokens > 100000 ? 0.55 : f.tokens > 40000 ? 0.4 : f.tokens > 12000 ? 0.22 : 0.08)
    + (coding ? 0.18 : 0)
    + (agent ? 0.16 : 0)
    + (math && operation !== "simple" ? 0.22 : 0)
    + (f.hasStack ? 0.12 : 0)
    + (f.turns >= 6 ? 0.1 : 0)
  );
  const verificationNeed = clamp01(
    (coding ? 0.55 : 0) + (math ? 0.7 : 0) + (agent ? 0.45 : 0) + (f.hasJson ? 0.2 : 0) + difficulty * 0.2
  );
  const decomposition = clamp01((coding || agent ? 0.45 : 0.1) + difficulty);
  const agenticDepth = clamp01((f.toolsRequired ? 0.35 : 0) + (f.toolsRequired && f.toolsAvailable >= 4 ? 0.3 : 0) + (f.hasFilePath && f.toolsRequired ? 0.2 : 0));
  const expectedOutputTokens = Math.max(64, Math.min(8000,
    coding ? 1600 : agent ? 900 : math ? 700 : vision ? 400 : 280
  ));
  return {
    task,
    domain,
    operation,
    confidence,
    difficulty,
    ambiguity: clamp01((f.words < 6 ? 0.35 : 0.12) + (/\?/.test(lastUserText(payload)) ? 0.08 : 0)),
    decomposition,
    verificationNeed,
    agenticDepth,
    contextTokens: f.contextTokens,
    semanticTokens: f.semanticTokens,
    expectedOutputTokens,
    tools: {
      available: f.toolsAvailable,
      required: !!f.toolsRequired,
      count: f.toolsAvailable,
      mutation: task === "agent:repo_edit" || (f.hasDiff && f.toolsRequired)
    },
    modalities: f.imageCount ? ["text", "image"] : ["text"],
    latencyClass: f.tokens > 40000 || difficulty > 0.7 ? "batch" : "interactive",
    riskClass: verificationNeed > 0.7 ? "high" : "normal",
    successCriteria: coding
      ? ["identify_root_cause", "edit_correct_file", "tests_pass"]
      : agent
        ? ["tool_args_valid", "state_updated"]
        : math
          ? ["answer_checkable"]
          : ["direct_answer"],
    features: f
  };
}
