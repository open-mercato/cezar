import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * #2003: a task usually settles at `review` (not reclaimable) and reaches `done` later, through
 * Finish or an opened PR — never through `dropActive`. That transition must reclaim on its own,
 * with no config at all exactly as with an explicitly saved 10.
 */
describe('retention on a finished transition outside dropActive (#2003)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retention-zero-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Ten finished worktrees (the default limit) and one newer task resting at review. */
  async function seed(): Promise<{ oldest: { id: string; path: string; branch: string }; review: string }> {
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const seeded: Array<{ id: string; path: string; branch: string }> = [];
    for (let i = 0; i < 11; i++) {
      const rec = store.createRun({ title: `t${i}`, workflow: 'w', task: 't', steps: [] });
      const wt = await createWorktree(repoRoot, rec.id, 'main');
      store.updateRun(rec.id, {
        status: i === 10 ? 'review' : 'done',
        finishedAt: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        worktreePath: wt.path,
        branch: wt.branch,
      });
      seeded.push({ id: rec.id, path: wt.path, branch: wt.branch });
    }
    manager = new RunManager(store, repoRoot);
    return { oldest: seeded[0]!, review: seeded[10]!.id };
  }

  async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  for (const [label, config] of [
    ['no config at all', undefined],
    ['an explicitly saved 10', { worktreeRetention: 10 }],
  ] as const) {
    it(`Finish on a settled review reclaims the eleventh worktree — ${label}`, async () => {
      if (config) writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify(config));
      const { oldest, review } = await seed();

      expect(manager!.finish(review)).toBe(true);
      expect(store.getRun(review)?.status).toBe('done');
      await waitFor(() => !!store.getRun(oldest.id)?.worktreeReclaimedAt);

      expect(store.getRun(oldest.id)?.worktreeReclaimedAt).toBeTruthy();
      expect(existsSync(oldest.path)).toBe(false);
      // Directory only — the branch stays, so the work is recoverable.
      await expect(run('git', ['rev-parse', '--verify', `refs/heads/${oldest.branch}`], { cwd: repoRoot })).resolves.toBeTruthy();
      const left = store.listRuns().filter((r) => r.worktreePath && existsSync(r.worktreePath));
      expect(left).toHaveLength(10);
      expect(existsSync(store.getRun(review)!.worktreePath!)).toBe(true);
    }, 60_000);
  }

  it('0 = unlimited still keeps every finished worktree', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ worktreeRetention: 0 }));
    const { oldest, review } = await seed();
    manager!.finish(review);
    await new Promise((r) => setTimeout(r, 500));
    await (manager as unknown as { retentionPass: Promise<void> }).retentionPass;
    expect(existsSync(oldest.path)).toBe(true);
    expect(store.getRun(oldest.id)?.worktreeReclaimedAt).toBeUndefined();
  }, 60_000);
});
