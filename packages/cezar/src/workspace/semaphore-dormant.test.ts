import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const reads: string[] = [];
vi.mock('../runs/run-index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runs/run-index.ts')>();
  return {
    ...actual,
    readRunIndexFromDisk: (dataDir: string) => {
      reads.push(dataDir);
      return actual.readRunIndexFromDisk(dataDir);
    },
  };
});

const { WorkspaceSemaphore } = await import('./semaphore.ts');
const { RunStore } = await import('../runs/store.ts');
const { agentAccountsPath } = await import('../paths.ts');

describe('WorkspaceSemaphore dormant hold snapshot', () => {
  const temp: string[] = [];
  afterEach(() => {
    reads.length = 0;
    for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const root = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cezar-dormant-')));
    temp.push(dir);
    return dir;
  };

  it('does not read the run index of a loaded project', async () => {
    const [live, unloaded] = [root(), root()];
    const sem = new WorkspaceSemaphore({
      load: async () => ({ maxParallel: 2, memoryLimitMb: null, projectRoots: [live, unloaded] }),
    });
    const unregister = sem.register({ busySlots: () => 0, oldestQueuedAt: () => null, pump: () => {}, repoRoot: live });
    await sem.refresh();
    expect(reads).toEqual([join(unloaded, '.ai/cezar')]);
    // A config write refreshes the limits, not the snapshot: no second read of every project.
    await sem.refresh();
    expect(reads).toHaveLength(1);
    unregister();
  });

  it('keys an unloaded project\'s hold on the account it selects, not the default (#1722)', async () => {
    const saved = process.env.CEZ_HOME;
    process.env.CEZ_HOME = root();
    try {
      const unloaded = root();
      mkdirSync(process.env.CEZ_HOME, { recursive: true });
      writeFileSync(agentAccountsPath(), JSON.stringify({
        version: 1,
        accounts: [{ id: 'work', provider: 'claude', configDir: join(process.env.CEZ_HOME, 'claude-work'), label: 'Work' }],
        defaults: { claude: 'work' },
      }));
      const store = RunStore.open(join(unloaded, '.ai/cezar'));
      const run = store.createRun({ title: 'Limited', steps: [], task: 'Limited', workflow: 'quick-task', runner: 'claude' });
      store.updateRun(run.id, { status: 'failed', autoResumeAt: new Date(Date.now() + 3_600_000).toISOString() });
      store.flush();
      const sem = new WorkspaceSemaphore({
        load: async () => ({ maxParallel: 2, memoryLimitMb: null, projectRoots: [unloaded] }),
      });
      await sem.refresh();
      expect([...sem.accountHolds().deadline]).toEqual(['claude:work']);
    } finally {
      if (saved === undefined) delete process.env.CEZ_HOME;
      else process.env.CEZ_HOME = saved;
    }
  });
});
