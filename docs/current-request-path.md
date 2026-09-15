# AI Gateway request path

Reader: gateway maintainer. Post-read action: keep this public behavior
stable across deploys.

## Production path

1. Client calls the gateway:
   - `POST /v1/chat/completions`
   - `GET /v1/models`
   - Admin UI and management APIs remain separate.
2. Server authenticates the gateway API key, checks model access, budget, expiry, and rate limit.
3. Server loads enabled model routes for the public slug in rank order.
4. For each route, server selects upstream format:
   - OpenAI-compatible: upstream `/chat/completions`
   - Anthropic: upstream `/messages`, translated to OpenAI-compatible output
5. Transport selection:
   - Provider without `proxy_url`: direct server-to-provider HTTPS fetch.
   - Provider with `proxy_url`: server sends the provider request through an OCI-hosted HTTP relay using `?url=<encoded-target>`.
   - Provider with transport `koyeb`: server sends the request through the Koyeb WebSocket tunnel.
6. Server tries routes in rank order until one returns a usable response.
7. Non-streaming responses are parsed for usage, priced, sanitized, cached when eligible, and returned with gateway headers.
8. Streaming responses are normalized to OpenAI-style SSE, priced, and returned to the client.
9. Provider credentials remain in the gateway database or process env; the relay only receives the already-authorized provider request.
10. No request or response bodies are stored. Usage counters and budgets live on the API key rows.

## Important preserved behavior

- Public URLs, auth scheme, model slugs, SSE shape, response schema, and gateway accounting must remain unchanged.
- OCI stays available as rollback until Koyeb parity is proven.
