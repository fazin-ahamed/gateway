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
   - Z.ai web chat (`zaiminted`, recommended): signed pure-HTTP calls to
     chat.z.ai, translated to OpenAI-compatible output. The `zaiweb` and
     `zaiwebbrowser` labels select the same engine but change how the CAPTCHA
     proof is acquired (caller-supplied proof, or a Chromium fallback for
     proof-infrastructure failures). All three are direct transport only.
5. Transport selection:
   - Provider without `proxy_url`: direct server-to-provider HTTPS fetch.
   - Provider with `proxy_url`: server sends the provider request through an
     HTTP relay using `?url=<encoded-target>` (the OCI path).
   - Provider with transport `koyeb`: server sends the request through the
     Koyeb WebSocket tunnel.
   - Z.ai routes are unaffected by both relay paths: they use the local uTLS
     helper (`ZAI_UTLS_PROXY`) when a Chrome ClientHello is required, and
     otherwise plain HTTPS.
6. Server tries routes in rank order until one returns a usable response.
   Provider-specific client errors (for example a Z.ai route missing a
   session credential) return their own status and `error.code` instead of
   being flattened into a generic 503, so operators can act on them.
7. Non-streaming responses are parsed for usage, priced, sanitized, cached when eligible, and returned with gateway headers.
8. Streaming responses are normalized to OpenAI-style SSE, priced, and returned to the client.
9. Provider credentials remain in the gateway database or process env; the relay only receives the already-authorized provider request.
10. No request or response bodies are stored. Usage counters and budgets live on the API key rows.

## Telemetry

- `route_attempts` is the authoritative per-attempt telemetry: one row per
  real upstream attempt, with `health_impact` marking the operational
  failures that train a route posterior. Credential, caller, capability and
  cancellation outcomes are recorded but excluded, so they never make a
  route look unreliable.
- `trajectories` is the legacy per-request record and still feeds live V1
  health; both are written from one terminal outcome so they cannot drift.
  `GET /admin/router/reconcile` reports the agreement between them, gated on
  health-impacting sample count per route.

## Important preserved behavior

- Public URLs, auth scheme, model slugs, SSE shape, response schema, and gateway accounting must remain unchanged.
- OCI stays available as rollback until Koyeb parity is proven.
- Auto-routing capability gates (context window, vision, tools) read the
  models.dev catalog, plus a local overlay for Z.ai routes whose models the
  catalog does not carry.
- Auto-router health folds in the latest `provider_probe_runs` verdict for a
  slug: `MULTI-MODEL RELAY`, `TOKENIZER MISMATCH`, and `STACK LEAK` scale
  `ok_rate` by 0.35 (below the eligibility floor). Integrity probes themselves
  are admin-only (`POST /admin/providers/:id/integrity`) and never sit on the
  client path. Playground **Verify this slug** hits that same endpoint.
