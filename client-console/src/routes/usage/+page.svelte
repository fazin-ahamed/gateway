<script lang="ts">
  import { apiFetch } from "$lib/api";
  import { onMount } from "svelte";
  import { fmtInt, fmtMs, fmtUsd } from "$lib/api";

  type ModelRow = {
    slug: string;
    model_kind: "chat" | "decision";
    requests: number;
    ok: number;
    tokens: number;
    spend_usd: number;
    p50_ttft_ms: number | null;
    p95_ttft_ms: number | null;
  };

  type Usage = { window: { days: number }; models: ModelRow[] };

  let usage = $state<Usage | null>(null);
  let failed = $state(false);
  let days = $state(7);

  async function load() {
    failed = false;
    usage = null;
    try {
      const res = await apiFetch(`/console/api/usage?days=${days}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      usage = await res.json();
    } catch {
      failed = true;
    }
  }

  onMount(load);
  $effect(() => {
    void days;
    load();
  });

  function successRate(m: ModelRow): string {
    if (!m.requests) return "—";
    return Math.round((m.ok / m.requests) * 100) + "%";
  }

  const totalRequests = $derived((usage?.models ?? []).reduce((s, m) => s + m.requests, 0));
  const totalSpend = $derived((usage?.models ?? []).reduce((s, m) => s + m.spend_usd, 0));
  const totalTokens = $derived((usage?.models ?? []).reduce((s, m) => s + m.tokens, 0));
</script>

<h1 class="page-title">Usage</h1>

<div class="controls">
  <div class="tabs" role="tablist" aria-label="Window">
    <button class="tab" class:on={days === 7} onclick={() => (days = 7)}>7d</button>
    <button class="tab" class:on={days === 30} onclick={() => (days = 30)}>30d</button>
    <button class="tab" class:on={days === 90} onclick={() => (days = 90)}>90d</button>
  </div>
</div>

{#if failed}
  <div class="error-note">
    <span>Usage couldn't load.</span>
    <button class="btn" onclick={load}>Retry</button>
  </div>
{:else if !usage}
  <div class="metrics" aria-hidden="true">
    {#each ["Requests", "Tokens", "Spend"] as label (label)}
      <div class="metric">
        <div class="label">{label}</div>
        <div class="skeleton-row" style="margin-top:8px;width:60%"></div>
      </div>
    {/each}
  </div>
{:else}
  <div class="metrics">
    <div class="metric">
      <div class="label">Requests</div>
      <div class="value">{fmtInt(totalRequests)}</div>
    </div>
    <div class="metric">
      <div class="label">Tokens</div>
      <div class="value">{fmtInt(totalTokens)}</div>
    </div>
    <div class="metric">
      <div class="label">Spend</div>
      <div class="value">{fmtUsd(totalSpend)}</div>
    </div>
  </div>

  <section class="block">
    <h2 class="section-heading">By model</h2>
    {#if usage.models.length === 0}
      <div class="empty">
        <p>No usage in this window.</p>
        <p class="meta">Requests through the gateway appear here with their cost and latency.</p>
      </div>
    {:else}
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>Model</th><th>Type</th>
              <th class="r">Requests</th><th class="r">Success</th>
              <th class="r">Tokens</th><th class="r">Spend</th>
              <th class="r">p50 TTFT</th><th class="r">p95 TTFT</th>
            </tr>
          </thead>
          <tbody>
            {#each usage.models as m (m.slug + "|" + m.model_kind)}
              <tr>
                <td class="mono">{m.slug}</td>
                <td>{m.model_kind}</td>
                <td class="r">{fmtInt(m.requests)}</td>
                <td class="r">{successRate(m)}</td>
                <td class="r">{m.tokens ? fmtInt(m.tokens) : "—"}</td>
                <td class="r">{fmtUsd(m.spend_usd)}</td>
                <td class="r">{fmtMs(m.p50_ttft_ms)}</td>
                <td class="r">{fmtMs(m.p95_ttft_ms)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

<style>
  .controls {
    display: flex;
    gap: 12px;
    margin: 16px 0;
    align-items: center;
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

  .block {
    margin-top: 28px;
  }

  .block h2 {
    margin-bottom: 12px;
  }
</style>
