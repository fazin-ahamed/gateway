<script lang="ts">
  import { onMount } from "svelte";
  import { api, fmtInt, fmtUsd, type AccountKey, type Account } from "$lib/api";

  let keys = $state<AccountKey[] | null>(null);
  let account = $state<Account | null>(null);
  let failed = $state(false);
  let newName = $state("");
  let minted = $state<string | null>(null);
  let busy = $state(false);
  let confirmDelete = $state<string | null>(null);

  async function load() {
    failed = false;
    keys = null;
    account = null;
    try {
      const body = await api.keys();
      keys = body.keys;
      account = body.account;
      if (keys.length === 0) minted = null;
    } catch {
      failed = true;
    }
  }

  onMount(load);

  async function create() {
    if (!newName.trim() || busy) return;
    busy = true;
    try {
      const made = await api.createKey(newName.trim());
      minted = made.key;
      newName = "";
      await load();
    } catch {
      minted = null;
    } finally {
      busy = false;
    }
  }

  async function toggle(key: AccountKey) {
    try {
      await api.setKeyActive(key.key_id, !key.active);
      await load();
    } catch {
      /* the row keeps its old state; the next load corrects it */
    }
  }

  async function remove(key: AccountKey) {
    confirmDelete = null;
    try {
      await api.deleteKey(key.key_id);
      await load();
    } catch {
      /* the row survives; the next load corrects it */
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard can be denied; the raw value stays selectable on screen */
    }
  }

  const spendLabel = $derived(
    account
      ? account.budget_mode === "usd"
        ? `${fmtUsd(account.used_usd)}${account.budget_limit != null ? ` / ${fmtUsd(account.budget_limit)}` : " (no cap)"}`
        : `${fmtInt(account.used_tokens)}${account.budget_limit != null ? ` / ${fmtInt(account.budget_limit)} tokens` : " tokens (no cap)"}`
      : ""
  );
</script>

<h1 class="page-title">Keys</h1>

{#if account}
  <p class="lede">
    Keys under <strong>{account.username}</strong>. Spend across all of them: {spendLabel}.
    {#if account.tiers.length}
      Model access: {account.tiers.map((t) => t.name).join(", ")}.
    {:else}
      Model access follows the gateway default.
    {/if}
  </p>
{:else}
  <p class="lede">This session is tied to a single API key, so there is nothing to manage here.</p>
{/if}

{#if failed}
  <div class="error-note"><span>Keys couldn't load.</span><button class="btn" onclick={load}>Retry</button></div>
{:else if account}
  <section class="panel">
    <h2>Create a key</h2>
    <form class="create" onsubmit={(e) => { e.preventDefault(); create(); }}>
      <input
        class="input"
        placeholder="laptop, ci-runner, prod-app"
        aria-label="Key name"
        bind:value={newName}
        disabled={busy}
      />
      <button class="btn btn-primary" type="submit" disabled={busy || !newName.trim()}>
        {busy ? "Creating…" : "Create key"}
      </button>
    </form>
    {#if minted}
      <div class="minted" role="status">
        <p>Copy this key now. It is not shown again.</p>
        <div class="key-row">
          <code class="key-value">{minted}</code>
          <button class="btn" type="button" onclick={() => copy(minted)}>Copy</button>
        </div>
      </div>
    {/if}
  </section>

  <section class="block">
    {#if !keys}
      <div class="skeleton-row"></div>
    {:else if keys.length === 0}
      <div class="empty">
        <p>No keys yet. Create the first one above.</p>
      </div>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>State</th>
              <th>Requests</th>
              <th>Spend</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each keys as key (key.key_id)}
              <tr class:off={!key.active}>
                <td>{key.name}</td>
                <td><code class="key-id">{key.key_id.slice(0, 8)}…</code></td>
                <td>
                  {#if key.active}
                    <span class="state on">active</span>
                  {:else}
                    <span class="state">off</span>
                  {/if}
                </td>
                <td>{fmtInt(key.request_count)}</td>
                <td>{key.request_count === 0 ? "—" : account?.budget_mode === "usd" ? fmtUsd(key.used_usd) : fmtInt(key.used_tokens)}</td>
                <td class="actions">
                  <button class="btn" type="button" onclick={() => toggle(key)}>
                    {key.active ? "Disable" : "Enable"}
                  </button>
                  {#if confirmDelete === key.key_id}
                    <button class="btn btn-danger" type="button" onclick={() => remove(key)}>Confirm delete</button>
                    <button class="btn" type="button" onclick={() => (confirmDelete = null)}>Keep</button>
                  {:else}
                    <button class="btn btn-quiet" type="button" onclick={() => (confirmDelete = key.key_id)}>Delete</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

<style>
  .lede {
    margin: 0 0 20px;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 19px;
  }

  .panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-panel, 10px);
    background: var(--surface);
    padding: 20px;
    margin-bottom: 24px;
  }

  .panel h2 {
    margin: 0 0 12px;
    font-size: 14px;
    font-weight: 600;
  }

  .create {
    display: flex;
    gap: 8px;
  }

  .create .input {
    flex: 1;
  }

  .minted {
    margin-top: 14px;
    border: 1px solid var(--accent, #4f8cff);
    border-radius: 8px;
    padding: 12px;
  }

  .minted p {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .key-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .key-value {
    flex: 1;
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    word-break: break-all;
    user-select: all;
  }

  .key-id {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
  }

  .state {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--border, #2a2f3a);
    color: var(--text-muted);
  }

  .state.on {
    background: rgba(72, 187, 120, 0.16);
    color: #48bb78;
  }

  tr.off td {
    opacity: 0.55;
  }

  .actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }

  .table-scroll {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: 10px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  th, td {
    text-align: left;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  th {
    color: var(--text-muted);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .skeleton-row {
    height: 52px;
    border-radius: 10px;
    background: linear-gradient(90deg, var(--border) 25%, var(--surface) 50%, var(--border) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.2s infinite;
  }

  @keyframes shimmer {
    from { background-position: 200% 0; }
    to { background-position: -200% 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton-row { animation: none; }
  }

  .empty {
    padding: 32px 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .error-note {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border: 1px solid var(--danger, #e5735f);
    border-radius: 10px;
    color: var(--danger, #e5735f);
    font-size: 13px;
  }
</style>
