import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** "Start now" on a queued task: it starts over a saturated `maxParallel`, and only that task does. */
describe('RunManager.startNow', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let unregister: () => void;
  /** Accounts the stub participant reports as waiting out a usage-limit reset. */
  let heldAccounts: Set<string>;
  let semaphore: WorkspaceSemaphore;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-start-now-'));
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    // Another project holding the only workspace slot for the whole test.
    heldAccounts = new Set();
    unregister = semaphore.register({
      busySlots: () => 1,
      pump: () => {},
      oldestQueuedAt: () => null,
      accountHolds: () => ({ deadline: heldAccounts, inFlight: new Set() }),
    });
    manager = new RunManager(store, repoRoot, { semaphore });
  });

  afterEach(() => {
    unregister();
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const leftQueue = async (id: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (store.getRun(id)?.status === 'queued') {
      if (Date.now() > deadline) throw new Error('run never left the queue');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('starts the chosen queued run over the cap and leaves the rest queued', async () => {
    const first = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:done first', worktree: false });
    const second = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:done second', worktree: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(store.getRun(first.id)?.status).toBe('queued');
    expect(store.getRun(second.id)?.status).toBe('queued');

    expect(await manager.startNow(second.id)).toBe('started');
    await leftQueue(second.id);

    expect(store.getRun(first.id)?.status).toBe('queued');
  }, 30_000);

  it('refuses a run that is not queued', async () => {
    expect(await manager.startNow('no-such-run')).toBe('not-queued');
  });

  it('refuses a run whose account is held, and leaves no mark to jump the cap once it lifts', async () => {
    heldAccounts.add('claude:default');
    const queued = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:done held', worktree: false });
    await new Promise((r) => setTimeout(r, 100));

    expect(await manager.startNow(queued.id)).toBe('held');

    heldAccounts.clear();
    await semaphore.release(); // a pump with the hold gone — the cap is still saturated
    await new Promise((r) => setTimeout(r, 300));
    expect(store.getRun(queued.id)?.status).toBe('queued');
  });
});
