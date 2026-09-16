# AI Gateway

OpenAI-compatible AI gateway on Node + SQLite (direct egress, Koyeb WebSocket relay, OCI rollback path) with an operator console and usage accounting. No request or response bodies are ever stored.

## Layout

- `ai-gateway/` — app source (`src/index.js`, `src/playground.js`, `src/login.js`, `src/uae-time.js`), SQLite schema, admin console UI, Worker entry + `wrangler.jsonc`
- `server/` — Node entrypoint (`server.mjs`, `db.mjs`, `import.mjs`), the Node deploy target (Workers deploy from `ai-gateway/`)
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

## Provider formats

`providers.fmt` accepts three values. The admin UI exposes all three.

| `fmt`       | Upstream                                   | Credential (sealed `provider_keys` row)                                                              |
| ----------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `openai`    | `{base_url}/chat/completions`              | API key, sent as `Authorization: Bearer …`                                                            |
| `anthropic` | `{base_url}/messages`                      | API key, sent as `x-api-key`                                                                          |
| `zaiweb`    | Z.ai consumer web chat (`https://chat.z.ai`) | JSON `{"token":"<chat.z.ai localStorage token>","captcha_verify_param":"<proof>"}` or a bare JWT token |

### Z.ai web chat — automatic (`zaiwebbrowser`)

The `zaiweb` format above needs a fresh CAPTCHA proof per completion, which no
one wants to paste by hand. `zaiwebbrowser` removes that step: the gateway
drives chat.z.ai in a local Chromium and lets the page mint its own proof.

- Requires the **Node host** (a Worker cannot run a browser) with Chromium:
  `npm install playwright && npx playwright install chromium`, or point
  `BROWSER_EXECUTABLE` at an existing Chromium binary.
- Credential is the session token only: `{"token":"<chat.z.ai localStorage token>"}`.
- Measured live: first turn ~8 s (includes cold Chromium launch), warm turns
  ~2.4 s, no captcha input at any point.
- One browser context is pooled per credential and reused, so consecutive
  requests stay warm; idle contexts are closed after 5 minutes.
- Same gates as `zaiweb`: no caller-supplied tools (`zai_tools_unsupported`),
  images only on `glm-5.3-flash`, model access still per account tier.
- Memory: a Chromium process runs alongside the gateway (roughly 300–500 MB).
  On a small VM set `SESSION_POOL_SIZE`/limits accordingly, or use an API-key
  provider where a browser is not needed at all.

### Experimental: programmatic captcha minting

`ai-gateway/src/zai-captcha.js` ports the published GLM-Free-API approach —
Aliyun `InitCaptchaV3`, the `generateArg`/`aliHash`/`encrypt` payload
construction, and `VerifyCaptchaV3` with a harvested device token. It is
**not wired into any provider**, because it does not yet yield a usable proof:

