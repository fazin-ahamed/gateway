<script lang="ts">
  import { session } from "$lib/state/session.svelte";

  let apiKey = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function signIn(event: SubmitEvent) {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key) {
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
        body: JSON.stringify({ api_key: key })
      });
      if (res.ok) {
        await loadAndGo();
      } else {
        const body = await res.json().catch(() => null);
        error = body?.error?.message ?? "That key was not accepted.";
      }
    } catch {
      error = "Could not reach the gateway.";
    } finally {
      busy = false;
    }
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

<main class="wrap">
  <div class="panel">
    <h1 class="panel-title">Astrosphere</h1>
    <p class="panel-sub">Sign in with your gateway API key. It is exchanged for a session cookie and never stored in the browser.</p>
    <form onsubmit={signIn} class="form">
      <label for="key">API key</label>
      <input
        id="key"
        class="input"
        type="password"
        autocomplete="off"
        placeholder="sk-…"
        bind:value={apiKey}
        disabled={busy}
      />
      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}
      <button class="btn btn-primary" type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  </div>
</main>

<style>
  .wrap {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    background: var(--canvas);
  }

  .panel {
    width: min(360px, calc(100vw - 48px));
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    background: var(--surface);
    padding: 28px;
  }

  .panel-title {
    font-size: 15px;
    line-height: 22px;
    font-weight: 600;
  }

  .panel-sub {
    margin-top: 4px;
    margin-bottom: 20px;
    font-size: 12px;
    line-height: 17px;
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
    height: 34px;
  }

  .error {
    font-size: 12px;
    line-height: 17px;
    color: var(--danger);
    margin: 0;
  }
</style>
