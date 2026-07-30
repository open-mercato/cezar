#!/bin/sh
# om-prepare-test-env: generated entrypoint (contract v2)
# regenerate with: om-prepare-test-env --regenerate
# history:
#   2026-07-14 generated (cold ~40s, warm ~2s) — cezar has no backing services, so
#             the service-provisioning step of the contract is deliberately absent.
#   2026-07-21 detach the app with nohup so non-interactive bootstrap shells do not
#             terminate the healthy server immediately after the script exits.
#   2026-07-21 start a new session when setsid is available; some task runners reap
#             every process left in the bootstrap shell's process group despite nohup.
#   2026-07-30 run npm ci before building and cache-check installed runtime dependencies;
#             fresh worktrees have no workspace links, so tsc otherwise resolves contract
#             imports as missing/unknown and a cached build cannot start without node_modules.
#   2026-07-30 execute the compound preparation chain through sh -c and stop requiring an
#             api-client dist artifact that this source-aliased workspace does not produce.
set -eu

# ---- project-specific parameters -------------------------------------------
# Everything below the next banner is generic contract logic; tweak only here.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# <root>/.ai/scripts/test-env-up.sh → <root>. Derived from the script's own path so this
# works unchanged inside a git worktree (no `git rev-parse`, no cwd assumption).
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

QA_DIR="$REPO_ROOT/.ai/qa"
ENV_DESCRIPTOR="$QA_DIR/test-env.json"
LOCK_DIR="$QA_DIR/test-env.lock"
CACHE_FILE="$QA_DIR/.build-cache"
APP_LOG="$QA_DIR/test-env-app.log"
BROWSER_DESCRIPTOR=".ai/browsers/agent-browser.md"

PREFERRED_PORT=4321
HEALTH_PATH="/api/v1/health"
HEALTH_TIMEOUT=60
TEST_ENV_CACHE_TTL_SECONDS=${TEST_ENV_CACHE_TTL_SECONDS:-600}

# The preparation chain: install workspace links/dependencies, server `tsc` →
# packages/cezar/dist/, then `vite build` → packages/cezar/web/dist/. All are required — a
# fresh worktree has no node_modules, and the server serves the React cockpit from
# packages/cezar/web/dist (missing it would silently test the fallback hint page).
BUILD_COMMAND="npm ci && npm run build"
BUILD_ARTIFACTS="node_modules/zod/package.json packages/cezar/dist/index.js packages/cezar/web/dist/index.html"
# Fingerprint inputs — a change to any of these invalidates the cached build. Each workspace
# contributes its own sources AND its own manifest: a dependency moved between packages
# changes what gets bundled without touching a single source file.
BUILD_INPUT_PATHS="packages/contract/src packages/contract/package.json packages/cezar/src packages/cezar/package.json packages/cezar/tsconfig.json packages/api-client/src packages/api-client/package.json packages/web/src packages/web/index.html packages/web/vite.config.ts packages/web/package.json package.json package-lock.json"

# CEZ_DRY_RUN=1 swaps the agent CLIs for the bundled mock, so booting needs no
# `claude` login and reaches no network — the whole point for CI/e2e.
export CEZ_DRY_RUN=1

# The real CLI writes workspace state at boot (~/.cezar migrations + project
# registration) — pin CEZ_HOME under .ai/qa so a test boot never touches the
# developer's real ~/.cezar. Kept stable (not per-boot) so the reuse path
# attaches to the same workspace the running instance was booted with.
export CEZ_HOME="$QA_DIR/cez-home"

FORCE=0
FORCE_REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --force-rebuild) FORCE_REBUILD=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ---- generic contract logic -------------------------------------------------

mkdir -p "$QA_DIR"

log() { echo "[test-env] $*" >&2; }

# Never assume python3 exists — cascade through whatever the machine has.
free_port() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
  elif command -v python >/dev/null 2>&1; then
    python -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
  elif command -v node >/dev/null 2>&1; then
    node -e 's=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
  else
    awk 'BEGIN{srand();print 20000+int(rand()*20000)}'
  fi
}

port_free() {
  node -e '
    const net = require("net");
    const s = net.createServer();
    s.once("error", () => process.exit(1));
    s.listen(Number(process.argv[1]), "127.0.0.1", () => s.close(() => process.exit(0)));
  ' "$1" 2>/dev/null
}

http_ok() { curl -fsS --max-time 5 "$1" >/dev/null 2>&1; }

json_get() { node -e '
  const fs = require("fs");
  try {
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), d);
    if (v !== undefined && v !== null) process.stdout.write(String(v));
  } catch { /* absent or corrupt descriptor → empty, caller treats as stale */ }
' "$1" "$2" 2>/dev/null; }

