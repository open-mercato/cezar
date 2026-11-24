#!/usr/bin/env bash
# Stand up the store-review demo on a fresh Ubuntu 24.04 VPS: a dry-run, hosted cezar behind Caddy
# (TLS + Basic auth), seeded with a demo project, reset nightly. Idempotent; run as root:
#
#   sudo ./setup.sh <cezar-version>            # e.g. 0.20.0
#   sudo ./setup.sh <cezar-version> --reset    # also wipe and re-seed now
#
# Reads the domain and the reviewer login from /etc/cezar-demo/demo.env (README.md, "Credentials").
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
. "$HERE/common.sh"

usage() { printf 'usage: sudo %s <cezar-version> [--reset]\n' "$0" >&2; exit 2; }
[ $# -ge 1 ] || usage
CEZAR_VERSION=$1
shift
FORCE_RESET=0
for arg in "$@"; do
  case "$arg" in --reset) FORCE_RESET=1 ;; *) usage ;; esac
done
# A pinned, exact version: a dist-tag would let the demo drift between reviews.
printf '%s' "$CEZAR_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
  die "cezar version must be exact, like 0.20.0 (got '$CEZAR_VERSION')"

require_root
take_lock
read_config

. /etc/os-release
if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != 24.04 ]; then
  warn "written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}; continuing"
fi

export DEBIAN_FRONTEND=noninteractive

# ---- packages ---------------------------------------------------------------------------------
log "Installing base packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git jq debian-keyring debian-archive-keyring apt-transport-https
install -d -m 0755 /etc/apt/keyrings

node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [ "$(node_major)" != 22 ]; then
  log "Installing Node 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
[ "$(node_major)" = 22 ] || die "Node 22 did not install (node is $(node -v 2>/dev/null || echo missing))"

if ! command -v caddy >/dev/null 2>&1; then
  log "Installing Caddy from its official repository"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

installed_cezar() { npm ls -g --depth=0 --json 2>/dev/null | jq -r '.dependencies["@open-mercato/cezar"].version // empty'; }
if [ "$(installed_cezar)" != "$CEZAR_VERSION" ]; then
  log "Installing @open-mercato/cezar@$CEZAR_VERSION"
  npm install -g --no-fund --no-audit "@open-mercato/cezar@$CEZAR_VERSION"
fi
[ "$(installed_cezar)" = "$CEZAR_VERSION" ] || die "cezar $CEZAR_VERSION did not install"
CEZAR_BIN=$(command -v cezar) || die "the cezar binary is not on PATH after npm install -g"

# ---- user and files ---------------------------------------------------------------------------
if ! id "$DEMO_USER_NAME" >/dev/null 2>&1; then
  log "Creating system user $DEMO_USER_NAME"
  useradd --system --home-dir "$DEMO_ROOT" --create-home --shell /usr/sbin/nologin "$DEMO_USER_NAME"
fi
install -d -o "$DEMO_USER_NAME" -g "$DEMO_USER_NAME" -m 0700 "$DEMO_ROOT" "$DEMO_CEZ_HOME" "$DEMO_PROJECTS"

log "Installing the demo scripts and pairing page into $DEMO_OPT"
install -d -m 0755 "$DEMO_OPT" "$DEMO_OPT/pair"
install -m 0644 "$HERE/common.sh" "$DEMO_OPT/common.sh"
install -m 0755 "$HERE/seed.sh" "$DEMO_OPT/seed.sh"
install -m 0755 "$HERE/reset.sh" "$DEMO_OPT/reset.sh"
install -m 0644 "$HERE/pair/index.html" "$HERE/pair/pair.js" "$HERE/pair/pair.css" "$DEMO_OPT/pair/"

# ---- cezar service ----------------------------------------------------------------------------
# Not `cezar server-install`: see README.md, "Why not server-install". Every env var is cited there.
UNIT=/etc/systemd/system/$DEMO_SERVICE
# The login is a shell (see below), so by default that shell reaches nothing but loopback. Relay pairing
# needs the relay on the internet: DEMO_RELAY=1 lifts the lock (README.md, "Threat model").
if [ "$DEMO_RELAY" = 1 ]; then
  EGRESS='# DEMO_RELAY=1: outbound network open, for the relay'
else
  EGRESS=$'Environment=CEZ_RELAY=0\nIPAddressDeny=any\nIPAddressAllow=localhost'
fi
cat >"$UNIT.tmp" <<EOF
# Managed by packages/mobile/demo/setup.sh — rerun it rather than editing this file.
[Unit]
Description=cezar store-review demo (dry run, hosted)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$DEMO_USER_NAME
Group=$DEMO_USER_NAME
WorkingDirectory=$DEMO_REPO
Environment=HOME=$DEMO_ROOT
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=CEZ_HOME=$DEMO_CEZ_HOME
# Agents are the bundled mock: no model calls, no LLM keys on this box.
Environment=CEZ_DRY_RUN=1
Environment=CEZ_REMOTE=1
Environment=CEZ_TERMINAL=0
Environment=CEZ_BROWSE_ROOT=$DEMO_PROJECTS
Environment=CEZ_PROJECTS_DIR=$DEMO_PROJECTS
Environment=CEZ_SECRETS_KEYCHAIN=0
Environment=CEZ_TELEMETRY=0
Environment=CEZ_NO_BANNER=1
Environment=CEZ_SKILLS_AUTO_UPDATE=0
Environment=CEZ_ARTIFACTS_CDN=0
Environment=GIT_TERMINAL_PROMPT=0
Environment=GIT_AUTHOR_NAME=Cezar Demo
Environment=GIT_AUTHOR_EMAIL=demo@cezar.invalid
Environment=GIT_COMMITTER_NAME=Cezar Demo
Environment=GIT_COMMITTER_EMAIL=demo@cezar.invalid
ExecStart=$CEZAR_BIN serve --no-open --port $DEMO_PORT
$EGRESS
Restart=on-failure
RestartSec=5

