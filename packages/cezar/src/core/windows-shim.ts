/**
 * Node refuses to spawn a `.cmd`/`.bat` without a shell (EINVAL since 20.12, CVE-2024-27980), and
 * running one through `cmd.exe` would reopen the BatBadBut surface closed in #459. Yet `npm i -g`
 * on Windows installs every agent CLI as exactly such a shim, so a `CEZ_CODEX_BIN=…\codex.cmd`
 * threw before the CLI ever ran (telemetry a330744e).
 *
 * An npm or pnpm shim only ever runs `node <script> %*`, so this reads the script out of it and
 * spawns node directly: same program, no shell. A `.js` override gets the same treatment.
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

const SHIM_EXTENSIONS = new Set(['.cmd', '.bat']);
const SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
/** The quoted script right before `%*`: npm writes `"%dp0%\…"`, pnpm `"%~dp0\…"`. */
const SHIM_TARGET_RE = /"%~?dp0%?\\?([^"%]+)"\s*%\*/g;
const SHIM_MAX_BYTES = 64 * 1024;

export interface ShimOptions {
  platform?: NodeJS.Platform;
  /** The node to run a script with when the shim has none beside it; defaults to this process's. */
  nodePath?: string;
}

/** The node script an npm/pnpm `.cmd` shim launches, or null for anything else. */
export function shimScript(shimPath: string): string | null {
  let text: string;
  try {
    // One descriptor, one bounded read: no stat-then-read gap (CodeQL js/file-system-race).
    const fd = openSync(shimPath, 'r');
    try {
      const buffer = Buffer.alloc(SHIM_MAX_BYTES + 1);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > SHIM_MAX_BYTES) return null;
      text = buffer.toString('utf8', 0, bytes);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  // pnpm repeats the target in both IF branches; any disagreement is a shim we don't understand.
  const targets = new Set([...text.matchAll(SHIM_TARGET_RE)].map((match) => match[1]!.trim()));
  if (targets.size !== 1) return null;
  const [relative] = targets;
  if (!SCRIPT_EXTENSIONS.has(extname(relative!).toLowerCase())) return null;
  const script = resolve(dirname(shimPath), relative!.replace(/\\/g, '/'));
  return existsSync(script) ? script : null;
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
  const script = shimScript(shimPath);
  if (!script) return [program, [...args]];
  // The shim prefers a node.exe shipped beside it; mirror that.
  const bundledNode = join(dirname(shimPath), 'node.exe');
  return [existsSync(bundledNode) ? bundledNode : nodePath, [script, ...args]];
}
