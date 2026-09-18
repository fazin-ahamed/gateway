# AI Gateway

OpenAI-compatible AI gateway on Node + SQLite (direct egress, Koyeb WebSocket relay, OCI rollback path) with an operator console and usage accounting. No request or response bodies are ever stored.

## Layout

- `ai-gateway/` — app source (`src/index.js`, `src/zai-session.js`, `src/zai-models.js`, `src/playground.js`, `src/login.js`, `src/uae-time.js`), SQLite schema, admin console UI
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

`model: "auto"` is HORIZON-Ω over **your enabled routes only**. Easy asks
are one reflex hop. Hard coding compiles TaskIR, injects a worker lens
(goal/facts/unknowns — not MVC/reroute), and reroutes to an uncorrelated
family on 5xx. Compaction fires only when input exceeds 82% of the model's
usable window (context minus output reserve), and keeps tool-call pairs.

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
by an idempotent `ALTER TABLE` on Node boot, so an existing `data/gateway.db`
picks it up on the next start with no manual step.

## Provider formats

The admin UI exposes normal API providers plus three Z.AI consumer transports.

| `fmt` | Upstream | Credential |
| --- | --- | --- |
| `openai` | `{base_url}/chat/completions` | API key via `Authorization: Bearer …` |
| `anthropic` | `{base_url}/messages` | API key via `x-api-key` |
| `zaiminted` | chat.z.ai pure HTTP — **recommended** | Z.AI session token; gateway mints a fresh CAPTCHA proof from the local device-token store |
| `zaiwebbrowser` | real chat.z.ai Chromium page — fallback/debug | Z.AI session token |
| `zaiweb` | chat.z.ai pure HTTP with caller-supplied proof | Z.AI session token + fresh `captcha_verify_param` per completion |

### Z.ai web chat — session, models, and transport

`zaiweb` runs against a real session object (`src/zai-session.js`) rather than a
hand-pasted JWT:

- **Guest bootstrap** — `GET /` (warm cookies + discover the frontend build) →
  `POST /api/v1/auths/guest` → `GET /api/v1/auths/`. An account token in the
  provider key is validated first and preferred; guest is the fallback.
- **Cookie jar** — every `Set-Cookie` from warm, auth, completion, upload,
  and delete is retained and replayed, which is what the edge expects.
- **Single-flight refresh** — concurrent requests share one refresh; a 401
  mid-flight invalidates, refreshes once, and replays the completion.
- **Rotation** — a token the site rotates during a request is adopted and
  returned as the provider key's new value, so a stored credential never keeps
  a token the site already retired.
- **Live models** (`src/zai-models.js`) — `GET /api/models` with the session's
  cookies decides which models the account can actually use. A model the
  account cannot see is reported `available: false` and the router skips it;
  the static table is fallback metadata only.
- **Chat lifecycle** — chat IDs are client-generated UUIDs, matching GLM-Free-API.
  A pool of ready IDs is maintained locally; an ID only materializes upstream
  when the completion references it. The used chat is deleted after the stream
  drains, so history never accumulates or stacks on re-sent client context.
- **Failure classification** — an edge/WAF block (`code: "zai_waf"`) is
  process-wide and fails fast before image upload or CAPTCHA-token consumption.
  Proof-infrastructure failures on `zaiminted` may use Chromium as a secondary
  fallback; confirmed WAF/model/request failures do not.
- **Persist** — the cookie jar, token, and frontend version are mirrored to
  `<db-dir>/zai-sessions.json` (override with `ZAI_SESSION_STORE`) so a
  restart does not re-bootstrap every guest.
- **Chrome TLS** — optional helper in `relay/cmd/zaihttp`. Run
  `go run .` there and set `ZAI_UTLS_PROXY=http://127.0.0.1:8477` so signed
  chat.z.ai calls present a Chrome ClientHello instead of Node's.

`captcha_verify_param` is still required per completion on the signed path;
it is issued once and cannot be reused.

### Z.ai web chat — pure HTTP (`zaiminted`, recommended)

The primary automatic Z.AI path follows the serving lifecycle proven by
GLM-Free-API. Chromium is not in the normal request path.

```text
OpenAI request
  -> live Z.AI model/capability check
  -> optional image upload to /api/v1/files/
  -> acquire local throwaway chat UUID
  -> take/prefetch a harvested Aliyun device token
  -> InitCaptchaV3 + VerifyCaptchaV3
  -> fresh captcha_verify_param
  -> one signed POST /api/v2/chat/completions
  -> normalize SSE / tools / reasoning
  -> DELETE /api/v1/chats/<uuid>
```

