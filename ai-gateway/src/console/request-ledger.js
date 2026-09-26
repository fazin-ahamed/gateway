// Body-free request ledger. One row per request, the same lifecycle for chat
// and decision traffic. Overview, Requests and Usage read this table;
// trajectories stays optional body capture and route_attempts stays internal.
// A ledger write failure is logged and swallowed: it must never block serving.

function clientAppFrom(headers) {
  const title = headers["x-title"] || headers["x-openrouter-title"] || "";
  const agent = headers["user-agent"] || "";
  const named = /opencode|omp|claude|cursor|cline|continue|aider|codex/i.exec(title + " " + agent);
  return named ? named[0] : (title || agent.split(/[\/\s]/)[0] || "");
}

export async function startRequestSummary(db, { requestId, keyId, modelKind, publicSlug, stream, headers }) {
  const kept = {};
  for (const name of ["user-agent", "x-title", "http-referer", "x-request-id"]) {
    if (headers && headers[name]) kept[name] = String(headers[name]).slice(0, 240);
  }
  try {
    await db.prepare(
      "INSERT OR IGNORE INTO request_summaries (request_id, key_id, model_kind, public_slug, created_at, status, stream, attempts, client_app, request_headers) VALUES (?,?,?,?,?,'pending',?,0,?,?)"
    ).bind(String(requestId), keyId ?? null, modelKind === "decision" ? "decision" : "chat", String(publicSlug || ""), new Date().toISOString(), stream ? 1 : 0, clientAppFrom(headers || {}), JSON.stringify(kept)).run();
  } catch (e) {
    try { console.warn("[gateway] request summary start failed: " + String(e.message || e)); } catch {}
  }
}

// Terminal states: ok | fail | cancelled. A client cancel is its own status,
// never a failure and never a success. timings/tokens/cost arrive when the
// attempt that served the request knows them; unknown stays null.
export async function finishRequestSummary(db, requestId, fields) {
  try {
    await db.prepare(
      "UPDATE request_summaries SET finished_at=?, status=?, http_status=?, cache_state=?, headers_ms=?, ttft_ms=?, latency_ms=?, prompt_tokens=?, completion_tokens=?, total_tokens=?, cost_usd=?, attempts=? WHERE request_id=?"
    ).bind(
      new Date().toISOString(),
      fields.status === "ok" || fields.status === "fail" || fields.status === "cancelled" ? fields.status : "fail",
      fields.httpStatus ?? null,
      fields.cacheState ?? null,
      fields.headersMs ?? null,
      fields.ttftMs ?? null,
      fields.latencyMs ?? null,
      Math.max(0, Math.trunc(Number(fields.promptTokens) || 0)),
      Math.max(0, Math.trunc(Number(fields.completionTokens) || 0)),
      Math.max(0, Math.trunc(Number(fields.totalTokens) || 0)),
      Math.max(0, Number(fields.costUsd) || 0),
      Math.max(0, Math.trunc(Number(fields.attempts) || 0)),
      String(requestId)
    ).run();
  } catch (e) {
    try { console.warn("[gateway] request summary finish failed: " + String(e.message || e)); } catch {}
  }
}
