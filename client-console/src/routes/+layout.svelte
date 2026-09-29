<script lang="ts">
  import "../lib/styles/tokens.css";
  import "../lib/styles/reset.css";
  import "../lib/styles/typography.css";

  import AppShell from "$lib/components/AppShell.svelte";
  import { page } from "$app/state";
  import { session } from "$lib/state/session.svelte";

  let { children } = $props();

  const isSignIn = $derived(page.url.pathname === "/console/signin" || page.url.pathname === "/console/redeem");
</script>

{#if isSignIn}
  {@render children()}
{:else}
  <AppShell>
    {@render children()}
  </AppShell>
{/if}

