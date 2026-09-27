<script lang="ts">
  import { onMount } from "svelte";
  import ThemeToggle from "$lib/components/ThemeToggle.svelte";
  import { api, fmtInt, fmtUsd, type Limits } from "$lib/api";
  import { ui } from "$lib/state/ui.svelte";

  let limits = $state<Limits | null>(null);

  onMount(async () => {
    try {
      limits = await api.limits();
    } catch {
      limits = null;
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
</script>

<header class="topbar">
  <button class="collapse" type="button" aria-label="Toggle sidebar" onclick={() => ui.toggle()}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><line x1="6" y1="2.5" x2="6" y2="13.5" /></svg>
  </button>
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
</style>
