<script lang="ts">
  import "../lib/styles/tokens.css";
  import "../lib/styles/reset.css";
  import "../lib/styles/typography.css";

  import AppShell from "$lib/components/AppShell.svelte";
  import { page } from "$app/state";
  import { session, loadSession } from "$lib/state/session.svelte";

  const isSignIn = $derived(page.url.pathname === "/console/signin");
  loadSession();
</script>

{#if isSignIn}
  <slot />
{:else if session.state === "loading"}
  <div class="boot">Loading…</div>
{:else if session.state === "signed-out"}
  <a href="/console/signin">Sign in with an API key</a>
{:else}
  <AppShell>
    <slot />
  </AppShell>
{/if}

<style>
  .boot, a {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    color: var(--text-muted);
    text-decoration: none;
    background: var(--canvas);
  }
</style>
