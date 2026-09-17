const enc = new TextEncoder();

export function normalizeTerminalFinishReason(reason, sawToolCalls, cleanDone = true) {
  const value = reason == null ? null : String(reason);
  if (sawToolCalls) {
    if (value === "length" || value === "content_filter") return value;
    return "tool_calls";
  }
  if (value) return value;
  return cleanDone ? "stop" : null;
}

function terminalChunk(model, finishReason) {
  return {
    id: "gateway-tool-loop-guard",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || "unknown",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
  };
}

export function guardOpenAiSse(source, modelHint = "") {
  const reader = source.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  let sawToolCalls = false;
  let terminalSeen = false;
  let model = modelHint;

  return new ReadableStream({
    async start(controller) {
      const emit = (text) => controller.enqueue(enc.encode(text));
      const handleLine = (rawLine) => {
        const line = rawLine.trimEnd();
        if (!line.startsWith("data:")) {
          emit(rawLine + "\n");
          return;
        }
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          if (sawToolCalls && !terminalSeen) {
            emit("data: " + JSON.stringify(terminalChunk(model, "tool_calls")) + "\n\n");
            terminalSeen = true;
          }
          emit("data: [DONE]\n\n");
          return;
        }
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          emit(rawLine + "\n");
          return;
        }
        if (obj && typeof obj.model === "string" && obj.model) model = obj.model;
        const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
        const delta = choice && choice.delta;
        if (delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length) sawToolCalls = true;
        if (choice && choice.finish_reason != null) {
          const fixed = normalizeTerminalFinishReason(choice.finish_reason, sawToolCalls, true);
          choice.finish_reason = fixed;
          terminalSeen = !!fixed;
        }
        emit("data: " + JSON.stringify(obj) + "\n\n");
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (!line.trim()) continue;
            handleLine(line);
          }
        }
        buffer += dec.decode();
        if (buffer.trim()) handleLine(buffer);
        controller.close();
      } catch (err) {
        try {
          emit("data: " + JSON.stringify({
            error: {
              message: "Upstream stream disconnected: " + String(err && err.message || err).slice(0, 240),
              type: "upstream_stream_error",
              code: "upstream_socket_closed",
              retryable: true
            }
          }) + "\n\n");
          emit("data: [DONE]\n\n");
          controller.close();
        } catch {
        }
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    }
  });
}

export function guardToolLoopResponse(response, modelHint = "") {
  if (!(response instanceof Response) || !response.body) return response;
  const ct = response.headers.get("content-type") || "";
  if (!ct.toLowerCase().includes("text/event-stream")) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache, no-store");
  return new Response(guardOpenAiSse(response.body, modelHint), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
