# Browser provider: agent-browser

This is the local, self-provisioning `agent-browser` implementation of the
browser-provider contract in `TEMPLATE.md`. It uses native release binaries and
Chrome for Testing. It never requires Node, a project package manager, a
preinstalled browser, or a cloud-browser account.

## Prerequisites

- Network access to GitHub Releases and the Chrome-for-Testing download host on
  first install. Warm runs reuse the cached binary and browser.
- Supported release targets: macOS x64/arm64; Linux glibc or musl x64/arm64;
  Windows x64. WSL2 uses the matching Linux target. Windows on ARM may use the
  x64 binary only when the operating system's x64 compatibility layer is active.
- Linux Chrome libraries may require root. The operation below performs the
  install itself when already root or passwordless elevation is available. If
  elevation is unavailable, it reuses readable shared libraries already staged
  by `agent-browser` under the per-user cache and retries the doctor check with
  those libraries exported. In an unprivileged Linux container it also adds
  `--no-sandbox` (and the usual container-safe flags) for that retry only; it
  never delegates commands to the operator.

## Operations

### ensure-installed

Use an existing healthy `agent-browser` from `PATH`; otherwise install the
official native release in a per-user cache. Do not add binary files to the
repository.

POSIX shell (macOS, Linux, WSL2, Git Bash/MSYS):

```bash
if command -v agent-browser >/dev/null 2>&1; then
  AGENT_BROWSER_BIN=$(command -v agent-browser)
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
  case "$ASSET" in *unsupported*) echo "Unsupported agent-browser target: $OS/$ARCH" >&2; exit 1 ;; esac
  AGENT_BROWSER_BIN="$TOOL_DIR/$ASSET"
  if [ ! -x "$AGENT_BROWSER_BIN" ]; then
    URL="https://github.com/vercel-labs/agent-browser/releases/latest/download/$ASSET"
    TMP="$AGENT_BROWSER_BIN.tmp.$$"
    if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 --connect-timeout 30 --max-time 600 -o "$TMP" "$URL"
    elif command -v wget >/dev/null 2>&1; then wget -T 30 -t 3 -O "$TMP" "$URL"
    else echo "No built-in HTTP downloader is available" >&2; exit 1
    fi
    chmod 755 "$TMP"
    mv "$TMP" "$AGENT_BROWSER_BIN"
  fi
fi

"$AGENT_BROWSER_BIN" install
if ! "$AGENT_BROWSER_BIN" doctor --json >/dev/null 2>&1; then
  if [ "$(uname -s 2>/dev/null || true)" = Linux ]; then
    if [ "$(id -u)" = 0 ]; then
      "$AGENT_BROWSER_BIN" install --with-deps
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo -n "$AGENT_BROWSER_BIN" install --with-deps
    fi
  fi
fi
if ! "$AGENT_BROWSER_BIN" doctor --json >/dev/null 2>&1 && [ "$(uname -s 2>/dev/null || true)" = Linux ] && [ "$(id -u)" != 0 ]; then
  STAGED_LIBRARY_PATH=""
  for STAGED_ROOT in "$HOME/.agent-browser/deps" "$HOME/.cache/agent-tools/chrome-deps"; do
    if [ -d "$STAGED_ROOT" ]; then
      STAGED_DIRS=$(find "$STAGED_ROOT" -type f \( -name '*.so' -o -name '*.so.*' \) -exec dirname {} \; 2>/dev/null | sort -u)
      if [ -n "$STAGED_DIRS" ]; then
        if [ -n "$STAGED_LIBRARY_PATH" ]; then STAGED_LIBRARY_PATH="$STAGED_LIBRARY_PATH:"; fi
        STAGED_LIBRARY_PATH="$STAGED_LIBRARY_PATH$(printf '%s\n' "$STAGED_DIRS" | paste -sd: -)"
      fi
    fi
  done
  if [ -n "$STAGED_LIBRARY_PATH" ]; then
    export LD_LIBRARY_PATH="$STAGED_LIBRARY_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    ROOTLESS_NO_USERNS=0
    if command -v unshare >/dev/null 2>&1 && ! unshare -Ur true 2>/dev/null; then ROOTLESS_NO_USERNS=1; fi
    if [ "$ROOTLESS_NO_USERNS" = 1 ] || [ -f /.dockerenv ] || [ -f /run/.containerenv ] || grep -Eqi '(docker|containerd|kubepods|libpod|lxc)' /proc/1/cgroup 2>/dev/null; then
      case ",${AGENT_BROWSER_ARGS:-}," in
        *,--no-sandbox,*) ;;
        *) AGENT_BROWSER_ARGS="${AGENT_BROWSER_ARGS:+$AGENT_BROWSER_ARGS,}--no-sandbox,--disable-dev-shm-usage,--disable-gpu"; export AGENT_BROWSER_ARGS ;;
      esac
    fi
  fi
fi
browser_probe() {
  BROWSER_PROBE_SESSION="cez-provider-probe-$$"
  if "$AGENT_BROWSER_BIN" --session "$BROWSER_PROBE_SESSION" open about:blank --json >/dev/null 2>&1; then
    "$AGENT_BROWSER_BIN" --session "$BROWSER_PROBE_SESSION" close --json >/dev/null 2>&1 || true
    return 0
  fi
  "$AGENT_BROWSER_BIN" --session "$BROWSER_PROBE_SESSION" close --json >/dev/null 2>&1 || true
  return 1
}
if "$AGENT_BROWSER_BIN" doctor --json >/dev/null 2>&1 || browser_probe; then
  printf 'BROWSER_PROVIDER=agent-browser\nBROWSER_INSTALLED=1\nBROWSER_COMMAND=%s\nBROWSER_VERSION=%s\nBROWSER_ENV_LD_LIBRARY_PATH=%s\nBROWSER_ENV_AGENT_BROWSER_ARGS=%s\nBROWSER_NOTES=\n' \
    "$AGENT_BROWSER_BIN" "$("$AGENT_BROWSER_BIN" --version 2>/dev/null || echo unknown)" "${LD_LIBRARY_PATH:-}" "${AGENT_BROWSER_ARGS:-}"
else
  printf 'BROWSER_PROVIDER=agent-browser\nBROWSER_INSTALLED=0\nBROWSER_COMMAND=%s\nBROWSER_VERSION=unknown\nBROWSER_ENV_LD_LIBRARY_PATH=%s\nBROWSER_ENV_AGENT_BROWSER_ARGS=%s\nBROWSER_NOTES=live browser launch failed after autonomous install\n' "$AGENT_BROWSER_BIN" "${LD_LIBRARY_PATH:-}" "${AGENT_BROWSER_ARGS:-}"
  exit 1
fi
```

