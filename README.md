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

`providers.fmt` accepts three values. The admin UI exposes all three.

| `fmt`       | Upstream                                   | Credential (sealed `provider_keys` row)                                                              |
| ----------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `openai`    | `{base_url}/chat/completions`              | API key, sent as `Authorization: Bearer …`                                                            |
| `anthropic` | `{base_url}/messages`                      | API key, sent as `x-api-key`                                                                          |
| `zaiweb`    | Z.ai consumer web chat (`https://chat.z.ai`) | Optional: JSON `{"token":"<chat.z.ai token>","captcha_verify_param":"<proof>"}`. With no token the gateway bootstraps a guest session itself. |

### Z.ai web chat — session, models, and transport

`zaiweb` runs against a real session object (`src/zai-session.js`) rather than a
hand-pasted JWT:

- **Guest bootstrap** — `GET /` (warm cookies + discover the frontend build) →
  `POST /api/v1/auths/guest` → `GET /api/v1/auths/`. An account token in the
  provider key is validated first and preferred; guest is the fallback.
- **Cookie jar** — every `Set-Cookie` from warm, auth, chat-create, completion,
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
- **Chat lifecycle** — each request uses a throwaway chat and deletes it once
  the stream drains, so the account's history does not accumulate.
- **Failure classification** — an edge/WAF/challenge block (`code: "zai_waf"`)
  is reported separately from an auth failure or a model outage, so the caller
  can fall back to the browser transport instead of treating them all as 5xx.

`captcha_verify_param` is still required per completion on the signed path;
it is issued once and cannot be reused.

### Z.ai web chat — browser (`zaiwebbrowser`)

`zaiwebbrowser` removes the captcha step entirely: the gateway drives chat.z.ai
in a local Chromium and lets the page mint its own proof. Each request gets a
fresh page (no cross-conversation state), serialized by a per-credential mutex.

- Requires Chromium: `npm install playwright && npx playwright install chromium`.
  On a host where you cannot install system packages, the `npx playwright install`
  step may report missing shared libraries; two ways around it:
  - point `BROWSER_EXECUTABLE` at a Chromium already present on the host
    (or in `~/.cache/ms-playwright/*/chrome-linux64/chrome`) and skip the
    download entirely, or
  - run the browser on another machine and give this provider a `proxy_url`
    pointing at the existing OCI relay — the guard that pins z.ai routes to
    direct transport applies to `zaiminted`, not to this one.

  ```sh
  # in .env on the gateway host
  BROWSER_EXECUTABLE=/home/<user>/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
  ```
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

### Z.ai web chat — minted (`zaiminted`)

The `zaiweb` format needs a caller-supplied captcha proof per completion and the
`zaiwebbrowser` format needs a browser. `zaiminted` needs neither: it mints the
Aliyun proof itself in pure Node (no packages, no Chromium) from a file of
harvested device tokens.

Setup:

1. Harvest device tokens on a machine that has a browser (this is the only step
   that needs one — the gateway stays browser-free):

   ```sh
   node scripts/harvest-zai-tokens.mjs --token "<chat.z.ai localStorage token>" --count 300
   ```

2. Copy the file to the gateway host: `scp data/zai-device-tokens.txt <host>:~/gateway/data/`.
3. Supply the Aliyun captcha credential pair (`ZAI_CAPTCHA_ACCESS_KEY`,
   `ZAI_CAPTCHA_SECRET_KEY`) — see `.env.example`. There is no shared default.
4. Console → Providers → Add provider → preset **Z.AI web chat — automatic
   (no browser)**, credential `{"token":"<chat.z.ai token>"}`.

Each completion consumes exactly one device token (Aliyun binds a token to a
single verification), so the store needs topping up as it drains. An empty store
returns a typed 503 (`zai_tokens`) naming the harvest script.

**Status — minting works; the gateway's minted route does not yet.** Measured live:

| Step | Result |
| --- | --- |
| Token harvest (`window.z_um.getToken()`) | works; 30 tokens in ~16 s |
| `InitCaptchaV3` + payload construction | works; `data` blob byte-identical to the reference implementation |
| `VerifyCaptchaV3` with a stealth-harvested token | works — `VerifyCode T001`, real `securityToken` |
| A full direct flow (create chat → mint → completion) | **completed twice** on a signed-in account (`glm-5.3-flash`) |
| The same flow through this gateway's provider | still answered `Captcha verification failed` / an outage sentinel |

Two things that are now settled:

- **The harvester must inject a stealth fingerprint.** Aliyun will not mint a
  usable token from a plainly automated browser; `scripts/zai-harvest-stealth.js`
  patches `navigator.webdriver`, plugins, `window.chrome`, WebGL and screen
  geometry before any page JS runs. Without it every token fails with
  `VerifyCode F001` — verified by running the harvested tokens through the
  reference bridge, which failed the same way.
- **The account tier matters.** A guest session only reaches `glm-5.3-flash`;
  a signed-in account (`glm-5.3`, `glm-5.2`, vision models) is what makes the
  route worth having.

So the remaining gap is entirely in the gateway's completion request shape, not
in token validity or minting. Until that is closed, use `zaiwebbrowser` (or an
API-key provider) for anything you depend on.

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
| `zai-browser`  | `zaiwebbrowser` provider on `https://chat.z.ai` — automatic, no captcha; routes `z-ai/glm-5.3-flash` + `z-ai/glm-5.3` |
| `zai-web`      | `zaiweb` provider on `https://chat.z.ai`, direct transport; routes `z-ai/glm-5.3-flash` + `z-ai/glm-5.3` |
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
