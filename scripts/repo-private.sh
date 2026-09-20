#!/usr/bin/env bash
# Flip the origin repository between private and public with a PAT.
#
#   ./scripts/repo-private.sh private   # make the repo private
#   ./scripts/repo-private.sh public    # make it public again
#
# Token: $GITHUB_PAT, or GITHUB_PAT in the repo-root .env (gitignored).
# Required permissions: classic PAT with `repo` scope, or fine-grained with
# Administration: read/write on this repository (you must be an admin).
set -euo pipefail

vis="${1:-}"
case "$vis" in
  private) want=true ;;
  public)  want=false ;;
  *) echo "usage: $0 [private|public]" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${GITHUB_PAT:-}" ] && [ -f "$root/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$root/.env"
  set +a
fi
: "${GITHUB_PAT:?GITHUB_PAT is not set - add it to .env (see .env.example)}"

url="$(git -C "$root" config --get remote.origin.url)"
case "$url" in
  https://github.com/*) ;;
  *) echo "unsupported remote url: $url" >&2; exit 1 ;;
esac
repo="${url#https://github.com/}"
repo="${repo%.git}"

private="$(curl -fsS -X PATCH \
  -H "Authorization: Bearer $GITHUB_PAT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$repo" \
  -d "{\"private\":$want}" \
  | jq -r '.private')"

[ "$private" = "$want" ] || { echo "unexpected response: private=$private" >&2; exit 1; }
echo "$repo is now private=$private"
