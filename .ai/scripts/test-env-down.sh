#!/bin/sh
# om-prepare-test-env: generated entrypoint (contract v2)
# regenerate with: om-prepare-test-env --regenerate
# history:
#   2026-07-14 generated — mirrors test-env-up.sh; no services to remove, so this
#             only stops the app PID this repo started and marks the descriptor stopped.
#   2026-08-17 prove the recorded PID is still this worktree's server before signalling
#             it, and clear the PID on stop — a descriptor outlives reboots, so its PID
#             number is routinely recycled onto an unrelated process (#898).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
QA_DIR="$REPO_ROOT/.ai/qa"
ENV_DESCRIPTOR="$QA_DIR/test-env.json"

log() { echo "[test-env] $*" >&2; }

[ -f "$ENV_DESCRIPTOR" ] || { log "no descriptor — nothing to stop"; exit 0; }

pid=$(node -e '
  const fs = require("fs");
  try {
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (d.startedByThisRepo && d.app && d.app.pid) process.stdout.write(String(d.app.pid));
  } catch { /* corrupt descriptor → nothing safe to stop */ }
' "$ENV_DESCRIPTOR" 2>/dev/null || true)

# The process fingerprint, duplicated from test-env-up.sh on purpose: these two are
# deliberately standalone entrypoints, and the guard has to hold in both. `startedByThisRepo`
# cannot carry it — up writes it as the literal true on every boot — and a bare `kill -0`
# only proves *some* process holds that number. start_app launches
# `node packages/cezar/dist/index.js … --repo $REPO_ROOT`, which names this worktree alone;
# the match is anchored at end-of-argv (or a space) so the main checkout cannot claim a
# worktree's server, `<root>` being a prefix of `<root>/.ai/cezar/worktrees/<id>`.
is_our_server() {
  [ -n "${1:-}" ] || return 1
  cmd=$(ps -ww -o command= -p "$1" 2>/dev/null || true)
  case "$cmd" in
    *"packages/cezar/dist/index.js"*"--repo $REPO_ROOT") return 0 ;;
    *"packages/cezar/dist/index.js"*"--repo $REPO_ROOT "*) return 0 ;;
  esac
  return 1
}

if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ! is_our_server "$pid"; then
  log "descriptor pid $pid is not this worktree's server — leaving it alone"
  pid=
fi

# Only ever stop what this repo started; safe to run twice.
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  log "stopping cezar (pid $pid)"
  kill "$pid" 2>/dev/null || true
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -9 "$pid" 2>/dev/null || true
else
  log "app is already stopped"
fi

node -e '
  const fs = require("fs");
  const f = process.argv[1];
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.status = "stopped";
    // Defence in depth: a cleanly stopped descriptor must not nominate any PID at all.
    // (The identity guards above still matter — a crashed run leaves status "running"
    // with a dead PID, and this line never gets to run.)
    if (d.app) d.app.pid = null;
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  } catch { /* leave a corrupt descriptor alone — up will treat it as stale */ }
' "$ENV_DESCRIPTOR"

rm -rf "$QA_DIR/test-env.lock" 2>/dev/null || true
echo "TEST_ENV_STATUS=stopped"
