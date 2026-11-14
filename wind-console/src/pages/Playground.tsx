import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { api, fmtInt, type ChatMessage, type Model } from "../lib/api";
import { streamChatCompletion, renderMarkdown, type ToolCall, type Usage } from "../lib/chat";
import { Button, Card, Chip, Label, Modal, Select, Segmented, Switch, Textarea, useToast } from "../lib/ui";
import { WindMark } from "../lib/logo";

const EASE = [0.23, 1, 0.32, 1] as const;
type Mode = "chat" | "decision" | "image" | "video";

type Msg = {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
  headers?: Record<string, string>;
  finish?: string | null;
  error?: string;
  streaming?: boolean;
};

const uuid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export function Playground() {
  const models = useQuery({ queryKey: ["models"], queryFn: api.models });
  const chatModels = useMemo(() => (models.data?.data || []).filter((m) => m.model_kind === "chat"), [models.data]);
  const decisionModels = useMemo(() => (models.data?.data || []).filter((m) => m.model_kind === "decision"), [models.data]);
  const imageModels = useMemo(() => (models.data?.data || []).filter((m) => (m.kinds || []).includes("image")), [models.data]);
  const videoModels = useMemo(() => (models.data?.data || []).filter((m) => (m.kinds || []).includes("video")), [models.data]);

  const available: Array<{ value: Mode; label: string }> = [{ value: "chat", label: "Chat" }];
  if (decisionModels.length) available.push({ value: "decision", label: "Decision" });
  if (imageModels.length) available.push({ value: "image", label: "Image" });
  if (videoModels.length) available.push({ value: "video", label: "Video" });

  const [mode, setMode] = useState<Mode>("chat");
  return (
    <div className="flex flex-col" style={{ height: "calc(100dvh - 150px)" }}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Playground</h1>
          <p className="mt-1 text-sm text-muted">Try models with your own key. Traffic here is billed like any API call.</p>
        </div>
        <Segmented ariaLabel="Mode" value={mode} onChange={(v) => setMode(v)} options={available} />
      </div>
      <div className="mt-5 min-h-0 flex-1">
        {mode === "chat" && <ChatPane models={chatModels} />}
        {mode === "decision" && <DecisionPane models={decisionModels} />}
        {mode === "image" && <MediaPane kind="image" models={imageModels} />}
        {mode === "video" && <MediaPane kind="video" models={videoModels} />}
      </div>
    </div>
  );
}

/* ------------------------------ Chat ------------------------------ */

