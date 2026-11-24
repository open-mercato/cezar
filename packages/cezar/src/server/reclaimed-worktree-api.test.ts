import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktree, removeWorktree } from '../git-worktree.ts';
import { restoreReclaimedForPublish } from '../runs/retention.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createDraftPr } from './pr.ts';
import { createApp } from './server.ts';

vi.mock('./pr.ts', async (importActual) => {
  const actual = await importActual<typeof import('./pr.ts')>();
  return { ...actual, createDraftPr: vi.fn() };
});

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const ORIGIN = { origin: 'http://127.0.0.1:4321' };

// Spec 2026-11-19-worktree-disk-usage: a `review` run whose tree age retention reclaimed keeps its
// diff and its draft-PR gate; archiving a task reclaims its tree.
describe('a reclaimed review run', () => {
  let repo: string;
  let cezHome: string;
  let store: RunStore;
  let app: Hono;
  let reclaimOf: ReturnType<typeof vi.fn>;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(async () => {
    vi.mocked(createDraftPr).mockReset();
    cezHome = mkdtempSync(join(tmpdir(), 'cez-reclaimed-home-'));
    process.env.CEZ_HOME = cezHome;
    repo = mkdtempSync(join(tmpdir(), 'cez-reclaimed-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repo });
    mkdirSync(join(repo, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repo, '.ai/cezar'));
    reclaimOf = vi.fn(async () => []);
    const manager = {
      isActive: () => false,
      restoreReclaimedWorktree: (id: string) => restoreReclaimedForPublish(repo, store, id),
      reclaimWorktreesOf: reclaimOf,
    } as unknown as RunManager;
    app = createApp({ repoRoot: repo, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(cezHome, { recursive: true, force: true });
  });

  async function reclaimedReview(): Promise<string> {
    const run = store.createRun({ title: 'feature', workflow: 'w', task: 't', steps: [] });
    const wt = await createWorktree(repo, run.id, 'main');
    writeFileSync(join(wt.path, 'feature.txt'), 'the work\n');
    await exec('git', ['add', '-A'], { cwd: wt.path });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'work'], { cwd: wt.path });
    await removeWorktree(repo, wt.path); // what retention leaves: branch kept
    store.updateRun(run.id, {
      status: 'review', worktreePath: wt.path, branch: wt.branch, baseBranch: 'main',
      worktreeReclaimedAt: new Date().toISOString(),
    });
    return run.id;
  }

  it('shows its diff and commits from the kept branch without checking the tree out again', async () => {
    const id = await reclaimedReview();
    expect(await (await apiRequest(app, `/api/v1/runs/${id}/diff`)).text()).toContain('+the work');
    const commits = (await (await apiRequest(app, `/api/v1/runs/${id}/commits`)).json()) as { commits: Array<{ sha: string; subject: string }> };
    expect(commits.commits.map((c) => c.subject)).toEqual(['work']);
    const commit = await apiRequest(app, `/api/v1/runs/${id}/commit/${commits.commits[0]!.sha}`);
    expect(commit.status).toBe(200);
    const changes = await apiRequest(app, `/api/v1/runs/${id}/changes`);
    expect(changes.status).toBe(409);
    const error = ((await changes.json()) as { error: string }).error;
    expect(error).toContain('was reclaimed');
    expect(error).toContain('Continue restores it');
    expect(error).not.toContain('could not be restored');
    expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(false);
    expect(store.getRun(id)?.worktreeReclaimedAt).toBeDefined();
  });

  it('never recreates a branch deleted since: the PR is refused and no tree appears', async () => {
    const id = await reclaimedReview();
    await exec('git', ['branch', '-D', store.getRun(id)!.branch!], { cwd: repo });
    const res = await apiRequest(app, `/api/v1/runs/${id}/pr`, { method: 'POST', headers: ORIGIN });
    expect(res.status).toBe(400);
    expect(createDraftPr).not.toHaveBeenCalled();
    expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(false);
    expect(await (await apiRequest(app, `/api/v1/runs/${id}/diff`)).text()).toContain('reclaimed');
  });

  it('still opens its pull request, restoring the tree from the kept branch', async () => {
    const id = await reclaimedReview();
    vi.mocked(createDraftPr).mockResolvedValue({ ok: true, url: 'https://github.com/acme/demo/pull/7', dryRun: false });
    const res = await apiRequest(app, `/api/v1/runs/${id}/pr`, { method: 'POST', headers: ORIGIN });
    expect(res.status).toBe(201);
    expect(createDraftPr).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createDraftPr).mock.calls[0]![0].run.worktreePath).toBe(store.getRun(id)!.worktreePath);
  });

  it('adopts an existing pull request from the kept branch without the worktree', async () => {
    const id = await reclaimedReview();
    await exec('git', ['remote', 'add', 'origin', 'git@github.com:acme/demo.git'], { cwd: repo });
    const saved = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1'; // the dry-run forge answers the branch lookup offline
    try {
      const res = await apiRequest(app, `/api/v1/runs/${id}/pr/adopt`, { method: 'POST', headers: ORIGIN });
      expect(await res.json()).toEqual({ found: true, url: 'https://github.com/open-mercato/demo/pull/777' });
    } finally {
      if (saved === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = saved;
    }
    expect(store.getRun(id)?.pullRequestUrl).toBe('https://github.com/open-mercato/demo/pull/777');
    expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(false);
  });

  it('archiving a task, one or all finished, reclaims its worktree', async () => {
    const one = store.createRun({ title: 'one', workflow: 'w', task: 't', steps: [] });
    store.updateRun(one.id, { status: 'done' });
    await apiRequest(app, `/api/v1/runs/${one.id}/archive`, { method: 'POST', headers: ORIGIN });
    expect(reclaimOf).toHaveBeenLastCalledWith([one.id]);

    const two = store.createRun({ title: 'two', workflow: 'w', task: 't', steps: [] });
    store.updateRun(two.id, { status: 'failed' });
    await apiRequest(app, '/api/v1/runs/archive-finished', { method: 'POST', headers: ORIGIN });
    expect(reclaimOf).toHaveBeenLastCalledWith([two.id]);
  });
});
