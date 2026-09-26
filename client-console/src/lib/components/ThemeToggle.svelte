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

  const label = $derived(choice === "system" ? "Theme: system" : `Theme: ${choice}`);
</script>

<button class="btn btn-quiet" type="button" onclick={cycle} title={label}>{label}</button>
