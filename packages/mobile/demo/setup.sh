#!/usr/bin/env bash
# Stand up the store-review demo on a fresh Ubuntu 24.04 VPS: a dry-run cezar reachable ONLY through
# the phone relay, with a fixed, auto-approved pairing code, seeded with sample data and reset nightly.
# No domain, no TLS, no open inbound port. Idempotent; run as root (deploy.sh does it for you):
#
#   sudo ./setup.sh --tarball cezar.tgz --relay-email demo@example.com [--code K7QM-3XNA-9VPD] [--relay-url URL] [--reset]
#
# Branch demo/store-review only: the cezar it installs must carry CEZ_DEMO and CEZ_RELAY_DEMO_CODE.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
. "$HERE/common.sh"

usage() { printf 'usage: sudo %s --tarball <cezar.tgz> --relay-email <address> [--code <code>] [--relay-url <url>] [--reset]\n' "$0" >&2; exit 2; }
TARBALL='' EMAIL='' CODE='' RELAY_URL='' FORCE_RESET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) TARBALL=$2; shift 2 ;;
    --relay-email) EMAIL=$2; shift 2 ;;
    --code) CODE=$2; shift 2 ;;
    --relay-url) RELAY_URL=$2; shift 2 ;;
    --reset) FORCE_RESET=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || usage

require_root
take_lock

. /etc/os-release
[ "${ID:-}" = ubuntu ] || warn "written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}; continuing"
export DEBIAN_FRONTEND=noninteractive

# ---- config -------------------------------------------------------------------------------------
install -d -m 0700 "$DEMO_ETC"
if [ ! -f "$DEMO_CONFIG" ]; then
  [ -n "$EMAIL" ] || die "first run: pass --relay-email (the demo's own relay account, never yours)"
  ( umask 077; {
    echo "CEZ_RELAY_DEMO_CODE=${CODE:-$(new_code)}"
    echo "RELAY_EMAIL=$EMAIL"
    echo "RELAY_KEEP_DAYS=3"
    [ -n "$RELAY_URL" ] && echo "CEZ_RELAY_URL=$RELAY_URL"
  } >"$DEMO_CONFIG" )
  log "Wrote $DEMO_CONFIG"
else
  # Later runs change only what was passed.
  [ -n "$CODE" ] && sed -i "s/^CEZ_RELAY_DEMO_CODE=.*/CEZ_RELAY_DEMO_CODE=$CODE/" "$DEMO_CONFIG"
  [ -n "$EMAIL" ] && sed -i "s/^RELAY_EMAIL=.*/RELAY_EMAIL=$EMAIL/" "$DEMO_CONFIG"
fi
chmod 600 "$DEMO_CONFIG"
read_config

# ---- packages -----------------------------------------------------------------------------------
log "Installing base packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git jq nftables
install -d -m 0755 /etc/apt/keyrings
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [ "$(node_major)" != 22 ]; then
  log "Installing Node 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' >/etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
[ "$(node_major)" = 22 ] || die "Node 22 did not install"

install -d -m 0755 "$DEMO_OPT"
SUM=$(sha256sum "$TARBALL" | cut -d' ' -f1)
if [ "$(cat "$DEMO_OPT/cezar.sha256" 2>/dev/null)" != "$SUM" ]; then
  log "Installing cezar from $(basename "$TARBALL")"
  npm install -g --no-fund --no-audit "$TARBALL"
  echo "$SUM" >"$DEMO_OPT/cezar.sha256"
fi
CEZAR_BIN=$(command -v cezar) || die "the cezar binary is not on PATH after npm install -g"

# ---- user and files -----------------------------------------------------------------------------
if ! id "$DEMO_USER_NAME" >/dev/null 2>&1; then
  log "Creating system user $DEMO_USER_NAME"
  useradd --system --home-dir "$DEMO_ROOT" --create-home --shell /usr/sbin/nologin "$DEMO_USER_NAME"
fi
install -d -o "$DEMO_USER_NAME" -g "$DEMO_USER_NAME" -m 0700 "$DEMO_ROOT" "$DEMO_CEZ_HOME" "$DEMO_PROJECTS"
install -m 0644 "$HERE/common.sh" "$DEMO_OPT/common.sh"
install -m 0755 "$HERE/seed.sh" "$HERE/reset.sh" "$DEMO_OPT/"

# ---- egress: DNS and HTTPS only, for the demo user ------------------------------------------------
# The relay is Cloudflare anycast, so no IP list fits; ports are what we can pin.
cat >"$DEMO_ETC/egress.nft" <<EOF
table inet cezar_demo
delete table inet cezar_demo
table inet cezar_demo {
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid "$DEMO_USER_NAME" oif lo accept
    meta skuid "$DEMO_USER_NAME" udp dport 53 accept
    meta skuid "$DEMO_USER_NAME" tcp dport { 53, 443 } accept
    meta skuid "$DEMO_USER_NAME" counter drop
  }
}
EOF
cat >/etc/systemd/system/cezar-demo-egress.service <<EOF
# Managed by packages/mobile/demo/setup.sh.
[Unit]
Description=Egress filter for the cezar store-review demo
Before=$DEMO_SERVICE
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $DEMO_ETC/egress.nft
ExecStop=/usr/sbin/nft delete table inet cezar_demo
[Install]
WantedBy=multi-user.target
EOF

