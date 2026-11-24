# shellcheck shell=bash
# shellcheck disable=SC2034 # variables here are used by the scripts that source this file
# Shared paths and helpers for the store-review demo (setup.sh, reset.sh, seed.sh, local.sh). Sourced, never run.
# Every path can be overridden from the environment, which is how local.sh runs the same seed on a Mac.

: "${DEMO_USER_NAME:=cezar-demo}"
: "${DEMO_ROOT:=/var/lib/cezar-demo}"          # the service user's home; everything the demo writes lives here
: "${DEMO_CEZ_HOME:=$DEMO_ROOT/home}"           # CEZ_HOME (instead of ~/.cezar)
: "${DEMO_PROJECTS:=$DEMO_ROOT/projects}"       # CEZ_BROWSE_ROOT and CEZ_PROJECTS_DIR
: "${DEMO_REPO:=$DEMO_PROJECTS/todo-cli}"       # the boot project (the service's WorkingDirectory)
: "${DEMO_PORT:=4321}"
DEMO_API=http://127.0.0.1:$DEMO_PORT/api/v1
DEMO_OPT=/opt/cezar-demo                       # installed copies of these scripts
DEMO_ETC=/etc/cezar-demo
DEMO_CONFIG=$DEMO_ETC/demo.env                 # root-only: the pairing code and the relay account email
DEMO_SERVICE=cezar-demo.service
DEMO_LOCK=/run/cezar-demo.lock
# The relay account's terms (RELAY_TERMS in packages/contract/src/phones.ts), accepted by the operator.
DEMO_TERMS_VERSION=2026-11-13

log() { printf '[cezar-demo] %s\n' "$*"; }
warn() { printf '[cezar-demo] WARNING: %s\n' "$*" >&2; }
die() { printf '[cezar-demo] ERROR: %s\n' "$*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" = 0 ] || die "run this as root (sudo $0 …)"
}

# One setup/reset at a time. A child started by a parent that holds the lock inherits it.
take_lock() {
  if [ "${CEZAR_DEMO_LOCKED:-}" = 1 ]; then return 0; fi
  exec 9>"$DEMO_LOCK"
  flock -n 9 || die "another setup.sh or reset.sh is running"
  export CEZAR_DEMO_LOCKED=1
}

# A 12-character code of Crockford base32 (RELAY_PROTOCOL.md § 9.2), shown as XXXX-XXXX-XXXX.
new_code() {
  local alphabet=0123456789ABCDEFGHJKMNPQRSTVWXYZ code='' i byte
  for ((i = 0; i < 12; i++)); do
    byte=$(od -An -N1 -tu1 /dev/urandom | tr -d ' ')
    code+=${alphabet:$((byte % 32)):1}
  done
  printf '%s-%s-%s' "${code:0:4}" "${code:4:4}" "${code:8:4}"
}

# Reads KEY=VALUE lines without evaluating them.
read_config() {
  [ -f "$DEMO_CONFIG" ] || die "$DEMO_CONFIG is missing; setup.sh writes it"
  local owner mode line key val
  owner=$(stat -c %u "$DEMO_CONFIG")
  mode=$(stat -c %a "$DEMO_CONFIG")
  [ "$owner" = 0 ] || die "$DEMO_CONFIG must be owned by root"
  [ "$mode" = 600 ] || [ "$mode" = 400 ] || die "$DEMO_CONFIG must be mode 600 (it is $mode)"
  CEZ_RELAY_DEMO_CODE='' RELAY_EMAIL='' RELAY_KEEP_DAYS=3 CEZ_RELAY_URL=''
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    case "$key" in
      CEZ_RELAY_DEMO_CODE | RELAY_EMAIL | RELAY_KEEP_DAYS | CEZ_RELAY_URL) printf -v "$key" '%s' "$val" ;;
      *) warn "ignoring unknown key '$key' in $DEMO_CONFIG" ;;
    esac
  done <"$DEMO_CONFIG"
  printf '%s' "$CEZ_RELAY_DEMO_CODE" | grep -Eq '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$' ||
    die "CEZ_RELAY_DEMO_CODE must look like K7QM-3XNA-9VPD"
  printf '%s' "$RELAY_EMAIL" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+$' || die "RELAY_EMAIL must be an email address"
  case "$RELAY_KEEP_DAYS" in '' | *[!0-9]*) die "RELAY_KEEP_DAYS must be a whole number of days" ;; esac
}

# curl against cezar on loopback: prints the body, then the HTTP status on its own last line.
# No Origin header, so the same-origin write guard lets it through (server.ts, the /api/* guard).
api() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H 'content-type: application/json' -H 'accept: application/json' \
      --data-binary "$body" -w '\n%{http_code}' "$DEMO_API$path"
  else
    curl -sS -X "$method" -H 'accept: application/json' -w '\n%{http_code}' "$DEMO_API$path"
  fi
}
api_status() { printf '%s' "$1" | tail -n 1; }
api_body() { printf '%s' "$1" | sed '$d'; }

wait_for_health() {
  local tries=${1:-90} i
  for ((i = 0; i < tries; i++)); do
    if curl -fsS -o /dev/null "$DEMO_API/health" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

# Attach the demo's own relay account (RELAY_PROTOCOL.md § 18). The relay emails a confirmation
# link to RELAY_EMAIL once; until it is clicked the demo works for 48 hours.
attach_account() {
  local email=$1 resp
  # The name a phone shows for this computer while pairing and in its list.
  api PUT /workspace/phones/computer-name '{"name":"cezar demo"}' >/dev/null || true
  resp=$(api GET /workspace/phones)
  if [ "$(api_body "$resp" | jq -r '.account.attached')" = true ] &&
    [ "$(api_body "$resp" | jq -r '.account.email // empty')" = "$email" ]; then
    return 0
  fi
  resp=$(api POST /workspace/phones/account "$(jq -n --arg email "$email" --arg terms "$DEMO_TERMS_VERSION" '{email: $email, termsVersion: $terms, accepted: true}')")
  [ "$(api_status "$resp")" = 200 ] || { warn "attaching the relay account answered $(api_status "$resp"): $(api_body "$resp" | head -c 300)"; return 1; }
}

account_state() {
  api_body "$(api POST /workspace/phones/account/check)" | jq -r '.status.state // .reason // "unknown"' 2>/dev/null || echo unknown
}
