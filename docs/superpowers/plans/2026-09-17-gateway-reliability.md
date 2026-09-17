# Gateway Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make gateway failures isolate to the correct component, prevent internal provider details from reaching clients, and make routing/cache/stream behavior deterministic and testable.

**Architecture:** Keep HORIZON responsible for model planning while the request executor owns provider/key/transport reliability. Public error payloads are gateway-owned; upstream diagnostics remain internal. Z.AI remains an adapter-specific subsystem rather than the architecture for the whole gateway.

**Tech Stack:** Node.js 22, Hono, node:test, SQLite, Go relay, GitHub Actions.

**Spec:** User request and the 2026-09-17 gateway audit in this conversation.

## Global Constraints

- Never expose provider names, provider URLs, transport names, key labels, or raw upstream exception/error text to API clients.
- Do not let request/auth/quota/model-specific failures poison provider-wide health.
- GLM-Free-API is only a Z.AI behavioral reference.
- Preserve OpenAI-compatible response and SSE shapes.
- All behavioral fixes require regression tests and CI.

---

### Task 1: Reliability regression suite

**Files:**
- Create: `ai-gateway/test/reliability-regressions.test.mjs`
- Create: `.github/workflows/ci.yml`

- [x] Add failing tests for stale circuit windows, non-health failures, key failover, explicit deterministic cache admission, HORIZON cost propagation, and SSE secrecy.
- [x] Run CI and confirm failures reproduce the current bugs.

### Task 2: Circuit and key isolation

**Files:**
- Modify: `ai-gateway/src/index.js`

- [x] Reset failure count when the rolling circuit window expires.
- [x] Exclude auth, quota/rate-limit, model, tool-schema, request-size, and ordinary 4xx failures from provider-wide circuit health.
- [x] Make random and round-robin strategies return all keys in fallback order rather than one credential only.
- [x] Preserve same-key retry only for pre-header transport failures.

### Task 3: Public error firewall and streaming correctness

**Files:**
- Modify: `server/tool-loop-guard.mjs`
- Test: `ai-gateway/test/reliability-regressions.test.mjs`
- Test: `ai-gateway/test/tool-loop-finish.test.mjs`

- [x] Remove caught exception text from client-visible SSE errors.
- [x] Track structured stream errors so a partial tool call followed by failure is not converted into a successful `tool_calls` terminal event.
- [x] Keep gateway-owned generic error codes/messages only.

### Task 4: Cache and HORIZON correctness

**Files:**
- Modify: `ai-gateway/src/index.js`
- Modify: `ai-gateway/src/horizon.js`

- [x] Require explicit `temperature: 0` for normal deterministic response caching.
- [x] Version the cache key and preserve omitted temperature as `null` rather than rewriting it to zero.
- [x] Carry candidate cost into HORIZON actions so reflex cheapest-model selection operates on real values.
- [x] Preserve the existing HORIZON fallback slug queue execution path.

### Task 5: Runtime hardening

**Files:**
- Modify: `server/db.mjs`
- Modify: `server/server.mjs`
- Modify: `ai-gateway/src/index.js`
- Modify: `ai-gateway/src/zai-session.js`

- [x] Enable SQLite foreign keys, busy timeout, WAL-safe synchronous mode.
- [x] Reduce maximum request body from 512 MiB to 32 MiB.
- [x] Set real `nosniff` and `DENY` security header values.
- [x] Add a five-second timeout to generic provider model probes.
- [x] Invalidate a reused Z.AI session when its configured credential changes.

### Task 6: Verification and delivery

- [ ] Run Node syntax check and all Node tests.
- [ ] Run all Go relay tests.
- [ ] Remove the one-shot patch workflow/script used to safely transform the large legacy `index.js`.
- [ ] Re-run CI on the cleaned branch.
- [ ] Fast-forward `main` only after both CI jobs pass.
