<script lang="ts">
  import ThemeToggle from "$lib/components/ThemeToggle.svelte";
</script>

<header class="topbar">
  <div class="spacer"></div>
  <ThemeToggle />
</header>

<style>
  .topbar {
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 32px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    position: sticky;
    top: 0;
    z-index: 30;
  }

  .spacer {
    flex: 1;
  }
</style>
