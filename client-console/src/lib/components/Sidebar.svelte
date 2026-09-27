<script lang="ts">
  import { page } from "$app/state";
  import { ui } from "$lib/state/ui.svelte";
  let { keyName, onSignOut } = $props();
  const here = $derived(page.url.pathname.replace(/\/$/, "") || "/console");
  const current = (href: string) => (here === href.replace(/\/$/, "") ? "page" : undefined);
  const initial = $derived((keyName || "?").trim().charAt(0).toUpperCase() || "?");
</script>

<nav class="sidebar" class:collapsed={ui.collapsed} aria-label="Console">
  <a class="brand" href="/console/">
    <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <ellipse cx="12" cy="12" rx="10" ry="4.2" fill="none" stroke="currentColor" stroke-width="1.3" />
      <ellipse cx="12" cy="12" rx="10" ry="4.2" fill="none" stroke="currentColor" stroke-width="1.3" transform="rotate(60 12 12)" />
    </svg>
    Astrosphere
  </a>
  <ul class="nav">
    <li><a href="/console/" aria-current={current("/console/")}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><circle cx="8" cy="2" r="1.3" fill="currentColor" stroke="none" /></svg>
      Activity
    </a></li>
    <li><a href="/console/requests/" aria-current={current("/console/requests/")}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" /></svg>
      Requests
    </a></li>
    <li><a href="/console/usage/" aria-current={current("/console/usage/")}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13V8M8 13V4M13 13V10" /></svg>
      Usage
    </a></li>
    <li><a href="/console/models/" aria-current={current("/console/models/")}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="4" r="1.4" fill="currentColor" stroke="none" /><circle cx="12.5" cy="6" r="1.4" fill="currentColor" stroke="none" /><circle cx="6" cy="12.5" r="1.4" fill="currentColor" stroke="none" /><path d="M4.6 4.8 11.4 6M11.9 7.3 6.7 11.4M4.6 5.1 5.6 11.2" /></svg>
      Models
    </a></li>
    <li><a href="/console/playground/" aria-current={current("/console/playground/")}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2 4 9h3l-1 5 6-8H9l1-4z" fill="currentColor" stroke="none" /></svg>
      Playground
    </a></li>
    <li><a href="/console/settings/" aria-current={current("/console/settings/")}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h8M2 8h12M2 12h5" /><circle cx="12" cy="4" r="1.6" fill="var(--surface)" /><circle cx="8.5" cy="12" r="1.6" fill="var(--surface)" /></svg>
      Settings
    </a></li>
  </ul>
  <div class="foot">
    <div class="avatar" aria-hidden="true">{initial}</div>
    <div class="who"><span class="name">{keyName}</span></div>
    <button class="signout" type="button" onclick={onSignOut} title="Sign out" aria-label="Sign out">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2H3v12h3M10 11l3-3-3-3M13 8H6" /></svg>
    </button>
  </div>
</nav>

<style>
  .sidebar {
    width: var(--sidebar-width);
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 82%, transparent);
    backdrop-filter: blur(10px);
    display: flex;
    flex-direction: column;
    position: sticky;
    top: 0;
    height: 100dvh;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 20px 20px 18px;
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .brand-mark {
    width: 26px;
    height: 26px;
    color: var(--accent);
    flex-shrink: 0;
  }

  .nav {
    flex: 1;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 8px;
  }

  .nav a {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-radius: var(--radius-control);
    font-size: 13px;
    line-height: 18px;
    color: var(--text-muted);
    transition: background var(--t-fast), color var(--t-fast);
  }

  .nav svg {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .nav a:hover {
    color: var(--text);
    background: var(--surface-subtle);
  }

  .nav a[aria-current="page"] {
    color: var(--accent);
    background: var(--accent-soft);
    font-weight: 500;
  }

  .foot {
    border-top: 1px solid var(--border);
    padding: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .avatar {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
    font-size: 13px;
  }

  .who {
    flex: 1;
    min-width: 0;
  }

  .who .name {
    display: block;
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .signout {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    color: var(--text-muted);
    background: transparent;
    cursor: pointer;
    transition: color var(--t-fast), background var(--t-fast);
  }

  .signout:hover {
    color: var(--danger);
    background: var(--surface-subtle);
  }

  .signout svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Collapsed: icons only. */
  .sidebar.collapsed {
    width: 60px;
  }
  .sidebar.collapsed .brand { justify-content: center; font-size: 0; gap: 0; padding: 20px 0 18px; }
  .sidebar.collapsed .nav a { justify-content: center; font-size: 0; gap: 0; padding: 8px 0; }
  .sidebar.collapsed .nav svg { font-size: 16px; }
  .sidebar.collapsed .who, .sidebar.collapsed .signout { display: none; }
  .sidebar.collapsed .foot { justify-content: center; }

  /* Narrow screens: the sidebar becomes a drawer later; for now it hides
     so content keeps the full width. */
  @media (max-width: 899px) {
    .sidebar {
      display: none;
    }
  }
</style>
