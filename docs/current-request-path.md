# Current AI Gateway request path

Reader: gateway maintainer. Post-read action: implement the Koyeb relay without changing this public behavior.

## Current production path

1. Client calls the public Worker:
   - `POST /v1/chat/completions`
   - `GET /v1/models`
   - Admin UI and management APIs remain separate.
2. Worker authenticates the gateway API key, checks model access, budget, expiry, and rate limit.
3. Worker loads enabled model routes for the public slug in rank order.
4. For each route, Worker selects upstream format:
   - OpenAI-compatible: upstream `/chat/completions`
   - Anthropic: upstream `/messages`, translated to OpenAI-compatible output
5. Transport selection today:
   - Provider without `proxy_url`: direct Worker-to-provider HTTPS fetch.
   - Provider with `proxy_url`: Worker sends the provider request through an OCI-hosted HTTP relay using `?url=<encoded-target>`.
6. Worker tries routes in rank order until one returns a usable response.
7. Non-streaming responses are parsed for usage, priced, sanitized, cached when eligible, and returned with gateway headers.
8. Streaming responses are normalized to OpenAI-style SSE, priced, and returned to the client.
9. Provider credentials remain in the gateway database or Worker secrets; OCI only receives the already-authorized provider request.
10. No repository tests, relay source, Docker files, or package manifest are currently present; only the Worker bundle and Wrangler config are checked in.

## Important preserved behavior

- Public URLs, auth scheme, model slugs, SSE shape, response schema, and gateway accounting must remain unchanged.
- OCI is currently the only non-direct egress path and must remain available as rollback until Koyeb parity is proven.
