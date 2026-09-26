<script lang="ts">
  import { onMount } from "svelte";
  import { api, fmtInt, fmtUsd, type Settings } from "$lib/api";

  let settings = $state<Settings | null>(null);
  let failed = $state(false);
  let saving = $state(false);
  let note = $state("");

  async function load() {
    failed = false;
    try {
      settings = await api.settings();
    } catch {
      failed = true;
    }
  }

  onMount(load);

  async function toggle() {
    if (!settings || saving) return;
    saving = true;
    note = "";
    try {
      const next = await api.setCache(!settings.response_cache.enabled);
      settings = {
        response_cache: { ...settings.response_cache, enabled: next.response_cache.enabled }
      };
      note = next.response_cache.enabled ? "Caching is on." : "Caching is off. New requests go to the provider.";
    } catch {
      note = "The change did not save.";
    } finally {
      saving = false;
    }
  }
</script>

<h1 class="page-title">Settings</h1>
<p class="lede">Gateway behavior this key can change. Model access, budgets, and providers stay in the operator console.</p>

{#if failed}
  <div class="error-note"><span>Settings couldn't load.</span><button class="btn" onclick={load}>Retry</button></div>
{:else if !settings}
  <div class="skeleton-row"></div>
{:else}
  <section class="panel">
    <div class="row">
      <div>
        <h2>Response cache</h2>
        <p>Identical chat requests can be answered from a stored completion instead of calling the provider again. Tool calls are never cached. Turning this off applies to the whole gateway, not only this key.</p>
      </div>
      <button class="switch" type="button" role="switch" aria-checked={settings.response_cache.enabled} disabled={saving} onclick={toggle}>
        <span>{settings.response_cache.enabled ? "On" : "Off"}</span>
      </button>
    </div>
    {#if note}<p class="note">{note}</p>{/if}
    <dl>
      <dt>Stored completions</dt><dd>{fmtInt(settings.response_cache.entries)}</dd>
      <dt>Served from cache</dt><dd>{fmtInt(settings.response_cache.hits)}</dd>
      <dt>Provider spend avoided</dt><dd>{fmtUsd(settings.response_cache.saved_usd)}</dd>
      <dt>Tokens not rebilled</dt><dd>{fmtInt(settings.response_cache.saved_tokens)}</dd>
    </dl>
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
    padding: 20px;
    border: 1px solid var(--border);
    background: var(--surface);
  }

  .row {
    display: flex;
    gap: 24px;
    align-items: flex-start;
    justify-content: space-between;
  }

  h2 {
    margin: 0 0 6px;
    font-size: 16px;
  }

  p {
    margin: 0;
    max-width: 62ch;
    color: var(--text-muted);
    font-size: 14px;
  }

  .switch {
    flex-shrink: 0;
    min-width: 72px;
    height: 36px;
    border: 1px solid var(--border-strong);
    background: var(--surface-subtle);
    color: var(--text);
    font-weight: 600;
  }

  .switch[aria-checked="true"] {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .note {
    margin-top: 12px;
    color: var(--text);
  }

  dl {
    display: grid;
    grid-template-columns: 180px 1fr;
    gap: 8px 12px;
    margin: 20px 0 0;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    font-size: 13px;
  }

  dt { color: var(--text-muted); }
  dd { margin: 0; font-variant-numeric: tabular-nums; }

  @media (max-width: 639px) {
    .row { flex-direction: column; }
    dl { grid-template-columns: 1fr; }
  }
</style>
