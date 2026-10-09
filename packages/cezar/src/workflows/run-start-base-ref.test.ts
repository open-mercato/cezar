import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRepoInfo } from '../server/git.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const SINGLE_STEP: WorkflowDef = {
  name: '(planned)',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};

/**
 * The run-start base branch must reflect the repository at the moment the run
 * starts. `getRepoInfo` is memoized for a few seconds for the read-only routes,
 * so a branch switched inside that window would otherwise fork the worktree off
 * the previous branch.
 */
describe('run start reads the base branch fresh', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let savedDryRun: string | undefined;

  beforeEach(async () => {
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-run-base-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }),
    });
  });

  afterEach(async () => {
    manager.dispose();
    store.flush();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('forks the worktree off a branch switched inside the memo TTL', async () => {
    // The sidebar read that warms the memo the health tick keeps hot.
    expect((await getRepoInfo(repoRoot))?.branch).toBe('main');
    await run('git', ['checkout', '-q', '-b', 'feature'], { cwd: repoRoot });
    // The memo still answers with the old branch…
    expect((await getRepoInfo(repoRoot))?.branch).toBe('main');

    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done hello' });
    const deadline = Date.now() + 20_000;
    let current: RunRecord | undefined;
    while (Date.now() < deadline) {
      current = store.getRun(record.id);
      if (current?.worktreePath) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // …the run must not.
    expect(current?.baseBranch).toBe('feature');
  }, 30_000);
});
