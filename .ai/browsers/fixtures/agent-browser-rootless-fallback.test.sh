#!/bin/sh
# Shell fixture for the POSIX ensure-installed operation in the descriptor.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DESCRIPTOR="${DESCRIPTOR_OVERRIDE:-$ROOT/../agent-browser.md}"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/agent-browser-fallback.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

extract_operation() {
  awk '
    index($0, sprintf("%c%c%c", 96, 96, 96)) == 1 {
      block++
      if (block == 1) { inside=1; next }
    }
    inside && index($0, sprintf("%c%c%c", 96, 96, 96)) == 1 { exit }
    inside { print }
  ' "$DESCRIPTOR"
}

mkdir -p "$TMP/bin" "$TMP/home/.agent-browser/deps/lib" "$TMP/home/.cache/agent-tools/chrome-deps/usr/lib/x86_64-linux-gnu"
: > "$TMP/home/.agent-browser/deps/lib/libfixture.so"
: > "$TMP/home/.cache/agent-tools/chrome-deps/usr/lib/x86_64-linux-gnu/libfixture.so.1"

cat > "$TMP/bin/agent-browser" <<'EOF'
#!/bin/sh
COMMAND=${1:-}
[ "$COMMAND" = "--session" ] && COMMAND=${3:-}
case "$COMMAND" in
  install) exit 0 ;;
  --version) echo "fixture-agent-browser 0.0.0" ;;
  doctor)
    [ "${FAKE_DOCTOR_ALWAYS_FAIL:-}" = 1 ] && exit 1
    case ",${AGENT_BROWSER_ARGS:-}," in *,--no-sandbox,*) ;; *) exit 1 ;; esac
    case ":${LD_LIBRARY_PATH:-}:" in *".agent-browser/deps/lib"*) exit 0 ;; *) exit 1 ;; esac
    ;;
  open|close)
    case ",${AGENT_BROWSER_ARGS:-}," in *,--no-sandbox,*) ;; *) exit 1 ;; esac
    case ":${LD_LIBRARY_PATH:-}:" in *".agent-browser/deps/lib"*) exit 0 ;; *) exit 1 ;; esac
    ;;
  *) exit 2 ;;
esac
EOF
chmod 755 "$TMP/bin/agent-browser"

cat > "$TMP/bin/id" <<'EOF'
#!/bin/sh
[ "${1:-}" = "-u" ] && echo 1000 || exec /usr/bin/id "$@"
EOF
chmod 755 "$TMP/bin/id"

cat > "$TMP/bin/grep" <<'EOF'
#!/bin/sh
case "$*" in
  *docker*|*containerd*|*kubepods*|*libpod*|*lxc*) exit 0 ;;
  *) exec /usr/bin/grep "$@"
esac
EOF
chmod 755 "$TMP/bin/grep"

run_case() {
  label=$1
  home=$2
  expected=$3
  output="$TMP/$label.out"
  if HOME="$home" PATH="$TMP/bin:/usr/bin:/bin" sh -c "$(extract_operation)" >"$output" 2>&1; then
    actual=0
  else
    actual=$?
  fi
  [ "$actual" -eq "$expected" ] || { cat "$output" >&2; exit 1; }
  printf '%s\n' "$output"
}

EMPTY_HOME="$TMP/empty-home"
mkdir -p "$EMPTY_HOME"
run_case failure "$EMPTY_HOME" 1 >/dev/null
export FAKE_DOCTOR_ALWAYS_FAIL=1
SUCCESS_OUTPUT=$(run_case fallback "$TMP/home" 0)
grep -F 'BROWSER_INSTALLED=1' "$SUCCESS_OUTPUT" >/dev/null
grep -F 'BROWSER_ENV_LD_LIBRARY_PATH=' "$SUCCESS_OUTPUT" >/dev/null
grep -F 'BROWSER_ENV_AGENT_BROWSER_ARGS=--no-sandbox' "$SUCCESS_OUTPUT" >/dev/null
cat > "$TMP/test-env.json" <<'EOF'
{"browser":{"installed":true,"environment":{"LD_LIBRARY_PATH":"/tmp/staged/lib","AGENT_BROWSER_ARGS":"--no-sandbox"}}}
EOF
PROPAGATED=$(node -e '
  const d = require(process.argv[1]);
  for (const [key, value] of Object.entries(d.browser.environment || {})) {
    if (value) process.stdout.write(key + "=" + value + "\n");
  }
' "$TMP/test-env.json")
printf '%s\n' "$PROPAGATED" | grep -Fx 'LD_LIBRARY_PATH=/tmp/staged/lib' >/dev/null
printf '%s\n' "$PROPAGATED" | grep -Fx 'AGENT_BROWSER_ARGS=--no-sandbox' >/dev/null
echo "agent-browser rootless fallback fixture: PASS"
