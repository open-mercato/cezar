#!/usr/bin/env bash
# Run the store-review demo on this machine, from this checkout's build (npm run build:server && npm run build:web).
#
#   packages/mobile/demo/local.sh [--relay http://127.0.0.1:8787] [--email you@example.com] [--code K7QM-3XNA-9VPD]
#
# With no --relay it uses the default relay. For an Android emulator against a local relay
# (rome under `wrangler dev`): adb reverse tcp:8787 tcp:8787, then type the relay address under
# Enter code > Advanced in a debug build. Stop with Ctrl-C; the temp directory is printed.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
RELAY='' EMAIL='demo@example.test' CODE=''
while [ $# -gt 0 ]; do
  case "$1" in
    --relay) RELAY=$2; shift 2 ;;
    --email) EMAIL=$2; shift 2 ;;
    --code) CODE=$2; shift 2 ;;
    *) printf 'usage: %s [--relay <origin>] [--email <address>] [--code <code>]\n' "$0" >&2; exit 2 ;;
  esac
done

export DEMO_LOCAL=1
export DEMO_ROOT=${DEMO_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/cezar-demo.XXXXXX")}
export DEMO_PORT=${DEMO_PORT:-4399}
# shellcheck source=common.sh
. "$HERE/common.sh"
[ -n "$CODE" ] || CODE=$(new_code)
mkdir -p "$DEMO_CEZ_HOME" "$DEMO_PROJECTS"
[ -f "$REPO/packages/cezar/dist/index.js" ] || die "build first: npm run build:server && npm run build:web"

"$HERE/seed.sh" repos

# A clean environment: CEZ_* from the calling shell must not leak in.
env -i PATH="$PATH" HOME="$DEMO_ROOT" TMPDIR="${TMPDIR:-/tmp}" \
  CEZ_HOME="$DEMO_CEZ_HOME" CEZ_DRY_RUN=1 CEZ_DEMO=1 CEZ_REMOTE=1 CEZ_TERMINAL=0 \
  CEZ_RELAY_DEMO_CODE="$CODE" ${RELAY:+CEZ_RELAY_URL="$RELAY"} \
  CEZ_BROWSE_ROOT="$DEMO_PROJECTS" CEZ_PROJECTS_DIR="$DEMO_PROJECTS" CEZ_SECRETS_KEYCHAIN=0 \
  CEZ_TELEMETRY=0 CEZ_NO_BANNER=1 CEZ_SKILLS_AUTO_UPDATE=0 CEZ_ARTIFACTS_CDN=0 CEZ_RELAY_KEEP_AWAKE=0 \
  GIT_AUTHOR_NAME='Cezar Demo' GIT_AUTHOR_EMAIL=demo@cezar.invalid GIT_COMMITTER_NAME='Cezar Demo' GIT_COMMITTER_EMAIL=demo@cezar.invalid \
  sh -c "cd '$DEMO_REPO' && exec node '$REPO/packages/cezar/dist/index.js' serve --no-open --port $DEMO_PORT" \
  >"$DEMO_ROOT/cezar.log" 2>&1 &
CEZAR_PID=$!
trap 'kill $CEZAR_PID 2>/dev/null || true' EXIT INT TERM

wait_for_health 60 || { tail -50 "$DEMO_ROOT/cezar.log"; die "cezar did not start"; }
attach_account "$EMAIL" || warn "no relay account attached; the code stays closed until one is"
"$HERE/seed.sh" tasks

log "Cockpit:   http://127.0.0.1:$DEMO_PORT (this machine only)"
log "Demo code: $CODE   (CezarBot > Enter code)"
log "Relay:     ${RELAY:-default}; account $(account_state)"
log "State:     $DEMO_ROOT  (log: $DEMO_ROOT/cezar.log)"
wait "$CEZAR_PID"
