<script lang="ts">
  import { apiFetch } from "$lib/api";
  import { api, type ConsoleModel, fmtUsd } from "$lib/api";
  import { session } from "$lib/state/session.svelte";

  type Mode = "chat" | "decision";

  let mode = $state<Mode>("chat");
  let models = $state<ConsoleModel[] | null>(null);
  let model = $state("");
  let stream = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  let messages = $state<{ role: string; content: string }[]>([]);
  let prompt = $state("");
  let inspector = $state<Record<string, unknown> | null>(null);

  let stateJson = $state('{\n  "task": "rate this change"\n}');
  let questionsJson = $state('{\n  "verify": { "type": "noul", "instructions": "Does this need verification?" }\n}');
  let answers = $state<Record<string, Record<string, unknown>> | null>(null);

  $effect(() => {
    loadModels();
  });

  async function loadModels() {
    try {
      const res = await api.models();
      const wanted = mode === "chat" ? "chat" : "decision";
      const list = res.data.filter((m) => m.model_kind === wanted);
      if (mode === "chat") {
        const auto = res.data.find((m) => m.id === "auto" && m.model_kind === "chat");
        const others = list.filter((m) => m.id !== "auto");
        models = auto ? [auto, ...others] : others;
      } else {
        models = list;
      }
      if (models.length && !models.some((m) => m.id === model))
        model = models[0].id;
      if (!models.length)
        model = "";
    } catch {
      models = [];
    }
  }

  async function sendChat() {
    const text = prompt.trim();
    if (!text || busy) return;
    busy = true;
    error = null;
    const history = [...messages, { role: "user", content: text }];
    messages = history;
    prompt = "";
    inspector = null;
    try {
      const res = await apiFetch("/console/playground/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ model, messages: history, stream })
      });
      const requestId = res.headers.get("x-request-id");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        error = body?.error?.message ?? `HTTP ${res.status}`;
        return;
      }
      if (stream) {
        messages = [...messages, { role: "assistant", content: "" }];
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const o = JSON.parse(data);
              const delta = o.choices?.[0]?.delta?.content || "";
              if (delta) {
                messages = messages.slice(0, -1).concat([{ role: "assistant", content: messages[messages.length - 1].content + delta }]);
              }
            } catch {}
          }
        }
      } else {
        const body = await res.json();
        const content = body.choices?.[0]?.message?.content ?? "";
        messages = [...messages, { role: "assistant", content }];
      }
      if (requestId) {
        try {
          inspector = await api.request(requestId);
        } catch {
          inspector = null;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "The request failed.";
    } finally {
      busy = false;
    }
  }

  async function sendDecision() {
    if (busy) return;
    let state: unknown;
    let questions: unknown;
    try {
      state = JSON.parse(stateJson);
    } catch {
      error = "State must be valid JSON.";
      return;
    }
    try {
      questions = JSON.parse(questionsJson);
    } catch {
      error = "Questions must be valid JSON.";
      return;
    }
    busy = true;
    error = null;
    answers = null;
    try {
      const res = await apiFetch("/console/playground/systemone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ model, state, questions })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        error = body?.error?.message ?? `HTTP ${res.status}`;
        return;
      }
      const body = await res.json();
      answers = body.answers ?? null;
    } catch (e) {
      error = e instanceof Error ? e.message : "The request failed.";
    } finally {
      busy = false;
    }
  }

  function prob(answer: Record<string, unknown>): number | null {
    const p = answer.probability ?? answer.confidence ?? null;
    return typeof p === "number" ? Math.round(p * 100) : null;
  }

  function setMode(next: Mode) {
    mode = next;
    model = "";
    messages = [];
    answers = null;
    inspector = null;
    error = null;
    loadModels();
  }
</script>

<h1 class="page-title">Playground</h1>

