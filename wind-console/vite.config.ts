import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cpSync } from "node:fs";

// The React console is a static SPA the gateway serves at /console: Vite
// builds into wind-console/dist, and a plugin copies it over
// client-console/build (the directory server/server.mjs and the Workers
// assets already serve), so production deploys need no other change.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "copy-to-gateway-console",
      closeBundle() {
        cpSync("dist", "../client-console/build", { recursive: true, force: true });
      }
    }
  ],
  base: "/console/",
  build: { outDir: "dist", emptyOutDir: true }
});
