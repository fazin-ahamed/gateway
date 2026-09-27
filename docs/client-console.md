# Astrosphere client console (`/console`)

The client console is a separate customer surface. `/_gw` remains the
operator cockpit. The console serves from a static SvelteKit build; no Node
or Svelte server runs in production.

## What is where

```text
/console          client console (customers)
/_gw              admin console (operators, unchanged)
/v1/*             public API, bearer-key auth
```

## Startup and autostart

The console deploys with the same watcher that already runs the gateway:

```bash
cd ~/gateway
nohup sh server/auto-update.sh </dev/null >/tmp/gateway-watch.out 2>&1 &
```

The watcher polls `origin/main`. On each update it:

1. hard-resets to the new SHA,
2. runs `npm install` for the server if `server/package.json` changed,
3. **builds the client console** (`client-console/npm run build`) if its
   sources exist, logging to `/tmp/gateway-console-build.log`,
4. restarts Node.

The console build is therefore automatic: pushing to `main` is the deploy.
A failed console build leaves the previous `build/` served and logs the
reason; it never takes the gateway down.

Manual restart, if ever needed:

```bash
pkill -9 -f '[a]uto-update.sh'; pkill -9 -f '[n]ode .*server\.mjs'; sleep 2
cd ~/gateway && nohup sh server/auto-update.sh </dev/null >/tmp/gateway-watch.out 2>&1 &
```

## Sign-in: how credentials work

The console signs in with a **gateway API key**, the same `sk-` key used
against `/v1/*`. There is no separate console account in V1.

```text
POST /console/auth        { "api_key": "sk-..." }
-> Set-Cookie: gw_client=<token>; Path=/console; HttpOnly
```

The key is exchanged once for an HttpOnly session cookie. The browser never
stores the `sk-` secret; `localStorage` is not used. The session maps back to
the owning `api_keys` row, so all console data is scoped to that key and no
other key's data can appear.

`POST /console/logout` deletes the session.

### Creating a key

In the admin console (`/_gw`), Keys tab: **Add key**, choose budget mode and
limit, optionally restrict models. The created `sk-...` value signs in to
`/console`.

### Linking an existing key to the console

Nothing to link: every active `sk-` key works at `/console/signin` by
default. To deny console access for a key, deactivate the key in `/_gw`
(sign-in re-checks `active=1`).

## Endpoints

Browser surface (all session-authenticated):

```text
POST /console/auth
POST /console/account
POST /console/logout
GET  /console/api/me
GET  /console/api/overview?days=7|30|90
GET  /console/api/activity?hours=
GET  /console/api/limits
GET  /console/api/settings
POST /console/api/settings        { "response_cache": "on" | "off" }
GET  /console/api/requests?days=&kind=&status=&model=&request_id=&limit=
GET  /console/api/requests/:id
GET  /console/api/usage?days=
GET  /console/api/models
POST /console/playground/completions
POST /console/playground/systemone
```

The playground routes resolve the session's owning API key server-side and
run the existing inference paths under it. The browser never calls `/v1/*`
with a recovered credential.

## The request ledger

`request_summaries` is the always-on, body-free per-request ledger the
console reads. Chat and decision traffic write it through the same
lifecycle; `trajectories` remains optional body capture. Disabling
trajectory capture in `/_gw` has **no effect** on the console: usage,
requests, and cost come from the ledger, which is pinned by regression.

## Building locally

```bash
cd client-console
npm install
npm run build      # writes client-console/build/
```

The gateway serves `client-console/build/` at `/console` with SPA fallback,
so deep links like `/console/requests` survive a refresh.
