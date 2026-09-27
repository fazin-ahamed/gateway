<script lang="ts">
  type Choice = "system" | "light" | "dark";
  const KEY = "console-theme";

  function initial(): Choice {
    const saved = localStorage.getItem(KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  }

  let choice = $state<Choice>(initial());

  $effect(() => {
    localStorage.setItem(KEY, choice);
    const dark = choice === "dark" || (choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  });

  function cycle() {
    choice = choice === "system" ? "light" : choice === "light" ? "dark" : "system";
  }

  const nextLabel = $derived(
    choice === "system" ? "Switch to light theme" : choice === "light" ? "Switch to dark theme" : "Use system theme"
  );
  const title = $derived(choice === "system" ? "Theme: system" : choice === "light" ? "Theme: light" : "Theme: dark");
</script>

<button class="theme" type="button" onclick={cycle} title={title} aria-label={nextLabel}>
  {#if choice === "light"}
    <svg viewBox="0 0 24 24" aria-hidden="true" class="icon sun">
      <circle cx="12" cy="12" r="4.2" />
      <g class="rays">
        <line x1="12" y1="2" x2="12" y2="4.4" />
        <line x1="12" y1="19.6" x2="12" y2="22" />
        <line x1="2" y1="12" x2="4.4" y2="12" />
        <line x1="19.6" y1="12" x2="22" y2="12" />
        <line x1="4.9" y1="4.9" x2="6.6" y2="6.6" />
        <line x1="17.4" y1="17.4" x2="19.1" y2="19.1" />
        <line x1="4.9" y1="19.1" x2="6.6" y2="17.4" />
        <line x1="17.4" y1="6.6" x2="19.1" y2="4.9" />
      </g>
    </svg>
  {:else if choice === "dark"}
    <svg viewBox="0 0 24 24" aria-hidden="true" class="icon moon">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />
    </svg>
  {:else}
    <svg viewBox="0 0 24 24" aria-hidden="true" class="icon auto">
      <rect x="3" y="4.5" width="18" height="12" rx="1.6" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="16.5" x2="12" y2="20" />
    </svg>
  {/if}
</button>

<style>
  .theme {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--t-fast), background var(--t-fast), border-color var(--t-fast);
  }

  .theme:hover {
    color: var(--text);
    background: var(--surface-subtle);
  }

  .theme:focus-visible {
    outline: none;
    border-color: var(--accent);
    color: var(--text);
  }

  .icon {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    animation: pop var(--t-select);
  }

  .sun circle { fill: currentColor; stroke: none; }

  @keyframes pop {
    from { opacity: 0; transform: rotate(-35deg) scale(0.7); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .theme, .icon { transition: none; animation: none; }
  }
</style>
