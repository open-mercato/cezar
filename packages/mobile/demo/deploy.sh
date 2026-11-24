#!/usr/bin/env bash
# One command from a developer machine: build cezar from this checkout, copy it and the kit to the VPS,
# run setup.sh there, and print the reviewer pairing details.
#
#   packages/mobile/demo/deploy.sh root@<vps> --relay-email demo@example.com [--code K7QM-3XNA-9VPD] [--relay-url URL] [--reset] [--no-build]
#
# Needs ssh access as root (or a user with passwordless sudo: pass user@host and it uses sudo).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
[ $# -ge 1 ] || { printf 'usage: %s <user@host> --relay-email <address> [--code <code>] [--relay-url <url>] [--reset] [--no-build]\n' "$0" >&2; exit 2; }
TARGET=$1
shift
BUILD=1 PASS=()
for arg in "$@"; do
  case "$arg" in --no-build) BUILD=0 ;; *) PASS+=("$arg") ;; esac
done

cd "$REPO"
if [ "$BUILD" = 1 ]; then
  echo "[deploy] Building cezar"
  npm run build:server >/dev/null
  npm run build:web >/dev/null
fi
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
echo "[deploy] Packing"
TARBALL=$(npm pack -w @open-mercato/cezar --pack-destination "$OUT" --silent | tail -1)
mkdir -p "$OUT/kit"
cp "$HERE/common.sh" "$HERE/setup.sh" "$HERE/reset.sh" "$HERE/seed.sh" "$OUT/kit/"
cp "$OUT/$TARBALL" "$OUT/kit/cezar.tgz"

SUDO=''
case "$TARGET" in root@*) ;; *) SUDO=sudo ;; esac
echo "[deploy] Copying to $TARGET"
ssh "$TARGET" 'rm -rf ~/cezar-demo-kit && mkdir -p ~/cezar-demo-kit'
scp -q "$OUT"/kit/* "$TARGET:cezar-demo-kit/"
echo "[deploy] Running setup.sh on $TARGET"
# shellcheck disable=SC2029 # the arguments are meant to expand here
ssh -t "$TARGET" "$SUDO bash ~/cezar-demo-kit/setup.sh --tarball ~/cezar-demo-kit/cezar.tgz $(printf '%q ' "${PASS[@]}")"
