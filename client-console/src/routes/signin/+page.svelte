<script lang="ts">
  import { session } from "$lib/state/session.svelte";
  import Starfield from "$lib/components/Starfield.svelte";

  let apiKey = $state("");
  let username = $state("");
  let password = $state("");
  let confirm = $state("");
  let mode = $state<"key" | "create" | "login">("key");
  let busy = $state(false);
  let error = $state<string | null>(null);

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
        mode = "create";
        error = null;
        return;
      }
      if (body?.account) {
        mode = "login";
        username = body.username || "";
        error = null;
        return;
      }
      if (res.ok) {
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

  async function submitAccount(event: SubmitEvent) {
    event.preventDefault();
    if (mode === "create") {
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
    }
    busy = true;
    error = null;
    try {
      const res = await fetch(mode === "create" ? "/console/account" : "/console/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ api_key: apiKey.trim(), username: username.trim(), password })
      });
      const body = await res.json().catch(() => null);
      if (res.ok && !body?.setup && !body?.account) {
        await loadAndGo();
        return;
      }
      error = body?.error?.message ?? "That was not accepted.";
    } catch {
      error = "Could not reach the gateway.";
    } finally {
      busy = false;
    }
  }

  function backToKey() {
    mode = "key";
    error = null;
    password = "";
    confirm = "";
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
    <p class="panel-sub">Your window into the gateway. Sign in with your API key.</p>
    <form onsubmit={submitKey} class="form">
      <label for="key">API key</label>
      <input id="key" class="input" type="password" autocomplete="off" placeholder="sk-…" bind:value={apiKey} disabled={busy || mode !== "key"} />
      {#if mode === "key" && error}<p class="error" role="alert">{error}</p>{/if}
      <button class="btn btn-primary" type="submit" disabled={busy || mode !== "key"}>{busy && mode === "key" ? "Checking…" : "Continue"}</button>
    </form>
  </div>
</main>

{#if mode !== "key"}
  <div class="scrim"></div>
  <div class="modal-wrap" role="dialog" aria-modal="true" aria-labelledby="acct-title">
    <div class="modal">
      <p class="kicker">{apiKey.slice(0, 7)}…</p>
      <h2 id="acct-title">{mode === "create" ? "Create your account" : "Welcome back"}</h2>
      <p class="modal-sub">
        {mode === "create"
          ? "This key is new here. Pick a username and password to protect it. The key itself is never stored in the browser."
          : "This key already has an account. Enter its username and password."}
      </p>
      <form onsubmit={submitAccount} class="form">
        <label for="user">Username</label>
        <input id="user" class="input" autocomplete="username" bind:value={username} disabled={busy || mode === "login"} placeholder="observatory" />
        <label for="pass">Password</label>
        <input id="pass" class="input" type="password" autocomplete={mode === "create" ? "new-password" : "current-password"} bind:value={password} disabled={busy} placeholder={mode === "create" ? "at least 8 characters" : ""} />
        {#if mode === "create"}
          <label for="confirm">Confirm password</label>
          <input id="confirm" class="input" type="password" autocomplete="new-password" bind:value={confirm} disabled={busy} />
        {/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <div class="actions">
          <button class="btn btn-quiet" type="button" onclick={backToKey} disabled={busy}>Back</button>
          <button class="btn btn-primary" type="submit" disabled={busy}>{busy ? "Working…" : mode === "create" ? "Create account" : "Sign in"}</button>
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
