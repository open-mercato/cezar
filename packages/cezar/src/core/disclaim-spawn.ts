/**
 * macOS privacy prompts name the RESPONSIBLE process, and every process the desktop app starts
 * inherits the app as its responsible process. Left alone, an agent that lists `~/Documents`
 * raises "Cezar would like to access files in your Documents folder" — and an Allow there hands
 * every agent, forever, what one of them asked for.
 *
 * The desktop shell exports `CEZ_DISCLAIM_EXEC`: its own executable, which, run as
 * `<exe> --cez-disclaim-exec <program> <args…>`, replaces itself (same pid, same stdio) with
 * `program` as its own responsible process. Agent backends are started through it, so the prompt
 * names the agent (`claude`, `codex`, …) and a grant covers that agent only. The cockpit server
 * itself stays the app's — the folder picker's prompts are still Cezar's, which they should be.
 *
 * The prompt names the executable's REAL file, past symlinks: Claude Code's native install links
 * `claude` to `versions/2.1.295`, so it asked as "2.1.295". A Mach-O whose file name is not the
 * agent's runs from an APFS clone named after it (`~/.cache/cez/agent-exec/`) — no extra disk,
 * same code signature, so a grant still follows the agent's identity. No clone, no rename.
 * A Node script (an npm install) would ask as "node", so it runs on a clone of its `node` named
 * after the agent; a bash launcher stays as it is unless its runner unwraps it (`cursor-agent`).
 *
 * Anywhere else — no desktop shell, not macOS, a program that does not resolve — the command is
 * returned untouched, so a missing binary still fails the spawn with the usual ENOENT and hint.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';

export const DISCLAIM_EXEC_FLAG = '--cez-disclaim-exec';

export interface DisclaimOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Where `CEZ_DISCLAIM_EXEC` is read from; defaults to `process.env`. */
  hostEnv?: NodeJS.ProcessEnv;
  /** Where agent-named clones live; defaults to `~/.cache/cez/agent-exec`. */
  cloneDir?: string;
  /** The name a privacy prompt should show; defaults to `program`'s file name. */
  name?: string;
}

/** Whether `disclaimedCommand` reroutes at all: the desktop shell on macOS. */
export function disclaimActive(opts: DisclaimOptions = {}): boolean {
  const trampoline = (opts.hostEnv ?? process.env).CEZ_DISCLAIM_EXEC;
  return (opts.platform ?? process.platform) === 'darwin' && !!trampoline && isExecutable(trampoline);
}

/** `[file, args]` to spawn so `program` runs as its own responsible process when it can. */
export function disclaimedCommand(
  program: string,
  args: readonly string[],
  childEnv: NodeJS.ProcessEnv | undefined,
  opts: DisclaimOptions = {},
): [string, string[]] {
  if (!disclaimActive(opts)) return [program, [...args]];
  const trampoline = (opts.hostEnv ?? process.env).CEZ_DISCLAIM_EXEC!;
  const path = childEnv?.PATH ?? process.env.PATH;
  const resolved = resolveProgram(program, path);
  if (!resolved) return [program, [...args]];
  const name = opts.name ?? basename(program);
  const cloneDir = opts.cloneDir ?? join(homedir(), '.cache', 'cez', 'agent-exec');
  const shebang = nodeShebang(resolved);
  const node = shebang && resolveProgram(shebang[0]!, path);
  if (shebang && node && isRealNode(node)) {
    return [trampoline, [DISCLAIM_EXEC_FLAG, namedAfterAgent(node, name, cloneDir), ...shebang.slice(1), resolved, ...args]];
  }
  return [trampoline, [DISCLAIM_EXEC_FLAG, namedAfterAgent(resolved, name, cloneDir), ...args]];
}

/** `[node, …flags]` from a `#!/usr/bin/env node` (or `-S node …`, or `/path/node`) script, else null. */
function nodeShebang(path: string): string[] | null {
  try {
    const head = readHead(path, 256).toString('utf8');
    if (!head.startsWith('#!')) return null;
    let [interpreter, ...rest] = head.slice(2).split('\n')[0]!.trim().split(/\s+/);
    if (interpreter && basename(interpreter) === 'env') {
      if (rest[0] === '-S') rest = rest.slice(1);
      [interpreter, ...rest] = rest;
    }
    return interpreter && basename(interpreter) === 'node' ? [interpreter, ...rest] : null;
  } catch {
    return null;
  }
}

/** A Volta or mise `node` is a multicall shim that picks its tool by its own name; never rename one. */
function isRealNode(path: string): boolean {
  try {
    return basename(realpathSync(path)) === 'node';
  } catch {
    return false;
  }
}

/** `resolved`, or a clone of its real file named `name`; any failure keeps `resolved`. */
function namedAfterAgent(resolved: string, name: string, cloneDir: string): string {
  try {
    const real = realpathSync(resolved);
    // Scripts find their siblings relative to their own path; only a Mach-O is safe to move.
    if (basename(real) === name || !isMachO(real)) return resolved;
    const { size, mtimeMs } = statSync(real);
    const key = createHash('sha256').update(`${real}\0${size}\0${mtimeMs}`).digest('hex').slice(0, 16);
    const slot = `${name}-${key}`;
    const target = join(cloneDir, slot, name);
    if (isExecutable(target)) return target;
    mkdirSync(join(cloneDir, slot), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    // `cp -c` is clonefile(2): a clone or an error, never a silent full copy of a 200 MB binary
    // (Node's COPYFILE_FICLONE_FORCE is ENOSYS on macOS).
    execFileSync('/bin/cp', ['-c', real, tmp], { stdio: 'ignore', timeout: 10_000 });
    renameSync(tmp, target);
    // Drop the clones of versions this agent has moved past (a running one keeps its inode).
    for (const entry of readdirSync(cloneDir)) {
      if (entry !== slot && entry.startsWith(`${name}-`) && entry.length === slot.length) {
        rmSync(join(cloneDir, entry), { recursive: true, force: true });
      }
    }
    return target;
  } catch {
    return resolved;
  }
}

const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(path: string): boolean {
  const head = readHead(path, 4);
  return head.length === 4 && MACHO_MAGIC.has(head.readUInt32BE(0));
}

/** Up to the first `bytes` bytes of `path`, read through one descriptor. */
export function readHead(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(bytes);
    return head.subarray(0, readSync(fd, head, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

/** `program` as an absolute executable path: itself when absolute, else the first hit on `path`. */
export function resolveProgram(program: string, path: string | undefined): string | null {
  if (program.includes('/')) return isAbsolute(program) && isExecutable(program) ? program : null;
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, program);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
