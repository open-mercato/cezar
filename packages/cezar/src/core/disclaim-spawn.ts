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
 * Anywhere else — no desktop shell, not macOS, a program that does not resolve — the command is
 * returned untouched, so a missing binary still fails the spawn with the usual ENOENT and hint.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export const DISCLAIM_EXEC_FLAG = '--cez-disclaim-exec';

export interface DisclaimOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Where `CEZ_DISCLAIM_EXEC` is read from; defaults to `process.env`. */
  hostEnv?: NodeJS.ProcessEnv;
}

/** `[file, args]` to spawn so `program` runs as its own responsible process when it can. */
export function disclaimedCommand(
  program: string,
  args: readonly string[],
  childEnv: NodeJS.ProcessEnv | undefined,
  opts: DisclaimOptions = {},
): [string, string[]] {
  const platform = opts.platform ?? process.platform;
  const trampoline = (opts.hostEnv ?? process.env).CEZ_DISCLAIM_EXEC;
  if (platform !== 'darwin' || !trampoline || !isExecutable(trampoline)) return [program, [...args]];
  const resolved = resolveProgram(program, childEnv?.PATH ?? process.env.PATH);
  if (!resolved) return [program, [...args]];
  return [trampoline, [DISCLAIM_EXEC_FLAG, resolved, ...args]];
}

function resolveProgram(program: string, path: string | undefined): string | null {
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
