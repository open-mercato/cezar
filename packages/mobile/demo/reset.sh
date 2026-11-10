#!/usr/bin/env bash
# Put the demo back to its seeded state. Run as root; the nightly timer (03:00 UTC) runs it too.
#
#   sudo /opt/cezar-demo/reset.sh            # wipe and re-seed; keep the relay identity and recent phones
#   sudo /opt/cezar-demo/reset.sh --fresh    # also forget the relay identity: every paired phone must pair again
#
# Survives a reset: the Caddy config and certificates, the reviewer login, the installed cezar and,
# unless --fresh, $CEZ_HOME/relay (README.md, "What a reset keeps").
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
. "$HERE/common.sh"

FRESH=0
for arg in "$@"; do
  case "$arg" in --fresh) FRESH=1 ;; *) printf 'usage: sudo %s [--fresh]\n' "$0" >&2; exit 2 ;; esac
done

require_root
take_lock
read_config
unset DEMO_PASSWORD

# ---- 1. revoke old phones while cezar still runs ------------------------------------------------
# DELETE goes through cezar so the relay hears `device-remove`; editing devices.json by hand would
# leave the phone on the relay's allowlist, which holds 10 per cezar (RELAY_PROTOCOL.md § 8).
if [ "$FRESH" = 0 ] && systemctl is-active --quiet "$DEMO_SERVICE" && wait_for_health 5; then
  CUTOFF=$(date -u -d "-$RELAY_KEEP_DAYS days" +%Y-%m-%dT%H:%M:%S.000Z)
  RESP=$(api GET /workspace/phones || true)
  if [ "$(api_status "$RESP")" = 200 ]; then
    OLD=$(api_body "$RESP" | jq -r --arg cutoff "$CUTOFF" '.phones[] | select(.addedAt < $cutoff) | .deviceId')
    REMOVED=0
    for device in $OLD; do
      case "$device" in *[!A-Za-z0-9_-]*) warn "skipping odd device id"; continue ;; esac
      [ "$(api_status "$(api DELETE "/workspace/phones/$device")")" = 200 ] && REMOVED=$((REMOVED + 1))
    done
    if [ "$REMOVED" -gt 0 ]; then
      log "Removed $REMOVED phone(s) paired before $CUTOFF"
      sleep 5 # let the removals reach the relay; one that does not is resent on the next connect
    fi
  else
    log "Phone list unavailable (relay off?); nothing to revoke"
  fi
fi

# ---- 2. stop and wipe --------------------------------------------------------------------------
log "Stopping $DEMO_SERVICE"
systemctl stop "$DEMO_SERVICE" || true

case "$DEMO_ROOT" in /var/lib/cezar-demo) ;; *) die "refusing to wipe unexpected DEMO_ROOT '$DEMO_ROOT'" ;; esac
log "Wiping demo state under $DEMO_ROOT"
# Everything in the user's home except CEZ_HOME itself: projects, worktrees, caches, agent leftovers.
find "$DEMO_ROOT" -mindepth 1 -maxdepth 1 ! -name home -exec rm -rf -- {} +
if [ "$FRESH" = 1 ]; then
  find "$DEMO_CEZ_HOME" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
else
  # CEZ_HOME: config, registry, managers, secrets, agent scratch; only relay/ stays.
  find "$DEMO_CEZ_HOME" -mindepth 1 -maxdepth 1 ! -name relay -exec rm -rf -- {} +
fi
install -d -o "$DEMO_USER_NAME" -g "$DEMO_USER_NAME" -m 0700 "$DEMO_ROOT" "$DEMO_CEZ_HOME" "$DEMO_PROJECTS"

# ---- 3. seed -----------------------------------------------------------------------------------
log "Creating the demo repository"
runuser -u "$DEMO_USER_NAME" -- env HOME="$DEMO_ROOT" "$DEMO_OPT/seed.sh" repo

log "Starting $DEMO_SERVICE"
systemctl start "$DEMO_SERVICE"
wait_for_health 90 || die "cezar did not come back. Check: journalctl -u $DEMO_SERVICE -n 100"

log "Seeding tasks and a manager"
runuser -u "$DEMO_USER_NAME" -- env HOME="$DEMO_ROOT" "$DEMO_OPT/seed.sh" tasks || warn "seeding tasks failed; the cockpit is up but may look empty"
log "Reset complete"