# ---- 2. lock — one bootstrap at a time --------------------------------------
# Released when the bootstrap finishes rather than held for the environment's lifetime:
# the server `readFileSync`s packages/cezar/dist/ and packages/cezar/web/dist/ per request, so a later rebuild under a
# running app is picked up on the next reload instead of corrupting it. The reuse check's
# "source newer than startedAt" test is what keeps a stale build from being tested.
LOCK_HELD=0
release_lock() { [ "$LOCK_HELD" = 1 ] && rm -rf "$LOCK_DIR" 2>/dev/null || true; }
trap release_lock EXIT INT TERM

acquire_lock() {
  waited=0
  while : ; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      LOCK_HELD=1
      printf '{"pid":%s,"source":"test-env-up.sh","acquiredAt":"%s"}\n' \
        "$$" "$(date -u +%FT%TZ)" > "$LOCK_DIR/owner.json"
      return 0
    fi
    owner=$(json_get "$LOCK_DIR/owner.json" pid || true)
    # Owner PID dead → stale lock from a crashed run; remove and retake.
    if [ -z "$owner" ] || ! kill -0 "$owner" 2>/dev/null; then
      log "removing stale lock (owner pid ${owner:-unknown} is gone)"
      rm -rf "$LOCK_DIR" 2>/dev/null || true
      continue
    fi
    if [ "$waited" -ge 300 ]; then
      log "timed out waiting for the bootstrap lock held by pid $owner"
      exit 1
    fi
    [ "$waited" = 0 ] && log "another bootstrap (pid $owner) is running — waiting"
    sleep 2
    waited=$((waited + 2))
  done
}

# ---- 3. reuse check — attach, don't reboot ----------------------------------
emit() {
  reused=$1
  cat <<EOF
TEST_ENV_STATUS=running
TEST_ENV_BASE_URL=$BASE_URL
TEST_ENV_DESCRIPTOR=.ai/qa/test-env.json
TEST_ENV_REUSED=$reused
BROWSER_PROVIDER=agent-browser
BROWSER_INSTALLED=$BROWSER_INSTALLED
EOF
}

try_reuse() {
  [ "$FORCE" = 1 ] && return 1
  [ -f "$ENV_DESCRIPTOR" ] || return 1
  [ "$(json_get "$ENV_DESCRIPTOR" status)" = running ] || return 1

  pid=$(json_get "$ENV_DESCRIPTOR" app.pid)
  url=$(json_get "$ENV_DESCRIPTOR" baseUrl)
  started=$(json_get "$ENV_DESCRIPTOR" startedAt)
  requested_single_project=false
  [ "${CEZ_SINGLE_PROJECT:-}" = 1 ] && requested_single_project=true
  [ "$(json_get "$ENV_DESCRIPTOR" environment.singleProject)" = "$requested_single_project" ] || return 1
  [ -n "$pid" ] && [ -n "$url" ] || return 1
  # A state file is a claim, not proof: the PID must still be alive…
  kill -0 "$pid" 2>/dev/null || return 1
  # …and the app must actually answer. Health first (deep: reads config + git),
  # then the app shell, which is what the e2e specs actually load.
  http_ok "$url$HEALTH_PATH" || return 1
  http_ok "$url/" || return 1

  # Fresh: within TTL and no tracked source newer than startedAt.
  if [ -n "$started" ]; then
    age=$(node -e 'const t=Date.parse(process.argv[1]);process.stdout.write(String(isNaN(t)?1e9:Math.round((Date.now()-t)/1000)))' "$started")
    [ "$age" -le "$TEST_ENV_CACHE_TTL_SECONDS" ] || { log "descriptor is stale (${age}s old)"; return 1; }
    newer=$(cd "$REPO_ROOT" && find $BUILD_INPUT_PATHS -newermt "$started" -type f -print -quit 2>/dev/null || true)
    [ -z "$newer" ] || { log "source changed since boot ($newer)"; return 1; }
  fi

  BASE_URL=$url
  BROWSER_INSTALLED=$(json_get "$ENV_DESCRIPTOR" browser.installed)
  [ "$BROWSER_INSTALLED" = true ] && BROWSER_INSTALLED=1 || BROWSER_INSTALLED=0
  return 0
}

teardown_stale() {
  [ -f "$ENV_DESCRIPTOR" ] || return 0
  pid=$(json_get "$ENV_DESCRIPTOR" app.pid)
  own=$(json_get "$ENV_DESCRIPTOR" startedByThisRepo)
  # Only ever kill what this repo started.
  if [ -n "$pid" ] && [ "$own" = true ] && kill -0 "$pid" 2>/dev/null; then
    log "stopping stale instance (pid $pid)"
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
}

