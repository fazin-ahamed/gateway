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

  let activity = $state<Activity | null>(null);
  let limits = $state<Limits | null>(null);
  let recent = $state<Recent[] | null>(null);
  let failed = $state(false);
  let detail = $state<RequestDetail | null>(null);
  let metric = $state<"requests" | "tokens" | "spend_usd">("requests");
  let hours = $state(168);

  async function load(h: number) {
    failed = false;
    try {
      const [act, lim, ov] = await Promise.all([api.activity(h), api.limits(), api.overview(Math.max(1, Math.ceil(h / 24)))]);
      activity = act;
      limits = lim;
      recent = ov.recent;
    } catch {
      failed = true;
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

  function budgetText(l: Limits) {
    if (l.budget.mode === "usd") return `${fmtUsd(l.budget.used)} of ${fmtUsd(l.budget.limit)}`;
    return `${fmtInt(l.budget.used)} of ${fmtInt(l.budget.limit)} tokens`;
  }
</script>

<div class="head">
  <div>
    <h1 class="page-title">Activity</h1>
    <p class="lede">What this key has sent through Astrosphere.</p>
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
  <div class="metrics">
    <div class="metric"><div class="label">Requests</div><div class="value">{fmtInt(activity.totals.requests)}</div></div>
    <div class="metric"><div class="label">Succeeded</div><div class="value">{fmtInt(activity.totals.ok)}</div></div>
    <div class="metric"><div class="label">Failed</div><div class="value">{fmtInt(activity.totals.fail)}</div></div>
    <div class="metric"><div class="label">Spend</div><div class="value">{fmtUsd(activity.totals.spend_usd)}</div></div>
  </div>

  {#if limits}
    <p class="limit-line">
      Budget {budgetText(limits)}.
      {#if limits.rate.per_minute}
        Rate {fmtInt(limits.rate.used_this_minute)} of {fmtInt(limits.rate.per_minute)} this minute.
      {:else}
        No per-minute cap.
      {/if}
      <a href="/console/limits/">Limits</a>
    </p>
  {/if}
  {#if limits?.models.length}
    <div class="caps">
      {#each limits.models as cap (`${cap.slug}-${cap.kind}-${cap.period}`)}
        <a class="cap" href="/console/limits/">
          <span>{cap.slug}</span>
          <strong>{cap.kind === "usd" ? fmtUsd(cap.used) : fmtInt(cap.used)} / {cap.kind === "usd" ? fmtUsd(cap.limit) : fmtInt(cap.limit)}</strong>
          <em>{cap.period}</em>
        </a>
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
      <UsageChart series={points} {metric} />
    {:else}
      <div class="empty">
        <p>No requests in this window.</p>
        <p class="meta">Send one through the gateway and it will appear on the hour it landed.</p>
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
.caps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.cap {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
}

.cap strong { font-variant-numeric: tabular-nums; }
.cap em { color: var(--text-muted); font-style: normal; }

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
