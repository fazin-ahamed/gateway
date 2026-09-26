#!/bin/sh
# Poll origin/main and restart the Node gateway when HEAD moves.
# Intended for the ecli.app AIO egg (no systemd/root). Run from any cwd.
#
#   cd ~/gateway && sh server/auto-update.sh
#
# Env (optional):
#   GATEWAY_ROOT   repo root (default: parent of this script's directory)
#   GATEWAY_PORT   listen port (default: 30012). Panel PORT is ignored.
#   POLL_SECONDS   git fetch interval (default: 30)
#   GATEWAY_LOG    node stdout (default: /tmp/gateway.log)
#   UPDATE_LOG     watcher stdout (default: /tmp/gateway-update.log)
#   ZAIHTTP_LOG    uTLS helper stdout (default: /tmp/zaihttp.log)

set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=${GATEWAY_ROOT:-$(CDPATH= cd -- "$HERE/.." && pwd)}
PORT=${GATEWAY_PORT:-30012}
POLL=${POLL_SECONDS:-30}
LOG=${GATEWAY_LOG:-/tmp/gateway.log}
CONSOLE_LOG=${CONSOLE_LOG:-/tmp/gateway-console-build.log}
UPDATE_LOG=${UPDATE_LOG:-/tmp/gateway-update.log}
ZAIHTTP_LOG=${ZAIHTTP_LOG:-/tmp/zaihttp.log}
ENV_FILE="$ROOT/.env"
SERVER_DIR="$ROOT/server"
SERVER_JS="$SERVER_DIR/server.mjs"
ZAIHTTP_BIN="$SERVER_DIR/bin/zaihttp"
ZAIHTTP_ADDR=${ZAI_HTTP_ADDR:-127.0.0.1:8477}

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

start_zaihttp() {
  stop_zaihttp
  unset ZAI_UTLS_PROXY
  ZAIHTTP_DIR="$ROOT/relay/cmd/zaihttp"
  RUN_BIN=""
  if command -v go >/dev/null 2>&1 && [ -f "$ZAIHTTP_DIR/main.go" ]; then
    cd "$ZAIHTTP_DIR"
    if go build -o /tmp/gateway-zaihttp . >>"$ZAIHTTP_LOG" 2>&1; then
      RUN_BIN=/tmp/gateway-zaihttp
      log "built zaihttp helper -> $RUN_BIN"
    else
      log "go build zaihttp failed; see $ZAIHTTP_LOG"
    fi
    cd "$ROOT"
  fi
  if [ -z "$RUN_BIN" ] && [ -x "$ZAIHTTP_BIN" ]; then
    RUN_BIN="$ZAIHTTP_BIN"
  fi
  if [ -z "$RUN_BIN" ]; then
    log "zaihttp helper missing (no go, no $ZAIHTTP_BIN); Node TLS will be used"
    return 0
  fi
  # Sticky egress is process-level: one helper = one identity. Pull from .env
  # without sourcing the whole file (secrets). Never log the URL (credentials).
  EGRESS=$(grep -E '^ZAI_EGRESS_PROXY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r' || true)
  if [ -n "$EGRESS" ]; then
    log "zaihttp egress configured (scheme-sticky; value not logged)"
  fi
  ZAI_HTTP_ADDR="$ZAIHTTP_ADDR" ZAI_EGRESS_PROXY="$EGRESS" nohup "$RUN_BIN" >>"$ZAIHTTP_LOG" 2>&1 &
  echo $! > /tmp/zaihttp.pid
  log "started zaihttp pid=$! addr=$ZAIHTTP_ADDR log=$ZAIHTTP_LOG"
  i=0
  while [ "$i" -lt 40 ]; do
    if node -e 'fetch("http://'"$ZAIHTTP_ADDR"'/healthz").then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})' >/dev/null 2>&1; then
      export ZAI_UTLS_PROXY="http://$ZAIHTTP_ADDR"
      log "zaihttp ready proxy=$ZAI_UTLS_PROXY"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  log "zaihttp did not become ready; continuing without uTLS"
}


build_console() {
  CONSOLE_DIR="$ROOT/client-console"
  [ -d "$CONSOLE_DIR/src" ] || return 0
  command -v npm >/dev/null || { log "npm missing; console will serve the previous build"; return 0; }
  # Skip when nothing changed since the last build: restart_server also runs
  # on poll-loop recovery, and an unchanged rebuild just delays the gateway.
  STAMP="$CONSOLE_DIR/.svelte-kit/.console-built"
  if [ -f "$STAMP" ] && [ -f "$CONSOLE_DIR/build/index.html" ]; then
    NEWEST=$(find "$CONSOLE_DIR/src" "$CONSOLE_DIR/package.json" -type f -newer "$STAMP" 2>/dev/null | head -1)
    [ -z "$NEWEST" ] && return 0
  fi
  # Install on a missing node_modules OR when package.json changed after the
  # last install: a new dependency in a commit must actually be installed,
  # not only when the tree started empty.
  DEPS_STAMP="$CONSOLE_DIR/.svelte-kit/.console-deps"
  # A missing stamp means this logic has never installed here: run once.
  # After that, a package.json newer than the stamp adds dependencies.
  if [ ! -f "$DEPS_STAMP" ] || [ "$CONSOLE_DIR/package.json" -nt "$DEPS_STAMP" ]; then
    DEPS_NEWER=yes
  else
    DEPS_NEWER=no
  fi
  if [ ! -d "$CONSOLE_DIR/node_modules" ] || [ "$DEPS_NEWER" = yes ]; then
    log "console: installing dependencies"
    (cd "$CONSOLE_DIR" && npm install --no-audit --no-fund >>"$CONSOLE_LOG" 2>&1) \
      || { log "console: npm install failed; serving previous build; see $CONSOLE_LOG"; return 0; }
    mkdir -p "$CONSOLE_DIR/.svelte-kit"
    date -u '+%Y-%m-%dT%H:%M:%SZ' >"$DEPS_STAMP"
  fi
  log "console: building"
  (cd "$CONSOLE_DIR" && npm run build >"$CONSOLE_LOG" 2>&1) \
    || { log "console: build failed; serving previous build; see $CONSOLE_LOG"; return 0; }
  mkdir -p "$CONSOLE_DIR/.svelte-kit"
  date -u '+%Y-%m-%dT%H:%M:%SZ' >"$STAMP"
  log "console: build ok -> $CONSOLE_DIR/build"
}