# ---- 4. build cache ---------------------------------------------------------
# Node rather than `find | xargs stat`: `stat` takes -c on GNU and -f on BSD, and this
# repo already requires Node 20+ — no reason to guess the flavor.
fingerprint() {
  (cd "$REPO_ROOT" && node -e '
    const fs = require("fs"), path = require("path"), crypto = require("crypto");
    const parts = [];
    const walk = (p) => {
      let st;
      try { st = fs.statSync(p); } catch { return; }
      if (st.isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e));
      else if (st.isFile()) parts.push(`${p}:${st.size}:${Math.floor(st.mtimeMs)}`);
    };
    for (const r of process.argv.slice(1)) walk(r);
    process.stdout.write(crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16));
  ' $BUILD_INPUT_PATHS)
}

artifacts_present() {
  for a in $BUILD_ARTIFACTS; do
    [ -f "$REPO_ROOT/$a" ] || return 1
  done
  return 0
}

ensure_build() {
  fp=$(fingerprint)
  cached=""
  [ -f "$CACHE_FILE" ] && cached=$(cat "$CACHE_FILE" 2>/dev/null || true)
  if [ "$FORCE_REBUILD" = 0 ] && [ -n "$fp" ] && [ "$fp" = "$cached" ] && artifacts_present; then
    log "build cache hit — skipping $BUILD_COMMAND"
    return 0
  fi
  log "building ($BUILD_COMMAND)"
  (cd "$REPO_ROOT" && sh -c "$BUILD_COMMAND" >"$QA_DIR/test-env-build.log" 2>&1) || {
    log "build failed — see .ai/qa/test-env-build.log"
    tail -20 "$QA_DIR/test-env-build.log" >&2 || true
    exit 1
  }
  artifacts_present || { log "build produced no artifacts ($BUILD_ARTIFACTS)"; exit 1; }
  printf '%s' "$fp" > "$CACHE_FILE"
}

# ---- browser provider (per .ai/browsers/agent-browser.md: ensure-installed) --
# Never fails the boot: e2e degrades to a loud SKIP when the provider is unavailable,
# and everything else about the environment stays usable.
BROWSER_INSTALLED=0
BROWSER_COMMAND=""
BROWSER_VERSION=unknown
BROWSER_NOTES=""

ensure_browser() {
  if command -v agent-browser >/dev/null 2>&1; then
    BROWSER_COMMAND=$(command -v agent-browser)
  else
    CACHE_ROOT=${XDG_CACHE_HOME:-"$HOME/.cache"}
    TOOL_DIR="$CACHE_ROOT/agent-tools/agent-browser"
    mkdir -p "$TOOL_DIR"
    OS=$(uname -s 2>/dev/null || echo unknown)
    ARCH=$(uname -m 2>/dev/null || echo unknown)
    case "$ARCH" in x86_64|amd64) ARCH=x64 ;; arm64|aarch64) ARCH=arm64 ;; *) ARCH=unsupported ;; esac
    case "$OS" in
      Darwin) ASSET="agent-browser-darwin-$ARCH" ;;
      Linux)
        LIBC=linux
        (ldd --version 2>&1 || true) | grep -qi musl && LIBC=linux-musl
        ASSET="agent-browser-$LIBC-$ARCH"
        ;;
      MINGW*|MSYS*|CYGWIN*) ASSET=agent-browser-win32-x64.exe ;;
      *) ASSET=unsupported ;;
    esac
    case "$ASSET" in
      *unsupported*)
        BROWSER_NOTES="unsupported agent-browser target: $OS/$ARCH"
        return 0 ;;
    esac
    BROWSER_COMMAND="$TOOL_DIR/$ASSET"
    if [ ! -x "$BROWSER_COMMAND" ]; then
      URL="https://github.com/vercel-labs/agent-browser/releases/latest/download/$ASSET"
      TMP="$BROWSER_COMMAND.tmp.$$"
      log "installing agent-browser ($ASSET)"
      if command -v curl >/dev/null 2>&1; then
        curl -fL --retry 3 --connect-timeout 30 --max-time 600 -o "$TMP" "$URL" || {
          BROWSER_NOTES="download failed: $URL"; rm -f "$TMP"; return 0; }
      elif command -v wget >/dev/null 2>&1; then
        wget -T 30 -t 3 -O "$TMP" "$URL" || { BROWSER_NOTES="download failed: $URL"; rm -f "$TMP"; return 0; }
      else
        BROWSER_NOTES="no built-in HTTP downloader is available"; return 0
      fi
      chmod 755 "$TMP"
      mv "$TMP" "$BROWSER_COMMAND"
    fi
  fi

  "$BROWSER_COMMAND" install >/dev/null 2>&1 || true
  if ! "$BROWSER_COMMAND" doctor --json >/dev/null 2>&1; then
    # Linux Chrome libraries may need root; only try when it costs no prompt.
    if [ "$(uname -s 2>/dev/null || true)" = Linux ]; then
      if [ "$(id -u)" = 0 ]; then
        "$BROWSER_COMMAND" install --with-deps >/dev/null 2>&1 || true
      elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        sudo -n "$BROWSER_COMMAND" install --with-deps >/dev/null 2>&1 || true
      fi
    fi
  fi
  if "$BROWSER_COMMAND" doctor --json >/dev/null 2>&1; then
    BROWSER_INSTALLED=1
    BROWSER_VERSION=$("$BROWSER_COMMAND" --version 2>/dev/null || echo unknown)
  else
    BROWSER_NOTES="live browser launch failed after autonomous install"
  fi
}

