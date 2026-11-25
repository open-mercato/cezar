/**
 * Stop a child and everything it started (#2467). POSIX: the child must have been spawned
 * `detached` so it leads its own group; SIGTERM the group, SIGKILL it after a grace. Windows has
 * no groups, so `taskkill /T /F` takes the tree. Never throws.
 */

import { spawn } from 'node:child_process';

/** `detached` for a spawn whose descendants must be killable as a group (Windows would open a console). */
export const detachesProcessGroup = process.platform !== 'win32';

export function killProcessTree(pid: number | undefined, graceMs = 2_000): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } catch {
      // already gone
    }
    return;
  }
  const send = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      // group already empty
    }
  };
  send('SIGTERM');
  setTimeout(() => send('SIGKILL'), graceMs).unref?.();
}

const tracked = new Set<number>();
let exitHook = false;

/**
 * Remember a detached child's tree until `untrack`, and SIGKILL whatever is still tracked when
 * cezar exits: a detached group is outside the tty's foreground group, so Ctrl-C no longer
 * reaches it (#2467). A SIGKILLed cezar cannot run this; the reaper covers that case.
 */
export function trackProcessTree(pid: number | undefined): () => void {
  if (pid === undefined || !detachesProcessGroup) return () => undefined;
  tracked.add(pid);
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => {
      for (const p of tracked) {
        try {
          process.kill(-p, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });
  }
  return () => {
    tracked.delete(pid);
  };
}
