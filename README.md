# AI Gateway

OpenAI-compatible AI gateway on Cloudflare Workers (direct egress, Koyeb WebSocket relay, OCI rollback path) with an operator console, usage accounting, and tracing.

## Layout

- `ai-gateway/` — Worker source (`src/index.js`, `src/playground.js`, `src/login.js`, `src/uae-time.js`), Wrangler config, D1 schema, admin console UI
- `relay/` — small Go relay for providers that need non-Cloudflare egress
- `docs/` — request-path and migration runbooks

## Quickstart (fresh fork, no secrets needed to read/build)

```sh
cd relay && go test ./... -short -count=1
cd ../ai-gateway && npm install && npx wrangler deploy --dry-run
```

To run it for real you need your own Cloudflare account + D1 database:

1. `cp ../.env.example ../.env` (local only, never commit) and generate values.
2. Create a D1 database: `wrangler d1 create ai-gateway`, then put the id in `ai-gateway/wrangler.jsonc`.
3. Apply the schema: `wrangler d1 execute DB --file ai-gateway/schema.sql`.
4. Set secrets (never in git):
   - `wrangler secret put ADMIN_TOKEN` (admin console password)
   - `wrangler secret put PROVIDER_CRYPTO_KEY` (provider-key encryption)
   - `wrangler secret put KOYEB_RELAY_SECRET` (only if you deploy the relay)
5. `npx wrangler deploy` from `ai-gateway/`.

## Secrets model

| Secret                | Where            | Purpose                              |
| --------------------- | ---------------- | ------------------------------------ |
| `ADMIN_TOKEN`         | Worker secret    | Admin console password               |
| `PROVIDER_CRYPTO_KEY` | Worker secret    | AES-GCM envelope for provider keys   |
| `KOYEB_RELAY_SECRET`  | Worker + relay   | HMAC auth for the relay tunnel       |
| Provider API keys     | D1 (encrypted)   | Sealed `enc:v1:` envelopes in the DB |

Public `vars` in `wrangler.jsonc` contain only non-secret routing defaults
(`UPSTREAM_APP_TITLE`, `UPSTREAM_HTTP_REFERER`, `RELAY_BACKEND`,
`KOYEB_RELAY_URL`). Private provider hostnames live in your D1 rows or
`RELAY_PROVIDERS_JSON`, never in this repo.

## API

- `POST /v1/chat/completions` — OpenAI-compatible completions (auth: `Bearer sk-…`)
- `GET /v1/models` — enabled public slugs
- `GET /health`, `GET /status` (admin) — liveness and route inventory
- `/_gw` — operator console (Overview, Providers, Model routes, Tiers, Keys, Playground, Cache, Prices)

Model routing: each public slug maps to one primary route (rank 0) plus
automatic fallbacks (higher ranks, tried in order).