# ---- 6. app start + health wait ---------------------------------------------
start_app() {
  PORT=$PREFERRED_PORT
  port_free "$PORT" || PORT=$(free_port)
  BASE_URL="http://127.0.0.1:$PORT"

  log "starting cezar on $BASE_URL (CEZ_DRY_RUN=1)"
  # --no-open: a test boot must never hijack the operator's browser.
  if command -v setsid >/dev/null 2>&1; then
    (cd "$REPO_ROOT" && exec setsid nohup node packages/cezar/dist/index.js --port "$PORT" --no-open --repo "$REPO_ROOT" \
      >"$APP_LOG" 2>&1 </dev/null) &
  else
    (cd "$REPO_ROOT" && exec nohup node packages/cezar/dist/index.js --port "$PORT" --no-open --repo "$REPO_ROOT" \
      >"$APP_LOG" 2>&1 </dev/null) &
  fi
  APP_PID=$!

  waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      log "the app exited during boot — see .ai/qa/test-env-app.log"
      tail -20 "$APP_LOG" >&2 || true
      exit 1
    fi
    if http_ok "$BASE_URL$HEALTH_PATH"; then
      log "healthy after ${waited}s"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  log "health wait timed out after ${HEALTH_TIMEOUT}s — see .ai/qa/test-env-app.log"
  kill "$APP_PID" 2>/dev/null || true
  exit 1
}

# ---- 7. descriptor write ----------------------------------------------------
write_descriptor() {
  SINGLE_PROJECT=false
  [ "${CEZ_SINGLE_PROJECT:-}" = 1 ] && SINGLE_PROJECT=true
  node -e '
    const fs = require("fs");
    const [out, baseUrl, port, pid, cmd, bInstalled, bCmd, bVer, bNotes, desc, singleProject] = process.argv.slice(1);
    fs.writeFileSync(out, JSON.stringify({
      version: 1,
      runId: "cezar-" + new Date().toISOString().slice(0, 10) + "-" + pid,
      status: "running",
      mode: "prod",
      baseUrl,
      startedByThisRepo: true,
      startScript: ".ai/scripts/test-env-up.sh",
      stopScript: ".ai/scripts/test-env-down.sh",
      app: { startCommand: cmd, port: Number(port), healthPath: "/api/health", pid: Number(pid) },
      services: [],
      credentials: [],
      environment: { singleProject: singleProject === "true" },
      browser: {
        provider: "agent-browser",
        installed: bInstalled === "1",
        command: bCmd,
        version: bVer,
        descriptor: desc,
        notes: bNotes,
      },
      testRunner: { name: "other", config: "packages/web/e2e/vitest.config.ts" },
      platform: "wsl2",
      startedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      notes: "Booted from a production build after npm ci with CEZ_DRY_RUN=1, so workspace links/runtime dependencies are present, the agent CLIs are mocked, and no agent login/network is needed. No backing services. Stop with .ai/scripts/test-env-down.sh. App log: .ai/qa/test-env-app.log.",
    }, null, 2) + "\n");
  ' "$ENV_DESCRIPTOR" "$BASE_URL" "$PORT" "$APP_PID" \
    "CEZ_DRY_RUN=1 CEZ_HOME=.ai/qa/cez-home node packages/cezar/dist/index.js --port $PORT --no-open" \
    "$BROWSER_INSTALLED" "$BROWSER_COMMAND" "$BROWSER_VERSION" "$BROWSER_NOTES" "$BROWSER_DESCRIPTOR" \
    "$SINGLE_PROJECT"
}

# ---- main -------------------------------------------------------------------
acquire_lock

if try_reuse; then
  log "reusing the healthy instance at $BASE_URL"
  emit 1
  exit 0
fi

teardown_stale
ensure_browser
ensure_build
start_app
write_descriptor
emit 0
