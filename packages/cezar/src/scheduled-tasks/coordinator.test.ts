import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTaskCoordinator } from './coordinator.ts';

const dirs: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cezar-sched-coordinator-'));
  dirs.push(root);
  return root;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('ScheduledTaskCoordinator', () => {
  it('discovers only projects carrying the optional definitions file', async () => {
    const first = await project();
    const second = await project();
    await mkdir(join(first, '.ai/cezar'), { recursive: true });
    await writeFile(join(first, '.ai/cezar/scheduled-tasks.json'), '{"version":1,"scheduledTasks":[]}');
    const coordinator = new ScheduledTaskCoordinator({
      listProjects: async () => [
        { id: 'first', root: first, status: 'ok' },
        { id: 'second', root: second, status: 'ok' },
      ],
    });
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual(['first']);
    await expect(import('node:fs/promises').then(({ stat }) => stat(join(second, '.ai')))).rejects.toThrow();
  });

  it('drops removed and gone projects without failing other handles', async () => {
    const root = await project();
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    await writeFile(join(root, '.ai/cezar/scheduled-tasks.json'), '{"version":1,"scheduledTasks":[]}');
    let status: 'ok' | 'missing' = 'ok';
    const coordinator = new ScheduledTaskCoordinator({
      listProjects: async () => [{ id: 'one', root, status }],
    });
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual(['one']);
    status = 'missing';
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual([]);
  });

  it('only lists projects that have an enabled definition', async () => {
    const root = await project();
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    await writeFile(join(root, '.ai/cezar/scheduled-tasks.json'), '{"version":1,"scheduledTasks":[]}');
    const coordinator = new ScheduledTaskCoordinator({
      listProjects: async () => [{ id: 'one', root, status: 'ok' }],
    });
    await coordinator.refresh();
    expect(coordinator.enabledProjectIds()).toEqual([]);
    const store = coordinator.store('one')!;
    store.create({
      name: 'x', enabled: true,
      timing: { kind: 'once', at: '2026-09-01T13:30:00.000Z', timezone: 'UTC' },
      task: { prompt: 'go' },
    });
    expect(coordinator.enabledProjectIds()).toEqual(['one']);
  });

  it('degrades registry failures to warnings', async () => {
    const warn = vi.fn();
    const coordinator = new ScheduledTaskCoordinator({ listProjects: async () => { throw new Error('offline'); }, warn });
    await expect(coordinator.refresh()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });
});
