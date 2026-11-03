import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  describeReaped,
  listTaskProcesses,
  parsePsEnvOutput,
  ppidFromStat,
  reapTaskProcesses,
  taskIdFromEnviron,
  taskProcessReapEnabled,
  type TaskProcess,
} from './task-processes.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('task-processes parsers', () => {
  it('reads CEZ_TASK_ID from a NUL-separated environ', () => {
    expect(taskIdFromEnviron('PATH=/bin\0CEZ_TASK_ID=abc-123\0HOME=/h\0')).toBe('abc-123');
    expect(taskIdFromEnviron('PATH=/bin\0XCEZ_TASK_ID=nope\0')).toBeUndefined();
    expect(taskIdFromEnviron('CEZ_TASK_ID=\0')).toBeUndefined();
    expect(taskIdFromEnviron('')).toBeUndefined();
  });

  it('reads the ppid after the last paren of /proc/<pid>/stat', () => {
    expect(ppidFromStat('4242 (my (odd) prog) S 17 4242 4242 0 -1')).toBe(17);
    expect(ppidFromStat('1 (systemd) S 0 1 1')).toBe(0);
  });

  it('parses macOS ps -E rows, keeping only marked processes but every parent link', () => {
    const { procs, parents } = parsePsEnvOutput(
      [
        '  101     1 /usr/bin/program --flag PATH=/bin CEZ_TASK_ID=run-1 HOME=/h',
        '  102   101 node server.js PATH=/bin HOME=/h',
        'garbage',
      ].join('\n'),
    );
    expect(procs).toEqual([{ pid: 101, taskId: 'run-1', command: '/usr/bin/program --flag PATH=/bin' }]);
    expect(parents.get(102)).toBe(101);
  });

  it('is on unless CEZ_TASK_PROCESS_REAP is exactly 0', () => {
    expect(taskProcessReapEnabled({})).toBe(true);
    expect(taskProcessReapEnabled({ CEZ_TASK_PROCESS_REAP: '1' })).toBe(true);
    expect(taskProcessReapEnabled({ CEZ_TASK_PROCESS_REAP: '0' })).toBe(false);
  });

  it('describes reaped processes for the lifecycle note', () => {
    const p = (pid: number): TaskProcess => ({ pid, taskId: 't', command: `cmd${pid}` });
    expect(describeReaped([p(1)])).toBe('1 process: cmd1 (pid 1)');
    expect(describeReaped([1, 2, 3, 4, 5, 6].map(p))).toMatch(/^6 processes: .*cmd5 \(pid 5\), \+1 more$/);
  });
});

describe('reapTaskProcesses', () => {
  const procs: TaskProcess[] = [
    { pid: 10, taskId: 'a', command: 'sleep' },
    { pid: 11, taskId: 'b', command: 'sleep' },
  ];

  it('SIGTERMs matching processes, then SIGKILLs only the survivors', async () => {
    const sent: string[] = [];
    let listed = 0;
    const killed = await reapTaskProcesses({
      match: (id) => id === 'a',
      killGraceMs: 1,
      // second listing: pid 10 survived SIGTERM
      list: async () => (listed++ === 0 ? procs : [procs[0] as TaskProcess]),
      kill: (pid, sig) => void sent.push(`${pid}:${sig}`),
    });
    expect(killed.map((p) => p.pid)).toEqual([10]);
    expect(sent).toEqual(['10:SIGTERM', '10:SIGKILL']);
  });

  it('signals nothing once the task is live again', async () => {
    const sent: string[] = [];
    const killed = await reapTaskProcesses({
      match: () => true,
      stillSettled: () => false,
      list: async () => procs,
      kill: (pid, sig) => void sent.push(`${pid}:${sig}`),
    });
    expect(killed).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('never throws on a failing listing or kill', async () => {
    await expect(
      reapTaskProcesses({ match: () => true, list: () => Promise.reject(new Error('x')) }),
    ).resolves.toEqual([]);
    await expect(
      reapTaskProcesses({
        match: () => true,
        list: async () => procs,
        kill: () => {
          throw new Error('ESRCH');
        },
      }),
    ).resolves.toEqual([]);
  });
});

describe.runIf(process.platform === 'linux')('reaping real processes (linux)', () => {
  it('finds and stops a re-parented setsid process carrying the marker, and nothing else', async () => {
    const taskId = randomUUID();
    const other = randomUUID();
    // `setsid` forks when it already leads a group, so the sleep's pid comes from the listing.
    const spawnSleep = (id: string): void =>
      spawn('setsid', ['sleep', '100000'], { env: { ...process.env, CEZ_TASK_ID: id }, detached: true, stdio: 'ignore' }).unref();
    spawnSleep(taskId);
    spawnSleep(other);
    const pidOf = async (id: string): Promise<number | undefined> =>
      (await listTaskProcesses()).find((p) => p.taskId === id && p.command.includes('sleep 100000'))?.pid;
    let target = 0;
    let bystander = 0;
    try {
      expect(await waitFor(async () => (target = (await pidOf(taskId)) ?? 0) > 0)).toBe(true);
      expect(await waitFor(async () => (bystander = (await pidOf(other)) ?? 0) > 0)).toBe(true);
      const killed = await reapTaskProcesses({ match: (id) => id === taskId, killGraceMs: 200 });
      expect(killed.map((p) => p.taskId)).toEqual([taskId]);
      expect(killed[0]?.command).toContain('sleep 100000');
      expect(await waitFor(() => !alive(target))).toBe(true);
      expect(alive(bystander)).toBe(true);
      // cezar's own process is never listed, whatever it inherited
      expect((await listTaskProcesses()).some((p) => p.pid === process.pid)).toBe(false);
    } finally {
      for (const pid of [target, bystander]) {
        if (!pid) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  });
});
