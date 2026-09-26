<script lang="ts">
  import { onMount } from "svelte";
  import { api, fmtInt, fmtUsd, fmtMs, type Overview, type RequestDetail } from "$lib/api";
  import UsageChart from "$lib/components/UsageChart.svelte";

  let overview = $state<Overview | null>(null);
  let failed = $state(false);
  let detail = $state<RequestDetail | null>(null);
  let metric = $state<"requests" | "tokens" | "spend_usd">("requests");
  let daysWindow = $state(7);

  let loadError = $state<string | null>(null);

  async function load(w: number) {
    failed = false;
    loadError = null;
    try {
      overview = await api.overview(w);
    } catch (e) {
      failed = true;
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  function changeWindow(w: number) {
    if (daysWindow === w) return;
    daysWindow = w;
    load(w);
  }

  onMount(() => load(daysWindow));

  async function openRequest(id: string) {
    try {
      detail = await api.request(id);
    } catch {
      detail = null;
    }
  }

  function requestDelta(): number | null {
    if (!overview?.prior_totals) return null;
    const prev = overview.prior_totals.requests;
    if (!prev) return null;
    return ((overview.totals.requests - prev) / prev) * 100;
  }
</script>

<h1 class="page-title">Overview</h1>

{#if failed}
  <div class="error-note">
    <span>Usage couldn't load.{loadError ? " " + loadError : ""}</span>
    <button class="btn" onclick={() => load(daysWindow)}>Retry</button>
  </div>
{:else if !overview}
  <div class="metrics" aria-hidden="true">
    {#each ["Requests", "Tokens", "Spend", "p95 TTFT"] as label (label)}
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
      <div class="value">{fmtInt(overview.totals.requests)}</div>
      {#if requestDelta() !== null}
        <div class="delta">{requestDelta()!.toFixed(1)}% vs prior period</div>
      {/if}
    </div>
    <div class="metric">
      <div class="label">Tokens</div>
      <div class="value">{fmtInt(overview.totals.tokens)}</div>
    </div>
    <div class="metric">
      <div class="label">Spend</div>
      <div class="value">{fmtUsd(overview.totals.spend_usd)}</div>
    </div>
    <div class="metric">
      <div class="label">p95 TTFT</div>
      <div class="value">{fmtMs(overview.totals.p95_ttft_ms)}</div>
    </div>
  </div>

  <section class="block">
    <div class="block-head">
      <h2 class="section-heading">Usage</h2>
      <div class="head-controls">
        <div class="tabs" role="tablist" aria-label="Metric">
          <button class="tab" class:on={metric === "requests"} onclick={() => (metric = "requests")}>Requests</button>
          <button class="tab" class:on={metric === "tokens"} onclick={() => (metric = "tokens")}>Tokens</button>
          <button class="tab" class:on={metric === "spend_usd"} onclick={() => (metric = "spend_usd")}>Spend</button>
        </div>
        <div class="tabs" role="tablist" aria-label="Window">
          <button class="tab" class:on={daysWindow === 7} onclick={() => changeWindow(7)}>7d</button>
          <button class="tab" class:on={daysWindow === 30} onclick={() => changeWindow(30)}>30d</button>
          <button class="tab" class:on={daysWindow === 90} onclick={() => changeWindow(90)}>90d</button>
        </div>
      </div>
    </div>
    <UsageChart series={overview.series} {metric} days={daysWindow} />
  </section>

  <section class="block">
    <h2 class="section-heading">Recent requests</h2>
    {#if overview.recent.length === 0}
      <div class="empty">
        <p>No requests yet.</p>
        <p class="meta">Send your first request to see latency and usage here.</p>
      </div>
    {:else}
      <div class="table-scroll"><table class="table">
        <thead>
          <tr>
            <th>Time</th><th>Model</th><th>Type</th><th>Status</th>
            <th class="r">Latency</th><th class="r">Tokens</th><th class="r">Cost</th>
          </tr>
        </thead>
        <tbody>
          {#each overview.recent as r (r.id)}
            <tr class="clickable" onclick={() => openRequest(r.id)}>
              <td class="mono">{r.created_at.slice(11, 19)}</td>
              <td>{r.slug}</td>
              <td>{r.model_kind}</td>
              <td>
                <span class="status" class:status-ok={r.http_status === 200} class:status-bad={r.http_status !== 200}>
                  {r.http_status ?? "—"}
                </span>
              </td>
              <td class="r">{fmtMs(r.latency_ms)}</td>
              <td class="r">{r.tokens ? fmtInt(r.tokens) : "—"}</td>
              <td class="r">{fmtUsd(r.cost_usd)}</td>
            </tr>
          {/each}
        </tbody>
      </table></div>
    {/if}
  </section>
{/if}

{#if detail}
  <div class="drawer-backdrop" onclick={() => (detail = null)}></div>
  <aside class="drawer" role="dialog" aria-label="Request detail">
    <div class="drawer-head">
      <h2 class="section-heading">Request</h2>
      <button class="btn btn-quiet" onclick={() => (detail = null)}>Close</button>
    </div>
    <p class="mono" style="margin:8px 0 20px">{detail.id}</p>
    <dl class="kv">
      <dt>Status</dt><dd>{detail.http_status ?? detail.status}</dd>
      <dt>Model</dt><dd>{detail.slug}</dd>
      <dt>Type</dt><dd>{detail.model_kind}</dd>
      <dt>Stream</dt><dd>{detail.stream ? "Yes" : "No"}</dd>
      <dt>Headers</dt><dd>{fmtMs(detail.headers_ms)}</dd>
      <dt>First token</dt><dd>{fmtMs(detail.ttft_ms)}</dd>
      <dt>Completed</dt><dd>{fmtMs(detail.latency_ms)}</dd>
      <dt>Input</dt><dd>{fmtInt(detail.prompt_tokens)}</dd>
      <dt>Output</dt><dd>{fmtInt(detail.completion_tokens)}</dd>
      <dt>Cost</dt><dd>{fmtUsd(detail.cost_usd)}</dd>
      <dt>Attempts</dt><dd>{detail.attempts ?? "—"}</dd>
      <dt>Cache</dt><dd>{detail.cache_state ?? "—"}</dd>
    </dl>
  </aside>
{/if}

<style>
  .block {
    margin-top: 28px;
  }

  .block-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    flex-wrap: wrap;
    gap: 8px;
  }

  .head-controls {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
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



  .drawer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .kv {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 8px 16px;
    font-size: 13px;
    line-height: 19px;
    margin: 0;
  }

  .kv dt {
    color: var(--text-muted);
  }

  .kv dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
</style>