stop_zaihttp() {
  if [ -f /tmp/zaihttp.pid ]; then
    kill "$(cat /tmp/zaihttp.pid)" 2>/dev/null || true
    rm -f /tmp/zaihttp.pid
  fi
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "/tmp/gateway-zaihttp" 2>/dev/null || true
    pkill -f "relay/cmd/zaihttp" 2>/dev/null || true
    pkill -f "$ZAIHTTP_BIN" 2>/dev/null || true
  fi
}

start_server() {
  mkdir -p "$SERVER_DIR"
  # Cold boot has no node_modules until something installs them; a host
  # restart must converge on its own, not wait for the next commit.
  for dep_dir in "$SERVER_DIR" "$ROOT/ai-gateway"; do
    if [ -f "$dep_dir/package.json" ] && [ ! -d "$dep_dir/node_modules/hono" ]; then
      log "deps: installing in $dep_dir"
      (cd "$dep_dir" && npm install --omit=dev --no-audit --no-fund >>"$LOG" 2>&1) \
        || log "deps: install failed in $dep_dir; node may not start"
    fi
  done
  build_console
  start_zaihttp
  cd "$SERVER_DIR"
  # zaiwebbrowser launches headed Chromium. On a VM with no DISPLAY, wrap
  # Node in xvfb-run so Playwright has an X server. If DISPLAY is already
  # set (operator-provided Xvfb), leave it.
  CMD="node --env-file=$ENV_FILE $SERVER_JS"
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
    CMD="xvfb-run -a -s -screen 0 1280x800x24 $CMD"
    log "no DISPLAY; wrapping node with xvfb-run"
  elif [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    log "no DISPLAY and xvfb-run missing; zaiwebbrowser will fail until Xvfb is installed"
  fi
  if [ -n "${ZAI_UTLS_PROXY:-}" ]; then
    PORT="$PORT" ZAI_UTLS_PROXY="$ZAI_UTLS_PROXY" nohup $CMD >>"$LOG" 2>&1 &
  else
    PORT="$PORT" nohup $CMD >>"$LOG" 2>&1 &
  fi
  log "started node pid=$! port=$PORT log=$LOG utls=${ZAI_UTLS_PROXY:-none}"
  cd "$ROOT"
}

stop_server() {
  stop_zaihttp
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
  # Never block on interactive prompts. A 401 from a private/unreachable
  # remote makes git ask for a username on stdin; this watcher is a background
  # job whose stdin is the terminal, so the read raises SIGTTIN and the whole
  # watcher gets Stopped (that is the "[1]+ Stopped" death). GIT_TERMINAL_PROMPT=0
  # turns auth failure into a fast non-zero exit the caller retries next poll.
  # Credential helpers are kept: they serve GITHUB_PAT from $ENV_FILE/.env.
  GIT_TERMINAL_PROMPT=0 git fetch --quiet origin main 2>/dev/null \
    || GIT_TERMINAL_PROMPT=0 git fetch --quiet origin
}

# Idempotent: register the in-repo PAT credential helper for this clone so a
# private origin authenticates from $ENV_FILE with no manual git config. The
# empty value first clears helpers inherited from global config, then PAT is
# tried first and gh (if installed and logged in) is the silent fallback.
register_pat_helper() {
  [ -x "$ROOT/scripts/git-credential-github-pat.sh" ] || return 0
  helper="!$ROOT/scripts/git-credential-github-pat.sh"
  current=$(git config --get-all credential.https://github.com.helper 2>/dev/null || true)
  case "$current" in
    *"$helper"*) return 0 ;;
  esac
  git config credential.https://github.com.helper ''
  git config --add credential.https://github.com.helper "$helper"
  if command -v gh >/dev/null 2>&1; then
    git config --add credential.https://github.com.helper '!gh auth git-credential'
  fi
  log "registered PAT credential helper (GITHUB_PAT from $ENV_FILE)"
}

remote_head() {
  if git rev-parse --verify -q origin/main >/dev/null; then
    git rev-parse origin/main
  else
    git rev-parse FETCH_HEAD
  fi
}
register_pat_helper

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
  # The egg often has local edits (logs, generated files). --ff-only then
  # leaves the process on a stale SHA forever. .env and data/ are gitignored,
  # so a hard reset does not wipe secrets or the SQLite DB.
  if git reset --hard "$REMOTE"; then
    if [ -f "$SERVER_DIR/package.json" ]; then
      (cd "$SERVER_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1) || log "npm install failed; restarting anyway"
    fi
    restart_server
    log "updated to $(current_head)"
  else
    log "reset --hard failed; leaving process on $LOCAL"
  fi
done