The key details are intentional:

- There is **no `POST /api/v1/chats/new` before a completion**. Z.AI chat IDs
  are client-generated UUIDs and materialize when the completion first uses
  them. This avoids changing session/WAF state between CAPTCHA minting and the
  single-use completion.
- HTTP uses the public model id such as `glm-5.3-flash`; `x-preview-l` is
  treated only as the browser/UI alias.
- The completion body is intentionally minimal: `model`, `chat_id`,
  `messages`, `signature_prompt`, `stream`,
  `captcha_verify_param`, `features`, plus optional `files` and
  `mcp_servers`.
- A tiny CAPTCHA cache keeps fresh proofs while the route is active and pauses
  after inactivity. Device tokens are still single-use.
- WAF state is checked **before** image upload or consuming a device token.
- Every used chat is throwaway and best-effort deleted after the response
  finishes. The local chat-id pool costs no upstream warmup.
- `advancedSearch: true` maps to Z.AI's top-level
  `mcp_servers:["advanced-search"]`. Normal `webSearch`/`search` maps to
  `auto_web_search`. Both are disabled when caller-provided tools activate
  the gateway agent shim, avoiding two competing action channels.
- OpenAI tools still use our gateway-specific agent shim and **schema/hashline
  Tool Repair Layer**; that work is not replaced by the reference transport.
- Vision is real attachment upload now: image parts are uploaded to
  `/api/v1/files/`, their `image_url` values are rewritten to the returned
  file ids, and web-client-style `files[]` entries are attached. Remote image
  downloads are protected by a public-IP/DNS SSRF guard.

Setup on the serving host:

1. Put the Z.AI session token in the provider credential:
   `{"token":"<chat.z.ai localStorage token>"}`.
2. Harvest device tokens on any browser-capable machine:
   ```sh
   node scripts/harvest-zai-tokens.mjs --token "<chat.z.ai token>" --count 300
   ```
3. Copy the token file to the gateway host (default
   `./data/zai-device-tokens.txt`).
4. Set your own `ZAI_CAPTCHA_ACCESS_KEY`,
   `ZAI_CAPTCHA_SECRET_KEY`, and `ZAI_CAPTCHA_SCENE_ID`; the repository
   deliberately ships no shared CAPTCHA credentials.
5. Add the **Z.AI web chat — recommended (pure HTTP)** preset.

This serving path needs **no apt packages, Xvfb, Playwright, or Chromium**, so it
fits restricted ecli/AIO eggs. Browser work is only needed for harvesting.

### Z.ai web chat — browser fallback (`zaiwebbrowser`)

The Chromium implementation remains as a secondary transport and debugging
reference. It is no longer the preferred automatic serving path.

- It drives the real page so the page mints its own CAPTCHA proof.
- Warm contexts are retained across Z.AI token rotation and cold-page
  navigation is retried internally.
- It needs a usable Chromium/Playwright runtime and consumes substantially more
  memory than the pure-HTTP path.
- `zaiminted` may try this fallback only for proof-infrastructure failures
  such as an empty token store or unavailable CAPTCHA configuration. Set
  `ZAI_BROWSER_FALLBACK=0` to disable that behavior.
- Confirmed WAF blocks, model errors, request errors, and image requests do not
  fall back to Chromium.

### Z.ai web chat — caller proof (`zaiweb`)

This is the manual/debug version of the same pure-HTTP engine. Instead of
minting the CAPTCHA proof itself, it accepts a fresh `captcha_verify_param`
from `x-zai-captcha` or the request body. The completion wire, throwaway-chat
lifecycle, live model checks, SSE normalization, tools, search, and vision path
are otherwise the same.

### Model-integrity probes

A gateway trusts its `model_routes`: nothing today checks that the provider
behind a slug actually serves the model that slug claims. Resellers advertise
frontier names (Claude Opus, GPT-5.x, Grok, GLM…) while answering with cheaper
open weights, and the `model` field in a response proves nothing.

**Model routes → verify** on a slug (or `POST /admin/providers/:id/integrity`
with `{ "slug": "openai/gpt-4o" }`) probes that route only. Provider-level
verify still exists and probes the first enabled route.

| Verdict | Meaning |
| --- | --- |
| `CONSISTENT WITH CLAIM` | no contradiction found |
| `TOKENIZER MISMATCH` | measured tokenizer contradicts the claim |
| `MULTI-MODEL RELAY` | one endpoint answers unrelated model slugs — a reseller |
| `STACK LEAK` | serving stack named a different model (`response.model` or a limit error) |
| `INCONCLUSIVE` | auth/rate/transport blocked the probe; **not** evidence of faking |
| `UNVERIFIED` | nothing measurable (no usage field, no `/tokenize`, unknown slug) |

