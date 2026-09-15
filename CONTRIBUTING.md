# Contributing

Issues and pull requests are welcome. Keep secrets out of every contribution.

## Must never be committed

- Provider API keys, admin passwords, relay secrets, tokens
- Private provider hostnames or customer model slugs
- `.env` with real secrets, `.dev.vars`, `*.pem`, `*.key`, local `server/data/` files

Private providers go in your own DB rows or `RELAY_PROVIDERS_JSON`, not in
`relay/internal/relay/allowlist.go`.

## Checks before opening a PR

```sh
cd relay && go test ./... -short -count=1
cd ../server && npm install && node --check server.mjs
```

Also run `git diff --check` and confirm `git status` shows no `.env`,
`.dev.vars`, or `server/data/` files.
