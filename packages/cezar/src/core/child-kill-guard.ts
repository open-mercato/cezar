/**
 * `ChildProcess.kill()` on a child whose spawn failed (ENOENT, EACCES) can be a process-GROUP
 * kill: until Node emits the spawn error a tick later the handle's pid is 0, and a libuv that
 * still sends `kill(0, signal)` signals every process in the caller's group (Node 24.22 and 26.13
 * do not; `engines` admits older runtimes). Under the desktop app that group was the app itself: a check step's test suite killed a stage it could not start and SIGKILLed
 * the shell, the cockpit and every agent, twice on 2026-11-25.
 *
 * The guard makes `kill()` a no-op (`false`, as for an exited child) for any child without a
 * real pid, wherever the call comes from — our runners, a library, a test.
 */

import { ChildProcess } from 'node:child_process';

const GUARDED = Symbol.for('cezar.childKillGuard');

/** A pid `kill()` may signal: a started child's. Never 0 (the group) or a negative (a group). */
export function hasSignallablePid(child: Pick<ChildProcess, 'pid'>): boolean {
  return Number.isInteger(child.pid) && (child.pid as number) > 0;
}

/** Idempotent; returns whether it installed (false when it already was). */
export function guardChildProcessKill(): boolean {
  const proto = ChildProcess.prototype as ChildProcess & { [GUARDED]?: true };
  if (proto[GUARDED]) return false;
  const kill = proto.kill;
  proto.kill = function guardedKill(this: ChildProcess, signal?: NodeJS.Signals | number): boolean {
    if (!hasSignallablePid(this)) return false;
    return kill.call(this, signal);
  };
  proto[GUARDED] = true;
  return true;
}