function ChatPane({ models }: { models: Model[] }) {
  const toast = useToast();
  const state = useQuery({ queryKey: ["playground"], queryFn: api.playground, staleTime: 60_000 });
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [streaming, setStreaming] = useState(true);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [showTrace, setShowTrace] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const selected = useMemo(() => models.find((m) => m.id === model) || models[0], [models, model]);
  const chats = state.data?.chats || [];

  useEffect(() => {
    if (!state.data) return;
    const s = state.data.settings as Record<string, unknown>;
    const wanted = typeof s.model === "string" ? s.model : "";
    // "auto" is the router, not a model; a persisted auto would send every
    // playground message through routing instead of the model the user chose.
    if (wanted && wanted !== "auto" && models.some((m) => m.id === wanted)) setModel(wanted);
    else if (models[0]) setModel(models[0].id);
    if (typeof s.system === "string") setSystem(s.system);
    if (typeof s.temperature === "number") setTemperature(s.temperature);
    if (typeof s.streaming === "boolean") setStreaming(s.streaming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data, models.length]);

  useEffect(() => {
    const t = setTimeout(() => {
      api.savePlaygroundSettings({ model, system, temperature, streaming }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [model, system, temperature, streaming]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, running]);

  function schedulePersist(nextMessages: Msg[], id: string | null) {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const clean: ChatMessage[] = nextMessages
        .filter((m) => !m.streaming && !m.error)
        .map((m) => ({ role: m.role, content: m.content, ...(m.reasoning ? { reasoning: m.reasoning } : {}), ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}) }));
      if (!clean.length) return;
      const cid = id || "chat-" + uuid();
      api.savePlaygroundChat({ id: cid, title: titleOf(clean), model, messages: clean }).catch(() => {});
      if (!id) setChatId(cid);
    }, 800);
  }

  async function loadChat(id: string) {
    const chat = await api.playgroundChat(id);
    setChatId(chat.id);
    setMessages(chat.messages.map((m) => ({ id: uuid(), role: m.role as Msg["role"], content: m.content, reasoning: m.reasoning, toolCalls: m.tool_calls as ToolCall[] | undefined })));
    if (chat.model && models.some((m) => m.id === chat.model)) setModel(chat.model);
  }

  function newChat() {
    stop();
    setChatId(null);
    setMessages([]);
    setInput("");
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setMessages((ms) => ms.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  }

  async function send(fromMessages?: Msg[]) {
    const base = fromMessages ?? [...messages, { id: uuid(), role: "user" as const, content: input.trim() }];
    const lastUser = [...base].reverse().find((m) => m.role === "user");
    if (!lastUser || !lastUser.content.trim() || running) return;
    setInput("");
    const wire = [
      ...(system.trim() ? [{ role: "system", content: system.trim() }] : []),
      ...base.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content, ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}) }))
    ];
    const assistant: Msg = { id: uuid(), role: "assistant", content: "", streaming: true, toolCalls: undefined };
    const next = [...base, assistant];
    setMessages(next);
    schedulePersist(next, chatId);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      if (!streaming) {
        const res = await fetch("/console/playground/completions", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: selected?.id, messages: wire, temperature, stream: false }),
          signal: ctrl.signal
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
        const msg = data.choices && data.choices[0] && data.choices[0].message;
        const reason = (data.choices && data.choices[0] && data.choices[0].finish_reason) || null;
        setMessages((ms) => ms.map((m) => m.id === assistant.id ? { ...m, streaming: false, content: (msg && msg.content) || "", reasoning: msg && msg.reasoning_content, toolCalls: msg && msg.tool_calls, usage: data.usage, finish: reason } : m));
      } else {
        let headers: Record<string, string> | undefined;
        for await (const ev of streamChatCompletion({ model: selected?.id, messages: wire, temperature }, ctrl.signal)) {
          if (ev.type === "headers") headers = ev.headers;
          if (ev.type === "reasoning") setMessages((ms) => ms.map((m) => m.id === assistant.id ? { ...m, reasoning: (m.reasoning || "") + ev.text } : m));
          if (ev.type === "content") setMessages((ms) => ms.map((m) => m.id === assistant.id ? { ...m, content: m.content + ev.text } : m));
          if (ev.type === "tool_calls") setMessages((ms) => ms.map((m) => m.id === assistant.id ? { ...m, toolCalls: ev.calls } : m));
          if (ev.type === "usage") setMessages((ms) => ms.map((m) => m.id === assistant.id ? { ...m, usage: ev.usage } : m));
          if (ev.type === "finish") setMessages((ms) => ms.map((m) => m.id === assistant.id ? { ...m, finish: ev.reason } : m));
          if (ev.type === "error") setMessages((ms) => ms.map((m) => m.id === assistant.id ? { ...m, error: ev.message } : m));
        }
        setMessages((ms) => ms.map((m) => m.id === assistant.id ? { ...m, streaming: false, headers } : m));
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setMessages((ms) => ms.map((m) => m.id === assistant.id ? { ...m, streaming: false, error: (e as Error).message } : m));
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      setMessages((ms) => { schedulePersist(ms, chatId); return ms; });
    }
  }

  function regenerate() {
    const idx = [...messages].map((m, i) => [m, i] as const).reverse().find(([m]) => m.role === "user");
    if (!idx) return;
    send(messages.slice(0, idx[1] + 1));
  }

  function applyEdit(id: string, content: string) {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const edited = [...messages.slice(0, idx), { ...messages[idx], content }];
    setMessages(edited);
    setEditing(null);
    send(edited);
  }

  const canSend = !running && !!selected && input.trim().length > 0;
  const chatModelsUsed = models.length === 0;

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* Conversations */}
      <div className="hidden w-[220px] shrink-0 flex-col gap-1 overflow-y-auto rounded-[20px] bg-surface p-2 shadow-[var(--surface-shadow)] md:flex">
        <Button variant="secondary" size="sm" className="w-full" onClick={newChat}>New chat</Button>
        {chats.map((c) => (
          <div key={c.id} className={"group flex items-center gap-1 rounded-xl px-3 py-2 text-sm transition-colors " + (chatId === c.id ? "bg-default text-foreground" : "text-muted hover:bg-default hover:text-foreground")}>
            <button className="min-w-0 flex-1 truncate text-start" onClick={() => loadChat(c.id)}>{c.title}</button>
            <button
              className="rounded-full p-1 opacity-0 transition-opacity group-hover:opacity-100"
              aria-label={"Delete " + c.title}
              onClick={async () => { await api.deletePlaygroundChat(c.id); if (chatId === c.id) newChat(); toast("Chat deleted"); }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>
            </button>
          </div>
        ))}
        {!chats.length && <p className="p-3 text-xs text-muted">Saved chats appear here and follow your account.</p>}
      </div>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto rounded-[24px] bg-surface p-5 shadow-[var(--surface-shadow)]">
          {messages.length === 0 ? (
            <div className="grid h-full place-items-center text-center">
              <div>
                <WindMark size={44} className="mx-auto text-accent" />
                <h2 className="mt-3 text-base font-semibold">Start a conversation</h2>
                <p className="mx-auto mt-1 max-w-[40ch] text-sm leading-5 text-muted">
                  Pick a model on the right and send a message. Reasoning models show their thinking; tool-capable models show their calls.
                </p>
                {chatModelsUsed && <p className="mt-3 text-sm text-danger-soft-fg">No chat models are enabled for your keys.</p>}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {messages.map((m) => (
                <Message key={m.id} m={m} model={selected} editing={editing} setEditing={setEditing} applyEdit={applyEdit} onTrace={() => setShowTrace(m.id)} />
              ))}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="flex items-end gap-2 rounded-[24px] bg-surface p-3 shadow-[var(--surface-shadow)]">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (canSend) send(); } }}
            placeholder={selected ? `Message ${selected.id} (Enter to send, Shift+Enter for a new line)` : "Select a model"}
            className="min-h-11 flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0"
            rows={2}
            aria-label="Message"
          />
          {running ? (
            <Button variant="danger-soft" onClick={stop}>Stop</Button>
          ) : (
            <Button onClick={() => send()} disabled={!canSend}>Send</Button>
          )}
          <Button variant="tertiary" onClick={regenerate} disabled={running || !messages.some((m) => m.role === "assistant")} title="Resend the last user message">Retry</Button>
        </div>
      </div>

      {/* Settings rail */}
      <div className="hidden w-[260px] shrink-0 flex-col gap-4 overflow-y-auto rounded-[20px] bg-surface p-5 shadow-[var(--surface-shadow)] lg:flex">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pg-model">Model</Label>
          <Select id="pg-model" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </Select>
          {selected && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {selected.reasoning && <Chip variant="accent">reasoning</Chip>}
              {selected.tools && <Chip variant="accent">tools</Chip>}
              {selected.vision && <Chip variant="accent">vision</Chip>}
              {selected.context_window != null && <Chip>{fmtInt(selected.context_window)} context</Chip>}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pg-system">System prompt</Label>
          <Textarea id="pg-system" rows={4} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="You are a careful assistant." />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pg-temp">Temperature <span className="font-mono text-muted">{temperature.toFixed(1)}</span></Label>
          <input id="pg-temp" type="range" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} className="accent-[var(--accent)]" />
        </div>
        <Switch checked={streaming} onChange={setStreaming} label="Stream" description="Tokens appear as they are generated" />
      </div>

      {/* Trace modal */}
      <Modal open={!!showTrace} onClose={() => setShowTrace(null)} title="Request trace" width={560}>
        {(() => {
          const m = messages.find((x) => x.id === showTrace);
          if (!m) return null;
          const h = m.headers || {};
          const rows: Array<[string, string]> = [
            ["model", h["x-gateway-model"] || selected?.id || "-"],
            ["route", h["x-gateway-route"] || "-"],
            ["attempts", h["x-gateway-attempts"] || "-"],
            ["cache", h["x-gateway-cache"] || "off"],
            ["finish", m.finish || "-"],
            ["tool repair", h["x-gateway-tool-repair"] || "none"],
            ["prompt tokens", fmtInt(m.usage?.prompt_tokens)],
            ["completion tokens", fmtInt(m.usage?.completion_tokens)],
            ["total tokens", fmtInt(m.usage?.total_tokens)]
          ];
          return (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="font-mono text-xs leading-5">{v}</dd>
                </div>
              ))}
            </dl>
          );
        })()}
      </Modal>
    </div>
  );
}