What it measures, in order of strength:

1. **`/tokenize` raw token IDs** — compared for equality against reference
   tokenizers. An exact match is identity, not a guess.
2. **Token-count slope** — `usage.prompt_tokens` across growing prompts, matched
   against 12 reference families (OpenAI o200k/cl100k/p50k/r50k/gpt2, Qwen,
   GLM-5, DeepSeek, Llama 3, Mistral, Kimi K2.6, MiniMax). A fit worse than 6%
   is reported as unverified rather than naming the least-bad family. Gemini
   and Claude have no public tokenizer, so those slugs stay unverified on the
   fingerprint path.
3. **Routing** — six unrelated slugs; three or more answering is a relay.
4. **Stack leak** — `response.model` that does not echo the request, or a
   `max_tokens` rejection that names a different id. Echoes count as no evidence.
5. **Output ceiling** — absurd `max_tokens` rejection; scored only when the
   error names a cap or id. Silent clamp is recorded, not scored.
6. **Knowledge horizon** — dated trivia vs the advertised family's training
   window. Soft: two late facts (or two early misses) before it warns.
7. **Declared-limit breach** — a prompt past the context the claim advertises.
8. **Identity and determinism** — self-reported name (promptable, warn only)
   and temperature 0 reproducibility.

Playground **Verify this slug** runs the same probe against the selected model
only. Stack-leak, ceiling, and cutoff probes follow
[truemodel](https://github.com/pavandoescode/truemodel) (MIT).

Reference token data is **precomputed and committed**
(`ai-gateway/src/modelprobe-refs.js`): the probe text and sizes are constants, so
every reference count and ID sequence is a constant too. That is why the probes
run with no tokenizer dependency — `hono` stays the only package. Regenerate
after changing the probe text:

```sh
python3 scripts/build-modelprobe-refs.py > ai-gateway/src/modelprobe-refs.js
```

Results persist in `provider_probe_runs` (latest verdict per slug + provider),
surface on Model routes, the Playground integrity panel, and
`GET /admin/integrity`, and feed the auto-router: a slug whose latest verdict
is a relay, a mismatch, or a stack leak has its health score scaled to 0.35.
It is a penalty, not a ban — you can still call the slug deliberately.

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
| `zai-minted`  | **recommended** `zaiminted` pure-HTTP provider on `https://chat.z.ai`; automatic fresh proofs, throwaway chats, tools/vision/search |
| `zai-browser` | `zaiwebbrowser` Chromium fallback/debug transport |
| `zai-web` | `zaiweb` manual caller-proof version of the same pure-HTTP engine |
| `zai-api`      | Standard API-key provider on `https://api.z.ai/api/paas/v4`, routes `z-ai/glm-4.6` + `z-ai/glm-4.5` |

Route seeding never repoints a live slug: a preset only adds routes for slugs
that have no enabled route yet, and reports the rest as kept. Custom /
other provider is not a catalog id: the console omits `preset` and
`POST /admin/providers` with `"preset":"custom"` uses the normal create path
(default format `openai`). Typed route slugs still seed. API:
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
| `z-ai/glm-5.3-flash`    | `glm-5.3-flash`  | yes      | yes    | yes*  | reachable on guest sessions   |
| `z-ai/glm-5.3`          | `glm-5.3`        | yes      | live catalog | yes* | signed-in accounts only       |
| `z-ai/glm-5.2`          | `glm-5.2`        | yes      | live catalog | yes* | signed-in accounts only       |

\* Caller tools are gateway-emulated through the Z.AI agent shim and Tool Repair Layer, not native OpenAI tool fields upstream.

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
  Thinking is always on (the consumer models expose no non-thinking mode).
  `reasoning_effort` (`low`/`medium`/`high`/`max`) is forwarded; `glm-5.2`
  has no `low`, so it clamps to `high`. Reasoning arrives as
  `reasoning_content` deltas.
- OpenAI `tools` are not forwarded to chat.z.ai. They are folded into a
  user-only agent prompt; the model emits `<<<TOOL_CALL>>>` blocks, which
  the gateway converts to native OpenAI `tool_calls` (streamed incrementally).
- Vision requests use the reference attachment pipeline: upload to
  `/api/v1/files/`, rewrite the message image reference to the returned file
  id, and attach `files[]`. Models that do not advertise image input are
  rejected before completion.
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
