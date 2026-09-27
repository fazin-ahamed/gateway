<script lang="ts">
  import { onMount } from "svelte";
  import { api, fmtInt, fmtUsd, fmtMs, type Activity, type Limits, type RequestDetail } from "$lib/api";
  import UsageChart from "$lib/components/UsageChart.svelte";
  import RequestDrawer from "$lib/components/RequestDrawer.svelte";

  type Recent = {
    id: string;
    created_at: string;
    slug: string;
    model_kind: string;
    http_status: number | null;
    latency_ms: number | null;
    tokens: number;
    cost_usd: number;
  };

  type ModelUse = { slug: string; requests: number; tokens: number; spend_usd: number; ok: number };
  let activity = $state<Activity | null>(null);
  let limits = $state<Limits | null>(null);
  let usage = $state<ModelUse[]>([]);
  let recent = $state<Recent[] | null>(null);
  let failed = $state(false);
  let loading = $state(false);
  let detail = $state<RequestDetail | null>(null);
  let metric = $state<"requests" | "tokens" | "spend_usd">("requests");
  let hours = $state(168);

  let request = 0;
  async function load(h: number) {
    const mine = ++request;
    failed = false;
    loading = true;
    try {
      const days = Math.max(1, Math.ceil(h / 24));
      const [act, lim, used, list] = await Promise.all([
        api.activity(h),
        api.limits(),
        fetch(`/console/api/usage?days=${days}`, { credentials: "same-origin" }).then((r) => r.json()),
        fetch(`/console/api/requests?days=${days}&limit=25`, { credentials: "same-origin" }).then((r) => r.json())
      ]);
      if (mine !== request) return;
      activity = act;
      limits = lim;
      usage = used.models || [];
      recent = list.requests || [];
    } catch {
      if (mine === request) failed = true;
    } finally {
      if (mine === request) loading = false;
    }
  }

  function changeWindow(h: number) {
    if (hours === h) return;
    hours = h;
    load(h);
  }

  onMount(() => load(hours));

  async function openRequest(id: string) {
    try {
      detail = await api.request(id);
    } catch {
      detail = null;
    }
  }

  const points = $derived(
    (activity?.points || []).map((p) => ({ t: p.hour, requests: p.requests, tokens: p.tokens, spend_usd: p.spend_usd }))
  );

  const windowLabel = $derived(hours === 24 ? "Last 24 hours" : hours === 720 ? "Last 30 days" : "Last 7 days");
</script>

<div class="head">
  <div>
    <h1 class="page-title">Activity</h1>
    <p class="lede">{windowLabel} through Astrosphere.</p>
  </div>
  <div class="tabs" role="tablist" aria-label="Window">
    <button class="tab" class:on={hours === 24} onclick={() => changeWindow(24)}>24h</button>
    <button class="tab" class:on={hours === 168} onclick={() => changeWindow(168)}>7d</button>
    <button class="tab" class:on={hours === 720} onclick={() => changeWindow(720)}>30d</button>
  </div>
</div>

