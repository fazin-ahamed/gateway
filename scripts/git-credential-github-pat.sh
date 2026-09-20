#!/usr/bin/env bash
# Git credential helper: pushes to github.com authenticate with a PAT.
#
# Token source (first match wins):
#   1. $GITHUB_PAT in the environment
#   2. GITHUB_PAT in the repo-root .env (gitignored; see .env.example)
#
# When no token is found the helper prints NOTHING, so git falls through to the
# next configured helper (gh auth git-credential): pushes keep working while gh
# is logged in, and switch to the PAT the moment .env has one. That makes the
# repo safe to flip private — after that, the PAT is what authorizes every push.
#
# The token is never written anywhere by this script, never embedded in the
# remote URL, and never stored in .git/config. It answers ONLY for github.com
# so it can never leak to another host even if the helper scope changes later.
set -u
op="${1:-}"
[ "$op" = "get" ] || exit 0

# Read the credential request; only answer for github.com.
host=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    host=*) host="${line#host=}" ;;
  esac
done
[ "$host" = "github.com" ] || exit 0

root="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${GITHUB_PAT:-}" ] && [ -f "$root/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$root/.env"
  set +a
fi
[ -n "${GITHUB_PAT:-}" ] || exit 0

printf 'protocol=https\nhost=github.com\nusername=%s\npassword=%s\n' \
  "${GITHUB_USERNAME:-x-access-token}" "$GITHUB_PAT"
exit 0
