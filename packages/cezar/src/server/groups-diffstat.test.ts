import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearWorktreeDiffStatCache } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/**
 * The compare view compares each variant's real per-file `git diff --stat`
 * table, so the route must render that table even when the run record already
 * carries the numeric turn-end `diffStat`.
 */
describe('GET /api/v1/groups/:groupId — per-file diffStat', () => {
  let repoRoot: string;
  let worktree: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-group-stat-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false, cancel: () => {} } as unknown as RunManager,
      version: '0.0.0-test',
    });
    worktree = join(repoRoot, 'wt');
    mkdirSync(worktree);
    g(worktree, 'init', '-b', 'main');
    g(worktree, 'config', 'user.email', 'test@cezar.local');
    g(worktree, 'config', 'user.name', 'cezar-test');
    g(worktree, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(worktree, 'base.txt'), 'base\n');
    g(worktree, 'add', '-A');
    g(worktree, 'commit', '-m', 'base');
    g(worktree, 'checkout', '-b', 'task');
    writeFileSync(join(worktree, 'base.txt'), 'base changed\n');
    clearWorktreeDiffStatCache();
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function variant(
    worktreePath: string | null,
    diffStat?: { files: number; adds: number; dels: number },
  ): string {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    store.updateRun(run.id, {
      groupId: 'g1',
      variant: 'A',
      status: 'done',
      finishedAt: new Date().toISOString(),
      ...(worktreePath ? { worktreePath } : {}),
      baseBranch: 'main',
      branch: 'task',
      ...(diffStat ? { diffStat } : {}),
    });
    return run.id;
  }

  it('renders the per-file table instead of the persisted numeric summary', async () => {
    variant(worktree, { files: 2, adds: 5, dels: 1 });
    const res = await apiRequest(app, '/api/v1/groups/g1');
    expect(res.status).toBe(200);
    const body = await res.json() as { runs: Array<{ diffStat: string }> };
    expect(body.runs[0]?.diffStat).toContain('base.txt');
    expect(body.runs[0]?.diffStat).not.toContain('2 files changed, 5 insertions(+), 1 deletion(-)');
  });

  it('renders no synthetic line when the worktree is gone', async () => {
    variant(null, { files: 2, adds: 5, dels: 1 });
    const res = await apiRequest(app, '/api/v1/groups/g1');
    expect(res.status).toBe(200);
    const body = await res.json() as { runs: Array<{ diffStat: string }> };
    expect(body.runs[0]?.diffStat).toBe('');
  });
});
