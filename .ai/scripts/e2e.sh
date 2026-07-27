#!/bin/sh
# Runs the cockpit e2e suite: boot (or reuse) the test env, then drive it through the
# configured browser provider. Invoked by `npm run test:e2e` — the dispatcher's UI gate.
#
# Exit codes (documented contract — the pipeline depends on these):
#   0  + TEST_E2E_STATUS=passed   every spec passed
#   0  + TEST_E2E_STATUS=skipped  the browser provider could not be provisioned on this
#                                 machine (no network / unsupported platform / sandbox).
#                                 Loud, greppable, and deliberately non-blocking — a machine
#                                 that cannot run a browser must not masquerade as a failure,
#                                 and must not masquerade as a pass either.
#   non-zero + TEST_E2E_STATUS=failed  a spec failed, or the env could not boot.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

skip() {
  cat >&2 <<EOF

################################################################################
# E2E SKIPPED — the UI was NOT verified.
#
# Reason: $1
#
# The agent-browser provider (.ai/browsers/agent-browser.md) could not be
# provisioned here, so no spec ran. This is NOT a pass. Re-run on a machine with
# network access to the GitHub Releases and Chrome-for-Testing hosts.
################################################################################

EOF
  echo "TEST_E2E_STATUS=skipped"
  exit 0
}

# ---- 1. boot or reuse the environment ---------------------------------------
# The up script is the single source of truth for how this app boots; it also runs the
# provider's ensure-installed operation and records the result in the descriptor.
if ! sh "$SCRIPT_DIR/test-env-up.sh" "$@"; then
  echo "TEST_E2E_STATUS=failed" >&2
  exit 1
fi

# ---- 2. gate on the provider ------------------------------------------------
DESCRIPTOR="$REPO_ROOT/.ai/qa/test-env.json"
installed=$(node -e '
  const fs = require("fs");
  try {
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(d.browser && d.browser.installed ? "1" : "0");
  } catch { process.stdout.write("0"); }
' "$DESCRIPTOR" 2>/dev/null || echo 0)

if [ "$installed" != 1 ]; then
  notes=$(node -e '
    const fs = require("fs");
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write((d.browser && d.browser.notes) || "agent-browser is unavailable");
    } catch { process.stdout.write("no test-env descriptor"); }
  ' "$DESCRIPTOR" 2>/dev/null || echo "agent-browser is unavailable")
  skip "$notes"
fi

# ---- 3. run the specs -------------------------------------------------------
cd "$REPO_ROOT"
if npx vitest run --config packages/web/e2e/vitest.config.ts; then
  echo "TEST_E2E_STATUS=passed"
  exit 0
fi
echo "TEST_E2E_STATUS=failed" >&2
exit 1
