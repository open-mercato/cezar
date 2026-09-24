import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore, type WorkspaceResourceLimits } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * "Run next" (brief .ai/specs/briefs/2026-09-23-queued-task-run-next.md): a queued run can be
 * promoted to the front of its queue, so it takes the first slot the ordinary gates allow.
 *
 * The cap is held at 0 while the queue is arranged, so nothing starts behind the test's back;
 * `refresh()` then raises it, which is exactly the "a slot came free" sweep production runs.
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const settled = ['done', 'failed', 'cancelled', 'review'];

/** Long enough that the run which took the single slot is still running when we look. */
const HOLD: WorkflowDef = {
  name: 'hold',
  source: 'built-in',
  steps: [{ id: 'hold', command: 'node -e "setTimeout(()=>{},1500)"' }],
};

function fixtureRepo(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-run-next-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  return root;
}

async function waitFor(predicate: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A semaphore whose cap the test turns up with `open()`. */
function gatedSemaphore(): { semaphore: WorkspaceSemaphore; open: (cap: number) => Promise<void> } {
  let limits: WorkspaceResourceLimits = { maxParallel: 0, memoryLimitMb: null };
  const semaphore = new WorkspaceSemaphore({ initial: limits, load: async () => limits });
  return {
    semaphore,
    open: async (cap) => {
      limits = { ...limits, maxParallel: cap };
      await semaphore.refresh();
    },
  };
}

const queueOf = (manager: RunManager): string[] => (manager as unknown as { queue: string[] }).queue;

describe('RunManager.promote — "Run next"', () => {
  const roots: string[] = [];
  const managers: RunManager[] = [];
  const stores: RunStore[] = [];
  let savedDryRun: string | undefined;

  function project(semaphore: WorkspaceSemaphore, root = fixtureRepo(roots)) {
    const store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    const manager = new RunManager(store, root, { semaphore });
    stores.push(store);
    managers.push(manager);
    return { store, manager, root };
  }

  beforeEach(() => {
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
  });

  afterEach(async () => {
    for (const [index, store] of stores.entries()) {
      for (const run of store.listRuns()) {
        if (!settled.includes(run.status)) managers[index]?.cancel(run.id);
      }
      await waitFor(() => store.listRuns().every((r) => settled.includes(r.status)), 'runs to settle').catch(
        () => undefined,
      );
      store.flush();
    }
    for (const manager of managers.splice(0)) manager.dispose();
    stores.length = 0;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  it('keeps plain FIFO when nothing is promoted', () => {
    const { semaphore } = gatedSemaphore();
    const { manager } = project(semaphore);
    const ids = ['a', 'b', 'c'].map((task) => manager.startRun(HOLD, { task }).id);
    expect(queueOf(manager)).toEqual(ids);
  });

  it('moves the promoted run to the front and starts it in the first free slot', async () => {
    const gate = gatedSemaphore();
    const { store, manager } = project(gate.semaphore);
    const [a, b, c] = ['a', 'b', 'c'].map((task) => manager.startRun(HOLD, { task }).id) as [string, string, string];

    expect(manager.promote(c)).toBe(true);
    expect(queueOf(manager)).toEqual([c, a, b]);
    expect(store.getRun(c)?.promotedAt).toBeDefined();

    await gate.open(1);
    await waitFor(() => store.getRun(c)?.status !== 'queued', 'the promoted run to start');
    expect(store.getRun(a)?.status).toBe('queued');
    expect(store.getRun(b)?.status).toBe('queued');
    // Leaving the queue gives the place up, so a later re-queue lands at the tail.
    expect(store.getRun(c)?.promotedAt).toBeUndefined();
  });

  it('the newest promotion goes first, and promoting again re-stamps to the top', async () => {
    const { semaphore } = gatedSemaphore();
    const { manager } = project(semaphore);
    const [a, b, c] = ['a', 'b', 'c'].map((task) => manager.startRun(HOLD, { task }).id) as [string, string, string];

    manager.promote(a);
    await new Promise((resolve) => setTimeout(resolve, 5));
    manager.promote(c);
    expect(queueOf(manager)).toEqual([c, a, b]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    manager.promote(a);
    expect(queueOf(manager)).toEqual([a, c, b]);
  });

  it('never bypasses the cap: with no free slot the promoted run keeps waiting', async () => {
    const gate = gatedSemaphore();
    const { store, manager } = project(gate.semaphore);
    const holder = manager.startRun(HOLD, { task: 'holder' }).id;
    await gate.open(1);
    await waitFor(() => store.getRun(holder)?.status === 'running', 'the holder to take the slot');

    const queued = manager.startRun(HOLD, { task: 'queued' }).id;
    expect(manager.promote(queued)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.getRun(queued)?.status).toBe('queued');
  });

  it('answers false for a run that is not waiting in the queue', async () => {
    const gate = gatedSemaphore();
    const { store, manager } = project(gate.semaphore);
    const running = manager.startRun(HOLD, { task: 'running' }).id;
    await gate.open(1);
    await waitFor(() => store.getRun(running)?.status === 'running', 'the run to start');

    expect(manager.promote(running)).toBe(false);
    expect(manager.promote('no-such-run')).toBe(false);
    expect(store.getRun(running)?.promotedAt).toBeUndefined();
  });

  it('cancelling a promoted run retires the mark', () => {
    const { semaphore } = gatedSemaphore();
    const { store, manager } = project(semaphore);
    const id = manager.startRun(HOLD, { task: 'x' }).id;
    manager.promote(id);
    manager.cancel(id);
    expect(store.getRun(id)?.status).toBe('cancelled');
    expect(store.getRun(id)?.promotedAt).toBeUndefined();
  });

  it('across projects, a freed slot goes to the promoted run before an older unpromoted one', async () => {
    const gate = gatedSemaphore();
    const a = project(gate.semaphore);
    const b = project(gate.semaphore);
    const older = a.manager.startRun(HOLD, { task: 'older, in A' }).id;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = b.manager.startRun(HOLD, { task: 'newer, in B' }).id;
    b.manager.promote(newer);
    // Let the pumps `startRun`/`promote` kicked off finish first. A pump still awaiting
    // `getRepoInfo` when the cap opens reads the NEW cap and starts its own head — the
    // documented best-effort fairness of the sweep, not what this test is about.
    const idle = (manager: RunManager) => !(manager as unknown as { pumping: boolean }).pumping;
    await waitFor(() => idle(a.manager) && idle(b.manager), 'both managers to finish pumping');

    await gate.open(1);
    await waitFor(() => b.store.getRun(newer)?.status !== 'queued', 'the promoted run in B to start');
    expect(a.store.getRun(older)?.status).toBe('queued');
  });

  it('survives a restart: recovery re-queues the promoted run ahead of older ones', async () => {
    const first = gatedSemaphore();
    const { store, manager, root } = project(first.semaphore);
    const [a, b, c] = ['a', 'b', 'c'].map((task) => manager.startRun(HOLD, { task }).id) as [string, string, string];
    manager.promote(b);
    store.flush();
    manager.dispose();
    // The "previous process" is gone; teardown drives the reopened one.
    managers.splice(managers.indexOf(manager), 1);
    stores.splice(stores.indexOf(store), 1);

    const second = gatedSemaphore();
    const reopened = project(second.semaphore, root);
    await reopened.manager.recover();
    expect(queueOf(reopened.manager)).toEqual([b, a, c]);
  });
});
