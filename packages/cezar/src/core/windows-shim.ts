/**
 * Node refuses to spawn a `.cmd`/`.bat` without a shell (EINVAL since 20.12, CVE-2024-27980), and
 * running one through `cmd.exe` would reopen the BatBadBut surface closed in #459. Yet `npm i -g`
 * on Windows installs every agent CLI as exactly such a shim, so a `CEZ_CODEX_BIN=…\codex.cmd`
 * threw before the CLI ever ran (telemetry a330744e).
 *
 * An npm or pnpm shim only ever runs `node <script> %*` or a native `<bin>.exe %*`, so this reads
 * the target out of it and spawns that directly: same program, no shell. The `.ps1` twin npm writes
 * beside it (what PowerShell's `Get-Command` names) is read the same way (telemetry 3626ac13), and
 * a `.js` override gets the same treatment.
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

const SHIM_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1']);
const SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const NATIVE_EXTENSIONS = new Set(['.exe', '.com']);
/** The quoted target right before `%*`: npm writes `"%dp0%\…"`, pnpm `"%~dp0\…"`. */
const CMD_TARGET_RE = /"%~?dp0%?\\?([^"%]+)"\s*%\*/g;
/** The `.ps1` twin npm and pnpm write beside it: `"$basedir/…"` right before `$args`. */
const PS1_TARGET_RE = /"\$basedir[\\/]([^"$]+)"\s*\$args/g;
const SHIM_MAX_BYTES = 64 * 1024;
const NODE_SHEBANG_RE = /^#!.*\bnode\b/;

export interface ShimOptions {
  platform?: NodeJS.Platform;
  /** The node to run a script with when the shim has none beside it; defaults to this process's. */
  nodePath?: string;
}

/** What a shim launches: a node script, or a native binary it calls directly (opencode). */
export interface ShimTarget {
  kind: 'node' | 'native';
  path: string;
}

/** Up to `maxBytes` of a file, or null when it is unreadable or longer. */
function readHead(path: string, maxBytes: number): string | null {
  try {
    // One descriptor, one bounded read: no stat-then-read gap (CodeQL js/file-system-race).
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > maxBytes) return null;
      return buffer.toString('utf8', 0, bytes);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function hasNodeShebang(path: string): boolean {
  try {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(256);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      return NODE_SHEBANG_RE.test(buffer.toString('utf8', 0, bytes).split(/\r?\n/)[0]!);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** The program an npm/pnpm `.cmd`/`.bat`/`.ps1` shim launches, or null for anything else. */
export function shimTarget(shimPath: string): ShimTarget | null {
  const text = readHead(shimPath, SHIM_MAX_BYTES);
  if (text === null) return null;
  const pattern = extname(shimPath).toLowerCase() === '.ps1' ? PS1_TARGET_RE : CMD_TARGET_RE;
  // Both shims repeat the target in each branch; any disagreement is a shim we don't understand.
  const targets = new Set([...text.matchAll(pattern)].map((match) => match[1]!.trim()));
  if (targets.size !== 1) return null;
  const [relative] = targets;
  const path = resolve(dirname(shimPath), relative!.replace(/\\/g, '/'));
  if (!existsSync(path)) return null;
  const ext = extname(path).toLowerCase();
  if (NATIVE_EXTENSIONS.has(ext)) return { kind: 'native', path };
  // cmd-shim keeps a bin's own name, so a `#!/usr/bin/env node` bin often has no extension.
  if (SCRIPT_EXTENSIONS.has(ext) || (ext === '' && hasNodeShebang(path))) return { kind: 'node', path };
  return null;
}

/** The node script an npm/pnpm shim launches, or null for anything else. */
export function shimScript(shimPath: string): string | null {
  const target = shimTarget(shimPath);
  return target?.kind === 'node' ? target.path : null;
}

/**
 * `[file, args]` that run `program` without a shell. Untouched off Windows and for anything that
 * is not a recognisable shim or script, so a bad path still fails the spawn with its own error.
 */
export function spawnableCommand(
  program: string,
  args: readonly string[],
  opts: ShimOptions = {},
): [string, string[]] {
  if ((opts.platform ?? process.platform) !== 'win32') return [program, [...args]];
  const ext = extname(program).toLowerCase();
  const nodePath = opts.nodePath ?? process.execPath;
  if (SCRIPT_EXTENSIONS.has(ext) && existsSync(program)) return [nodePath, [program, ...args]];
  if (!SHIM_EXTENSIONS.has(ext)) return [program, [...args]];
  const shimPath = isAbsolute(program) ? program : resolve(program);
  const target = shimTarget(shimPath);
  if (!target) return [program, [...args]];
  if (target.kind === 'native') return [target.path, [...args]];
  // The shim prefers a node.exe shipped beside it; mirror that.
  const bundledNode = join(dirname(shimPath), 'node.exe');
  return [existsSync(bundledNode) ? bundledNode : nodePath, [target.path, ...args]];
}
