#!/bin/sh
# Poll origin/main and restart the Node gateway when HEAD moves.
# Intended for the ecli.app AIO egg (no systemd/root). Run from any cwd.
#
#   cd ~/gateway && sh server/auto-update.sh
#
# Env (optional):
#   GATEWAY_ROOT   repo root (default: parent of this script's directory)
#   PORT           listen port (default: 30012)
#   POLL_SECONDS   git fetch interval (default: 30)
#   GATEWAY_LOG    node stdout (default: /tmp/gateway.log)
#   UPDATE_LOG     watcher stdout (default: /tmp/gateway-update.log)

set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=${GATEWAY_ROOT:-$(CDPATH= cd -- "$HERE/.." && pwd)}
PORT=${PORT:-30012}
POLL=${POLL_SECONDS:-30}
LOG=${GATEWAY_LOG:-/tmp/gateway.log}
UPDATE_LOG=${UPDATE_LOG:-/tmp/gateway-update.log}
ENV_FILE="$ROOT/.env"
SERVER_DIR="$ROOT/server"
SERVER_JS="$SERVER_DIR/server.mjs"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$UPDATE_LOG"
}

die() {
  log "error: $*"
  exit 1
}

[ -f "$SERVER_JS" ] || die "missing $SERVER_JS"
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE (copy .env.example and fill secrets)"
command -v git >/dev/null || die "git not on PATH"
command -v node >/dev/null || die "node not on PATH"

cd "$ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$ROOT is not a git repo"

start_server() {
  mkdir -p "$SERVER_DIR"
  cd "$SERVER_DIR"
  PORT="$PORT" nohup node --env-file="$ENV_FILE" "$SERVER_JS" >>"$LOG" 2>&1 &
  log "started node pid=$! port=$PORT log=$LOG"
  cd "$ROOT"
}

stop_server() {
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "[n]ode .*server\\.mjs" 2>/dev/null || true
  else
    ps | awk '/[n]ode .*server\.mjs/ {print $1}' | while read -r pid; do
      kill "$pid" 2>/dev/null || true
    done
  fi
  i=0
  while [ "$i" -lt 20 ]; do
    if command -v pgrep >/dev/null 2>&1; then
      pgrep -f "[n]ode .*server\\.mjs" >/dev/null 2>&1 || break
    else
      ps | awk '/[n]ode .*server\.mjs/ {found=1} END {exit !found}' || break
    fi
    i=$((i + 1))
    sleep 1
  done
  if command -v pkill >/dev/null 2>&1; then
    pkill -9 -f "[n]ode .*server\\.mjs" 2>/dev/null || true
  fi
}

restart_server() {
  stop_server
  sleep 1
  start_server
}

current_head() {
  git rev-parse HEAD
}

fetch_remote() {
  git fetch --quiet origin main 2>/dev/null || git fetch --quiet origin
}

remote_head() {
  if git rev-parse --verify -q origin/main >/dev/null; then
    git rev-parse origin/main
  else
    git rev-parse FETCH_HEAD
  fi
}

log "watching $ROOT (poll=${POLL}s port=$PORT)"
restart_server

while :; do
  sleep "$POLL"
  fetch_remote || { log "git fetch failed; retrying"; continue; }
  LOCAL=$(current_head)
  REMOTE=$(remote_head)
  if [ "$LOCAL" = "$REMOTE" ]; then
    # Keep the process up even if it crashed.
    if command -v pgrep >/dev/null 2>&1; then
      pgrep -f "[n]ode .*server\\.mjs" >/dev/null 2>&1 && continue
    else
      ps | awk '/[n]ode .*server\.mjs/ {found=1} END {exit !found}' && continue
    fi
    log "node not running; restarting"
    start_server
    continue
  fi
  log "updating $LOCAL -> $REMOTE"
  if git merge --ff-only "$REMOTE"; then
    if [ -f "$SERVER_DIR/package.json" ]; then
      (cd "$SERVER_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1) || log "npm install failed; restarting anyway"
    fi
    restart_server
    log "updated to $(current_head)"
  else
    log "fast-forward failed; leaving process on $LOCAL"
  fi
done