<div class="controls">
  <div class="tabs" role="tablist" aria-label="Model class">
    <button class="tab" role="tab" aria-selected={mode === "chat"} class:on={mode === "chat"} onclick={() => setMode("chat")}>Chat</button>
    <button class="tab" role="tab" aria-selected={mode === "decision"} class:on={mode === "decision"} onclick={() => setMode("decision")}>Decision</button>
  </div>
  <div class="row">
    <label class="sr-only" for="pg-model">Model</label>
    <select id="pg-model" class="input select" bind:value={model}>
      {#if !models}
        <option value="">Loading…</option>
      {:else if models.length === 0}
        <option value="">{mode === "decision" ? "No decision models available to this key" : "No models available to this key"}</option>
      {:else}
        {#each models as m (m.id)}
          <option value={m.id}>{m.id}</option>
        {/each}
      {/if}
    </select>
    {#if mode === "chat"}
      <label class="check">
        <input type="checkbox" bind:checked={stream} />
        Stream
      </label>
    {/if}
  </div>
</div>

{#if error}
  <div class="error-note" role="alert">
    <span>{error}</span>
  </div>
{/if}

{#if mode === "chat"}
  <section class="workspace">
    <div class="messages" aria-live="polite">
      {#if messages.length === 0}
        <div class="empty">
          <p>No messages yet.</p>
          <p class="meta">Send a prompt to try this model through the gateway.</p>
        </div>
      {:else}
        {#each messages as m, i (i)}
          <div class="msg" class:own={m.role === "user"} style="animation-delay: {Math.min(i, 6) * 40}ms">
            <div class="who meta">{m.role === "user" ? "You" : model || "Model"}</div>
            <div class="body">{m.content}</div>
          </div>
        {/each}
      {/if}
    </div>
    <form class="composer" onsubmit={(e) => { e.preventDefault(); sendChat(); }}>
      <label class="sr-only" for="pg-prompt">Prompt</label>
      <textarea id="pg-prompt" class="input grow" rows="3" placeholder="Send a prompt" bind:value={prompt} disabled={busy}></textarea>
      <button class="btn btn-primary" type="submit" disabled={busy || !model}>{busy ? "Sending…" : "Send"}</button>
    </form>
  </section>
{:else}
  <section class="workspace decision">
    <div class="split">
      <div class="field">
        <label for="pg-state">State</label>
        <textarea id="pg-state" class="input mono" rows="12" spellcheck="false" bind:value={stateJson} disabled={busy}></textarea>
      </div>
      <div class="field">
        <label for="pg-questions">Questions</label>
        <textarea id="pg-questions" class="input mono" rows="12" spellcheck="false" bind:value={questionsJson} disabled={busy}></textarea>
      </div>
    </div>
    <div class="run">
      <button class="btn btn-primary" onclick={sendDecision} disabled={busy || !model}>{busy ? "Running…" : "Run decision"}</button>
    </div>
    {#if answers}
      <div class="answers">
        {#each Object.entries(answers) as [name, answer] (name)}
          <div class="answer">
            <div class="k">{name} <span class="meta">{String(answer.type)}</span></div>
            {#if answer.type === "choice"}
              <div class="v">{String(answer.choice ?? "—")}</div>
              {#each Object.entries((answer.probabilities ?? {}) as Record<string, number>) as [opt, p] (opt)}
                <div class="bar-row"><span>{opt}</span><i><b style="width:{Math.round(p * 100)}%"></b></i>{Math.round(p * 100)}%</div>
              {/each}
            {:else if answer.type === "score"}
              <div class="v">{answer.label ?? answer.score}</div>
            {:else}
              <div class="v">{prob(answer)}%</div>
              <div class="bar-row"><i><b style="width:{prob(answer) ?? 0}%"></b></i>{prob(answer)}%</div>
            {/if}
          </div>
        {/each}
      </div>
    {:else if !busy}
      <div class="empty"><p>No results yet.</p><p class="meta">Run a decision to see typed answers here.</p></div>
    {/if}
  </section>
{/if}

{#if inspector}
  <button class="btn btn-quiet" onclick={() => (inspector = null)}>Close inspector</button>
  <aside class="inspector" aria-label="Request details">
    <dl class="kv">
      <dt>Status</dt><dd>{inspector.http_status ?? inspector.status}</dd>
      <dt>Model</dt><dd>{inspector.slug}</dd>
      <dt>Headers</dt><dd>{inspector.headers_ms ?? "—"}</dd>
      <dt>First token</dt><dd>{inspector.ttft_ms ?? "—"}{inspector.ttft_ms ? "ms" : ""}</dd>
      <dt>Total</dt><dd>{inspector.latency_ms ?? "—"}{inspector.latency_ms ? "ms" : ""}</dd>
      <dt>Tokens</dt><dd>{inspector.total_tokens ?? "—"}</dd>
      <dt>Cost</dt><dd>{fmtUsd(inspector.cost_usd as number)}</dd>
      <dt>Cache</dt><dd>{inspector.cache_state ?? "—"}</dd>
    </dl>
  </aside>
{/if}

<style>
  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin: 16px 0;
    flex-wrap: wrap;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .select {
    min-width: 220px;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }

  .workspace {
    display: flex;
    flex-direction: column;
    min-height: 520px;
    border: 1px solid var(--border);
    background:
      linear-gradient(180deg, transparent, color-mix(in srgb, var(--accent) 6%, transparent)),
      var(--surface);
    padding: 20px;
  }

  .messages {
    flex: 1;
    max-height: 560px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 8px 4px 20px;
  }

  .msg {
    max-width: 68ch;
    animation: arrive 280ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }

  .msg.own {
    align-self: flex-end;
    text-align: right;
  }

  .msg .body {
    margin-top: 4px;
    padding: 12px 14px;
    background: var(--surface-subtle);
    white-space: pre-wrap;
    font-size: 15px;
    line-height: 23px;
  }

  .msg.own .body {
    background: var(--accent-soft);
    color: var(--text);
  }

  @keyframes arrive {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }

  .composer {
    display: flex;
    gap: 12px;
    align-items: flex-end;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  .composer textarea {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    min-height: 72px;
  }

  .split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .decision {
    min-height: 0;
    gap: 16px;
  }

  .decision textarea {
    width: 100%;
    min-height: 240px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 20px;
  }

  .run {
    display: flex;
    justify-content: flex-end;
  }

  .answers {
    margin-top: 16px;
    display: grid;
    gap: 16px;
  }

  .answer .k {
    font-weight: 500;
    display: flex;
    gap: 8px;
    align-items: baseline;
  }

  .answer .v {
    font-size: 16px;
    font-weight: 600;
    margin: 6px 0;
  }

  .bar-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .bar-row i {
    flex: 1;
    display: block;
    height: 5px;
    background: var(--surface-subtle);
    border-radius: 2px;
    overflow: hidden;
  }

  .bar-row b {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .inspector {
    margin-top: 16px;
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  @media (max-width: 899px) {
    .split {
      grid-template-columns: 1fr;
    }
  }
</style>
