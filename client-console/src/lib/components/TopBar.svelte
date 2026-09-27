<script lang="ts">
  import { onMount } from "svelte";
  import ThemeToggle from "$lib/components/ThemeToggle.svelte";
  import { api, fmtInt, fmtUsd, type Limits, type Pool } from "$lib/api";
  import { ui } from "$lib/state/ui.svelte";

  let limits = $state<Limits | null>(null);
  let pool = $state<Pool>(null);

  onMount(async () => {
    try {
      limits = await api.limits();
    } catch {
      limits = null;
    }
    try {
      pool = (await api.pool()).pool;
    } catch {
      pool = null;
    }
  });

  const pct = $derived(
    limits && limits.budget.limit > 0 ? (limits.budget.used / limits.budget.limit) * 100 : 0
  );
  const dotClass = $derived(pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok");
  const budgetText = $derived(
    limits
      ? limits.budget.mode === "usd"
        ? `${fmtUsd(limits.budget.used)} / ${fmtUsd(limits.budget.limit)}`
        : `${fmtInt(limits.budget.used)} / ${fmtInt(limits.budget.limit)}`
      : ""
  );

  const poolPct = $derived(pool && pool.limit > 0 ? Math.min(100, (pool.used / pool.limit) * 100) : 0);
  const poolState = $derived(!pool || pool.remaining <= 0 || !pool.active ? "over" : poolPct >= 80 ? "warn" : "ok");
  const poolRemaining = $derived(
    pool ? (pool.mode === "usd" ? fmtUsd(pool.remaining) : fmtInt(pool.remaining)) : ""
  );
  const poolLimit = $derived(
    pool ? (pool.mode === "usd" ? fmtUsd(pool.limit) : fmtInt(pool.limit)) : ""
  );
</script>

<header class="topbar">
  <button class="collapse" type="button" aria-label="Toggle sidebar" onclick={() => ui.toggle()}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><line x1="6" y1="2.5" x2="6" y2="13.5" /></svg>
  </button>
  {#if pool}
    <div class="pool {poolState}" title="Shared pool budget available to every key: {poolRemaining} of {poolLimit} left">
      <svg class="orbit" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="2.4" />
        <ellipse cx="12" cy="12" rx="9" ry="3.6" fill="none" />
        <ellipse cx="12" cy="12" rx="9" ry="3.6" fill="none" transform="rotate(60 12 12)" />
      </svg>
      <span class="pool-name">{pool.name}</span>
      <span class="pool-sep">·</span>
      <span class="pool-remaining">{poolRemaining} left</span>
      <span class="meter" aria-hidden="true"><span class="fill" style="width:{poolPct}%"></span></span>
    </div>
  {/if}
  <div class="spacer"></div>
  {#if limits}
    <a class="budget" href="/console/" title="Budget used against this key's limit">
      <span class="dot {dotClass}"></span>
      {budgetText}
    </a>
  {/if}
  <ThemeToggle />
</header>

<style>
  .topbar {
    height: 52px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 20px 0 16px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 82%, transparent);
    backdrop-filter: blur(10px);
    position: sticky;
    top: 0;
    z-index: 30;
  }

  .collapse {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    color: var(--text-muted);
    background: transparent;
    cursor: pointer;
    transition: color var(--t-fast), background var(--t-fast);
  }

  .collapse:hover {
    color: var(--text);
    background: var(--surface-subtle);
  }

  .collapse svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }

  .spacer {
    flex: 1;
  }

  .budget {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .budget:hover {
    border-color: var(--border-strong);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
  }

  .dot.warn {
    background: var(--warning);
  }

  .dot.over {
    background: var(--danger);
  }

  .pool {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 12px;
    margin-left: 4px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    font-size: 13px;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent);
    animation: pool-pulse 2.8s ease-in-out infinite;
  }

  .pool.warn {
    border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
    background: color-mix(in srgb, var(--warning) 12%, transparent);
  }

  .pool.over {
    border-color: color-mix(in srgb, var(--danger) 55%, var(--border));
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    animation: none;
  }

  .pool .orbit {
    width: 16px;
    height: 16px;
    color: var(--accent);
    fill: currentColor;
    stroke: currentColor;
    stroke-width: 1.3;
    flex-shrink: 0;
  }

  .pool.warn .orbit { color: var(--warning); }
  .pool.over .orbit { color: var(--danger); }

  .pool-name {
    font-weight: 600;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pool-sep { color: var(--text-muted); }
  .pool-remaining { color: var(--text-muted); }

  .pool .meter {
    width: 44px;
    height: 4px;
    border-radius: 999px;
    background: var(--surface-subtle);
    overflow: hidden;
    flex-shrink: 0;
  }

  .pool .meter .fill {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width var(--t-slow, 400ms) var(--ease, ease);
  }

  .pool.warn .meter .fill { background: var(--warning); }
  .pool.over .meter .fill { background: var(--danger); }

  @keyframes pool-pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 40%, transparent); }
    50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 0%, transparent); }
  }

  @media (max-width: 720px) {
    .pool-name { max-width: 90px; }
    .pool .meter { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .pool { animation: none; }
    .pool .meter .fill { transition: none; }
  }
</style>
