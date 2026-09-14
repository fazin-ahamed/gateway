# Contributing

Issues and pull requests are welcome. Keep secrets out of every contribution.

## Must never be committed

- Provider API keys, admin passwords, relay secrets, tokens
- Private provider hostnames or customer model slugs
- `wrangler.jsonc` with a real `database_id`, `KOYEB_RELAY_URL`, or referrer
- `.env`, `.dev.vars`, `*.pem`, `*.key`, `.wrangler/` output

Private providers go in your own D1 rows or `RELAY_PROVIDERS_JSON`, not in
`relay/internal/relay/allowlist.go`.

## Checks before opening a PR

```sh
cd relay && go test ./... -short -count=1
cd ../ai-gateway && npm install && npx wrangler deploy --dry-run
```

Also run `git diff --check` and confirm `git status` shows no `.env`,
`.dev.vars`, or `.wrangler/` files.
