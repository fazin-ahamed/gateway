<script lang="ts">
  import { onMount } from "svelte";
  import { api, fmtInt, fmtMs, fmtUsd, type RequestDetail } from "$lib/api";
  import RequestDrawer from "$lib/components/RequestDrawer.svelte";

  type Row = {
    id: string;
    created_at: string;
    slug: string;
    model_kind: "chat" | "decision";
    status: string;
    http_status: number | null;
    ttft_ms: number | null;
    latency_ms: number | null;
    total_tokens: number;
    cost_usd: number;
  };

  let rows = $state<Row[] | null>(null);
  let failed = $state(false);
  let kind = $state<"all" | "chat" | "decision">("all");
  let status = $state<"all" | "ok" | "fail" | "cancelled">("all");
  let search = $state("");
  let days = $state(7);
  let detail = $state<RequestDetail | null>(null);
  let ownedKeys = $state<Array<{ key_id: string; name: string }> | null>(null);
  let keyFilter = $state("all");

  async function load() {
    failed = false;
    rows = null;
    const params = new URLSearchParams({ days: String(days), limit: "50" });
    if (kind !== "all") params.set("kind", kind);
    if (keyFilter !== "all") params.set("key_id", keyFilter);
    if (search.trim()) params.set("request_id", search.trim());
    try {
      const res = await fetch(`/console/api/requests?${params}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      rows = body.requests;
    } catch {
      failed = true;
    }
  }

  onMount(async () => {
    load();
    try {
      const body = await api.keys();
      ownedKeys = body.account ? body.keys.map((k) => ({ key_id: k.key_id, name: k.name })) : [];
    } catch {
      ownedKeys = [];
    }
  });
  $effect(() => {
    void kind; void status; void days; void keyFilter;
    load();
  });

  async function open(id: string) {
    try {
      detail = await api.request(id);
    } catch {
      detail = null;
    }
  }

  let searchTimer: ReturnType<typeof setTimeout>;
  function onSearch(value: string) {
    search = value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 300);
  }

  const statusClass = (r: Row) =>
    r.status === "ok" ? "status-ok" : r.status === "cancelled" ? "status-warn" : "status-bad";
</script>

<h1 class="page-title">Requests</h1>

<div class="controls">
  <input
    class="input"
    placeholder="Search request ID"
    aria-label="Search request ID"
    value={search}
    oninput={(e) => onSearch(e.currentTarget.value)}
  />
  {#if ownedKeys && ownedKeys.length > 1}
    <select class="input" aria-label="Filter by key" bind:value={keyFilter}>
      <option value="all">All keys</option>
      {#each ownedKeys as k (k.key_id)}
        <option value={k.key_id}>{k.name}</option>
      {/each}
    </select>
  {/if}
  <div class="tabs" role="tablist" aria-label="Type">
    <button class="tab" class:on={kind === "all"} onclick={() => (kind = "all")}>All</button>
    <button class="tab" class:on={kind === "chat"} onclick={() => (kind = "chat")}>Chat</button>
    <button class="tab" class:on={kind === "decision"} onclick={() => (kind = "decision")}>Decision</button>
  </div>
  <div class="tabs" role="tablist" aria-label="Status">
    <button class="tab" class:on={status === "all"} onclick={() => (status = "all")}>All</button>
    <button class="tab" class:on={status === "ok"} onclick={() => (status = "ok")}>Success</button>
    <button class="tab" class:on={status === "fail"} onclick={() => (status = "fail")}>Failed</button>
    <button class="tab" class:on={status === "cancelled"} onclick={() => (status = "cancelled")}>Cancelled</button>
  </div>
  <div class="tabs" role="tablist" aria-label="Window">
    <button class="tab" class:on={days === 7} onclick={() => (days = 7)}>7d</button>
    <button class="tab" class:on={days === 30} onclick={() => (days = 30)}>30d</button>
    <button class="tab" class:on={days === 90} onclick={() => (days = 90)}>90d</button>
  </div>
</div>

{#if failed}
  <div class="error-note">
    <span>Requests couldn't load.</span>
    <button class="btn" onclick={load}>Retry</button>
  </div>
{:else if !rows}
  {#each [1, 2, 3, 4, 5] as i (i)}
    <div class="skeleton-row"></div>
  {/each}
{:else if rows.length === 0}
  <div class="empty">
    <p>No requests match.</p>
    <p class="meta">Try a wider window, or send a request through the gateway.</p>
  </div>
{:else}
  <div class="table-scroll">
    <table class="table">
      <thead>
        <tr>
          <th>Time</th><th>Model</th><th>Type</th><th>Status</th>
          <th class="r">TTFT</th><th class="r">Latency</th>
          <th class="r">Tokens</th><th class="r">Cost</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.id)}
          <tr class="clickable" onclick={() => open(r.id)}>
            <td class="mono">{r.created_at.slice(11, 19)}</td>
            <td>{r.slug}</td>
            <td>{r.model_kind}</td>
            <td><span class="status {statusClass(r)}">{r.http_status ?? r.status}</span></td>
            <td class="r">{fmtMs(r.ttft_ms)}</td>
            <td class="r">{fmtMs(r.latency_ms)}</td>
            <td class="r">{r.total_tokens ? fmtInt(r.total_tokens) : "—"}</td>
            <td class="r">{fmtUsd(r.cost_usd)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if detail}
  <RequestDrawer {detail} onClose={() => (detail = null)} />
{/if}

<style>
  .controls {
    display: flex;
    gap: 12px;
    align-items: center;
    margin: 16px 0;
    flex-wrap: wrap;
  }

  .controls .input {
    width: 220px;
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

</style>
