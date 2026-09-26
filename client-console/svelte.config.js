import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// The client console is a fully static SPA served by the existing gateway at
// /console. No SvelteKit server runtime, no SSR, no Node process in
// production — the kit exists only for file-based routing, layouts and
// code splitting.
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: "index.html" }),
    paths: { base: "/console" }
  }
};

export default config;
