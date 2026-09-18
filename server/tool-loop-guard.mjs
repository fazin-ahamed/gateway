import { canonicalToolName, isHashlineEditTool, repairEditToolArguments as repairEditToolArgumentsCore, repairToolCall } from "../ai-gateway/src/tool-repair.js";

// Compatibility export retained from main. Callers/tests that used the earlier
// helper still work, but the implementation now delegates to the schema-aware
// repair core when tool definitions are available.
export function repairEditToolArguments(name, rawArgs, tools = []) {
  return repairEditToolArgumentsCore(name, rawArgs, tools);
}

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

function repairedToolChunk(model, choiceIndex, pending, tools) {
  const call = repairToolCall({
    index: pending.index,
    id: pending.id || undefined,
    type: pending.type || "function",
    function: { name: pending.name || "", arguments: pending.arguments || "{}" }
  }, tools);
  return {
    id: "gateway-tool-repair",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || "unknown",
    choices: [{
      index: choiceIndex,
      delta: { tool_calls: [call] },
      finish_reason: null
    }]
  };
}

// Protect tool-loop finish semantics and repair hashline edit calls without
// touching partial JSON fragments. Only hashline edits are buffered; ordinary
// tool calls retain their native incremental streaming behavior.
export function guardOpenAiSse(source, modelHint = "", tools = []) {
  const reader = source.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  let sawToolCalls = false;
  let terminalSeen = false;
  let streamFailed = false;
  let model = modelHint;
  const pendingEdits = new Map();

  return new ReadableStream({
    async start(controller) {
      const emit = (text) => controller.enqueue(enc.encode(text));
      const emitObj = (obj) => emit("data: " + JSON.stringify(obj) + "\n\n");

      const flushPending = () => {
        if (!pendingEdits.size) return;
        const ordered = [...pendingEdits.values()].sort((a, b) =>
          a.choiceIndex - b.choiceIndex || a.index - b.index);
        pendingEdits.clear();
        for (const p of ordered) emitObj(repairedToolChunk(model, p.choiceIndex, p, tools));
      };

      const handleLine = (rawLine) => {
        const line = rawLine.trimEnd();
        if (!line.startsWith("data:")) {
          emit(rawLine + "\n");
          return;
        }
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          flushPending();
          if (sawToolCalls && !terminalSeen && !streamFailed) {
            emitObj(terminalChunk(model, "tool_calls"));
            terminalSeen = true;
          }
          emit("data: [DONE]\n\n");
          return;
        }

        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          // Preserve a complete SSE event delimiter on opaque/non-JSON events.
          emit(rawLine + "\n\n");
          return;
        }

        if (obj && typeof obj.model === "string" && obj.model) model = obj.model;
        if (obj && obj.error) streamFailed = true;

        const choices = obj && Array.isArray(obj.choices) ? obj.choices : [];
        for (const choice of choices) {
          const delta = choice && choice.delta;
          if (delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
            sawToolCalls = true;
            const forwarded = [];
            for (const original of delta.tool_calls) {
              if (!original) continue;
              const idx = Number.isInteger(original.index) ? original.index : 0;
              const choiceIndex = Number.isInteger(choice.index) ? choice.index : 0;
              const key = choiceIndex + ":" + idx;
              const prev = pendingEdits.get(key);
              const rawName = original.function && original.function.name || prev && prev.name || "";
              const name = canonicalToolName(rawName, tools);
              // Preserve the existing "edit"/"hashline" shorthand behavior
              // from main. Any edit-like call is buffered until complete so
              // bare [PATH#TAG] PUT/CUT/REM syntax or malformed JSON can be
              // normalized safely as a whole rather than fragment-by-fragment.
              const mustBuffer = !!prev || isHashlineEditTool(name, tools) ||
                /edit|hashline/i.test(String(name || ""));

              if (mustBuffer) {
                const p = prev || {
                  choiceIndex,
                  index: idx,
                  id: original.id || "",
                  type: original.type || "function",
                  name,
                  arguments: ""
                };
                if (original.id) p.id = original.id;
                if (original.type) p.type = original.type;
                if (name) p.name = name;
                if (original.function && typeof original.function.arguments === "string")
                  p.arguments += original.function.arguments;
                pendingEdits.set(key, p);
                continue;
              }

              if (original.function && name && name !== original.function.name) {
                forwarded.push({
                  ...original,
                  function: { ...original.function, name }
                });
              } else {
                forwarded.push(original);
              }
            }
            if (forwarded.length) delta.tool_calls = forwarded;
            else delete delta.tool_calls;
          }

          if (choice && choice.finish_reason != null) {
            // A terminal event is the first point at which a buffered edit is
            // guaranteed complete. Emit repaired full calls before the terminal.
            flushPending();
            const fixed = normalizeTerminalFinishReason(choice.finish_reason, sawToolCalls, !streamFailed);
            choice.finish_reason = fixed;
            terminalSeen = !!fixed;
          }
        }
        emitObj(obj);
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
        // Unclean EOF: never silently discard a completed buffered edit.
        if (!streamFailed) flushPending();
        controller.close();
      } catch {
        try {
          emitObj({
            error: {
              message: "Upstream stream disconnected",
              type: "upstream_stream_error",
              code: "upstream_socket_closed",
              retryable: true
            }
          });
          emit("data: [DONE]\n\n");
          controller.close();
        } catch {}
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    }
  });
}

export function guardToolLoopResponse(response, modelHint = "", tools = []) {
  if (!(response instanceof Response) || !response.body) return response;
  const ct = (response.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("text/event-stream")) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache, no-store");
  return new Response(guardOpenAiSse(response.body, modelHint, tools), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
