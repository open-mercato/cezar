import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

describe('CEZ:MONITORING on a non-final workflow step (#1076)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  const workflow: WorkflowDef = {
    name: 'implement-verify',
    source: 'built-in',
    steps: [
      { id: 'implement', name: 'Implement', prompt: '{{task}}' },
      { id: 'verify', name: 'Verify', command: 'true' },
    ],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-1076-'));
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    currentId = undefined;
  });

  afterEach(() => {
    if (currentId) manager.cancel(currentId);
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (id: string, predicate: (record: RunRecord | undefined) => boolean) => {
    const deadline = Date.now() + 20_000;
    while (!predicate(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it('holds the unfinished non-final step', async () => {
    const record = manager.startRun(workflow, {
      task: 'mock:monitoring compare in the background',
      worktree: false,
    });
    currentId = record.id;
    await waitFor(record.id, (current) => current?.activity === 'monitoring');

    expect(store.getRun(record.id)?.steps.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'implement', status: 'running' },
      { id: 'verify', status: 'pending' },
    ]);
  }, 40_000);

  it('nudges an autonomous non-final monitoring step before it can advance', async () => {
    const record = manager.startRun(workflow, {
      task: 'mock:monitoring compare in the background',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    await waitFor(record.id, (current) => current?.status === 'done');

    const events = store.readEvents(record.id);
    expect(events.some((event) => String(event.message ?? '').includes('autonomous — continuing'))).toBe(true);
    expect(store.getRun(record.id)?.steps.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'implement', status: 'done' },
      { id: 'verify', status: 'done' },
    ]);
  }, 40_000);

  it('keeps monitoring wake-ups bounded and cancellation terminal', async () => {
    manager.dispose();
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: 0.001 } }),
    });
    const record = manager.startRun(workflow, {
      task: 'mock:monitoring compare in the background',
      worktree: false,
    });
    currentId = record.id;
    await waitFor(record.id, (current) => current?.activity === 'monitoring');
    await waitFor(record.id, (current) => Boolean(current?.monitoringWakeAt));
    expect(manager.cancel(record.id)).toBe(true);
    await waitFor(record.id, (current) => current?.status === 'cancelled');
    expect(store.getRun(record.id)?.steps.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'implement', status: 'cancelled' },
      { id: 'verify', status: 'pending' },
    ]);
    expect(store.getRun(record.id)?.activity).toBeUndefined();
  }, 40_000);

  it('recovers a persisted monitoring park without completing downstream work', async () => {
    const record = manager.startRun(workflow, {
      task: 'mock:monitoring compare in the background',
      worktree: false,
    });
    currentId = record.id;
    await waitFor(record.id, (current) => current?.activity === 'monitoring');

    manager.dispose();
    store.flush();
    const reopened = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    store = reopened;
    manager = new RunManager(reopened, repoRoot);
    await manager.recover();

    await waitFor(record.id, (current) => current?.activity === 'monitoring');
    const recovered = store.getRun(record.id);
    expect(recovered?.status).toBe('running');
    expect(recovered?.steps.find((step) => step.id === 'verify')?.status).toBe('pending');
    expect(recovered?.steps.some((step) => step.id.startsWith('continue-'))).toBe(true);
    expect(store.readEvents(record.id).some((event) => String(event.message).includes('run finished'))).toBe(false);
  }, 40_000);
});