{#if failed}
  <div class="error-note">
    <span>Activity couldn't load.</span>
    <button class="btn" onclick={() => load(hours)}>Retry</button>
  </div>
{:else if !activity}
  <div class="metrics" aria-hidden="true">
    {#each ["Requests", "Succeeded", "Failed", "Spend"] as label (label)}
      <div class="metric"><div class="label">{label}</div><div class="skeleton-row" style="margin-top:8px;width:60%"></div></div>
    {/each}
  </div>
{:else}
  <div class="metrics" class:dim={loading}>
    <div class="metric"><div class="label">Requests</div><div class="value">{fmtInt(activity.totals.requests)}</div></div>
    <div class="metric"><div class="label">Succeeded</div><div class="value">{fmtInt(activity.totals.ok)}</div></div>
    <div class="metric"><div class="label">Failed</div><div class="value">{fmtInt(activity.totals.fail)}</div></div>
    <div class="metric"><div class="label">Spend</div><div class="value">{fmtUsd(activity.totals.spend_usd)}</div></div>
    {#if limits}
      {@const pct = limits.budget.limit > 0 ? Math.max(2, Math.min(100, (limits.budget.used / limits.budget.limit) * 100)) : 0}
      <div class="metric budget">
        <svg class="budget-ring" viewBox="0 0 36 36" aria-hidden="true">
          <circle cx="18" cy="18" r="15"></circle>
          <circle class="arc" cx="18" cy="18" r="15" pathLength="100" stroke-dasharray="{pct} 100"></circle>
        </svg>
        <div>
          <div class="label">Limit</div>
          <div class="value">{limits.budget.mode === "usd" ? fmtUsd(limits.budget.remaining) : fmtInt(limits.budget.remaining)}</div>
          <div class="label">{limits.budget.mode === "usd" ? fmtUsd(limits.budget.used) : fmtInt(limits.budget.used)} used{limits.rate.per_minute ? ` · ${limits.rate.used_this_minute}/${limits.rate.per_minute} min` : ""}</div>
        </div>
      </div>
    {/if}
  </div>
  {#if limits?.models.length}
    <div class="rings">
      {#each limits.models as cap (`${cap.slug}-${cap.kind}-${cap.period}`)}
        {@const pct = cap.limit > 0 ? Math.max(2, Math.min(100, (cap.used / cap.limit) * 100)) : 0}
        <div class="ring" style="--pct:{pct}">
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle cx="18" cy="18" r="15"></circle>
            <circle class="arc" cx="18" cy="18" r="15" pathLength="100" stroke-dasharray="{pct} 100"></circle>
          </svg>
          <span>
            <strong>{cap.slug}</strong>
            <em>{cap.kind === "usd" ? fmtUsd(cap.used) : fmtInt(cap.used)} of {cap.kind === "usd" ? fmtUsd(cap.limit) : fmtInt(cap.limit)}</em>
            <small>per {cap.period}</small>
          </span>
        </div>
      {/each}
    </div>
  {/if}

  <section class="block">
    <div class="block-head">
      <h2 class="section-heading">Global activity</h2>
      <div class="tabs" role="tablist" aria-label="Metric">
        <button class="tab" class:on={metric === "requests"} onclick={() => (metric = "requests")}>Requests</button>
        <button class="tab" class:on={metric === "tokens"} onclick={() => (metric = "tokens")}>Tokens</button>
        <button class="tab" class:on={metric === "spend_usd"} onclick={() => (metric = "spend_usd")}>Spend</button>
      </div>
    </div>
    {#if points.length}
      <UsageChart series={points} {metric} windowHours={hours} />
    {:else}
      <div class="empty">
        <p>No requests in this window.</p>
      </div>
    {/if}
  </section>

  <section class="block">
    <h2 class="section-heading">Usage by model</h2>
    {#if usage.length === 0}
      <div class="empty"><p>No model usage in this window.</p></div>
    {:else}
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>Model</th><th class="r">Requests</th><th class="r">Success</th><th class="r">Tokens</th><th class="r">Spend</th></tr></thead>
          <tbody>
            {#each usage as m (`${m.slug}`)}
              <tr>
                <td>{m.slug}</td>
                <td class="r">{fmtInt(m.requests)}</td>
                <td class="r">{m.requests ? Math.round((m.ok / m.requests) * 100) + "%" : "—"}</td>
                <td class="r">{fmtInt(m.tokens)}</td>
                <td class="r">{fmtUsd(m.spend_usd)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>


  <section class="block">
    <h2 class="section-heading">Recent</h2>
    {#if !recent || recent.length === 0}
      <div class="empty"><p>Nothing recorded yet.</p></div>
    {:else}
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>Time</th><th>Model</th><th>Status</th>
              <th class="r">Latency</th><th class="r">Tokens</th><th class="r">Cost</th>
            </tr>
          </thead>
          <tbody>
            {#each recent as r (r.id)}
              <tr class="clickable" onclick={() => openRequest(r.id)}>
                <td class="mono">{r.created_at.slice(5, 16).replace("T", " ")}</td>
                <td>{r.slug}</td>
                <td><span class="status" class:status-ok={r.http_status === 200} class:status-bad={r.http_status !== 200}>{r.http_status ?? "—"}</span></td>
                <td class="r">{fmtMs(r.latency_ms)}</td>
                <td class="r">{r.tokens ? fmtInt(r.tokens) : "—"}</td>
                <td class="r">{fmtUsd(r.cost_usd)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

{#if detail}
  <RequestDrawer {detail} onClose={() => (detail = null)} />
{/if}

<style>
  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }

  .lede {
    margin: 4px 0 0;
    color: var(--text-muted);
    font-size: 14px;
  }

  .limit-line {
    margin: 12px 0 0;
    font-size: 13px;
    color: var(--text-muted);
  }

  .limit-line a {
    color: var(--accent);
  }
.rings {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 16px;
}

.ring {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 220px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}

.ring svg { width: 52px; height: 52px; transform: rotate(-90deg); flex-shrink: 0; }
.ring circle { fill: none; stroke: var(--border); stroke-width: 3; }
.ring .arc {
  stroke: var(--accent);
}
.ring span { display: flex; flex-direction: column; min-width: 0; }
.ring strong { font-size: 14px; }
.ring em, .ring small { color: var(--text-muted); font-style: normal; font-size: 12px; }

  .metric.budget {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .budget-ring {
    width: 52px;
    height: 52px;
    transform: rotate(-90deg);
    flex-shrink: 0;
  }

  .budget-ring circle {
    fill: none;
    stroke: var(--border);
    stroke-width: 3;
  }

  .budget-ring .arc {
    stroke: var(--accent);
  }

  .metric.budget .value {
    font-size: 18px;
    line-height: 22px;
  }

  .metrics {
    transition: opacity var(--t-fast);
  }

  .metrics.dim {
    opacity: 0.5;
  }

  .block {
    margin-top: 28px;
  }

  .block-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  @media (max-width: 639px) {
    .head, .block-head {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
