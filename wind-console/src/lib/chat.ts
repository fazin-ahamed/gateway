// Client-side plumbing for the playground: SSE streaming against the console
// session, reasoning/tool-call accumulation, and a minimal markdown renderer
// with safe HTML escaping (no external markdown dependency).

export type StreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "usage"; usage: Usage }
  | { type: "headers"; headers: Record<string, string> }
  | { type: "finish"; reason: string | null }
  | { type: "error"; message: string };

export type ToolCall = { id: string | null; name: string; arguments: string };
export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

export async function* streamChatCompletion(
  payload: Record<string, unknown>,
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  const res = await fetch("/console/playground/completions", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, stream: true }),
    signal
  });
  yield { type: "headers", headers: Object.fromEntries([...res.headers.entries()].filter(([k]) => k.startsWith("x-gateway") || k === "x-request-id")) };
  if (!res.ok || !res.body) {
    let message = `HTTP ${res.status}`;
    try { message = (await res.json())?.error?.message || message; } catch {}
    yield { type: "error", message };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolSlots = new Map<number, ToolCall>();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        let obj: any;
        try { obj = JSON.parse(data); } catch { continue; }
        const choice = obj.choices && obj.choices[0];
        if (obj.usage) yield { type: "usage", usage: obj.usage };
        if (!choice) continue;
        const delta = choice.delta || {};
        const rc = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (typeof rc === "string" && rc) yield { type: "reasoning", text: rc };
        if (typeof delta.content === "string" && delta.content) yield { type: "content", text: delta.content };
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!tc) continue;
            const i = typeof tc.index === "number" ? tc.index : 0;
            const slot = toolSlots.get(i) || { id: tc.id || null, name: "", arguments: "" };
            if (tc.id) slot.id = tc.id;
            if (tc.function && tc.function.name) slot.name += tc.function.name;
            if (tc.function && typeof tc.function.arguments === "string") slot.arguments += tc.function.arguments;
            toolSlots.set(i, slot);
          }
        }
        if (choice.finish_reason) {
          if (toolSlots.size) {
            yield { type: "tool_calls", calls: [...toolSlots.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c) };
            toolSlots.clear();
          }
          yield { type: "finish", reason: choice.finish_reason };
        }
      }
    }
  }
}

// Minimal, safe markdown: headings, lists, code fences/inline, tables, bold,
// italic, links (http(s) only), blockquote, hr. Output is escaped HTML.
export function renderMarkdown(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) => {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return t;
  };
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let list: string[] = [];
  let ordered = false;
  const flushList = () => {
    if (!list.length) return;
    out.push(ordered ? `<ol>${list.join("")}</ol>` : `<ul>${list.join("")}</ul>`);
    list = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flushList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      flushList();
      const level = line.match(/^#{1,4}/)![0].length;
      out.push(`<h${level}>${inline(line.slice(level + 1))}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*(-|\*)\s+/.test(line)) {
      if (ordered) flushList();
      ordered = false;
      list.push(`<li>${inline(line.replace(/^\s*(?:-|\*)\s+/, ""))}</li>`);
      i++;
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (!ordered && list.length) flushList();
      ordered = true;
      list.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushList();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushList();
      out.push("<hr/>");
      i++;
      continue;
    }
    if (/^\s*\|(.+)\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushList();
      const rows: string[][] = [];
      const cells = (l: string) => l.trim().slice(1, -1).split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    flushList();
    if (line.trim() === "") { i++; continue; }
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  flushList();
  return out.join("");
}