function titleOf(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && m.content.trim());
  return (first?.content || "New chat").replace(/\s+/g, " ").trim().slice(0, 48) || "New chat";
}

function Message({ m, model, editing, setEditing, applyEdit, onTrace }: {
  m: Msg;
  model: Model | undefined;
  editing: string | null;
  setEditing: (id: string | null) => void;
  applyEdit: (id: string, content: string) => void;
  onTrace: () => void;
}) {
  const toast = useToast();
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [draft, setDraft] = useState(m.content);
  useEffect(() => { setDraft(m.content); }, [m.content]);

  if (m.role === "user") {
    return (
      <div className="group flex justify-end">
        <div className="max-w-[78%] rounded-2xl rounded-br-md bg-accent-soft px-4 py-3">
          {editing === m.id ? (
            <div className="flex flex-col gap-2">
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} className="min-w-[280px]" />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="tertiary" onClick={() => setEditing(null)}>Cancel</Button>
                <Button size="sm" onClick={() => applyEdit(m.id, draft.trim())} disabled={!draft.trim()}>Send again</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="whitespace-pre-wrap break-words text-sm leading-6">{m.content}</div>
              <div className="mt-1.5 flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button className="rounded-full px-2 py-0.5 text-xs text-muted transition-colors hover:text-foreground" onClick={() => navigator.clipboard.writeText(m.content).then(() => toast("Copied"))}>Copy</button>
                <button className="rounded-full px-2 py-0.5 text-xs text-muted transition-colors hover:text-foreground" onClick={() => setEditing(m.id)}>Edit</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex justify-start">
      <div className="max-w-[86%]">
        {m.reasoning && (
          <div className="mb-2">
            <button className="flex items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground" onClick={() => setReasoningOpen(!reasoningOpen)} aria-expanded={reasoningOpen}>
              <motion.svg width="11" height="11" viewBox="0 0 10 10" animate={{ rotate: reasoningOpen ? 90 : 0 }} transition={{ duration: 0.15 }}><path d="M2 1l5 4-5 4z" fill="currentColor" /></motion.svg>
              {m.streaming && !m.content ? "Thinking..." : "Thinking"}
            </button>
            <AnimatePresence initial={false}>
              {reasoningOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 max-h-64 overflow-y-auto rounded-xl bg-default px-3.5 py-3 text-xs leading-5 text-muted whitespace-pre-wrap">{m.reasoning}</div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
        {m.content && (
          <div className="rounded-2xl rounded-bl-md bg-default px-4 py-3">
            <div className="md text-sm leading-6" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
          </div>
        )}
        {m.streaming && !m.content && !m.reasoning && (
          <div className="rounded-2xl rounded-bl-md bg-default px-4 py-3">
            <span className="inline-flex gap-1" role="status" aria-label="Generating">
              {[0, 1, 2].map((i) => <motion.span key={i} className="h-1.5 w-1.5 rounded-full bg-muted" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.18 }} />)}
            </span>
          </div>
        )}
        {m.toolCalls && m.toolCalls.length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {m.toolCalls.map((tc, i) => <ToolCallCard key={i} call={tc} />)}
          </div>
        )}
        {m.error && (
          <div className="mt-2 rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger-soft-fg" role="alert">{m.error}</div>
        )}
        {!m.streaming && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted opacity-0 transition-opacity group-hover:opacity-100">
            {model && <span className="font-mono">{model.id}</span>}
            {m.usage && m.usage.total_tokens ? <span>{fmtInt(m.usage.total_tokens)} tokens</span> : null}
            <button className="rounded-full px-2 py-0.5 transition-colors hover:text-foreground" onClick={() => navigator.clipboard.writeText(m.content).then(() => toast("Copied"))}>Copy</button>
            <button className="rounded-full px-2 py-0.5 transition-colors hover:text-foreground" onClick={onTrace}>Trace</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  let pretty = call.arguments;
  try { pretty = JSON.stringify(JSON.parse(call.arguments || "{}"), null, 2); } catch {}
  return (
    <div className="rounded-xl bg-surface-2">
      <button className="flex w-full items-center gap-2 px-3.5 py-2.5 text-start" onClick={() => setOpen(!open)} aria-expanded={open}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent"><path d="M9.7 6.3 13 3a2 2 0 0 0-3-3L6.7 3.3M6.3 9.7 3 13a2 2 0 1 0 3 3l3.3-3.3M6 10l4-4"/></svg>
        <span className="font-mono text-xs font-medium">{call.name || "tool"}</span>
        <Chip className="ml-auto">call</Chip>
        <motion.svg width="11" height="11" viewBox="0 0 10 10" animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }} className="text-muted"><path d="M2 1l5 4-5 4z" fill="currentColor" /></motion.svg>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18, ease: EASE }} className="overflow-hidden">
            <pre className="max-h-72 overflow-auto px-3.5 pb-3 font-mono text-xs leading-5 text-muted">{pretty}</pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------ Decision ------------------------------ */

function DecisionPane({ models }: { models: Model[] }) {
  const [model, setModel] = useState("");
  const [stateText, setStateText] = useState(JSON.stringify({ inventory: 5, demand: "high" }, null, 2));
  const [criteriaText, setCriteriaText] = useState(JSON.stringify({
    action: { type: "choice", criteria: { restock: "order more stock now", wait: "wait for demand to settle" } },
    confidence: { type: "score", criteria: ["not sure at all", "somewhat sure", "very sure"] }
  }, null, 2));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ answers: Record<string, unknown>; latency_ms?: number; model?: string } | null>(null);
  const [error, setError] = useState("");
  const selected = models.find((m) => m.id === model) || models[0];
  useEffect(() => { if (!model && models[0]) setModel(models[0].id); }, [models, model]);

  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const state = JSON.parse(stateText);
      const criteria = JSON.parse(criteriaText);
      const r = await api.systemone({ model: selected?.id, state, questions: criteria });
      setResult(r as typeof result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const answers = result && Object.entries(result.answers || {});
  // Decision answers are typed: {type:"choice",choice,...}, {type:"score",score,...},
  // {type:"noul",probability}. Render the value, not the envelope.
  const answerText = (a: unknown): string => {
    if (typeof a === "object" && a !== null) {
      const o = a as Record<string, unknown>;
      if (o.type === "choice") return String(o.choice ?? "-");
      if (o.type === "score") return o.label ? String(o.label) + " (" + String(o.score) + ")" : String(o.score ?? "-");
      if (o.type === "noul") return Math.round(Number(o.probability || 0) * 100) + "%";
      if ("answer" in o) return String(o.answer);
    }
    if (typeof a === "string" || typeof a === "number" || typeof a === "boolean") return String(a);
    return JSON.stringify(a);
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 overflow-y-auto lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Card className="p-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dec-model">Decision model</Label>
            <Select id="dec-model" value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </Select>
            {selected && <div className="flex flex-wrap gap-1.5 pt-1"><Chip variant="accent">{selected.protocol || "systemone"}</Chip><Chip>{selected.endpoint || "/v1/systemone"}</Chip></div>}
          </div>
        </Card>
        <Card className="p-5">
          <Label htmlFor="dec-state">State (JSON)</Label>
          <Textarea id="dec-state" className="mt-1.5 font-mono text-xs" rows={8} value={stateText} onChange={(e) => setStateText(e.target.value)} spellCheck={false} />
        </Card>
        <Card className="p-5">
          <Label htmlFor="dec-questions">Questions (JSON)</Label>
          <Textarea id="dec-questions" className="mt-1.5 font-mono text-xs" rows={8} value={criteriaText} onChange={(e) => setCriteriaText(e.target.value)} spellCheck={false} />
          <Button className="mt-3" onClick={run} disabled={busy || !selected}>{busy ? "Deciding..." : "Decide"}</Button>
        </Card>
      </div>
      <div className="flex flex-col gap-4">
        {error && <div className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-fg" role="alert">{error}</div>}
        {result && answers && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: EASE }} className="flex flex-col gap-3">
            {answers.map(([q, a], i) => (
              <motion.div key={q} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: i * 0.06, ease: EASE }}>
                <Card className="p-5">
                  <div className="text-xs font-medium text-muted">{q}</div>
                  <div className="mt-1 text-lg font-semibold">{answerText(a)}</div>
                  {(() => {
                    const why = typeof a === "object" && a !== null ? (a as Record<string, unknown>).why : undefined;
                    if (why != null) return <p className="mt-1.5 text-sm leading-5 text-muted">{answerText(why)}</p>;
                    if (typeof a === "object" && a !== null && (a as Record<string, unknown>).type === "choice") {
                      const probs = (a as Record<string, unknown>).probabilities;
                      if (probs && typeof probs === "object" && Object.keys(probs).length)
                        return <p className="mt-1.5 text-sm leading-5 text-muted">{Object.entries(probs as Record<string, number>).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ")}</p>;
                    }
                    return null;
                  })()}
                </Card>
              </motion.div>
            ))}
            <div className="flex items-center gap-3 text-xs text-muted">
              <Chip variant="accent">{result.model}</Chip>
              {result.latency_ms != null && <span className="font-mono">{result.latency_ms}ms</span>}
            </div>
          </motion.div>
        )}
        {!result && !error && (
          <div className="grid min-h-[200px] place-items-center rounded-[24px] bg-surface p-8 text-center shadow-[var(--surface-shadow)]">
            <p className="max-w-[44ch] text-sm leading-5 text-muted">
              Describe the state and the questions, then decide. The model returns a structured answer per question, not prose.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ Media ------------------------------ */

function MediaPane({ kind, models }: { kind: "image" | "video"; models: Model[] }) {
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [streamText, setStreamText] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const selected = models.find((m) => m.id === model) || models[0];
  useEffect(() => { if (!model && models[0]) setModel(models[0].id); }, [models, model]);

  async function generate() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError("");
    setStreamText("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      for await (const ev of streamChatCompletion({ model: selected?.id, messages: [{ role: "user", content: prompt.trim() }] }, ctrl.signal)) {
        if (ev.type === "content") setStreamText((t) => t + ev.text);
        if (ev.type === "error") setError(ev.message);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 overflow-y-auto lg:grid-cols-[320px_1fr]">
      <div className="flex flex-col gap-4">
        <Card className="p-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="md-model">{kind === "image" ? "Image" : "Video"} model</Label>
            <Select id="md-model" value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </Select>
          </div>
        </Card>
        <Card className="p-5">
          <Label htmlFor="md-prompt">Prompt</Label>
          <Textarea id="md-prompt" rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={kind === "image" ? "A lighthouse at blue hour, long exposure" : "Paper planes over a city, dusk"} />
          <div className="mt-3 flex gap-2">
            {busy ? <Button variant="danger-soft" onClick={() => abortRef.current?.abort()}>Stop</Button> : <Button onClick={generate} disabled={!prompt.trim()}>Generate</Button>}
          </div>
        </Card>
        <Card className="p-5">
          <p className="text-xs leading-5 text-muted">
            Media flows through the gateway instead of being downloaded on the server: the model's response is shown here as it arrives. If the provider returns a link or inline data, it is preserved in the raw output below.
          </p>
        </Card>
      </div>
      <div className="flex flex-col gap-4">
        {error && <div className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-fg" role="alert">{error}</div>}
        <div className="grid min-h-[280px] place-items-center rounded-[24px] bg-surface p-8 shadow-[var(--surface-shadow)]">
          {streamText ? (
            <div className="md w-full text-sm leading-6" dangerouslySetInnerHTML={{ __html: renderMarkdown(streamText) }} />
          ) : busy ? (
            <span className="inline-flex h-7 w-7 animate-spin rounded-full border-2 border-default border-t-accent" role="status" aria-label="Generating" />
          ) : (
            <p className="max-w-[44ch] text-center text-sm leading-5 text-muted">Describe what you want and generate. The {kind} appears here when the model supports {kind} output.</p>
          )}
        </div>
      </div>
    </div>
  );
}
