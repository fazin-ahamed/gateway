<script lang="ts">
  import { onMount } from "svelte";
  import { api, fmtContext, fmtUsd, type ConsoleModel } from "$lib/api";

  let models = $state<ConsoleModel[] | null>(null);
  let failed = $state(false);
  let filter = $state<"all" | "chat" | "decision">("all");
  let query = $state("");
  let selected = $state<ConsoleModel | null>(null);

  onMount(async () => {
    try {
      const res = await api.models();
      models = res.data;
    } catch {
      failed = true;
    }
  });

  const shown = $derived(
    (models ?? []).filter((m) => {
      if (filter !== "all" && m.model_kind !== filter) return false;
      if (query && !m.id.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    })
  );


  function decisionExample(id: string): string {
    const body = JSON.stringify({
      model: id,
      state: { task: "rate this change" },
      questions: { verify: { type: "noul", instructions: "Needs review?" } }
    });
    return [
      "curl $BASE_URL/v1/systemone \\",
      '  -H "Authorization: Bearer $KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '${body}'`
    ].join("\n");
  }

  function chatExample(id: string): string {
    const body = JSON.stringify({
      model: id,
      messages: [{ role: "user", content: "Hello" }]
    });
    return [
      "curl $BASE_URL/v1/chat/completions \\",
      '  -H "Authorization: Bearer $KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '${body}'`
    ].join("\n");
  }

  function price(m: ConsoleModel): string {
    if (m.per_request != null) return `${fmtUsd(m.per_request)} / request`;
    if (m.prompt_per_1m != null) return `$${m.prompt_per_1m.toFixed(2)} / 1M in`;
    return "—";
  }
</script>

<h1 class="page-title">Models</h1>

{#if failed}
  <div class="error-note">
    <span>Models couldn't load.</span>
    <button class="btn" onclick={() => location.reload()}>Retry</button>
  </div>
{:else if !models}
  {#each [1, 2, 3, 4] as i (i)}
    <div class="skeleton-row" style="width:100%"></div>
  {/each}
{:else if models.length === 0}
  <div class="empty">
    <p>No models are enabled for this key yet.</p>
  </div>
{:else}
  <div class="controls">
    <div class="tabs" role="tablist" aria-label="Model type">
      <button class="tab" class:on={filter === "all"} onclick={() => (filter = "all")}>All</button>
      <button class="tab" class:on={filter === "chat"} onclick={() => (filter = "chat")}>Chat</button>
      <button class="tab" class:on={filter === "decision"} onclick={() => (filter = "decision")}>Decision</button>
    </div>
    <input class="input" placeholder="Search models" bind:value={query} aria-label="Search models" />
  </div>

  <div class="table-scroll"><table class="table">
    <thead>
      <tr>
        <th>Model</th><th>Type</th><th class="r">Context</th><th class="r">Output</th>
        <th>Tools</th><th>Vision</th><th class="r">Cost</th>
      </tr>
    </thead>
    <tbody>
      {#each shown as m (m.id)}
        <tr class="clickable" onclick={() => (selected = m)}>
          <td class="mono">{m.id}</td>
          <td>{m.model_kind === "decision" ? "Decision" : "Chat"}</td>
          <td class="r">{m.model_kind === "decision" ? "—" : fmtContext(m.context_window ?? m.routing?.resilient_context)}</td>
          <td class="r">{m.model_kind === "decision" ? "—" : fmtContext(m.max_output_tokens)}</td>
          <td>{m.model_kind === "decision" ? "—" : m.tools ? "Yes" : "No"}</td>
          <td>{m.model_kind === "decision" ? "—" : m.vision ? "Yes" : "No"}</td>
          <td class="r">{price(m)}</td>
        </tr>
      {:else}
        <tr><td colspan="7" class="none">No models match.</td></tr>
      {/each}
    </tbody>
  </table></div>
{/if}

{#if selected}
  <div class="drawer-backdrop" role="presentation" onclick={() => (selected = null)} onkeydown={(e) => { if (e.key === "Escape") selected = null; }}></div>
  <div class="drawer" role="dialog" aria-modal="true" aria-label={selected.id + " details"}>
    <div class="drawer-head">
      <h2 class="section-heading mono">{selected.id}</h2>
      <button class="btn btn-quiet" onclick={() => (selected = null)}>Close</button>
    </div>
    <p class="meta" style="margin-top:2px">
      {selected.model_kind === "decision" ? "Decision model" : "Chat model"}
    </p>
    <dl class="kv">
      {#if selected.model_kind === "decision"}
        <dt>Endpoint</dt><dd class="mono">POST {selected.endpoint}</dd>
        <dt>Protocol</dt><dd>{selected.protocol}</dd>
        <dt>Supported</dt><dd>Choice, Score, Noul</dd>
      {:else if selected.id === "auto"}
        <dt>Endpoint</dt><dd class="mono">POST /v1/chat/completions</dd>
        {#if selected.routing}
          <dt>Resilient context</dt><dd>{fmtContext(selected.routing.resilient_context)}</dd>
          <dt>Maximum available</dt><dd>{fmtContext(selected.routing.max_context)}</dd>
        {/if}
      {:else}
        <dt>Endpoint</dt><dd class="mono">POST /v1/chat/completions</dd>
        <dt>Context</dt><dd>{fmtContext(selected.context_window)}</dd>
        <dt>Output</dt><dd>{fmtContext(selected.max_output_tokens)}</dd>
        <dt>Tools</dt><dd>{selected.tools ? "Yes" : "No"}</dd>
        <dt>Vision</dt><dd>{selected.vision ? "Yes" : "No"}</dd>
      {/if}
      <dt>Price</dt><dd>{price(selected)}</dd>
    </dl>
    <div class="example">
      <h3 class="meta">Example</h3>
      {#if selected.model_kind === "decision"}
        <pre class="mono">{decisionExample(selected.id)}</pre>
      {:else}
        <pre class="mono">{chatExample(selected.id)}</pre>
      {/if}
    </div>
  </div>
{/if}

<style>
  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin: 16px 0 12px;
  }

  .controls .input {
    width: 240px;
  }

  .tabs {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    overflow: hidden;
  }

  .tab {
    padding: 4px 12px;
    font-size: 12px;
    line-height: 17px;
    color: var(--text-muted);
    border-right: 1px solid var(--border);
  }

  .tab:last-child {
    border-right: none;
  }

  .tab.on {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 500;
  }

  .none {
    color: var(--text-muted);
    text-align: center;
    padding: 32px 0;
  }

  .drawer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .kv {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 8px 16px;
    font-size: 13px;
    line-height: 19px;
    margin: 20px 0;
  }

  .kv dt {
    color: var(--text-muted);
  }

  .kv dd {
    margin: 0;
  }

  .example {
    border-top: 1px solid var(--border);
    padding-top: 16px;
    margin-top: 8px;
  }

  .example pre {
    margin: 8px 0 0;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--surface-subtle);
    overflow-x: auto;
    white-space: pre;
  }
</style>
