import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager, setArchiveReclaimDelayForTests } from './run.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

// Spec 2026-11-19-worktree-disk-usage, decision 2: archive frees disk — unless the task was
// unarchived again before the delayed reclaim ran.
describe('RunManager.reclaimWorktreesOf', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-archive-reclaim-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
    await exec('git', ['add', '-A'], { cwd: repoRoot });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    setArchiveReclaimDelayForTests(50);
  });

  afterEach(() => {
    setArchiveReclaimDelayForTests(1_000);
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function archivedTask(): Promise<string> {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    const wt = await createWorktree(repoRoot, run.id, 'main');
    store.updateRun(run.id, { status: 'done', worktreePath: wt.path, branch: wt.branch, baseBranch: 'main' });
    store.setArchived(run.id, true);
    return run.id;
  }

  it('reclaims an archived task\'s worktree, keeping its branch', async () => {
    const id = await archivedTask();
    expect(await manager.reclaimWorktreesOf([id])).toEqual([id]);
    expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(false);
    expect(store.getRun(id)?.worktreeReclaimedAt).toBeDefined();
  });

  it('keeps the worktree of a task unarchived before the delayed reclaim ran', async () => {
    const id = await archivedTask();
    const pending = manager.reclaimWorktreesOf([id]);
    store.setArchived(id, false);
    expect(await pending).toEqual([]);
    expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(true);
    expect(store.getRun(id)?.worktreeReclaimedAt).toBeUndefined();
  });
});
