# HORIZON Cloudflare Workers Free Migration — Milestones 0–2 Status

Repository HEAD audited: `2a741ca` (in sync with `origin/main`).
Baseline suite at that HEAD: **511 tests, 511 pass, 0 fail**.
Scope of this document: Milestone 0 (audit + compatibility matrix), Milestone 1 (Worker-native entrypoint, Z.AI bridge excluded from the bundle), Milestone 2 (D1 migrations + Worker-runtime baseline). Later milestones (chat streaming port, console static hosting, admission control, benchmarks, staging cutover) are out of scope here.

## Milestone 0 — Audit and compatibility matrix

### Confirmed Node-only dependencies (blockers if `src/index.js` were bundled directly)

The existing `wrangler.jsonc` points `main` at `src/index.js`. That file imports the Z.AI consumer-web bridge at top level (`src/index.js:5-9`), which transitively imports Node-only modules:

| Module | Node imports | Triggered when |
| --- | --- | --- |
| `src/zai-session.js:1-3` | `node:fs`, `node:path`, `node:crypto` (file-backed session store) | import of `zaiweb.js` |
| `src/zai-tokens.js:8-9` | `node:fs`, `node:path` (device-token FIFO) | import of `index.js` (`peekDeviceTokens`/`appendDeviceTokens`) |
| `src/zai-vision.js:13-16` | `node:dns/promises`, `node:net`, `node:http(s)` | import of `zaiweb.js` |
| `src/zaibrowser.js:1-3` | `node:crypto`, `node:child_process`, `node:fs` (spawns a browser) | import of `zaiweb.js` |
| `src/zai-captcha.js:24-26` | `node:crypto`, `node:zlib` | import of `zaiweb.js` |
| `src/skills/load.js:1-3` | `node:fs`, `node:path`, `node:url` | not imported by `index.js` (skills system is agent-side) |
| `server/tool-loop-guard.mjs:1` | none of its own; re-exports `src/tool-repair.js` | imported by `index.js:16` — pure, Worker-safe |

Direct Node usage inside `src/index.js` itself: only `process.env.ZAI_UTLS_PROXY`/`ZAI_HTTP_ADDR` (lines 7554-7555, egress-test endpoint) and an in-memory ring `logBuffer` for admin logs. All crypto in `index.js` is already WebCrypto (`crypto.subtle`, `crypto.getRandomValues`, `crypto.randomUUID` — lines 74, 295-309, 501-516, 2821-2869). No `node:sqlite` import in `src/` outside `server/`.

### Z.AI bridge call sites inside `index.js` (what must be gated at runtime)

34 references in four clusters:

- Lines 2292-2558: provider-format dispatch (`isZaiWebFormat`/`isZaiBrowserFormat`/`isZaiMintedFormat` checks, `callZaiWeb`/`callZaiBrowser`/`callZaiMinted` invocation, error mapping incl. `ZaiWebError`).
- Lines 4221-4403: Z.AI stream normalization paths (`zaiWaf`, session pool, frame normalizer).
- Line 6362-6363, 6599: admin provider test/integrity endpoints referencing zai helpers.
- Lines 7915-8005: dedicated admin zai routes (`/admin/zai/diagnose`, `/admin/zai/status`, `/admin/zai/device-tokens/*`).
- Line 7478: a `modelCatalogEntry` (zai static catalog) reference in model discovery.

Plus the shared modules the bridge owns that the *clean* path also uses: `src/router/model-registry.js` (`seedWireToCanonical`), `src/router/agent-telemetry.js`, `src/tool-repair.js` (via `zai-agent.js`). These are Worker-safe and stay.

### Module-level mutable state (Worker semantics)

