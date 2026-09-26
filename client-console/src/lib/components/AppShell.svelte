<script lang="ts">
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TopBar from "$lib/components/TopBar.svelte";
  import { session, signOutLocal, loadSession } from "$lib/state/session.svelte";

  let { children } = $props();
  loadSession();
  $effect(() => {
    if (session.state === "signed-out")
      location.assign("/console/signin");
  });

  async function signOut() {
    await fetch("/console/logout", { method: "POST", credentials: "same-origin" });
    signOutLocal();
    location.assign("/console/signin");
  }
</script>

<div class="shell">
  <Sidebar keyName={session.state === "signed-in" ? session.keyName : ""} onSignOut={signOut} />
  <div class="main">
    <TopBar />
    <main class="content">
      {@render children()}
    </main>
  </div>
</div>

<style>
  .shell {
    display: flex;
    min-height: 100dvh;
    background: var(--canvas);
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
</style>
