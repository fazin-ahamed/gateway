// SystemOne decision-model adapter (Jev-compatible).
//
// POST <base>/v1/systemone with { model, state, questions } and read typed
// answers back. This is one adapter for the whole model class: any provider
// speaking the same shape works, so Jev is not special-cased anywhere above
// this file.
//
// Nothing in here is a hard dependency. Every failure path returns a structured
// error the caller turns into a fallback; a missing key, a timeout, or a 5xx
// must never take the gateway down, because the decision model is optional.

import { buildUpstreamBody, normalizeAnswer } from "../types.js";

export function systemOnePath() {
  return "/v1/systemone";
}

export function isSystemOneFormat(fmt) {
  return String(fmt || "").toLowerCase() === "systemone";
}

export async function callSystemOne({ base, path, model, state, questions, apiKey, headers, fetchImpl, timeoutMs = 20000 }) {
  const url = String(base || "").replace(/\/+$/, "") + (path || systemOnePath());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const doFetch = fetchImpl || fetch;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
        ...(headers || {})
      },
      body: JSON.stringify(buildUpstreamBody({ model, state, questions })),
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        http: res.status,
        // The upstream message may name internal hosts, so only a short,
        // sanitized reason is exposed. The caller renders a generic error.
        reason: "decision provider HTTP " + res.status,
        providerMessage: String((json && json.error && json.error.message) || text || "").slice(0, 400)
      };
    }
    return { ok: true, http: res.status, json, text };
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return { ok: false, http: 0, reason: aborted ? "decision provider timed out" : "decision provider unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// Map a provider response into the normalized answer set. Tolerant of the two
// observed shapes: { answers: { name: {...} } } and a bare { name: {...} }.
export function mapSystemOneResponse({ json, questions }) {
  const container = (json && (json.answers || json.questions)) || json || {};
  const answers = {};
  for (const [name, question] of Object.entries(questions || {})) {
    const raw = container[name];
    const normalized = normalizeAnswer(question, raw);
    if (normalized)
      answers[name] = normalized;
  }
  return answers;
}
