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

A key's first visit is by **gateway API key**, the same `sk-` key used against
`/v1/*`. On that first sign-in the key holder sets a **username and password**;
every later sign-in is by username and password alone, no key.

```text
POST /console/auth     { "api_key": "sk-..." }        -> { "setup": true } when the key has no account yet
POST /console/account  { "api_key", "username", "password" }  -> creates the account, sets the session cookie
POST /console/auth     { "username", "password" }     -> returning sign-in, no key
-> Set-Cookie: gw_client=<token>; Path=/console; HttpOnly
```

The username is unique and maps to the owning `api_keys` row. A key created
with `console_auth=0` skips account setup and signs straight in by key. The
key is exchanged once for an HttpOnly session cookie; the browser never stores
the `sk-` secret and `localStorage` is not used. All console data is scoped to
the owning key.

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
GET  /console/api/pool
POST /console/playground/completions
POST /console/playground/systemone
```

The playground routes resolve the session's owning API key server-side and
run the existing inference paths under it. The browser never calls `/v1/*`
with a recovered credential.

## Shared pool

One `api_key` can be designated the **shared pool**: a communal key with its
own budget that every signed-in console user sees as a top-bar event pill with
the remaining balance. Clicking the pill copies the pool's `sk-` key so it can
be used against `/v1` — the point of a pool is shared use. It is set in `/_gw`,
Keys tab: **set pool** on a key (**unset pool** clears it).

```text
GET /admin/shared-pool                          -> { key_id, pool } (admin)
PUT /admin/shared-pool  { "key_id": "sk-..." }  -> designate; { "key_id": null } clears
GET /console/api/pool                           -> { pool: { key_id, name, mode, limit, used, remaining, request_count, active } | null }
```

The designation is stored in `gateway_settings` under `shared_pool_key`. The
console endpoint returns the pool's `key_id` only to an authenticated console
session, and only because the pill needs to copy it.

Because the pool key is communal — its secret is handed around for `/v1` use —
it is barred from the console: it cannot sign in (by key or username) and cannot
hold an account. Designating a key as the pool drops any account and live
sessions it had, so a previously-personal key loses console access the moment it
becomes the pool.

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
