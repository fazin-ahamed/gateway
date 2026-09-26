<script lang="ts">
  import "../lib/styles/tokens.css";
  import "../lib/styles/reset.css";
  import "../lib/styles/typography.css";

  import AppShell from "$lib/components/AppShell.svelte";
  import { page } from "$app/state";
  import { session } from "$lib/state/session.svelte";

  let { children } = $props();

  const isSignIn = $derived(page.url.pathname === "/console/signin");
</script>

{#if isSignIn}
  {@render children()}
{:else}
  <AppShell>
    {@render children()}
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
