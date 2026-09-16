# AI Gateway

OpenAI-compatible AI gateway on Node + SQLite (direct egress, Koyeb WebSocket relay, OCI rollback path) with an operator console and usage accounting. No request or response bodies are ever stored.

## Layout

- `ai-gateway/` — app source (`src/index.js`, `src/playground.js`, `src/login.js`, `src/uae-time.js`), SQLite schema, admin console UI
- `server/` — Node entrypoint (`server.mjs`, `db.mjs`, `import.mjs`), the only deploy target
- `relay/` — small Go relay for providers that need non-Cloudflare egress
- `docs/` — request-path and hosting runbooks

## Quickstart

```sh
cd relay && go test ./... -short -count=1
cd ../server && npm install && node --check server.mjs
```

To run it:

1. `cp .env.example .env` (local only, never commit) and generate values.
2. `cd server && npm install && node --env-file=../.env server.mjs`
3. Open `http://<host>:3000/_gw` (on ecli: `http://<allocation-host>:30012/_gw`), sign in with `ADMIN_TOKEN`, add providers, routes, and API keys.

On ecli, leave `sh server/auto-update.sh` running so each push to `main` pulls and restarts (see `docs/ecli-hosting.md`).

First boot applies `ai-gateway/schema.sql` to `./data/gateway.db` automatically.

## Secrets model

| Secret                | Where            | Purpose                              |
| --------------------- | ---------------- | ------------------------------------ |
| `ADMIN_TOKEN`         | env              | Admin console password               |
| `PROVIDER_CRYPTO_KEY` | env              | AES-GCM envelope for provider keys   |
| `KOYEB_RELAY_SECRET`  | env (both sides) | HMAC auth for the relay tunnel       |
| Provider API keys     | SQLite (sealed)  | Sealed `enc:v1:` envelopes in the DB |

Public defaults live in `.env.example`
(`UPSTREAM_APP_TITLE`, `UPSTREAM_HTTP_REFERER`, `RELAY_BACKEND`,
`KOYEB_RELAY_URL`). Private provider hostnames live in your DB rows or
`RELAY_PROVIDERS_JSON`, never in this repo.

## API

- `POST /v1/chat/completions` — OpenAI-compatible completions (auth: `Bearer sk-…`)
- `GET /v1/models` — enabled public slugs
- `GET /health`, `GET /status` (admin) — liveness and route inventory
- `/_gw` — operator console (Overview, Providers, Model routes, Tiers, Keys, Playground, Cache, Prices)

Model routing: each public slug maps to one primary route (rank 0) plus
automatic fallbacks (higher ranks, tried in order).

## Provider state: enabled vs healthy

Two independent switches on every provider row:

| Flag      | Meaning                                | Effect                                                                                          |
| --------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `enabled` | Operator off-switch (default on)       | Provider is never routed, never probed by `/status`, and advertises no slugs.                    |
| `healthy` | Runtime state / manual "mark down"     | Provider is skipped for routing but stays listed and probed, so it can recover or be inspected.   |

Console: **disable** / **enable** is the off-switch (row shows a `DISABLED`
pill); **mark down** / **mark up** is the health toggle. API:
`POST /admin/providers/:id/disable`, `POST /admin/providers/:id/enable`, or
`PATCH /admin/providers/:id` with `{"enabled":false}`.

`GET /v1/models` lists only slugs that can actually be served right now — a
slug whose providers are all disabled or all down is withheld instead of being
advertised and then 503ing on use. Routing a withheld slug returns 503 with
`code: "provider_disabled"` when a disabled provider is the reason, so the
cause is visible in the error rather than only in the console.

Migration: `providers.enabled` is in `schema.sql` (fresh installs) and is added
by an idempotent `ALTER TABLE` on Node boot. On Cloudflare Workers/D1 the Node
runtime never runs, so apply it once by hand before deploying a Worker built
from this commit:

```sh
wrangler d1 execute DB --command "ALTER TABLE providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1"
```
