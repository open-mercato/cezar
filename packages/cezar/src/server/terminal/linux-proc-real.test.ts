import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import { hasForeground } from './foreground.ts';
import { readLinuxProcesses, readLinuxProcessesSync } from './linux-proc.ts';
import { descendantGroups, readProcessTreeSync } from './process-tree.ts';

describe.skipIf(process.platform !== 'linux')('live Linux descendant traversal (#2349)', () => {
  it('retains live children, grandchildren and their independent shutdown groups', async () => {
    const child = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const job = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      process.send(job.pid);
      setInterval(() => {}, 1000);
    `], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let job: number | undefined;
    try {
      const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5_000) });
      if (typeof message !== 'number' || child.pid === undefined) throw new Error('Missing child identity');
      job = message;
      const foreground = await readLinuxProcesses();
      expect(hasForeground(foreground ?? [], child.pid)).toBe(true);
      for (const rows of [foreground, readLinuxProcessesSync(), readProcessTreeSync()]) {
        expect(rows).not.toBeNull();
        expect(rows?.some((row) => row.ppid === child.pid)).toBe(true);
        expect(descendantGroups(rows ?? [], child.pid)?.sort((a, b) => a - b)).toEqual([child.pid, job].sort((a, b) => a - b));
      }
    } finally {
      for (const pid of [job, child.pid]) {
        if (pid === undefined) continue;
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    }
  }, 10_000);
});
