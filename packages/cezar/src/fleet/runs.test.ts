import { describe, expect, it } from 'vitest';
import { createFleetRunHost, type BootProject } from './runs.ts';

const run = (id: string, status: string, fleetJobId?: string) => ({ id, status, ...(fleetJobId ? { fleetJobId } : {}) });

describe('cancelOrphans', () => {
  it('cancels live fleet-tagged runs left by a previous process and nothing else', async () => {
    const cancelled: string[] = [];
    const boot = {
      root: '/boot',
      dataDir: '/boot/.ai/cezar',
      store: { listRuns: () => [run('a', 'waiting', 'job-1'), run('b', 'queued', 'job-2'), run('c', 'running'), run('d', 'done', 'job-3')] },
      manager: { cancel: (id: string) => { cancelled.push(id); return true; } },
    } as unknown as BootProject;
    const host = createFleetRunHost({ boot, context: async () => boot });
    expect(await host.cancelOrphans()).toBe(2);
    expect(cancelled).toEqual(['a', 'b']);
  });
});
