/**
 * The process a check step (and a landing check) runs: the repo's own commands, its test suite
 * included, in a login `bash`. It gets a process group of its own, so a group signal from inside it
 * (`kill(0)`, `kill(-pgid)`) stays in the check. Sharing the cockpit's group, one test killed a
 * stage it never started and SIGKILLed the cockpit, its agents and the desktop app, twice on
 * 2026-11-25 (`core/child-kill-guard.ts`). Windows has no process group; `detached` there would
 * open a console window instead.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { hasSignallablePid } from '../core/child-kill-guard.ts';

const CHECK_GROUPS = process.platform !== 'win32';
const liveChecks = new Set<ChildProcessWithoutNullStreams>();
let exitHookInstalled = false;

export function spawnCheck(command: string, cwd: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn('bash', ['-lc', command], { cwd, env, detached: CHECK_GROUPS });
  liveChecks.add(child);
  const forget = () => liveChecks.delete(child);
  child.once('close', forget);
  child.once('error', forget);
  // In its own group a check no longer hears the terminal's Ctrl-C, so the cockpit's exit ends it.
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const live of liveChecks) signalCheck(live, 'SIGTERM');
    });
  }
  return child;
}

/** Signals the check's whole group — what it started goes too — or just the child without one. */
export function signalCheck(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!hasSignallablePid(child) || child.exitCode !== null || child.signalCode !== null) return;
  if (CHECK_GROUPS) {
    try {
      process.kill(-child.pid!, signal);
      return;
    } catch {
      // the group is already empty: fall through to the child itself
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/** Checks still running — for tests. */
export function liveCheckCount(): number {
  return liveChecks.size;
}
