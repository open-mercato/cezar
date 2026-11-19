# shellcheck shell=bash
# Shared paths and helpers for the store-review demo (setup.sh, reset.sh, seed.sh). Sourced, never run.

DEMO_USER_NAME=cezar-demo
DEMO_ROOT=/var/lib/cezar-demo             # the service user's home; everything the demo writes lives here
DEMO_CEZ_HOME=$DEMO_ROOT/home             # CEZ_HOME (instead of ~/.cezar)
DEMO_PROJECTS=$DEMO_ROOT/projects         # CEZ_BROWSE_ROOT and CEZ_PROJECTS_DIR
DEMO_REPO=$DEMO_PROJECTS/demo-app         # the boot project (the service's WorkingDirectory)
DEMO_OPT=/opt/cezar-demo                  # installed copies of these scripts and the pairing page
DEMO_ETC=/etc/cezar-demo
DEMO_CONFIG=$DEMO_ETC/demo.env            # root-only: domain and the reviewer login
DEMO_PORT=4321
DEMO_API=http://127.0.0.1:$DEMO_PORT/api/v1
DEMO_SERVICE=cezar-demo.service
DEMO_LOCK=/run/cezar-demo.lock

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

# Reads KEY=VALUE lines without evaluating them, so a password may hold $, quotes or spaces.
read_config() {
  [ -f "$DEMO_CONFIG" ] || die "$DEMO_CONFIG is missing. Create it first (see README.md, 'Credentials')."
  local owner mode line key val
  owner=$(stat -c %u "$DEMO_CONFIG")
  mode=$(stat -c %a "$DEMO_CONFIG")
  [ "$owner" = 0 ] || die "$DEMO_CONFIG must be owned by root"
  [ "$mode" = 600 ] || [ "$mode" = 400 ] || die "$DEMO_CONFIG must be mode 600 (it is $mode): chmod 600 $DEMO_CONFIG"
  DEMO_DOMAIN='' DEMO_USER='' DEMO_PASSWORD='' ACME_EMAIL='' RELAY_KEEP_DAYS=3 DEMO_RELAY=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    # Strip one pair of surrounding quotes, nothing else.
    case "$val" in \"*\") val=${val#\"}; val=${val%\"} ;; \'*\') val=${val#\'}; val=${val%\'} ;; esac
    case "$key" in
      DEMO_DOMAIN | DEMO_USER | DEMO_PASSWORD | ACME_EMAIL | RELAY_KEEP_DAYS | DEMO_RELAY) printf -v "$key" '%s' "$val" ;;
      *) warn "ignoring unknown key '$key' in $DEMO_CONFIG" ;;
    esac
  done <"$DEMO_CONFIG"
  printf '%s' "$DEMO_DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$' ||
    die "DEMO_DOMAIN must be a lowercase host name like cezar-demo.example.com"
  # Caddy's basic_auth takes the user as a bare token, and the app sends it in a Basic header.
  printf '%s' "$DEMO_USER" | grep -Eq '^[A-Za-z0-9._-]{3,64}$' ||
    die "DEMO_USER must be 3-64 characters of letters, digits, '.', '_' or '-'"
  [ "${#DEMO_PASSWORD}" -ge 16 ] || die "DEMO_PASSWORD must be at least 16 characters"
  case "$DEMO_PASSWORD" in *[[:space:]]*) die "DEMO_PASSWORD must not contain whitespace (reviewers type it)" ;; esac
  case "$RELAY_KEEP_DAYS" in '' | *[!0-9]*) die "RELAY_KEEP_DAYS must be a whole number of days" ;; esac
  case "$DEMO_RELAY" in 0 | 1) ;; *) die "DEMO_RELAY must be 0 or 1" ;; esac
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
