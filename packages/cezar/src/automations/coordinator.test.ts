import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationCoordinator } from './coordinator.ts';

const dirs: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cezar-coordinator-'));
  dirs.push(root);
  return root;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('AutomationCoordinator', () => {
  it('discovers only projects carrying the optional definitions file', async () => {
    const first = await project();
    const second = await project();
    await mkdir(join(first, '.ai/cezar'), { recursive: true });
    await writeFile(join(first, '.ai/cezar/automations.json'), '{"version":1,"automations":[]}');
    const coordinator = new AutomationCoordinator({
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
    await writeFile(join(root, '.ai/cezar/automations.json'), '{"version":1,"automations":[]}');
    let status: 'ok' | 'missing' = 'ok';
    const coordinator = new AutomationCoordinator({
      listProjects: async () => [{ id: 'one', root, status }],
    });
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual(['one']);
    status = 'missing';
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual([]);
  });

  /**
   * The boot project is the one project the registry may legitimately not name:
   * `cezar serve` serves the folder it was started in either way, and since boot
   * registration became seed-once that folder is usually unregistered, so its
   * store is keyed on the `'default'` alias. Without the pin, the sweep in
   * `refresh()` reads "not in the registry" as "stale" and drops it — and because
   * the API keeps answering out of the store handle the server already holds, the
   * cockpit would go on listing those automations as enabled while the scheduler
   * had stopped polling for them. That silence is the whole reason this is pinned.
   */
  it('keeps the pinned boot project the registry never names', async () => {
    const boot = await project();
    const registered = await project();
    for (const root of [boot, registered]) {
      await mkdir(join(root, '.ai/cezar'), { recursive: true });
      await writeFile(join(root, '.ai/cezar/automations.json'), '{"version":1,"automations":[]}');
    }
    const coordinator = new AutomationCoordinator({
      // What the real registry answers for an unregistered boot folder: the boot
      // root simply is not in it.
      listProjects: async () => [{ id: 'kept', root: registered, status: 'ok' }],
      pinned: 'default',
    });
    // How the server opens it — by the boot alias, before any refresh runs.
    expect(coordinator.store('default', boot)).toBeDefined();

    await coordinator.refresh();

    expect(coordinator.ids().sort()).toEqual(['default', 'kept']);
    expect(coordinator.store('default')).toBeDefined();
  });

  it('still evicts a genuinely stale handle when a boot project is pinned', async () => {
    // The pin is one id, not an amnesty: a project that really did leave the
    // registry must still be dropped.
    const gone = await project();
    await mkdir(join(gone, '.ai/cezar'), { recursive: true });
    await writeFile(join(gone, '.ai/cezar/automations.json'), '{"version":1,"automations":[]}');
    const coordinator = new AutomationCoordinator({ listProjects: async () => [], pinned: 'default' });
    expect(coordinator.store('gone', gone)).toBeDefined();
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual([]);
  });

  it('degrades registry and corrupt definition failures to warnings', async () => {
    const warn = vi.fn();
    const coordinator = new AutomationCoordinator({ listProjects: async () => { throw new Error('offline'); }, warn });
    await expect(coordinator.refresh()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });
});
