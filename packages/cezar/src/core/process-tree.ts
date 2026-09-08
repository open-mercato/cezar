import { spawn, type ChildProcess } from 'node:child_process';

/** Agent backends are process-tree owners: every Unix runner is a process
 * group leader and Windows termination uses taskkill /t. */
export const AGENT_PROCESS_DETACHED = process.platform !== 'win32';

export function signalAgentProcessTree(
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/t'];
    if (signal === 'SIGKILL') args.push('/f');
    const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try {
        process.kill(child.pid, signal);
      } catch {
      }
    }
  }
}

/** Is any process still alive in the child's group? Signal 0 only checks for
 * existence and permission — it delivers nothing. A surviving group member is
 * why escalation cannot be tied to the leader's own exit (2026-07-27). */
function groupStillAlive(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * SIGTERM the whole process group, then escalate to SIGKILL if anything in it
 * outlives the grace window.
 *
 * The escalation used to be gated on the LEADER's `exitCode`/`signalCode` and
 * cancelled outright on its `close`. That is the wrong liveness question: the
 * group SIGTERM does reach every member, but a member that masks or outlasts it
 * — `opencode serve` draining an in-flight turn is the case in practice — then
 * survives, because the leader's exit both fails the guard and clears the timer.
 * Escalation now asks whether the GROUP is still alive.
 *
 * The original guard existed to stop PID reuse turning a watchdog into an
 * unrelated kill, and that risk is real, so the group is re-checked at fire time
 * and the timer is still cleared once the group is genuinely empty.
 */
export function terminateAgentProcessTree(
  child: ChildProcess,
  graceMs: number,
): NodeJS.Timeout {
  const pid = child.pid;
  signalAgentProcessTree(child, 'SIGTERM');
  const timer = setTimeout(() => {
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) {
        signalAgentProcessTree(child, 'SIGKILL');
      }
      return;
    }
    if (groupStillAlive(pid)) signalAgentProcessTree(child, 'SIGKILL');
  }, graceMs);
  child.once('close', () => {
    if (pid === undefined || !groupStillAlive(pid)) clearTimeout(timer);
  });
  timer.unref?.();
  return timer;
}
