#!/bin/sh
# Runs the `@e2e-dev/web` suites (packages/web/e2e/*.config.ts — chat, Telegram,
# extensions, webhooks). Invoked by `npm run test:e2e:runner [name ...]`, e.g. `telegram-inbound`.
# They are excluded from `npm run test:e2e` (vitest) by design: each config boots its own
# disposable cockpit + simulator, so nothing here reuses the shared test env.
#
# Every config is discovered, never listed, so a new suite cannot be forgotten. All of them run
# under the loopback guard (loopback-netguard.c, LD_PRELOAD): no spec can reach the network.
#
# Exit contract (mirrors e2e.sh):
#   0 + TEST_E2E_RUNNER_STATUS=passed   every selected config passed
#   0 + TEST_E2E_RUNNER_STATUS=skipped  no C compiler / not Linux — the guard cannot be built;
#                                       loud, and NOT a pass
#   non-zero + TEST_E2E_RUNNER_STATUS=failed
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
E2E_DIR="$REPO_ROOT/packages/web/e2e"
cd "$REPO_ROOT"

skip() {
  printf '\n# E2E RUNNER SKIPPED — the chat/extension suites were NOT verified.\n# Reason: %s\n\n' "$1" >&2
  echo "TEST_E2E_RUNNER_STATUS=skipped"
  exit 0
}

[ "$(uname -s)" = Linux ] || skip "the LD_PRELOAD loopback guard needs Linux"
CC=${CC:-cc}
command -v "$CC" >/dev/null 2>&1 || skip "no C compiler ($CC) to build the loopback guard"

GUARD_DIR=$(mktemp -d)
trap 'rm -rf "$GUARD_DIR"' EXIT INT TERM
GUARD="$GUARD_DIR/netguard.so"
timeout 60 "$CC" -shared -fPIC "$E2E_DIR/loopback-netguard.c" -o "$GUARD" -ldl

# The suites drive the BUILT cockpit and the stamped chat adapters; build under the guard when missing.
if [ ! -f "$REPO_ROOT/packages/cezar/dist/chat-plugins/catalog.json" ]; then
  LD_PRELOAD="$GUARD" timeout 900 npm run build
elif [ ! -f "$REPO_ROOT/packages/cezar/web/dist/index.html" ]; then
  LD_PRELOAD="$GUARD" timeout 300 npm run build:web
fi

configs=""
if [ "$#" -gt 0 ]; then
  for name in "$@"; do configs="$configs $E2E_DIR/${name%.config.ts}.config.ts"; done
else
  for cfg in "$E2E_DIR"/*.config.ts; do
    # vitest.config.ts and the harness bundlers (*.vite.config.ts) are not e2e suites.
    case "$(basename "$cfg")" in vitest.config.ts | *.vite.config.ts) continue ;; esac
    configs="$configs $cfg"
  done
fi

failed=""
for cfg in $configs; do
  [ -f "$cfg" ] || { echo "no such config: $cfg" >&2; failed="$failed $(basename "$cfg")"; continue; }
  echo "==> $(basename "$cfg")"
  # e2e filters the app subprocess env: a config that wants the guard on its app forwards LD_PRELOAD.
  if ! LD_PRELOAD="$GUARD" E2E_TELEMETRY=0 timeout 600 npm exec --no -- e2e run --config "$cfg"; then
    failed="$failed $(basename "$cfg")"
  fi
done

if [ -n "$failed" ]; then
  echo "failed:$failed" >&2
  echo "TEST_E2E_RUNNER_STATUS=failed" >&2
  exit 1
fi
echo "TEST_E2E_RUNNER_STATUS=passed"
