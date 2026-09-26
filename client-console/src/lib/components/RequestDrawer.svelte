<script lang="ts">
  import { fmtInt, fmtMs, fmtUsd, type RequestDetail } from "$lib/api";

  let { detail, onClose }: { detail: RequestDetail; onClose: () => void } = $props();

  const statusWord = $derived(
    detail.status === "ok" ? "Succeeded" : detail.status === "cancelled" ? "Cancelled" : detail.status === "fail" ? "Failed" : detail.status
  );
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") onClose();
  }}
/>

<button class="backdrop" type="button" aria-label="Close request" onclick={onClose}></button>
<div class="drawer" role="dialog" aria-modal="true" aria-labelledby="req-title">
  <header>
    <div>
      <p class="kicker">Request</p>
      <h2 id="req-title">{statusWord}</h2>
    </div>
    <button class="btn" type="button" onclick={onClose}>Close</button>
  </header>

  <p class="id">{detail.id}</p>

  <section>
    <h3>Route</h3>
    <dl>
      <dt>Model</dt><dd>{detail.slug || "—"}</dd>
      <dt>Kind</dt><dd>{detail.model_kind}</dd>
      <dt>HTTP</dt><dd>{detail.http_status ?? "—"}</dd>
      <dt>Stream</dt><dd>{detail.stream ? "Streamed" : "Complete"}</dd>
      <dt>Attempts</dt><dd>{detail.attempts}</dd>
      <dt>Cache</dt><dd>{detail.cache_state ?? "Not used"}</dd>
    </dl>
  </section>

  <section>
    <h3>Timing</h3>
    <dl>
      <dt>Started</dt><dd>{detail.created_at.slice(0, 19).replace("T", " ")} UTC</dd>
      <dt>Headers</dt><dd>{fmtMs(detail.headers_ms)}</dd>
      <dt>First token</dt><dd>{fmtMs(detail.ttft_ms)}</dd>
      <dt>Completed</dt><dd>{fmtMs(detail.latency_ms)}</dd>
    </dl>
  </section>

  <section>
    <h3>Usage</h3>
    <dl>
      <dt>Input</dt><dd>{fmtInt(detail.prompt_tokens)}</dd>
      <dt>Output</dt><dd>{fmtInt(detail.completion_tokens)}</dd>
      <dt>Cost</dt><dd>{fmtUsd(detail.cost_usd)}</dd>
    </dl>
  </section>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 39;
    border: 0;
    padding: 0;
    background: rgba(18, 14, 10, 0.46);
    cursor: pointer;
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(440px, 100%);
    z-index: 40;
    overflow-y: auto;
    background: var(--surface);
    border-left: 1px solid var(--border);
    padding: 24px;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .kicker {
    margin: 0;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }

  h2 {
    margin: 2px 0 0;
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 500;
    letter-spacing: -0.02em;
  }

  .id {
    margin: 16px 0 0;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    word-break: break-all;
  }

  section {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  h3 {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 600;
  }

  dl {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 8px 12px;
    margin: 0;
    font-size: 13px;
  }

  dt {
    color: var(--text-muted);
  }

  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
</style>