# ---- services -----------------------------------------------------------------------------------
cat >"/etc/systemd/system/$DEMO_SERVICE" <<EOF
# Managed by packages/mobile/demo/setup.sh — rerun it rather than editing this file.
[Unit]
Description=cezar store-review demo (dry run, relay only)
After=network-online.target cezar-demo-egress.service
Wants=network-online.target
Requires=cezar-demo-egress.service

[Service]
Type=simple
User=$DEMO_USER_NAME
Group=$DEMO_USER_NAME
WorkingDirectory=$DEMO_REPO
EnvironmentFile=$DEMO_CONFIG
Environment=HOME=$DEMO_ROOT
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=CEZ_HOME=$DEMO_CEZ_HOME
# Mock agents only; CEZ_DEMO locks a phone to the demo's own actions and never runs a check step.
Environment=CEZ_DRY_RUN=1
Environment=CEZ_DEMO=1
Environment=CEZ_REMOTE=1
Environment=CEZ_TERMINAL=0
Environment=CEZ_BROWSE_ROOT=$DEMO_PROJECTS
Environment=CEZ_PROJECTS_DIR=$DEMO_PROJECTS
Environment=CEZ_SECRETS_KEYCHAIN=0
Environment=CEZ_TELEMETRY=0
Environment=CEZ_NO_BANNER=1
Environment=CEZ_SKILLS_AUTO_UPDATE=0
Environment=CEZ_ARTIFACTS_CDN=0
Environment=CEZ_RELAY_KEEP_AWAKE=0
Environment=GIT_TERMINAL_PROMPT=0
Environment=GIT_AUTHOR_NAME=Cezar Demo
Environment=GIT_AUTHOR_EMAIL=demo@cezar.invalid
Environment=GIT_COMMITTER_NAME=Cezar Demo
Environment=GIT_COMMITTER_EMAIL=demo@cezar.invalid
ExecStart=$CEZAR_BIN serve --no-open --port $DEMO_PORT
Restart=always
RestartSec=5

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

timer() { # name, description, OnCalendar, command
  cat >"/etc/systemd/system/cezar-demo-$1.service" <<EOF
# Managed by packages/mobile/demo/setup.sh.
[Unit]
Description=$2
[Service]
Type=oneshot
ExecStart=$4
TimeoutStartSec=15min
EOF
  cat >"/etc/systemd/system/cezar-demo-$1.timer" <<EOF
# Managed by packages/mobile/demo/setup.sh.
[Unit]
Description=$2
[Timer]
OnCalendar=$3
Persistent=true
[Install]
WantedBy=timers.target
EOF
}
timer reset 'Reset the cezar store-review demo nightly' '*-*-* 03:00:00 UTC' "$DEMO_OPT/reset.sh"
timer tick 'Keep a task running on the cezar store-review demo' '*-*-* 00/2:30:00 UTC' \
  "/usr/sbin/runuser -u $DEMO_USER_NAME -- env HOME=$DEMO_ROOT $DEMO_OPT/seed.sh tick"

systemctl daemon-reload
systemctl enable --now cezar-demo-egress.service >/dev/null
systemctl enable "$DEMO_SERVICE" >/dev/null

# ---- seed or restart ----------------------------------------------------------------------------
if [ "$FORCE_RESET" = 1 ] || [ ! -d "$DEMO_REPO/.git" ]; then
  log "Seeding (reset.sh)"
  "$DEMO_OPT/reset.sh"
else
  log "Restarting $DEMO_SERVICE (demo data kept; pass --reset to wipe it)"
  systemctl restart "$DEMO_SERVICE"
  wait_for_health 90 || die "cezar did not answer. Check: journalctl -u $DEMO_SERVICE -n 100"
  attach_account "$RELAY_EMAIL" || true
fi
systemctl enable --now cezar-demo-reset.timer cezar-demo-tick.timer >/dev/null

# ---- summary ------------------------------------------------------------------------------------
log "Waiting for the pairing code to open on the relay"
CEZAR_ID=''
for ((i = 0; i < 60; i++)); do
  CEZAR_ID=$(journalctl -u "$DEMO_SERVICE" --since '-30 min' -o cat 2>/dev/null | sed -n 's/.*pairing code open on .* for cezarId \([A-Za-z0-9_-]*\).*/\1/p' | tail -1)
  [ -n "$CEZAR_ID" ] && break
  sleep 3
done
HEALTH=$(curl -fsS "$DEMO_API/health" || echo '{}')
cat <<EOF

  cezar store-review demo
  ------------------------------------------------------------
  Demo code:  $CEZ_RELAY_DEMO_CODE   (CezarBot > Enter code)
  Relay:      ${CEZ_RELAY_URL:-default (https://rome.cezar.run)}
  cezarId:    ${CEZAR_ID:-not open yet: journalctl -u $DEMO_SERVICE | grep demo}
  Account:    $RELAY_EMAIL — $(account_state)  (pending: click the link the relay emailed)
  cezar:      $(printf '%s' "$HEALTH" | jq -r '.version // "?"')
  Next reset: $(systemctl show cezar-demo-reset.timer -p NextElapseUSecRealtime --value 2>/dev/null || echo '03:00 UTC')

  Give rome the cezarId above for the demo rate-limit override (docs: packages/mobile/demo/README.md).
EOF
