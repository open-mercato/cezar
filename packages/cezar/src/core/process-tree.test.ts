import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { AGENT_PROCESS_DETACHED, terminateAgentProcessTree } from './process-tree.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signal 0 delivers nothing — it only answers "does this pid exist?". */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Review finding (2026-07-27): SIGKILL escalation was gated on the process-GROUP
 * LEADER's own exit and cancelled on its `close`. The group SIGTERM does reach
 * every member, so the leak is narrower than "grandchildren are orphaned" — but a
 * member that masks or outlasts SIGTERM (a server draining an in-flight turn,
 * which is exactly what `opencode serve` does) survived forever, because the
 * leader exiting both failed the liveness guard and cleared the escalation timer.
 *
 * These spawn real processes: the bug is in process semantics, and a fake would
 * only re-assert whatever model the fake encodes.
 */
describe.skipIf(process.platform === 'win32')('terminateAgentProcessTree', () => {
  it('escalates to SIGKILL for a group member that ignores SIGTERM after the leader exits', async () => {
    // Leader exits promptly on SIGTERM; its child traps SIGTERM and keeps running.
    const leader = spawn(
      '/bin/sh',
      ['-c', `/bin/sh -c 'trap "" TERM; while :; do sleep 0.05; done' & echo $!; wait $!`],
      { detached: AGENT_PROCESS_DETACHED, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    leader.stdout.setEncoding('utf8');
    leader.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    // Let the stubborn grandchild start and report its pid.
    await wait(250);
    const stubbornPid = Number(out.trim().split('\n')[0]);
    expect(Number.isInteger(stubbornPid)).toBe(true);
    expect(alive(stubbornPid)).toBe(true);

    terminateAgentProcessTree(leader, 300);

    // Grace window plus slack: the leader is long gone, the trapping child is not.
    await wait(1200);
    expect(alive(stubbornPid)).toBe(false);
  }, 15_000);

  it('still terminates an ordinary child that honours SIGTERM', async () => {
    const child = spawn('/bin/sh', ['-c', 'while :; do sleep 0.05; done'], {
      detached: AGENT_PROCESS_DETACHED,
      stdio: 'ignore',
    });
    await wait(150);
    const pid = child.pid!;
    expect(alive(pid)).toBe(true);

    terminateAgentProcessTree(child, 5_000);

    await wait(400);
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it('does not throw for a child that has already exited', async () => {
    const child = spawn('/bin/sh', ['-c', 'exit 0'], {
      detached: AGENT_PROCESS_DETACHED,
      stdio: 'ignore',
    });
    await new Promise((resolve) => child.once('close', resolve));

    expect(() => terminateAgentProcessTree(child, 50)).not.toThrow();
    await wait(150);
  }, 15_000);
});
