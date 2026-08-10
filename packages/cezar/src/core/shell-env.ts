/**
 * Rendering environment assignments into a shell command line — the CLI-handoff half of agent
 * profiles (spec 2026-07-29-agent-profiles).
 *
 * A run executed under a second account only resumes under that same account: `claude --resume
 * <id>` reads `<CLAUDE_CONFIG_DIR>/sessions`, so a handoff without the variable does not fail
 * loudly — it silently starts a fresh conversation. The variable therefore has to travel with
 * every command cezar hands to a terminal, and it has to SURVIVE the command, because the window
 * stays open and the user types the next `claude` in it themselves. Hence `export` / `set` rather
 * than a one-shot `VAR=v cmd` prefix.
 *
 * There is no portable spelling: `VAR=v cmd` is meaningless to `cmd.exe`, and `set "VAR=v"` is
 * meaningless to a POSIX shell. So this renders per platform, and — the load-bearing part —
 * refuses rather than guesses. `null` means "this value cannot be embedded safely here", and
 * every caller must then fail closed: opening a terminal on the WRONG account is worse than not
 * opening one, because the user cannot see which account a shell is pointed at.
 */

/** Values that cannot be embedded safely, per platform. Control characters are rejected
 *  everywhere (they would break the line-based launch script and are never a real path). */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
/** `cmd.exe` has no escape inside a quoted `set` argument: `"` ends the quote and `%`/`!` expand.
 *  A path containing one is pathological, so refusing is honest rather than limiting. */
const WIN32_UNSAFE_RE = /["%!]/;

/** POSIX single-quoting — the `'\''` dance, so any character but a control one is inert. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Assignments that persist for the rest of the shell session, or `null` when any value cannot be
 * embedded safely on `platform`. An empty `env` renders `''` — the zero-config path adds nothing.
 *
 * The result is a PREFIX ready to concatenate: it already ends with its own separator.
 */
export function renderEnvPrefix(
  env: Record<string, string>,
  platform: NodeJS.Platform,
): string | null {
  const entries = Object.entries(env);
  if (entries.length === 0) return '';
  for (const [name, value] of entries) {
    if (CONTROL_CHARS_RE.test(name) || CONTROL_CHARS_RE.test(value)) return null;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
    if (platform === 'win32' && (WIN32_UNSAFE_RE.test(name) || WIN32_UNSAFE_RE.test(value))) return null;
  }
  if (platform === 'win32') {
    return entries.map(([name, value]) => `set "${name}=${value}" && `).join('');
  }
  return entries.map(([name, value]) => `export ${name}=${shellQuote(value)}; `).join('');
}

/** `renderEnvPrefix` applied to a command, or `null` when the env cannot be rendered safely. */
export function withEnvPrefix(
  command: string,
  env: Record<string, string>,
  platform: NodeJS.Platform,
): string | null {
  const prefix = renderEnvPrefix(env, platform);
  return prefix === null ? null : `${prefix}${command}`;
}
