# Koyeb relay migration runbook

Reader: gateway owner. Post-read action: deploy the relay to Koyeb and
switch production traffic from OCI to Koyeb, with rollback available.

## Before vs after

- Before: client → Worker → OCI HTTP relay (`proxy_url + ?url=<target>`,
  no relay auth) → provider; or direct Worker → provider.
- After: client → Worker → direct fetch (providers that work from
  Cloudflare) or Koyeb WebSocket tunnel (providers needing separate
  egress) → provider. OCI stays configured as rollback until parity is
  proven, then its `proxy_url` values are removed.

## Files changed / added

- `relay/go.mod`, `relay/cmd/relay/main.go`: stdlib-only Go service.
- `relay/internal/relay/`: `server.go` (session handler), `ws.go`
  (minimal RFC 6455 server), `protocol.go` (message shapes + header
  allowlists), `auth.go` (HMAC + nonce replay cache), `allowlist.go`
  (provider table, URL validation, SSRF dial guard), `log.go`
  (sanitized logs).
- `relay/internal/relay/relay_test.go`, `stream_test.go`: 26 tests
  incl. a 105-second stream, cancellation both directions, 20-way
  concurrency, binary exactness, and auth/allowlist unit tables.
- `relay/Dockerfile` (multi-stage, distroless nonroot),
  `relay/.dockerignore`, `relay/README.md`.
- `ai-gateway/src/index.js`: `routeTransport` / `koyebCfg` /
  `koyebExchange` / `fetchViaKoyeb`, transport-aware dispatch, failure
  labels (`via-koyeb`), transport-aware `/admin/proxy-health`, provider
  `transport` CRUD, UI transport controls, `/status` await fix.
- `ai-gateway/wrangler.jsonc`: `RELAY_BACKEND=koyeb`, `KOYEB_RELAY_URL`
  (empty until the relay hostname exists).
- Production D1: `ALTER TABLE providers ADD COLUMN transport
  TEXT NOT NULL DEFAULT 'auto'` (already applied; all rows `auto`).
- `docs/current-request-path.md`, `docs/koyeb-migration.md` (this file).

## Security design

- Tunnel auth: HMAC-SHA256 over
  `v1 + timestamp + nonce + requestId + provider + method + path +
  query + body-sha256`, 5-minute window, bounded nonce cache,
  constant-time compare, WSS only.
- No open proxy: the relay never accepts URLs; provider IDs resolve to
  exact scheme + host + path prefixes. Traversal, wrong methods,
  credential-bearing queries, redirects off-origin, and private /
  link-local / metadata IPs are rejected (dial-time DNS guard).
- Keys stay in the gateway; the relay holds only `KOYEB_RELAY_SECRET`
  and forwards provider credentials solely to the allowlisted upstream.
- Logs contain IDs, latencies, byte counts, and error classes only.

## Protocol (one WebSocket per AI request)

`open` → body chunks (binary) → `request_end` →
`accepted` → `response` (status + filtered headers) → binary upstream
chunks → `response_end`; failures → `error` (never after `response`
starts). Ping frames every 15s keep long silences alive and never reach
the client. Closing the socket cancels the upstream request.

## Routing

Per provider `transport`: `auto` (direct unless `proxy_url` is set, then
`RELAY_BACKEND`), `direct`, `koyeb`, `oci`. Missing relay URL/secret
falls back to OCI (or direct), so deploys are safe before the relay
exists. Retries happen only for the initial socket connect; never after
`request_end` is sent, so generations are never duplicated.

## Koyeb deployment

1. Build/push the image from `relay/` (or connect the repo to Koyeb).
2. Web Service, Frankfurt, Free instance, port mapped to `$PORT`.
3. Set `KOYEB_RELAY_SECRET` (long random value).
4. Note `https://<app>.koyeb.app`.

## Worker config

```sh
wrangler secret put KOYEB_RELAY_SECRET   # same value as the relay
```

Then set `KOYEB_RELAY_URL=wss://<app>.koyeb.app/tunnel` in
`wrangler.jsonc` vars and redeploy. `RELAY_BACKEND=koyeb` is already set.

## Test results

- `go test ./... -short`: all pass (health, auth valid/invalid/
  expired/replay, malformed, unknown provider, 5 open-proxy attempts,
  private-target block, oversize body, SSE exactness, 3s slow first
  token, 4xx/5xx passthrough incl. 429 + Retry-After, provider abrupt
  close, 500×100B chunked writes, 1MB body, 1MB binary SHA match,
  20 concurrent streams with exactly 20 upstream hits, no-upstream-
  before-request_end, auth/URL/IP unit tables).
- `TestLongStreamOver100Seconds`: PASS, 105.08s, status 200, 105/105
  chunks intact through the tunnel.
- Throughput benchmark (loopback, i5-12400F): 323.89 MB/s per stream;
  relay overhead is noise next to model token rates.
- Worker `wrangler deploy --dry-run`: clean; production v63 live with
  `/` 200, `/health` 200, `/v1/models` 401 without key.
- No Docker daemon on this machine, so the image build is unverified
  here; the Dockerfile uses only standard multi-stage + distroless
  constructs. No Koyeb account here, so relay deployment and the live
  end-to-end Koyeb call are yours (steps above).

## Remaining limitations

- Adding a provider with a new upstream host needs a relay allowlist
  entry (code or `RELAY_PROVIDERS_JSON`) — deliberate, anti-open-proxy.
- Non-streamed Koyeb responses buffer up to 16MB in the Worker (same as
  current behavior); streams are constant-memory.
- Koyeb Free sleeps after ~1h idle: first call pays a cold start; the
  Worker retries the socket connect with backoff before anything is
  sent, then surfaces a clear error.

## Rollback

- Instant: set a provider's transport to `oci` (or `RELAY_BACKEND=oci`
  globally); traffic returns to the existing `proxy_url` path, which is
  untouched. `direct` removes the relay hop entirely.
- Code rollback: `wrangler rollback` / redeploy the previous version
  (v62 or earlier); the `transport` column is ignored by old code.

## Switch production OCI → Koyeb

1. Deploy the relay; confirm `https://<app>.koyeb.app/healthz`.
2. `wrangler secret put KOYEB_RELAY_SECRET` (same value).
3. Set `KOYEB_RELAY_URL` in `wrangler.jsonc`, redeploy.
4. In `/_gw` Providers tab, confirm transport pills read `koyeb`;
   proxy-health shows `koyeb ok`.
5. Send one non-stream + one stream chat per relayed provider; check
   traces carry `[via-koyeb]` only on failures and usage/cost account.
6. After a stable soak, clear each `proxy_url` (OCI references) and,
   finally, remove the OCI branch when no row references it.
