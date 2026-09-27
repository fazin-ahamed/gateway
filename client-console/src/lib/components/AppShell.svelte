<script lang="ts">
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TopBar from "$lib/components/TopBar.svelte";
  import Starfield from "$lib/components/Starfield.svelte";
  import { session, signOutLocal, loadSession } from "$lib/state/session.svelte";

  let { children } = $props();
  loadSession();
  $effect(() => {
    if (session.state.state === "signed-out")
      location.assign("/console/signin");
  });

  async function signOut() {
    await fetch("/console/logout", { method: "POST", credentials: "same-origin" });
    signOutLocal();
    location.assign("/console/signin");
  }
</script>

{#if session.state.state === "loading"}
  <Starfield />
  <div class="loading" role="status" aria-label="Loading Astrosphere">
    <span class="ring"></span>
    <strong>Astrosphere</strong>
  </div>
{:else}
  <Starfield />
  <div class="shell">
    <Sidebar keyName={session.state.state === "signed-in" ? session.state.keyName : ""} onSignOut={signOut} />
    <div class="main">
      <TopBar />
      <main class="content">{@render children()}</main>
    </div>
  </div>
{/if}

<style>
  .shell {
    position: relative;
    z-index: 1;
    display: flex;
    min-height: 100dvh;
    background: transparent;
  }

  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .content {
    flex: 1;
    padding: 24px 32px;
    min-width: 0;
  }

  @media (max-width: 899px) {
    .content {
      padding: 16px;
    }
  }
  .loading {
    position: relative;
    z-index: 1;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 16px;
    background: transparent;
  }

  .loading .ring {
    width: 64px;
    height: 64px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: turn 1.1s linear infinite;
  }

  .loading strong { font-family: var(--font-display); font-size: 24px; font-weight: 500; }
  @keyframes turn { to { transform: rotate(360deg); } }
</style>
