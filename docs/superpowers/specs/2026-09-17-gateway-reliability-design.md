# Gateway Reliability Hardening Design

## Goal

Make the gateway fail over correctly under partial provider/key/route failures, prevent all provider identity and raw upstream error leakage to clients, and align model availability, caching, health checks, and HORIZON execution with actual runtime behavior.

## Scope

This pass treats GLM-Free-API only as a Z.AI implementation reference. The gateway's routing, health, privacy, cache, transport, and HORIZON layers remain independent gateway architecture.

## Design

### 1. Public error firewall

Client-visible errors are gateway-owned. Provider names, provider URLs, upstream bodies, credential labels, internal transport labels, raw exception text, and provider-specific diagnostic codes never cross the public boundary. Internal logs and admin trajectories keep diagnostic detail.

Public error classes are limited to stable gateway semantics such as invalid request, unsupported feature, model unavailable, service busy, timeout, and stream interrupted. Successful JSON/SSE payloads are sanitized before emission. SSE wrapper failures must never concatenate exception text.

### 2. Hierarchical runtime health

Replace the provider-name circuit breaker with route-aware health state. Failures are classified before affecting health:

- request/tool/context/schema errors: no health penalty
- auth/credential errors: key-scoped cooldown only
- model-not-found/model-specific failures: route-scoped cooldown
- 429/quota: route/key cooldown using Retry-After when available
- transport/network failures: route+transport failure signal
- repeated 5xx: route failure signal; provider-wide degradation only after correlated failures across independent routes

Health uses rolling windows and CLOSED/OPEN/HALF_OPEN semantics. Expired failure windows reset their counters. A single healthy route/key must not be skipped because another route/key failed.

### 3. Key ordering and failover

Round-robin and random strategies determine the first key but retain remaining enabled keys as fallbacks. Auth/key-specific failures move to another credential without poisoning the provider.

### 4. Runtime availability consistency

`/v1/models`, HORIZON candidate selection, direct model execution, and admin status should share the same definition of route availability. DB enabled/healthy flags remain operator controls; runtime health/cooldowns are execution state.

### 5. Cache correctness

Response cache is only automatically used for explicitly deterministic requests. Missing `temperature` is not treated as `0`. Cache fingerprints include all semantic request inputs and a route/model configuration generation/fingerprint so provider/model remaps cannot serve stale responses indefinitely.

### 6. HORIZON correctness

Preserve the existing fallback slug queue execution. Fix reflex cost selection so generated actions carry the candidate cost. Keep routing intelligence separate from transport/key retry mechanics.

### 7. Health probing

Provider status probes are adapter/transport aware and bounded by timeout. Do not assume every provider supports `base_url + /models` with Bearer auth.

### 8. Privacy/storage

Trajectory body capture defaults off. Request/response content capture is opt-in and clearly separate from response cache. Metadata-only trajectories remain available for health/routing analysis.

### 9. Node/SQLite/security hardening

Enable SQLite foreign keys and busy timeout. Reduce the general JSON request-body ceiling. Set effective security header values, secure admin cookies when appropriate, and avoid trusting forwarded client IP headers unless explicitly configured for a trusted proxy deployment.

### 10. Z.AI boundary

Keep Z.AI-specific protocol behavior isolated in the Z.AI adapter. Improve stream edit/snapshot handling and regression fixtures independently of the generic gateway routing architecture.

## Verification

The change requires regression tests for circuit window reset, failure classification, key fallback ordering, public error secrecy in JSON and SSE, deterministic cache eligibility, HORIZON cost propagation, SQLite pragma behavior, and Z.AI stream edit handling. Run Node tests/checks and Go relay tests before merge.
