// HORIZON Cloudflare Worker entrypoint (built into .edge-build/ by
// scripts/build-edge.mjs — never imported from Node tests; the Node runtime
// entrypoint remains server/server.mjs + src/index.js).
//
// The build rewrites src/index.js's zai imports to runtime/zai-stubs.js and
// copies server/tool-loop-guard.mjs to runtime/ (it is pure JS: no Node APIs,
// it only re-exports the schema-aware repair core in tool-repair.js). The
// exported app is the SAME Hono app — same routes, same routing logic — with
// the consumer-web bridge compiled out and legacy zai routes stripped.
import { createApp } from "../index.js";

export default {
  fetch(request, env, ctx) {
    const bound = createApp(env);
    return bound.fetch(request, env, ctx);
  },
};