# Check steps still run real bash under CEZ_DRY_RUN=1 (README.md, "Threat model"), so whoever holds
# the reviewer login is assumed to have a shell as $DEMO_USER_NAME. Keep that shell in a small box.
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DEMO_ROOT
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
MemoryMax=1200M
TasksMax=512
CPUQuota=80%

[Install]
WantedBy=multi-user.target
EOF
mv "$UNIT.tmp" "$UNIT"

cat >/etc/systemd/system/cezar-demo-reset.service <<EOF
# Managed by packages/mobile/demo/setup.sh.
[Unit]
Description=Reset the cezar store-review demo

[Service]
Type=oneshot
ExecStart=$DEMO_OPT/reset.sh
TimeoutStartSec=15min
EOF

cat >/etc/systemd/system/cezar-demo-reset.timer <<'EOF'
# Managed by packages/mobile/demo/setup.sh.
[Unit]
Description=Reset the cezar store-review demo nightly at 03:00 UTC

[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable "$DEMO_SERVICE" >/dev/null

# ---- Caddy: TLS + Basic auth ------------------------------------------------------------------
log "Writing the Caddyfile for $DEMO_DOMAIN"
# The password reaches caddy on stdin, never in argv. Only the bcrypt hash is written to disk.
HASH=$(printf '%s\n' "$DEMO_PASSWORD" | caddy hash-password) || die "caddy hash-password failed"
case "$HASH" in '$2'*) ;; *) die "caddy hash-password returned something that is not a bcrypt hash" ;; esac
GLOBAL_BLOCK=''
[ -n "$ACME_EMAIL" ] && GLOBAL_BLOCK=$(printf '{\n\temail %s\n}\n' "$ACME_EMAIL")
CADDYFILE=/etc/caddy/Caddyfile
cat >"$CADDYFILE.tmp" <<EOF
# Managed by packages/mobile/demo/setup.sh — rerun it rather than editing this file.
$GLOBAL_BLOCK
$DEMO_DOMAIN {
	# Everything, /api/v1/health included, sits behind the login: the app reads a Basic challenge
	# on health as "this server needs a password" (HealthClassifier.java). Keep the realm fixed:
	# a changed realm makes every installed app ask for the password again (ShellConnector.java).
	basic_auth bcrypt cezar-demo {
		$DEMO_USER $HASH
	}
	header X-Robots-Tag "noindex, nofollow"

	redir /demo-pair /demo-pair/ 308
	handle_path /demo-pair/* {
		header Cache-Control no-store
		header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
		root * $DEMO_OPT/pair
		file_server
	}

	handle {
		# Caddy keeps the client's Host and streams text/event-stream unbuffered, which cezar's
		# same-origin guard and its SSE run streams both need.
		reverse_proxy 127.0.0.1:$DEMO_PORT
	}
}
EOF
chown root:caddy "$CADDYFILE.tmp"
chmod 0640 "$CADDYFILE.tmp"
caddy validate --adapter caddyfile --config "$CADDYFILE.tmp" >/dev/null 2>&1 ||
  { caddy validate --adapter caddyfile --config "$CADDYFILE.tmp" || true; die "the generated Caddyfile does not validate"; }
mv "$CADDYFILE.tmp" "$CADDYFILE"
unset HASH DEMO_PASSWORD
systemctl enable caddy >/dev/null
if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl start caddy; fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  log "ufw is active: allowing 80/tcp, 443/tcp and 443/udp"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
fi

# ---- seed or restart --------------------------------------------------------------------------
if [ "$FORCE_RESET" = 1 ] || [ ! -d "$DEMO_REPO/.git" ]; then
  log "Seeding (reset.sh)"
  "$DEMO_OPT/reset.sh"
else
  log "Restarting $DEMO_SERVICE (demo data kept; pass --reset to wipe it)"
  systemctl restart "$DEMO_SERVICE"
  wait_for_health 90 || die "cezar did not answer on 127.0.0.1:$DEMO_PORT. Check: journalctl -u $DEMO_SERVICE -n 100"
fi
systemctl enable --now cezar-demo-reset.timer >/dev/null

# ---- verify -----------------------------------------------------------------------------------
HEALTH=$(curl -fsS "$DEMO_API/health")
log "cezar answers on loopback: version $(printf '%s' "$HEALTH" | jq -r '.version // "?"'), managers $(printf '%s' "$HEALTH" | jq -r '.capabilities.managers | tostring')"
EDGE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DEMO_DOMAIN/api/v1/health" || true)
if [ "$EDGE" = 401 ]; then
  log "https://$DEMO_DOMAIN/api/v1/health answers 401 without a login, as it should"
else
  warn "https://$DEMO_DOMAIN/api/v1/health answered '$EDGE', expected 401. If the certificate is still being issued, wait a minute (journalctl -u caddy -n 50) and check DNS."
fi
OWN=$(hostname -I 2>/dev/null || true)
RESOLVED=$(getent ahosts "$DEMO_DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
log "DNS: $DEMO_DOMAIN -> ${RESOLVED:-nothing}; this host: ${OWN:-unknown}"
log "Done. Next reset: $(systemctl show cezar-demo-reset.timer -p NextElapseUSecRealtime --value 2>/dev/null || echo '03:00 UTC')"
