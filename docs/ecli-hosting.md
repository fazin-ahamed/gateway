# ecli.app hosting (EclipseSystems panel + QEMU Debian 13 VM)

The Worker code also runs on a plain Node server, so the whole stack can
live on ecli.app with no Cloudflare account. Two processes on one VM:

- `server/` — Node 22+ (`@hono/node-server`), serves the gateway + console
- `relay/` — Go binary, only needed when a provider requires separate egress

## 1. Create the VM

EcliPanel → Servers → New Server → **QEMU – Debian 13 VM**. Note the SSH
IP/port, then:

```sh
ssh -p <ssh-port> root@<server-ip>
apt update && apt install -y git curl nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs golang-go
```

## 2. Deploy the repo

```sh
git clone <your-repo-url> gateway && cd gateway
cp .env.example .env   # then edit: ADMIN_TOKEN, PROVIDER_CRYPTO_KEY, secrets
```

`.env` (never commit):

```sh
ADMIN_TOKEN=<long-random-admin-password>
PROVIDER_CRYPTO_KEY=<long-random-key-encryption-secret>
KOYEB_RELAY_SECRET=<long-random-relay-secret, only if you run the relay>
PORT=3000
HOST=0.0.0.0
DB_PATH=./data/gateway.db
```

## 3. Start the gateway

```sh
cd server && npm install
PORT=30012 node --env-file=../.env server.mjs
```

Or leave a watcher running so each push to `main` pulls and restarts:

```sh
pkill -9 -f auto-update.sh; pkill -9 -f server.mjs; sleep 2
cd ~/gateway && nohup sh server/auto-update.sh >/dev/null 2>&1 &
sleep 2
tail -20 /tmp/gateway-update.log
```

The watcher polls `origin/main` every 30s, fast-forwards, then restarts Node on **30012** (ignores the panel `PORT=3000`). Override with `GATEWAY_PORT` only if the allocation changes. Logs: `/tmp/gateway.log` (app), `/tmp/gateway-update.log` (watcher).

First boot creates `./data/gateway.db` (SQLite). Apply the schema once:

```sh
sqlite3 ./data/gateway.db < ../ai-gateway/schema.sql
```

The console lives at `http://<allocation-host>:30012/_gw` on the ecli allocation. Sign in with `ADMIN_TOKEN`. Add providers, routes, and API keys there — D1 is not used.

## 4. Optional: relay on the same VM

```sh
cd relay && go build -o /usr/local/bin/gateway-relay ./cmd/relay
KOYEB_RELAY_SECRET='<same-as-.env>' PORT=8000 gateway-relay
```

Then set the provider's transport to `koyeb` and the relay URL to
`ws://127.0.0.1:8000/tunnel` (same-machine, no TLS needed).

## 5. Domain + HTTPS (ecli.app)

EcliPanel → Server → Firewall: forward public **80** and **443** to the VM.
At your DNS provider:

```text
Type:  A
Name:  @            (or: app)
Value: <ecli-server-ipv4>
```

Nginx (`/etc/nginx/sites-available/gateway`):

```nginx
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```sh
ln -s /etc/nginx/sites-available/gateway /etc/nginx/sites-enabled/gateway
nginx -t && systemctl reload nginx
certbot --nginx -d example.com
```

The gateway already trusts `X-Forwarded-For` for login rate-limiting, so
Nginx must set it (above). If ecli.app later offers a managed-domain proxy
on your plan, use its hostname/DNS target instead of the A record.

## Notes
- Node deploys serve `ai-gateway/src/*` directly — no build step, no fork.
- Free ELO plan: 1 server, 1 port, ~1 GB RAM — enough for the gateway;
  run the relay on the same VM over loopback to save the port.
- Back up `./data/gateway.db` — it holds providers, keys, and usage.