| State | Location | Worker impact |
| --- | --- | --- |
| `registrySeededDbs` WeakSet + `registrySeedInflight` WeakMap | `src/index.js:27-28` | Safe: per-DB-handle memo of a boot seed. On Workers the handle is per-isolate; the seed becomes per-isolate-at-most-once. Must move to a controlled deploy step (M2) so ordinary requests don't write. |
| `accountTokensMigrated` WeakSet | `src/index.js:948` | Same class: lazy migration must move to D1 migrations. |
| `logBuffer` ring (1000 entries) | `src/index.js:69-71` | In-memory admin log; acceptable as best-effort per-isolate surface, documented as non-durable. |
| Circuit breaker `circuitState` Map | per memory notes, in `src/index.js` | In-process only; already documented as reset-on-restart. Non-durable per-isolate behavior on Workers is a known, acceptable degradation (breaker trips per isolate), flagged for the admission-control milestone to revisit. |
| Response cache, session pool, device-token FIFO, captcha cache | zai bridge / `zai-tokens.js`, `zai-conversation-cache.js` | Excluded from the Worker entirely. |

### Endpoint inventory (route-level Cloudflare compatibility)

Auth mechanisms: `authClient` (API key, 86 admin routes use `requireAdmin`), console cookie sessions, public. SQL is all `c.env.DB.prepare(...)` D1-shaped already. Node-specific handlers: `/admin/egress/test` (uTLS/zai proxy env), `/admin/zai/*`, `/admin/proxies/*` (koyeb/oci relay management — references `process.env` at 7554), provider `test`/`integrity` endpoints when the provider fmt is a zai format.

