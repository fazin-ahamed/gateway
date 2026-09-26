<script lang="ts">
  import { page } from "$app/state";
</script>

<main>
  <p class="mark" aria-hidden="true"></p>
  <h1>{page.status}</h1>
  <p>That page is not part of Astrosphere.</p>
  <a class="btn btn-primary" href="/console/">Back to activity</a>
</main>

<style>
  main {
    min-height: 70dvh;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 12px;
    text-align: center;
  }

  .mark {
    width: 72px;
    height: 72px;
    border: 2px solid var(--border-strong);
    border-radius: 50%;
    border-top-color: var(--accent);
    animation: turn 1.4s linear infinite;
  }

  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 64px;
    line-height: 1;
  }

  @keyframes turn { to { transform: rotate(360deg); } }
</style>
