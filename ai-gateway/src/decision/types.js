// The generic decision-model contract.
//
// A decision model does not generate an assistant answer. It answers typed,
// named questions about a shared state: a choice among a set the GATEWAY
// defined, a score on a scale the gateway defined, or a yes/no probability.
// This module is vendor-neutral — Jev is one adapter, not the protocol.
//
// Normalized answer shape, whatever the engine:
//
//   choice: { type, choice, probabilities, confidence }
//   score:  { type, score, confidence }
//   noul:   { type, probability }
//
// The candidate set is owned by the gateway. A decision model ranks and judges
// options the gateway already filtered on capability, context, tools, vision,
// circuit state, key permission and budget. Judgment is the model's job;
// authority is not.

export const QUESTION_TYPES = Object.freeze(["choice", "score", "noul"]);

export function isQuestionType(value) {
  return QUESTION_TYPES.includes(String(value || ""));
}

// Validate one question. Returns null when valid, else a reason string.
export function validateQuestion(name, question) {
  if (!question || typeof question !== "object")
    return "question must be an object";
  const type = String(question.type || "");
  if (!isQuestionType(type))
    return "question '" + name + "' must be type choice, score or noul";
  if (type === "choice") {
    const criteria = question.criteria;
    if (!criteria || typeof criteria !== "object" || !Object.keys(criteria).length)
      return "choice question '" + name + "' needs a non-empty criteria object";
  }
  if (type === "score") {
    if (!Array.isArray(question.criteria) || question.criteria.length < 2)
      return "score question '" + name + "' needs a criteria array of at least two labels";
  }
  if (type === "noul") {
    if (typeof question.instructions !== "string" || !question.instructions.trim())
      return "noul question '" + name + "' needs instructions";
  }
  return null;
}

export function validateRequest(body) {
  if (!body || typeof body !== "object")
    return "body must be a JSON object";
  if (!body.state || typeof body.state !== "object")
    return "state is required";
  const questions = body.questions;
  if (!questions || typeof questions !== "object" || !Object.keys(questions).length)
    return "at least one question is required";
  for (const [name, question] of Object.entries(questions)) {
    const problem = validateQuestion(name, question);
    if (problem)
      return problem;
  }
  return null;
}

// A choice answer must name one of the offered criteria. An invented option is
// dropped rather than passed through, so the gateway can never act on a model
// name the decision model made up.
export function normalizeChoice(question, raw) {
  const options = Object.keys((question && question.criteria) || {});
  const chosen = raw && (raw.choice ?? raw.answer ?? raw.value);
  const probabilities = {};
  let sum = 0;
  const rawProbs = (raw && (raw.probabilities || raw.choices)) || {};
  for (const option of options) {
    const value = Number(rawProbs[option]);
    if (Number.isFinite(value) && value >= 0) {
      probabilities[option] = value;
      sum += value;
    }
  }
  // Normalize to a distribution when the provider returned a non-unit total.
  if (sum > 0 && Math.abs(sum - 1) > 1e-6)
    for (const option of Object.keys(probabilities))
      probabilities[option] = Number((probabilities[option] / sum).toFixed(6));
  const valid = options.includes(chosen) ? chosen : null;
  return {
    type: "choice",
    choice: valid,
    probabilities,
    confidence: clamp01(Number(raw && raw.confidence) || (valid ? (probabilities[valid] ?? 0) : 0))
  };
}

export function normalizeScore(question, raw) {
  const labels = (question && Array.isArray(question.criteria)) ? question.criteria : [];
  const value = Number(raw && (raw.score ?? raw.answer ?? raw.value));
  const bounded = Number.isFinite(value) ? Math.max(0, Math.min(labels.length - 1, value)) : null;
  return {
    type: "score",
    score: bounded,
    label: bounded == null ? null : labels[Math.round(bounded)] ?? null,
    confidence: clamp01(Number(raw && raw.confidence) || 0)
  };
}

export function normalizeNoul(question, raw) {
  const value = Number(raw && (raw.probability ?? raw.answer ?? raw.value));
  const probability = Number.isFinite(value) ? clamp01(value > 1 ? value / 100 : value) : null;
  return { type: "noul", probability };
}

export function normalizeAnswer(question, raw) {
  if (!question || !raw || typeof raw !== "object") return null;
  const type = String(question.type || "");
  if (type === "choice") return normalizeChoice(question, raw);
  if (type === "score") return normalizeScore(question, raw);
  if (type === "noul") return normalizeNoul(question, raw);
  return null;
}

// The wire shape sent upstream: exactly the caller's state and questions, no
// gateway internals, no credentials, no route metadata.
export function buildUpstreamBody({ model, state, questions }) {
  return { model, state, questions };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
