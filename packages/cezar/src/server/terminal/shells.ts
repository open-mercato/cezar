import { existsSync, readFileSync } from 'node:fs';

/**
 * Which shells this host will open (spec `.ai/specs/2026-10-07-task-workspace.md` §6, "shell
 * selection").
 *
 * AN ALLOWLIST, DISCOVERED — never a path the client names. A terminal already runs arbitrary
 * commands INSIDE a shell, so it is tempting to argue that naming the shell adds nothing. It
 * does: the executable a request spawns is the one thing the worktree discipline never covers,
 * and accepting it from the body would turn `POST /terminal` into "run this binary on the host",
 * reachable by anything the reverse proxy admits — AGENTS.md's rule for a feature that widens
 * exposure. So the server decides what is openable and the client may only pick from that.
 *
 * The list is the host's own `/etc/shells` (the file every POSIX system keeps for exactly this
 * question), narrowed to entries that actually exist, with `$SHELL` and the platform default
 * folded in. Windows has no such file, so there it is the known interpreters that are present.
 */

/** The host's interactive default — first in the list, and what a session with no choice gets. */
export function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/bash';
}

/** Where POSIX keeps the list of legitimate login shells. */
const ETC_SHELLS = '/etc/shells';

/** The real read. A parameter so a test can hand in a host that has no such file — the one
 *  branch that cannot be reached otherwise on a machine that does. */
const defaultReader = (): string => readFileSync(ETC_SHELLS, 'utf8');

/** Windows has no `/etc/shells`; these are the interpreters worth offering when present. */
const WINDOWS_CANDIDATES = [
  'powershell.exe',
  'pwsh.exe',
  'cmd.exe',
];

/**
 * Every shell this host is willing to open, default first, deduplicated.
 *
 * Total: a missing or unreadable `/etc/shells` degrades to just the default, which is what every
 * cezar did before this existed. Never throws — a terminal that cannot enumerate shells must
 * still open one.
 */
export function discoverShells(readShellsFile: () => string = defaultReader): string[] {
  const found: string[] = [];
  const add = (candidate: string | undefined) => {
    if (!candidate) return;
    const value = candidate.trim();
    if (!value || found.includes(value)) return;
    // The default goes in unchecked — it is what the host told us to use, and refusing to list
    // it because `existsSync` disagrees would leave the picker emptier than reality.
    if (value === defaultShell() || existsSync(value)) found.push(value);
  };

  add(defaultShell());

  if (process.platform === 'win32') {
    for (const candidate of WINDOWS_CANDIDATES) add(candidate);
    return found;
  }

  try {
    for (const line of readShellsFile().split('\n')) {
      // `/etc/shells` is one absolute path per line, `#` comments and blanks allowed.
      const path = line.split('#')[0]?.trim();
      if (path?.startsWith('/')) add(path);
    }
  } catch {
    // No `/etc/shells` (a slim container, or a platform that does not keep one). The default
    // alone is an honest answer.
  }
  return found;
}

/**
 * The shell to spawn for a request, or `null` when it named one this host does not offer.
 *
 * `undefined` — the client expressed no preference — is the default, not a refusal.
 */
export function resolveShell(requested: string | undefined, available = discoverShells()): string | null {
  if (requested === undefined) return available[0] ?? defaultShell();
  return available.includes(requested) ? requested : null;
}