| Step | Result |
| --- | --- |
| Aliyun `InitCaptchaV3` | works (standard RPC signing; the reference's percent-everything encoder is rejected) |
| `generateArg`, tracking JSON, `aliHash` | byte-identical to the reference's Go output |
| `VerifyCaptchaV3` with page-harvested device tokens | `VerifyCode F001`, `VerifyResult false` |

The same tokens fail identically through the reference's own Go `tryCompute`,
so the blocker is device-token provenance, not the port. Until that is solved
the browser transport above is the automated route, and minting stays a
documented dead end rather than a half-working provider.

### Using an OpenAI-compatible bridge instead

If you would rather not run a browser, any OpenAI-compatible bridge for
chat.z.ai works as a plain `openai` provider — point `base_url` at it and use
the bridge's own token as the credential. A preset is not needed; the
**Custom / other provider** option in the console covers it. Such bridges mint
the CAPTCHA proof themselves, which is efficient, but it means a third-party
process (and whatever credentials it ships) sits in your request path, so run
one you build or trust locally rather than a public instance.

**Providers → Add provider** opens with a **Preset** picker. A preset fills the
name, base URL, format and transport, retargets the credential hint, and offers
the usual model routes; every field stays editable before saving, and choosing
*Custom / other provider* clears the form back to blank.

| Preset         | Result                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `zai-browser`  | `zaiwebbrowser` provider on `https://chat.z.ai` — automatic, no captcha; routes `z-ai/glm-5.3-flash` + `z-ai/glm-5.3` |
| `zai-web`      | `zaiweb` provider on `https://chat.z.ai`, direct transport; routes `z-ai/glm-5.3-flash` + `z-ai/glm-5.3` |
| `zai-api`      | Standard API-key provider on `https://api.z.ai/api/paas/v4`, routes `z-ai/glm-4.6` + `z-ai/glm-4.5` |

Route seeding never repoints a live slug: a preset only adds routes for slugs
that have no enabled route yet, and reports the rest as kept. API:
`GET /admin/provider-presets`, and
`POST /admin/providers {"preset":"zai-web","api_key":"…"}` (add
`seed_routes:false` for the provider alone, or `routes:[{slug,upstream_model}]`
to override the preset's list).

### Z.ai web chat (`zaiweb`)

The consumer site (chat.z.ai) is not an API: it authenticates with a session
JWT from the browser's Local Storage and requires a short-lived CAPTCHA proof
on each completion. This provider speaks that protocol from the server.

Model routes to create (slug → `upstream_model`):

| Public slug (suggested) | `upstream_model` | Thinking | Vision | Tools | Tier note                     |
| ----------------------- | ---------------- | -------- | ------ | ----- | ----------------------------- |
| `z-ai/glm-5.3-flash`    | `glm-5.3-flash`  | yes      | yes    | no    | reachable on guest sessions   |
| `z-ai/glm-5.3`          | `glm-5.3`        | yes      | no     | no    | signed-in accounts only       |
| `z-ai/glm-5.2`          | `glm-5.2`        | yes      | no     | no    | signed-in accounts only       |

Getting the credential:

1. Sign in at chat.z.ai in a browser.
2. Open DevTools → Application → Local Storage → `https://chat.z.ai` → copy
   the `token` value (a JWT).
3. Send one message, then in DevTools → Network find the `POST` to
   `/api/v2/chat/completions`, and copy `captcha_verify_param` out of its
   request body.
4. In the console: **Providers → Add provider**, leave the preset on *Z.AI web
   chat*, paste both values as JSON into **Credential**, and save. The preset
   fills the name, base URL, `zaiweb` format, direct transport, and the two
   model routes. Verify with the **test** button afterwards
   (`POST /admin/providers/:id/test`).

Behavior and limits:

- Model access is per account tier, not per gateway. A signed-out/guest
  `chat.z.ai` session may only reach `glm-5.3-flash` (`x-preview-l`); asking
  for `glm-5.3`/`glm-5.2` on such an account returns
  "Model not available for current user level" surfaced as a typed 502
  (`zai_stream_error`). Add routes only for models your account actually
  serves — the preset ships `z-ai/glm-5.3-flash` as primary for that reason.
- The session JWT carries no expiry, but the **captcha proof is issued per
  completion and single-use**: the first completion consumes it and later ones
  fail with `Captcha verification failed` (typed 502 `zai_stream_error`).
  There is no way to store a working proof, because it changes every time. So
  the provider key only needs the `token`, and each caller passes a fresh proof
  per request:

  ```sh
  curl -sS http://<host>:3000/v1/chat/completions \
    -H "Authorization: Bearer sk-…" -H "Content-Type: application/json" \
    -H "x-zai-captcha: <fresh captcha_verify_param>" \
    -d '{"model":"z-ai/glm-5.3-flash","messages":[{"role":"user","content":"hi"}]}'
  ```

  Precedence is header → request body → stored credential, so a stored value
  still works exactly once for a smoke test. Missing proof returns a typed 503
  (`zai_captcha`) naming the header. Treat this provider as a bursty,
  captcha-gated route; an API-key provider has no such limitation.
- Thinking is always on (the consumer models expose no non-thinking mode).
  `reasoning_effort` (`low`/`medium`/`high`/`max`) is forwarded; `glm-5.2`
  has no `low`, so it clamps to `high`. Reasoning arrives as
  `reasoning_content` deltas.
- Caller-supplied `tools` are refused with a 400 (`zai_tools_unsupported`).
  These models cannot call tools; silently dropping them would break agents.
- Images are accepted only on `glm-5.3-flash`; anything else returns 400
  (`zai_vision_unsupported`). Image parts are forwarded as `[image: <url>]`
  markers — uploading attachments is not implemented.
- `transport` must be `auto` or `direct`; the signed session cannot survive a
  relay hop, so `koyeb`/`oci` are rejected with a 400 (`zai_transport`).
- Captcha proofs are short-lived. When one expires the route fails with a
  typed 503 (`zai_captcha`) naming the fix, and never trips the provider
  circuit breaker.
- chat.z.ai rotates the session cookie on each chat creation; the gateway
  re-seals and stores the rotated token (keeping the other credential fields),
  so a long-lived route survives rotation.
- Usage is estimated (chat.z.ai reports none): ~4 chars/token on input, ~3
  chars/token on output, plus a per-image allowance.
