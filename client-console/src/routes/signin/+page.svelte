<script lang="ts">
  import { session } from "$lib/state/session.svelte";
  import Starfield from "$lib/components/Starfield.svelte";

  let view = $state<"login" | "key">("login");
  let apiKey = $state("");
  let username = $state("");
  let password = $state("");
  let confirm = $state("");
  let showCreate = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function login(event: SubmitEvent) {
    event.preventDefault();
    if (!username.trim() || !password) {
      error = "Enter your username and password.";
      return;
    }
    busy = true;
    error = null;
    try {
      const res = await fetch("/console/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username: username.trim(), password })
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        await loadAndGo();
        return;
      }
      error = body?.error?.message ?? "That username or password was not accepted.";
    } catch {
      error = "Could not reach the gateway.";
    } finally {
      busy = false;
    }
  }

  async function submitKey(event: SubmitEvent) {
    event.preventDefault();
    if (!apiKey.trim()) {
      error = "Enter your API key.";
      return;
    }
    busy = true;
    error = null;
    try {
      const res = await fetch("/console/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ api_key: apiKey.trim() })
      });
      const body = await res.json().catch(() => null);
      if (body?.setup) {
        showCreate = true;
        error = null;
        return;
      }
      if (body?.account) {
        view = "login";
        username = body.username || "";
        error = "This key already has an account. Sign in with your username and password.";
        return;
      }
      if (res.ok && body?.ok) {
        await loadAndGo();
        return;
      }
      error = body?.error?.message ?? "That key was not accepted.";
    } catch {
      error = "Could not reach the gateway.";
    } finally {
      busy = false;
    }
  }

  async function createAccount(event: SubmitEvent) {
    event.preventDefault();
    if (username.trim().length < 3) {
      error = "Username must be at least 3 characters.";
      return;
    }
    if (password.length < 8) {
      error = "Password must be at least 8 characters.";
      return;
    }
    if (password !== confirm) {
      error = "The passwords do not match.";
      return;
    }
    busy = true;
    error = null;
    try {
      const res = await fetch("/console/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ api_key: apiKey.trim(), username: username.trim(), password })
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        await loadAndGo();
        return;
      }
      error = body?.error?.message ?? "That account could not be created.";
    } catch {
      error = "Could not reach the gateway.";
    } finally {
      busy = false;
    }
  }

  function toKey() {
    view = "key";
    error = null;
  }

  function toLogin() {
    view = "login";
    error = null;
  }

  async function loadAndGo() {
    const me = await fetch("/console/api/me", { credentials: "same-origin" });
    if (me.ok) {
      const info = await me.json();
      session.set({ state: "signed-in", keyName: info.key?.name ?? "API key" });
      location.assign("/console/");
    } else {
      error = "Signed in, but the session did not stick.";
    }
  }
</script>

<Starfield />
<main class="wrap">
  <div class="panel">
    <div class="brand">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
        <ellipse cx="12" cy="12" rx="10" ry="4.2" fill="none" stroke="currentColor" stroke-width="1.3" />
        <ellipse cx="12" cy="12" rx="10" ry="4.2" fill="none" stroke="currentColor" stroke-width="1.3" transform="rotate(60 12 12)" />
      </svg>
      <h1>Astrosphere</h1>
    </div>

    {#if view === "login"}
      <p class="panel-sub">Sign in with your username and password.</p>
      <form onsubmit={login} class="form">
        <label for="user">Username</label>
        <input id="user" class="input" autocomplete="username" bind:value={username} disabled={busy} />
        <label for="pass">Password</label>
        <input id="pass" class="input" type="password" autocomplete="current-password" bind:value={password} disabled={busy} />
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <button class="btn btn-primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <button class="switch" type="button" onclick={toKey}>First time here? Set up with your API key</button>
    {:else}
      <p class="panel-sub">Enter your gateway API key to set up this account. The key is exchanged for a session and never stored in the browser.</p>
      <form onsubmit={submitKey} class="form">
        <label for="key">API key</label>
        <input id="key" class="input" type="password" autocomplete="off" placeholder="sk-…" bind:value={apiKey} disabled={busy} />
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <button class="btn btn-primary" type="submit" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
      </form>
      <button class="switch" type="button" onclick={toLogin}>Already have an account? Sign in</button>
    {/if}
  </div>
</main>

{#if showCreate}
  <div class="scrim"></div>
  <div class="modal-wrap" role="dialog" aria-modal="true" aria-labelledby="acct-title">
    <div class="modal">
      <p class="kicker">{apiKey.slice(0, 7)}…</p>
      <h2 id="acct-title">Create your account</h2>
      <p class="modal-sub">This key is new here. Pick a username and password. Next time, sign in with those, no key needed.</p>
      <form onsubmit={createAccount} class="form">
        <label for="new-user">Username</label>
        <input id="new-user" class="input" autocomplete="username" bind:value={username} disabled={busy} placeholder="observatory" />
        <label for="new-pass">Password</label>
        <input id="new-pass" class="input" type="password" autocomplete="new-password" bind:value={password} disabled={busy} placeholder="at least 8 characters" />
        <label for="new-confirm">Confirm password</label>
        <input id="new-confirm" class="input" type="password" autocomplete="new-password" bind:value={confirm} disabled={busy} />
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <div class="actions">
          <button class="btn btn-quiet" type="button" onclick={() => (showCreate = false)} disabled={busy}>Back</button>
          <button class="btn btn-primary" type="submit" disabled={busy}>{busy ? "Working…" : "Create account"}</button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .wrap {
    position: relative;
    z-index: 1;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    background: transparent;
  }

  .panel {
    width: min(380px, calc(100vw - 48px));
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    background: color-mix(in srgb, var(--surface) 86%, transparent);
    backdrop-filter: blur(8px);
    box-shadow: var(--shadow-pop);
    padding: 32px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .brand .mark {
    width: 30px;
    height: 30px;
    color: var(--accent);
  }

  .brand h1 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 28px;
    line-height: 32px;
    font-weight: 500;
    letter-spacing: -0.02em;
  }

  .panel-sub,
  .modal-sub {
    margin-top: 8px;
    margin-bottom: 20px;
    font-size: 13px;
    line-height: 19px;
    color: var(--text-muted);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .form label {
    font-size: 13px;
    font-weight: 500;
  }

  .form .input {
    height: 36px;
  }

  .error {
    font-size: 12px;
    line-height: 17px;
    color: var(--danger);
    margin: 0;
  }

  .switch {
    margin-top: 16px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }

  .switch:hover {
    color: var(--accent);
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(4, 6, 14, 0.6);
    backdrop-filter: blur(3px);
    animation: fade 160ms ease-out;
  }

  .modal-wrap {
    position: fixed;
    inset: 0;
    z-index: 51;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .modal {
    width: min(400px, 100%);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-panel);
    background: var(--surface);
    box-shadow: var(--shadow-pop);
    padding: 28px;
    animation: rise 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }

  .kicker {
    margin: 0 0 4px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--accent);
  }

  .modal h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 500;
    letter-spacing: -0.02em;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 6px;
  }

  @keyframes fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes rise {
    from { opacity: 0; transform: translateY(10px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .scrim, .modal { animation: none; }
  }
</style>
