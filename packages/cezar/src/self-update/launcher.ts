/**
 * The launchers in `~/.cezar/bin/` and the one-line PATH hook that makes `cezar` a command.
 *
 * A launcher is deliberately dumb: it execs whatever `versions/current` points at, so an update
 * is a symlink flip and the launcher is never rewritten. It carries ONE built-in verb, `use`,
 * that flips the link from the shell — the escape hatch for a downgrade into a version that
 * predates the cockpit's update dialog (this PoC's own situation).
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { binDir, CURRENT_LINK, PACKAGE_NAME, versionsDir } from './layout.ts';

const PATH_MARKER = '# cezar managed install';

function posixLauncher(env: NodeJS.ProcessEnv): string {
  // `CEZ_HOME` is honoured at run time too, so a launcher written under the default home keeps
  // working when the user later sets it — the launcher recomputes, it does not bake the path in.
  const home = env.CEZ_HOME || undefined;
  const homeExpr = home ? JSON.stringify(home) : '"${CEZ_HOME:-$HOME/.cezar}"';
  return `#!/bin/sh
${PATH_MARKER} — do not edit; \`cezar install\` regenerates this file.
CEZ_MANAGED_HOME=${homeExpr}
CEZ_VERSIONS="$CEZ_MANAGED_HOME/versions"
ENTRY="$CEZ_VERSIONS/${CURRENT_LINK}/node_modules/${PACKAGE_NAME}/dist/index.js"

# \`cezar use <id>\` flips the active version without starting cezar — works even when the
# active version has no idea what a managed install is.
if [ "$1" = "use" ] && [ -n "$2" ]; then
  if [ ! -f "$CEZ_VERSIONS/$2/node_modules/${PACKAGE_NAME}/dist/index.js" ]; then
    echo "cezar: version '$2' is not installed under $CEZ_VERSIONS" >&2
    echo "installed:" >&2
    ls -1 "$CEZ_VERSIONS" 2>/dev/null | grep -v '^${CURRENT_LINK}$' | grep -v '^\\.' | sed 's/^/  /' >&2
    exit 1
  fi
  # \`ln -sfn\` replaces the link itself; a \`mv\` onto a symlink-to-directory would move INTO it.
  ln -sfn "$2" "$CEZ_VERSIONS/${CURRENT_LINK}" || exit 1
  echo "cezar: now using $2"
  exit 0
fi

if [ ! -f "$ENTRY" ]; then
  echo "cezar: no active version under $CEZ_VERSIONS — run: npx cezar-cli install" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "cezar: node is not on PATH (Node 20+ is required)" >&2
  exit 1
fi
exec node "$ENTRY" "$@"
`;
}

function windowsLauncher(env: NodeJS.ProcessEnv): string {
  const home = env.CEZ_HOME || join(homedir(), '.cezar');
  const entry = join(home, 'versions', CURRENT_LINK, 'node_modules', ...PACKAGE_NAME.split('/'), 'dist', 'index.js');
  return `@echo off\r\nrem ${PATH_MARKER}\r\nnode "${entry}" %*\r\n`;
}

/** Write `cezar` and `cez` launchers. Returns the bin directory. Untested on Windows (PoC). */
export function writeLaunchers(env: NodeJS.ProcessEnv = process.env): string {
  const dir = binDir(env);
  mkdirSync(dir, { recursive: true });
  mkdirSync(versionsDir(env), { recursive: true });
  for (const name of ['cezar', 'cez']) {
    if (process.platform === 'win32') {
      writeFileSync(join(dir, `${name}.cmd`), windowsLauncher(env));
    } else {
      const path = join(dir, name);
      writeFileSync(path, posixLauncher(env));
      chmodSync(path, 0o755);
    }
  }
  return dir;
}

/** Whether `dir` is already on the caller's PATH. */
export function isOnPath(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const entries = (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  return entries.some((entry) => entry === dir || entry === dir.replace(homedir(), '~'));
}

export interface PathHookResult {
  /** The rc file the hook was written to, or null when nothing was written. */
  file: string | null;
  /** The line to add by hand when `file` is null. */
  line: string;
  alreadyPresent: boolean;
}

/**
 * Add `~/.cezar/bin` to PATH for future shells by appending one marked line to the shell's rc
 * file (`.zshrc`, `.bashrc`, or `.profile` for anything else). Idempotent: the marker is what a
 * second run looks for. Windows users are told the line; the PoC does not touch the registry.
 */
export function ensurePathHook(dir: string, env: NodeJS.ProcessEnv = process.env): PathHookResult {
  // The user's home comes from `env`, like every other path in this module: a caller (or a
  // test) that points HOME elsewhere must never reach the real shell profile.
  const home = env.HOME || homedir();
  const line = `export PATH="${dir.replace(home, '$HOME')}:$PATH" ${PATH_MARKER}`;
  if (process.platform === 'win32') return { file: null, line: `setx PATH "%PATH%;${dir}"`, alreadyPresent: false };
  const shell = env.SHELL ?? '';
  const rc = shell.endsWith('/zsh') ? '.zshrc' : shell.endsWith('/bash') ? '.bashrc' : '.profile';
  const file = join(home, rc);
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // No rc file yet: the append below creates it.
  }
  if (current.includes(PATH_MARKER)) return { file, line, alreadyPresent: true };
  appendFileSync(file, `\n${line}\n`);
  return { file, line, alreadyPresent: false };
}
