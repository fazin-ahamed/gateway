<div align="center">

<img src="assets/logo.svg" width="120" alt="Wind gateway logo">

# Wind

**A self-hosted AI gateway that measures how good its answers actually are.**

OpenAI-compatible, on Node + SQLite, with an operator console, per-account
budgets, tool-call repair, and a neurosymbolic taste layer that learns which
models follow the rules - and proves it on your own traffic.

</div>

---

Most gateways route requests and count tokens. This one also asks, of every
response: *was it valid, did it follow the schema, was it cut off, was it
actually relevant?* It answers with a deterministic critic for what a program
can decide, a decision model for the semantics it can't, and per-account Beta
posteriors that turn those verdicts into a measured, calibrated profile of
each model's real behavior. No prompt or response text is ever stored to do
it.

## Why

- **Taste layer.** A symbolic critic checks finished answers (valid JSON when
  asked, tool calls matching their schema, not empty or truncated, reasoning
  present when expected, operator style rules). A decision model (SubQ, or any
  systemone route) scores relevance, instruction-following and tone. Both feed
  the same Beta posteriors per (model, rule, route, account), so "how often
  does this model actually comply" is measured, with 30-day decay, never
  assumed.
- **Tool-call repair.** Malformed tool calls are repaired for every provider,
  streaming or not: tolerant JSON repair, type coercion against the advertised
  schema, enum snapping, name casing. A call cut off by the length limit is
  never emitted - closing the braces of a half-written edit is how data gets
  lost.
- **Per-account budgets.** Rolling 24-hour and 30-day caps plus prepaid
  credits. Windows are trailing, so spend ages out on its own instead of
  resetting at midnight.
- **Model-integrity probes.** Verify a slug actually serves the model it
  claims, against reference tokenizers and routing fingerprints, so a reseller
  relaying cheap weights behind a frontier name gets caught.
- **Privacy by construction.** The taste posteriors and the persisted verdict
  history store rule names, scores, model, route and account only. Prompts and
  responses never reach the learning tables.

## The gateway

- **OpenAI-compatible** `POST /v1/chat/completions` and `GET /v1/models`, plus
  a **decision API** `POST /v1/systemone` for typed questions (choice, score,
  noul) against decision models.
- **`model: "auto"`** routes over your enabled routes: easy asks take one
  reflex hop, hard asks compile a task lens and reroute on failure.
- **Operator console** at `/_gw`: providers, routes, tiers, keys, budgets,
  prices, cache, reliability and the taste profile.
- **Customer console** at `/console`: usage, keys, budgets, models, a
  playground with streaming reasoning traces, and the account's own taste
  profile with its verdict trend.
- **Public overview** at `/`: recorded usage and the model directory with no
  sign-in, drawn from the body-free request ledger.

## Quickstart

Requires Node 22.5 or newer (the gateway uses the built-in `node:sqlite`).

```sh
git clone <this-repo> && cd gateway
cp .env.example .env            # fill in the two secrets below

cd server && npm install --omit=dev
cd ../ai-gateway && npm install --omit=dev
cd ../wind-console && npm install && npm run build

cd ../server && node --experimental-sqlite server.mjs
```

Then:

1. Open `http://localhost:3000/_gw` and sign in with `ADMIN_TOKEN`.
2. Add a provider and a model route, then create an API key.
3. Open `http://localhost:3000/console` with that key.

Generate secrets with `openssl rand -base64 36`.

| Secret | Purpose |
| --- | --- |
| `ADMIN_TOKEN` | Operator console password |
| `PROVIDER_CRYPTO_KEY` | AES-GCM envelope that seals provider keys in SQLite |

Keep `PROVIDER_CRYPTO_KEY` safe. Losing it makes every sealed provider key
unreadable.

## Deploy

One Node process plus SQLite; no separate database, cache or frontend server.

- **Free 24/7 hosting** (Oracle Cloud Always Free, with a domain and free TLS
  via Caddy): [docs/FREE-HOSTING.md](docs/FREE-HOSTING.md)
- **Panel / SFTP hosts** (like the Node startup panel): main file
  `server/server.mjs`, runtime Node 24, persistent writable disk, and SSE
  streaming with no proxy buffering. See the same doc.
- **Cloudflare Workers + D1**, a zero-server second deployment:
  `ai-gateway/wrangler.jsonc`.

For streaming, the proxy in front must not buffer. With Caddy, keep
`flush_interval -1`.

## Docs

| Document | Covers |
| --- | --- |
| [docs/FREE-HOSTING.md](docs/FREE-HOSTING.md) | Free hosting, TLS, keeping the instance alive |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Provider wire formats, Z.AI transports, integrity probes |
| [docs/current-request-path.md](docs/current-request-path.md) | The request lifecycle through the gateway |
| [docs/ecli-hosting.md](docs/ecli-hosting.md) | Panel-based hosting specifics |
| [docs/client-console.md](docs/client-console.md) | The console build |

## Layout

| Path | Role |
| --- | --- |
| `ai-gateway/` | Shared application (`src/index.js`, taste, repair, decision), schema, tests |
| `server/` | Node entrypoint (`server.mjs`, `db.mjs`, migrations) - the deploy target |
| `wind-console/` | The React customer console, built into `client-console/build` |
| `relay/` | Optional Go egress relay for providers that need it |
| `docs/` | Runbooks and reference |

## Development

```sh
cd ai-gateway
node --test test/*.test.mjs     # the full suite
npm run check                   # syntax-check the worker bundle
```

The test suite covers the taste layer (symbolic critique, judge integration,
per-account posteriors), tool-call repair (JSON repair, schema coercion,
stream assembly), budgets, decision models, and the console API.

---

<div align="center">

Self-hosted. Your keys, your data, your measurements.

</div>
