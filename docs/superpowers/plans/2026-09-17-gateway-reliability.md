# Gateway Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden gateway routing, error isolation, health state, caching, HORIZON, storage/privacy, security, and Z.AI streaming while preserving current provider compatibility.

**Architecture:** Keep HORIZON as the planning layer and move reliability decisions into small reusable helpers. Generic routing uses route/key/transport-scoped health classification; provider-specific protocol quirks stay inside provider adapters. Public responses are rebuilt/sanitized through a gateway-owned error boundary.

**Tech Stack:** Node.js ESM, Hono, node:sqlite, Go relay, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-17-gateway-reliability-design.md`

## Global Constraints

- Never expose provider names, provider URLs, internal transport labels, raw provider error bodies, credential labels, or raw exception messages to API clients.
- GLM-Free-API is reference material only for the Z.AI adapter, not the gateway architecture.
- Do not break OpenAI-compatible JSON/SSE behavior.
- Preserve current model aliases and HORIZON fallback queues.
- Every behavior change gets a regression test first and is verified red -> green.

---

### Task 1: Reliability regression suite and runtime health helper

**Files:**
- Create: `ai-gateway/src/runtime-health.js`
- Create: `ai-gateway/test/runtime-health.test.mjs`
- Modify: `ai-gateway/src/index.js`

**Interfaces:**
- Produces `createRuntimeHealth()`, `failureImpact()`, `healthKey()`, and route/key cooldown APIs.

- [ ] Write tests proving expired windows reset counters, request/auth/model/rate-limit failures do not open a provider-wide circuit, route failures are isolated, and half-open recovery closes a route.
- [ ] Run the tests and confirm they fail before implementation.
- [ ] Implement the runtime-health helper and integrate it into route execution.
- [ ] Re-run tests and gateway test suite.

### Task 2: Credential ordering and failover

**Files:**
- Modify: `ai-gateway/src/index.js`
- Modify/Create: `ai-gateway/test/runtime-health.test.mjs`

- [ ] Add failing tests proving round-robin/random choose a first key while retaining the remaining enabled credentials as fallbacks.
- [ ] Implement ordered rotation/shuffle without dropping fallback keys.
- [ ] Verify auth failures move to the next credential without provider-wide health penalties.

### Task 3: Public error firewall

**Files:**
- Modify: `ai-gateway/src/index.js`
- Modify: `server/tool-loop-guard.mjs`
- Modify: `ai-gateway/test/error-redaction.test.mjs`
- Modify: `ai-gateway/test/tool-loop-finish.test.mjs`

- [ ] Add canary tests covering JSON, SSE, exception, provider-name, hostname, transport-name, and provider-specific-code leaks.
- [ ] Confirm failures on the old behavior.
- [ ] Replace raw/sanitized upstream error pass-through with gateway-owned error messages and codes.
- [ ] Remove raw exception concatenation from the outer SSE guard.
- [ ] Verify all canaries are absent from client bytes.

### Task 4: Cache and HORIZON correctness

**Files:**
- Modify: `ai-gateway/src/index.js`
- Modify: `ai-gateway/src/horizon.js`
- Create: `ai-gateway/test/cache-horizon.test.mjs`

- [ ] Add failing tests proving omitted temperature is not auto-cacheable and reflex actions carry candidate cost.
- [ ] Require explicit deterministic sampling for automatic cache eligibility.
- [ ] Add action cost propagation in HORIZON.
- [ ] Verify fallback queue behavior remains intact.

### Task 5: Storage, SQLite, request limits, and security headers

**Files:**
- Modify: `server/db.mjs`
- Modify: `server/server.mjs`
- Modify: `ai-gateway/src/index.js`
- Modify: `ai-gateway/schema.sql`
- Create: `server/db.test.mjs` or equivalent focused verification script

- [ ] Enable `PRAGMA foreign_keys=ON`, `busy_timeout`, and sensible WAL durability.
- [ ] Reduce the default request body ceiling from 512 MiB to a bounded chat API limit configurable by environment.
- [ ] Set `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and baseline CSP/Permissions-Policy.
- [ ] Make admin cookie `Secure` when the request is HTTPS / trusted proxy HTTPS.
- [ ] Default trajectory body capture off and update schema/docs accordingly.
- [ ] Verify startup and existing tests.

### Task 6: Adapter-aware health probe

**Files:**
- Modify: `ai-gateway/src/index.js`
- Create/Modify: gateway tests

- [ ] Add failing coverage for probe timeout and provider-format-aware probing.
- [ ] Use the configured transport/adapter path instead of unconditional direct `base_url + /models` Bearer fetch where possible.
- [ ] Bound probe latency with AbortSignal timeout.

### Task 7: Z.AI stream edit regression

**Files:**
- Modify: `ai-gateway/src/zaiweb.js`
- Create: `ai-gateway/test/zai-stream.test.mjs`

- [ ] Add a failing fixture for `edit_content` snapshot/rewind behavior and reasoning-to-answer transitions.
- [ ] Implement stateful stream normalization so replacement snapshots do not duplicate or reorder emitted text.
- [ ] Verify existing Z.AI session tests and new stream fixture.

### Task 8: Full verification and PR

- [ ] Run `cd ai-gateway && npm test`.
- [ ] Run `cd ai-gateway && npm run check`.
- [ ] Run `cd relay && go test ./...`.
- [ ] Inspect the final diff for provider/URL/error leaks and accidental behavior changes.
- [ ] Push branch and open a PR against `main` with verification results and remaining architectural follow-ups, if any.
