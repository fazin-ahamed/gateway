<script lang="ts">
  import { session } from "$lib/state/session.svelte";
  import Starfield from "$lib/components/Starfield.svelte";

  let token = $state("");
  let username = $state("");
  let password = $state("");
  let confirm = $state("");
  let purpose = $state<"reset" | "invite" | null>(null);
  let knownUsername = $state("");
  let busy = $state(false);
  let checked = $state(false);
  let error = $state<string | null>(null);

  async function probe(t: string) {
    busy = true;
    error = null;
    try {
      const res = await fetch(`/console/redeem-api?token=${encodeURIComponent(t)}`, {
        credentials: "same-origin"
      });
      const body = await res.json().catch(() => null);
      checked = true;
      if (body?.valid) {
        purpose = body.purpose;
        knownUsername = body.username || "";
        username = body.username || "";
        return;
      }
      purpose = null;
    } catch {
      error = "Could not reach the gateway.";
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    const params = new URLSearchParams(location.search);
    const t = params.get("token") ?? "";
    token = t;
    if (t) probe(t);
  });

  async function submit(event: SubmitEvent) {
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
      const res = await fetch("/console/redeem-api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token, username: username.trim(), password })
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        const me = await fetch("/console/api/me", { credentials: "same-origin" });
        if (me.ok) {
          const info = await me.json();
          session.set({ state: "signed-in", keyName: info.key?.name ?? "API key" });
          location.assign("/console/");
          return;
        }
        error = "Password saved, but the session did not stick.";
        return;
      }
      error = body?.error?.message ?? "This link could not be used.";
    } catch {
      error = "Could not reach the gateway.";
    } finally {
      busy = false;
    }
  }

  const heading = $derived(purpose === "reset" ? "Reset your password" : "Create your account");
  const sub = $derived(
    purpose === "reset"
      ? "Pick a new password for your account. You stay signed in after this."
      : "Pick a username and password for your account. You create your own API keys after signing in."
  );
</script>

<Starfield />
<main class="wrap">
  <div class="panel">
    <div class="brand">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2.5 21 12l-9 9.5L3 12Z" fill="none" stroke="currentColor" stroke-width="1.2" />
        <circle cx="12" cy="12" r="3.2" fill="currentColor" />
      </svg>
      <h1>Astrosphere</h1>
    </div>

    {#if busy && !checked}
      <p class="panel-sub">Checking this link…</p>
    {:else if !purpose}
      <p class="panel-sub">This link is not valid or has expired. Ask for a new one.</p>
      <button class="switch" type="button" onclick={() => location.assign("/console/signin")}>Back to sign in</button>
    {:else}
      <p class="panel-sub">{sub}</p>
      <form onsubmit={submit} class="form">
        <label for="user">Username</label>
        <input
          id="user"
          class="input"
          autocomplete="username"
          bind:value={username}
          disabled={busy}
          placeholder="observatory"
        />
        <label for="pass">{purpose === "reset" ? "New password" : "Password"}</label>
        <input id="pass" class="input" type="password" autocomplete="new-password" bind:value={password} disabled={busy} placeholder="at least 8 characters" />
        <label for="confirm">Confirm password</label>
        <input id="confirm" class="input" type="password" autocomplete="new-password" bind:value={confirm} disabled={busy} />
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <button class="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Working…" : purpose === "reset" ? "Reset password" : "Create account"}
        </button>
      </form>
      {#if knownUsername}
        <button class="switch" type="button" onclick={() => location.assign("/console/signin")}>Sign in instead</button>
      {/if}
    {/if}
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

  .panel-sub {
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
</style>
