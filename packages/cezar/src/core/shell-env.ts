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
 *  A path containing one is pathological, so refusing is honest rather than limiting.
 *  Scope: {@link renderEnvPrefix}'s `set "NAME=value"` assignments only. Executable quoting has
 *  its own, wider set — {@link WIN32_QUOTE_REWRITES_RE}, which adds `&`. */
const WIN32_UNSAFE_RE = /["%!]/;

/**
 * Every character {@link quoteExecutable} rewrites on win32 — `"`, `%` and `!` because they stay
 * live inside the quotes, and `&` which does not, so rewriting it only corrupts the value. None
 * of them survives the round trip intact, which is what {@link isShellEmbeddable} reports.
 *
 * Single source of truth for both: `quoteExecutable` does the rewriting through the `g` variant
 * derived below, `isShellEmbeddable` tests through this one, so the gate cannot drift from the
 * behaviour it is gating. The derivation carries `flags` across as well as `source`, so adding a
 * flag here cannot silently apply to only one of the two.
 */
const WIN32_QUOTE_REWRITES_RE = /[%&!"]/;
const WIN32_QUOTE_REWRITES_ALL_RE = new RegExp(
  WIN32_QUOTE_REWRITES_RE.source,
  `${WIN32_QUOTE_REWRITES_RE.flags}g`,
);

/** POSIX single-quoting — the `'\''` dance, so any character but a control one is inert. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Quote a binary PATH so a shell runs it as one word — the resolved `claude` can live under
 * `/Users/Jane Doe/.local/bin`, and an unquoted space there would split into two arguments.
 * `cmd.exe` needs its own handling, which is why this is not just {@link shellQuote}.
 *
 * KNOWN LIMITATION on win32: the `^`-prefixing below is not actually an escape. Inside a
 * `cmd.exe` double-quoted argument `^` is inert, so a path containing `"`, `%` or `!` comes back
 * corrupted rather than protected — `C:\Users\R&D\claude.exe` becomes `C:\Users\R^&D\claude.exe`,
 * and {@link WIN32_QUOTE_REWRITES_RE} above names every character with no escape to reach for.
 * (That is the set this function rewrites, `&` included — the narrower `WIN32_UNSAFE_RE` covers
 * only {@link renderEnvPrefix}'s `set` assignments.) Callers that can degrade should gate on
 * {@link isShellEmbeddable} first; this behaviour is preserved as-is because `provider-auth`'s
 * `loginCommand` pins it.
 */
export function quoteExecutable(executable: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `"${executable.replace(WIN32_QUOTE_REWRITES_ALL_RE, '^$&')}"`;
  return shellQuote(executable);
}

/**
 * Can `value` be embedded in a shell command on `platform` and come back out unchanged?
 *
 * The gate {@link quoteExecutable} cannot apply to itself: `provider-auth`'s `loginCommand`
 * pins its current (lossy) win32 output, so new callers opt in to correctness here instead of
 * emitting a path the shell would read differently than intended.
 */
export function isShellEmbeddable(value: string, platform: NodeJS.Platform): boolean {
  if (CONTROL_CHARS_RE.test(value)) return false;
  return platform === 'win32' ? !WIN32_QUOTE_REWRITES_RE.test(value) : true;
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
