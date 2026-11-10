import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationCoordinator } from './coordinator.ts';
import { AutomationStore } from './store.ts';

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

  /**
   * The exact sequence the cockpit's **Add project** button performs on the folder
   * cezar was started in: the server has already opened that root under the boot
   * alias, and the registry then gains the SAME root under a freshly allocated
   * slug. Two ids, one `.ai/cezar` directory.
   *
   * `AutomationStore` is file-backed with an in-memory snapshot taken at `open()`,
   * so a second instance over that directory is not a harmless duplicate: the
   * cockpit keeps writing through the alias handle while the scheduler polls the
   * slug's stale copy, and a disabled automation goes on firing until the process
   * restarts. One store per root is what makes that state unrepresentable.
   */
  it('serves two ids for one root from a single store', async () => {
    const root = await project();
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    await writeFile(join(root, '.ai/cezar/automations.json'), '{"version":1,"automations":[]}');
    let registry: { id: string; root: string; status: 'ok' }[] = [];
    const coordinator = new AutomationCoordinator({
      listProjects: async () => registry,
      pinned: 'default',
    });
    // How the server opens the boot folder before it is registered.
    const boot = coordinator.store('default', root);
    expect(boot).toBeDefined();

    // …and what Add project does: the same root, now carrying a registry slug.
    registry = [{ id: 'my-repo', root, status: 'ok' }];
    await coordinator.refresh();

    expect(coordinator.store('my-repo')).toBe(boot);
    expect(coordinator.ids().sort()).toEqual(['default', 'my-repo']);
  });

  it('schedules a doubly-addressed root once, under the pinned id', async () => {
    // The scheduler builds one due entry per id this returns, so a root reachable
    // by two ids polled GitHub and launched runs twice. The pinned id wins the tie
    // because only that one routes `launch` to the boot manager and store; the slug
    // would build a second ProjectContext over the same root.
    const root = await project();
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    AutomationStore.open(join(root, '.ai/cezar')).create(
      {
        name: 'Review PRs',
        enabled: true,
        events: ['pull_request.opened'],
        intervalSeconds: 300,
        filters: { lookbackDays: 7, maxRecords: 25 },
        task: { prompt: 'Review' },
      },
      'review-prs',
    );
    const coordinator = new AutomationCoordinator({
      listProjects: async () => [{ id: 'my-repo', root, status: 'ok' }],
      pinned: 'default',
    });
    coordinator.store('default', root);
    await coordinator.refresh();

    expect(coordinator.enabledProjectIds()).toEqual(['default']);
  });

  it('keeps the surviving id its store when its twin is removed', async () => {
    // Dropping the shared store with the first id to leave would hand the survivor
    // a fresh snapshot — the divergence again, by a slower route.
    const root = await project();
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    await writeFile(join(root, '.ai/cezar/automations.json'), '{"version":1,"automations":[]}');
    const coordinator = new AutomationCoordinator({ listProjects: async () => [] });
    const first = coordinator.store('default', root);
    expect(coordinator.store('my-repo', root)).toBe(first);

    coordinator.remove('my-repo');

    expect(coordinator.store('default')).toBe(first);
    expect(coordinator.ids()).toEqual(['default']);
  });

  it('degrades registry and corrupt definition failures to warnings', async () => {
    const warn = vi.fn();
    const coordinator = new AutomationCoordinator({ listProjects: async () => { throw new Error('offline'); }, warn });
    await expect(coordinator.refresh()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });
});
