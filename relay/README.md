# AI Gateway Koyeb Relay

Tiny egress relay for the AI gateway. It is **not** the gateway: it
authenticates one Worker request per WebSocket, resolves a hard provider
allowlist, forwards the upstream provider request, and streams response
bytes back unchanged.

## Endpoints

- `GET /healthz` → `{"ok":true}`
- `GET /tunnel` → WebSocket upgrade; one proxied AI request per connection

## Run locally

```sh
cd relay
KOYEB_RELAY_SECRET='<at least 16 chars>' PORT=8000 go run ./cmd/relay
```

`RELAY_ALLOW_PRIVATE=1` permits loopback upstreams for tests only.
Never set it in production.

## Environment

| Variable              | Required | Purpose                                            |
| --------------------- | -------- | -------------------------------------------------- |
| `KOYEB_RELAY_SECRET`  | yes      | HMAC secret shared with the gateway server       |
| `PORT`                | no       | listen port, default `8000` (Koyeb injects this)   |
| `LOG_LEVEL`           | no       | reserved, default empty                            |
| `RELAY_PROVIDERS_JSON`| no       | extra `[{id,scheme,host,path_prefixes}]`, https only |
| `RELAY_ALLOW_HTTP`    | no       | test escape hatch allowing `http` provider entries |
| `RELAY_ALLOW_PRIVATE` | no       | test escape hatch for loopback upstreams           |

## Wire protocol

Worker → relay text `open` (version, requestId, provider, method, path,
query, safe headers, body SHA-256, timestamp, nonce, HMAC-SHA256
signature), then binary body chunks, then text `request_end`.

Relay → worker text `accepted`, then text `response` (status + filtered
headers) once upstream headers arrive, then raw binary upstream chunks,
then text `response_end`. Failures arrive as text `error`
(code, message, retryable) and never touch the provider.

Keepalive uses WebSocket ping frames every 15s; they never reach the
client response. One 32KB buffer per stream; slow downstream applies
backpressure through write deadlines instead of memory growth.
Client close cancels the upstream request context.

## Security properties

- No arbitrary URLs: provider IDs resolve against a compiled allowlist
  (exact scheme + host + path prefixes); unknown providers, bad methods,
  path traversal, credential-bearing queries, and non-allowlisted
  redirects are rejected.
- SSRF guard: upstream dialing resolves DNS and refuses loopback,
  private, link-local, multicast, and metadata IPs.
- Auth: HMAC-SHA256 over timestamp + nonce + request + body hash,
  5-minute window, bounded nonce replay cache, constant-time compare.
- Logs carry request ID, provider, transport, status, latencies, byte
  counts, and disconnect reason only. No headers, keys, prompts, or
  response bodies are ever logged.
- Provider API keys stay in the gateway and travel inside the
  authenticated tunnel; the relay holds only `KOYEB_RELAY_SECRET`.

## Tests

```sh
cd relay
go test ./... -short -count=1   # fast suite (skips the >100s stream)
go test ./internal/relay/ -run TestLongStreamOver100Seconds -count=1 -v
```

## Deploy to Koyeb

1. Push this directory to a container registry (or connect the repo).
2. Create a **Web Service**, region **Frankfurt (FRA)**, instance **Free**.
3. Expose the service port mapped to `$PORT`.
4. Set `KOYEB_RELAY_SECRET` to a long random value (same value goes into
   the gateway `.env`).
5. Note the `https://<app>.koyeb.app` hostname; the gateway uses
   `wss://<app>.koyeb.app/tunnel`.
