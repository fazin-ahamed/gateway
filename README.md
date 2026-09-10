# FSquare AI Gateway

Cloudflare Worker AI gateway with direct egress, a Koyeb WebSocket relay, and an OCI rollback path.

## Layout

- `ai-gateway/` — Worker source, Wrangler configuration, admin UI, routing, accounting, and tracing
- `relay/` — small Go relay for providers that need non-Cloudflare egress
- `docs/` — request-path and migration runbooks

## Local checks

```sh
cd relay && go test ./... -short
cd ../ai-gateway && npx wrangler deploy --dry-run
```

Provider keys and relay credentials belong in Cloudflare/Koyeb secrets, never in this repository.
