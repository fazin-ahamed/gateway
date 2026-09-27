<script lang="ts">
  import { session } from "$lib/state/session.svelte";
  import Starfield from "$lib/components/Starfield.svelte";

  let apiKey = $state("");
  let username = $state("");
  let password = $state("");
  let step = $state<"key" | "create" | "login">("key");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function signIn(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      const res = await fetch(step === "create" ? "/console/account" : "/console/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ api_key: apiKey.trim(), username, password })
      });
      const body = await res.json().catch(() => null);
      if (body?.setup) { step = "create"; return; }
      if (body?.account) { step = "login"; username = body.username || ""; return; }
      if (res.ok) { await loadAndGo(); return; }
      error = body?.error?.message ?? "That was not accepted.";
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

<Starfield />
<main class="wrap">
  <div class="panel">
    <h1 class="panel-title">Astrosphere</h1>
    <p class="panel-sub">
      {step === "create" ? "This key has no account yet. Choose a username and password." : step === "login" ? "Enter the username and password for this key." : "Your window into the gateway. Sign in with your API key."}
    </p>
    <form onsubmit={signIn} class="form">
      {#if step === "key"}
        <label for="key">API key</label>
        <input id="key" class="input" type="password" autocomplete="off" placeholder="sk-…" bind:value={apiKey} disabled={busy} />
      {:else}
        <label for="user">Username</label>
        <input id="user" class="input" autocomplete="username" bind:value={username} disabled={busy || step === "login"} />
        <label for="pass">Password</label>
        <input id="pass" class="input" type="password" autocomplete={step === "create" ? "new-password" : "current-password"} bind:value={password} disabled={busy} />
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <button class="btn btn-primary" type="submit" disabled={busy}>{busy ? "Working…" : step === "create" ? "Create account" : "Sign in"}</button>
    </form>
  </div>
</main>

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

  .panel-title {
    font-family: var(--font-display);
    font-size: 30px;
    line-height: 34px;
    font-weight: 500;
    letter-spacing: -0.02em;
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