| Route group | Lines | D1-compatible | Node-only | Cloudflare decision |
| --- | --- | --- | --- | --- |
| `GET /`, `/health`, `/v1/models` | 649-654 | yes | no | Port as-is |
| `POST /v1/chat/completions` | 800 | yes | zai dispatch cluster (gated) | Port; zai fmts rejected |
| `POST /v1/systemone` + decision | 2048-2055 | yes | no | Port as-is |
| Console auth/account/redeem | 860-1154 | yes | `ensureAccountTokensTable` lazy migration | Port; migration moves to D1 step |
| Console API (keys/overview/usage/…) | 1167-1809 | yes | no | Port as-is |
| Admin keys/accounts/tiers/routes/prices/limits | 5474-6807, 8122-8421 | yes | no | Port as-is |
| Admin providers CRUD + test/credits/integrity | 5971-6707 | yes | test/integrity probe zai helpers | Port; zai-format providers rejected with sanitized error |
| Admin trajectories/export/router | 6903-7386 | yes | no | Port (read-only heavy; pagination already bounded) |
| Admin proxies/egress | 7590-7760 | — | koyeb/oci relay + uTLS env | Exclude from Worker (not supported on CF) |
| Admin zai/* | 7886-8005 | — | entire bridge | Exclude from Worker |
| `/_gw` admin UI | 8423-8448 | yes | no | Port as-is |
| Static console serving | server.mjs only | — | Node fs static server | M6: Workers Static Assets |

### Client console

`client-console` is SvelteKit + `adapter-static` with SPA fallback `index.html` (svelte.config.js:1,11). Build output `client-console/build` already exists. Serving it is M6; nothing in `src/index.js` references it (Node serves it from `server/server.mjs`), so the Worker needs an explicit assets binding — good isolation.

### Data migration reality check (measured against the real previous-server archive)

The operator provided the previous server's archive (`Previous Server Gateway.tar.gz`, 4.3 GB). Its `server/data/gateway.db` is **9.6 GB**, but the size is one table: `trajectories` holds 25,766 rows averaging 360 KB of request JSON (9.1 GB of the total). Every other table is small - the operationally required set is 478 rows across 20 tables (~97 KB of SQL).

Per the brief, bulk history does not auto-migrate. `scripts/d1-import.mjs --operational` imports only the serving truth: providers, provider keys, routes, aliases, canonical models, API keys, tiers, limits, usage counters, console accounts/tokens/sessions, gateway settings, prices, admin sessions, response-cache locks, probe runs. Telemetry (route_attempts, quality_observations, router_stats, reflex_posteriors, agent_loop_events, latency_shadow_decisions, proxy_test_runs) and bulk history (trajectories, request_summaries) stay on the Node host.

Measured import result against a fresh migrated D1: 478 statements, 0 FK failures (tables are written parents-first), and a real workerd boot verified two production API keys authenticating (200, 13 models listed), the consumer-web bridge route (`z-ai/glm-5.3-flash`, fmt zaiminted) correctly absent from advertising, and unknown keys rejected 401.

Secret handling: `api_keys.key_id` IS the live credential (auth is a direct key_id lookup), and the same value appears in `console_accounts`, `console_account_tiers`, `console_account_tokens`, `api_key_model_tiers`. The default dump redacts every `sk-` value (0 live keys in a default dump); `--include-key-ids` is the cutover-only opt-in. Provider keys are AES-GCM sealed (`enc:v1:` ciphertext) and copy verbatim only with `--include-sealed`; they decrypt only when the Worker secret `PROVIDER_CRYPTO_KEY` equals the Node host's key from its `.env`. The generated dump lives outside git in `.prev-server-data/` (0600).

## Milestone 1 — Worker-native boot

Not done by stubbing routes: `ai-gateway/src/runtime/edge.js` is a real entrypoint that builds the same Hono `app` from `src/index.js` and exports `fetch`. The Z.AI bridge is excluded at three layers:

1. **Build**: `ai-gateway/scripts/build-edge.mjs` copies `src/` to `.edge-build/`, rewrites `index.js`'s five zai imports (lines 5-9) into `./runtime/zai-stubs.js`, plus `../../server/tool-loop-guard.mjs` → `./runtime/tool-loop-guard.mjs` (a pure copy, since the original imports nothing Node itself), and strips the `/admin/zai/*`, `/admin/proxies/*`, `/admin/egress/test` route blocks (delimited markers injected by the same script). Wrangler `main` points at `.edge-build/index.js`; the original `src/` is untouched.
2. **Runtime gate**: `isZaiWebFormat`/`isZaiBrowserFormat`/`isZaiMintedFormat` resolve to `false` in the stub, so provider dispatch falls through to the ordinary OpenAI-compatible path; any provider row still carrying a zai `fmt` is rejected with a sanitized, provider-neutral error before any dial.
3. **Static scan check**: `scripts/verify-edge-bundle.mjs` greps the emitted bundle for `zai-session`, `zai-tokens`, `zai-vision`, `zaibrowser`, `zai-captcha`, `node:fs`, `node:child_process` and fails the build if any appear.

Evidence: `npm run build:edge` produces a bundle that passes the scan; `npm run verify:edge` boots that bundle under **workerd** via Miniflare (real Worker runtime, real D1) and asserts `/health`, `/v1/models` auth, `/admin/accounts` invite (201), zai-format provider rejection (sanitized 4xx, no provider identity), and legacy zai route 404.

## Milestone 2 — D1 baseline

- `ai-gateway/migrations/0001_initial.sql`: the full `schema.sql` (all 40 tables, FKs, indexes) as the initial D1 migration. `0002_seed_registry.sql`: idempotent canonical alias seeds (INSERT OR IGNORE), replacing per-request `ensureRegistrySeed` writes on the Worker. Lazy request-time migrations (`ensureAccountTokensTable`, `ensureRouteCapabilityColumns`) are bypassed on the edge entrypoint (schema is pre-migrated; the WeakSets simply never fill on D1 because `PRAGMA table_info` shows the columns already present — no writes, no failures).
- `wrangler.jsonc`: `main` → `ai-gateway/.edge-build/index.js`, D1 binding `DB`, compatibility date `2025-09-01`, observability sampling dropped from 100% → 1% (brief §15), vars preserved. `database_id` left as placeholder — deploy requires the operator's account.
- `scripts/d1-import.mjs`: dry-run Node→D1 importer. Reports per-table row counts, DB size, and zai-shaped providers/routes (marked unsupported, never dropped). Writes no secrets to disk: provider API keys stay sealed (AES-GCM, key from `PROVIDER_CRYPTO_KEY` env) and `--write` emits a sanitized SQL dump; plaintext key material is never printed.
- Edge tests (`ai-gateway/test/edge/*.test.mjs`) run under Miniflare/workerd against real D1: empty-DB bootstrap via migrations, key auth + revoked-key rejection, cross-account isolation, models endpoint, capability metadata (no `max_output_tokens: 0`), and a `rows_read` capture proving the hot auth query uses the index (single-digit rows read).

Not in scope for M0–M2 (per brief §20): streaming/tool port hardening on the edge (M4–5), console static assets (M6), admission control (M7), staging deploy (M8 — needs your Cloudflare credentials).
