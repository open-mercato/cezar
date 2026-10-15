/**
 * Pieces a container launcher needs, kept apart from the podman launcher because each was
 * learned from a failure and is easier to test on its own.
 */

/**
 * Variables that describe the HOST and must never cross into a container: a
 * macOS `PATH` resolves to nothing inside Linux, `HOME` points at a directory
 * that is not there, and TMPDIR/TEMP/TMP are replaced with container-local
 * scratch (see `containerEnvPairs`).
 */
export const HOST_ONLY_ENV: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'SHLVL', '_',
  'TMPDIR', 'TEMP', 'TMP',
  // Host paths to an agent's home (an agent account sets them). Inside the container the agent's
  // home is the mounted one, logged in with the SELECTED account's credential; a Mac path would
  // send it looking for a login — and a place to keep its conversation — that is not there.
  'KIMI_CODE_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CODEX_HOME',
  // The same for the other runners' homes and data dirs: each has a mounted per-project home
  // inside, and a Mac path would bypass it (OpenCode under XDG_DATA_HOME, Junie's binaries under
  // JUNIE_DATA, az under AZURE_CONFIG_DIR).
  'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'CURSOR_CONFIG_DIR', 'COPILOT_HOME', 'JUNIE_HOME', 'JUNIE_DATA', 'PI_CODING_AGENT_DIR',
  'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_DB', 'AZURE_CONFIG_DIR',
  // Host paths that mean nothing in Linux and change how tools behave: gh reads its config from
  // XDG_CONFIG_HOME (so the copied hosts.yml was ignored), NODE_OPTIONS can `--require` a Mac
  // file, and the ssh variables point at a socket or a command on the host.
  'XDG_CONFIG_HOME', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_SSH_COMMAND', 'GIT_SSH',
]);

/** A proxy on the host's loopback is the CONTAINER's loopback inside it: nothing listens there. */
const PROXY_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']);
function isLoopbackProxy(value: string): boolean {
  return /\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(value);
}

/**
 * `KEY=VALUE` pairs to hand a container runtime's `-e`. Everything cezar set
 * for this run (`CEZ_HANDOFF_FILE`, `CEZ_TASK_ID`, model knobs the agent reads)
 * crosses; host-shaped values do not.
 *
 * `guestTmp` overrides TMPDIR/TEMP/TMP unconditionally. cezar points those at
 * `<repo>/.ai/cezar/tmp/<runId>` (#785), which inside a container is the host
 * bind mount — and the native `claude` binary does a startup temp-file
 * operation that such a mount cannot serve, dying with an opaque
 * `ENOENT: no such file or directory, fstat` before it logs a single line.
 */
export function containerEnvPairs(env: NodeJS.ProcessEnv, guestTmp: string): string[] {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || HOST_ONLY_ENV.has(k)) continue;
    if (PROXY_NAMES.has(k) && isLoopbackProxy(v)) continue;
    pairs.push(`${k}=${v}`);
  }
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) pairs.push(`${name}=${guestTmp}`);
  return pairs.sort();
}

/**
 * The shell wrapped around the agent inside the container.
 *
 * It records its own pid BEFORE `exec`, and `exec` replaces the shell in place
 * — so the recorded pid IS the agent's. That file is the only way to signal a
 * process no host signal can reach: killing a `podman exec` client leaves the
 * process inside running, which was measured, not assumed.
 */
export function guestScript(): string {
  return 'mkdir -p "$TMPDIR"; echo $$ > "$CEZ_PID_FILE"; exec "$@"';
}

/** `kill` the recorded pid inside the container; never fails the caller. */
export function guestKillScript(pidFile: string, sig: NodeJS.Signals): string {
  return `kill -${sig.replace(/^SIG/, '')} "$(cat ${pidFile})" 2>/dev/null || true`;
}