Native Windows PowerShell:

```powershell
$onPath = Get-Command agent-browser -ErrorAction SilentlyContinue
if ($onPath) { $AgentBrowser = $onPath.Source }
else {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  if ($arch -notin 'X64','Arm64') { throw "Unsupported agent-browser Windows architecture: $arch" }
  $toolDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'agent-tools/agent-browser'
  New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
  $AgentBrowser = Join-Path $toolDir 'agent-browser-win32-x64.exe'
  if (-not (Test-Path $AgentBrowser)) {
    $url = 'https://github.com/vercel-labs/agent-browser/releases/latest/download/agent-browser-win32-x64.exe'
    $tmp = "$AgentBrowser.tmp.$PID"
    if ($PSVersionTable.PSVersion.Major -lt 7) {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    }
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri $url -OutFile $tmp
    Move-Item -Force $tmp $AgentBrowser
  }
}
& $AgentBrowser install
& $AgentBrowser doctor --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'agent-browser live browser launch failed after autonomous install' }
$version = (& $AgentBrowser --version 2>$null)
"BROWSER_PROVIDER=agent-browser"
"BROWSER_INSTALLED=1"
"BROWSER_COMMAND=$AgentBrowser"
"BROWSER_VERSION=$version"
"BROWSER_NOTES="
```

### doctor

```bash
"$AGENT_BROWSER_BIN" doctor --json
```

PowerShell: `& $AgentBrowser doctor --json`.

### open

Use a unique, validated session id such as `qa-<runId>`:

```bash
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" open "$BASE_URL" --json
```

### snapshot

```bash
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" snapshot -i --json
```

### interact

Use only a ref returned by the latest snapshot:

```bash
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" click "$ELEMENT_REF" --json
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" fill "$ELEMENT_REF" "$VALUE" --json
```

Other actions use the matching CLI command shown by
`"$AGENT_BROWSER_BIN" --help`; never interpolate untrusted shell fragments.

### assert

Use JSON output and compare the observed value in the current shell. Examples:

```bash
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" get text "$ELEMENT_REF" --json
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" get url --json
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" is visible "$ELEMENT_REF" --json
```

### screenshot

```bash
SCREENSHOT_DIR=$(dirname "$SCREENSHOT_PATH")
mkdir -p "$SCREENSHOT_DIR"
ABS_SCREENSHOT_PATH=$(cd "$SCREENSHOT_DIR" && pwd)/$(basename "$SCREENSHOT_PATH")
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" screenshot --full "$ABS_SCREENSHOT_PATH" --json
test -s "$ABS_SCREENSHOT_PATH"
```

The absolute path avoids the CLI treating a relative multi-segment path as a
selector. PowerShell resolves it with
`[IO.Path]::GetFullPath($ScreenshotPath)`, creates the parent directory, then
checks `Test-Path` and a non-zero file length.

### close

```bash
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" close --json 2>/dev/null || true
```

In PowerShell, run the same arguments with `& $AgentBrowser` in `finally` and
ignore only an already-closed-session error.

## Rules

- Run `agent-browser skills get core` when available before a complex scenario
  so interaction guidance matches the installed CLI version.
- Use a unique session per QA/test run. Never attach to a user's normal browser
  profile unless the operator explicitly requested that profile.
- Keep all operation targets local to the application under test. Do not enable
  a cloud provider or send credentials to a remote browser service.
