<script lang="ts">
  import { onMount } from "svelte";
  import { api, fmtInt, fmtUsd, type Limits } from "$lib/api";

  let limits = $state<Limits | null>(null);
  let failed = $state(false);

  async function load() {
    failed = false;
    try {
      limits = await api.limits();
    } catch {
      failed = true;
    }
  }

  onMount(load);

  const pct = $derived(
    limits && limits.budget.limit > 0 ? Math.min(100, (limits.budget.used / limits.budget.limit) * 100) : 0
  );
</script>

<h1 class="page-title">Limits</h1>
<p class="lede">The budget and rate the operator set on this key. Astrosphere enforces both; this page only reports them.</p>

{#if failed}
  <div class="error-note"><span>Limits couldn't load.</span><button class="btn" onclick={load}>Retry</button></div>
{:else if !limits}
  <div class="skeleton-row"></div>
{:else}
  <section class="panel">
    <h2>{limits.name || "This key"}</h2>
    <p class="meta">{limits.active ? "Active" : "Deactivated"}{limits.expires_at ? `, expires ${limits.expires_at.slice(0, 10)}` : ""}</p>

    <div class="meter" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin="0" aria-valuemax="100" aria-label="Budget used">
      <span style="width: {pct}%"></span>
    </div>
    <p class="figure">
      {#if limits.budget.mode === "usd"}
        {fmtUsd(limits.budget.used)} used of {fmtUsd(limits.budget.limit)}. {fmtUsd(limits.budget.remaining)} left.
      {:else}
        {fmtInt(limits.budget.used)} tokens used of {fmtInt(limits.budget.limit)}. {fmtInt(limits.budget.remaining)} left.
      {/if}
    </p>
    <p class="meta">{fmtInt(limits.budget.request_count)} requests counted against this key.</p>
  </section>

  <section class="panel">
    <h2>Rate</h2>
    {#if limits.rate.per_minute}
      <p class="figure">{fmtInt(limits.rate.used_this_minute)} of {fmtInt(limits.rate.per_minute)} this minute</p>
      <p class="meta">The window resets at the next minute. A request past the cap is refused with HTTP 429.</p>
    {:else}
      <p class="figure">No per-minute cap</p>
      <p class="meta">The budget is the only limit on this key.</p>
    {/if}
  </section>
{/if}

<style>
  .lede {
    margin: 6px 0 20px;
    max-width: 62ch;
    color: var(--text-muted);
    font-size: 14px;
  }

  .panel {
    margin-top: 16px;
    padding: 20px;
    border: 1px solid var(--border);
    background: var(--surface);
  }

  h2 {
    margin: 0;
    font-size: 16px;
  }

  .meter {
    margin-top: 16px;
    height: 8px;
    background: var(--surface-subtle);
    border: 1px solid var(--border);
  }

  .meter span {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .figure {
    margin: 12px 0 4px;
    font-size: 20px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
</style>
