<script lang="ts">
  import { page } from "$app/state";
  let { keyName, onSignOut } = $props();
  const here = $derived(page.url.pathname.replace(/\/$/, "") || "/console");
  const current = (href: string) => (here === href.replace(/\/$/, "") ? "page" : undefined);
</script>

<nav class="sidebar" aria-label="Console">
  <a class="brand" href="/console/">Astrosphere</a>
  <ul class="nav">
    <li><a href="/console/" aria-current={current("/console/")}>Activity</a></li>
    <li><a href="/console/requests/" aria-current={current("/console/requests/")}>Requests</a></li>
    <li><a href="/console/usage/" aria-current={current("/console/usage/")}>Usage</a></li>
    <li><a href="/console/models/" aria-current={current("/console/models/")}>Models</a></li>
    <li><a href="/console/playground/" aria-current={current("/console/playground/")}>Playground</a></li>
    <li><a href="/console/settings/" aria-current={current("/console/settings/")}>Settings</a></li>
  </ul>
  <div class="foot">
    <div class="who">
      <span class="meta">{keyName}</span>
    </div>
    <button class="btn btn-quiet" type="button" onclick={onSignOut}>Sign out</button>
  </div>
</nav>

<style>
  .sidebar {
    width: var(--sidebar-width);
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    position: sticky;
    top: 0;
    height: 100dvh;
  }
  .brand {
    padding: 20px 20px 18px;
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .nav {
    flex: 1;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 8px;
  }

  .nav a {
    display: block;
    padding: 6px 12px;
    border-radius: var(--radius-control);
    font-size: 13px;
    line-height: 18px;
    color: var(--text-muted);
    transition: background var(--t-fast), color var(--t-fast);
  }

  .nav a:hover {
    color: var(--text);
    background: var(--surface-subtle);
  }

  .nav a[aria-current="page"] {
    color: var(--text);
    background: var(--accent-soft);
    font-weight: 500;
  }

  .foot {
    border-top: 1px solid var(--border);
    padding: 12px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .who {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Narrow screens: the sidebar becomes a drawer later; for now it hides
     so content keeps the full width. */
  @media (max-width: 899px) {
    .sidebar {
      display: none;
    }
  }
</style>
