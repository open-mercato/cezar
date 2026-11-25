import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktree, removeWorktree } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager, restoreFailureReason } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const ORIGIN = { origin: 'http://127.0.0.1:4321' };

// `POST /runs/:id/restore-worktree` (the Changes tab's "Restore worktree"): the resume path's
// re-materialization, exposed. Spec 2026-11-19-worktree-disk-usage.
describe('POST /runs/:id/restore-worktree', () => {
  let repo: string;
  let cezHome: string;
  let store: RunStore;
  let manager: RunManager;
  let app: Hono;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(async () => {
    cezHome = mkdtempSync(join(tmpdir(), 'cez-restore-home-'));
    process.env.CEZ_HOME = cezHome;
    repo = mkdtempSync(join(tmpdir(), 'cez-restore-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repo });
    mkdirSync(join(repo, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repo, '.ai/cezar'));
    manager = new RunManager(store, repo);
    app = createApp({ repoRoot: repo, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manager.dispose();
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(cezHome, { recursive: true, force: true });
  });

  async function reclaimed(): Promise<string> {
    const run = store.createRun({ title: 'feature', workflow: 'w', task: 't', steps: [] });
    const wt = await createWorktree(repo, run.id, 'main');
    writeFileSync(join(wt.path, 'feature.txt'), 'the work\n');
    await exec('git', ['add', '-A'], { cwd: wt.path });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'work'], { cwd: wt.path });
    await removeWorktree(repo, wt.path);
    store.updateRun(run.id, {
      status: 'done', worktreePath: wt.path, branch: wt.branch, baseBranch: 'main',
      worktreeReclaimedAt: new Date().toISOString(),
    });
    return run.id;
  }

  const restore = (id: string) => apiRequest(app, `/api/v1/runs/${id}/restore-worktree`, { method: 'POST', headers: ORIGIN });

  it('restores the tree from its branch, clears the stamp, and the Changes tab reads it live again', async () => {
    const id = await reclaimed();
    const res = await restore(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'restored' });
    const run = store.getRun(id)!;
    expect(existsSync(join(run.worktreePath!, 'feature.txt'))).toBe(true);
    // Unstamped: eligible for retention again, exactly as after a resume.
    expect(run.worktreeReclaimedAt).toBeUndefined();
    const changes = (await (await apiRequest(app, `/api/v1/runs/${id}/changes`)).json()) as { fromBranch?: unknown; files: unknown[] };
    expect(changes.fromBranch).toBeUndefined();
    expect(changes.files).toHaveLength(1);
  });

  it('is idempotent: a tree already on disk answers present', async () => {
    const id = await reclaimed();
    await restore(id);
    const again = await restore(id);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'present' });
  });

  it('refuses when the branch is gone, and creates no tree off the base', async () => {
    const id = await reclaimed();
    await exec('git', ['branch', '-D', store.getRun(id)!.branch!], { cwd: repo });
    const res = await restore(id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('no longer exists');
    expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(false);
    expect(store.getRun(id)?.worktreeReclaimedAt).toBeDefined();
  });

  it('refuses a path occupied by something else, keeping the stamp', async () => {
    const id = await reclaimed();
    mkdirSync(store.getRun(id)!.worktreePath!, { recursive: true });
    writeFileSync(join(store.getRun(id)!.worktreePath!, 'stray.txt'), 'not ours\n');
    const res = await restore(id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('move it aside');
    expect(store.getRun(id)?.worktreeReclaimedAt).toBeDefined();
  });

  it('words a full disk and an occupied path', () => {
    expect(restoreFailureReason(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toContain('not enough disk space');
    expect(restoreFailureReason(new Error('fatal: No space left on device'))).toContain('not enough disk space');
    expect(restoreFailureReason(new Error('managed worktree path already exists and could not be repaired: /x'))).toContain('move it aside');
    expect(restoreFailureReason(new Error('boom'))).toBe('could not restore the worktree: boom');
  });

  it('shares one restore between concurrent calls', async () => {
    const id = await reclaimed();
    const [a, b] = await Promise.all([restore(id), restore(id)]);
    const bodies = [await a.json(), await b.json()] as Array<{ status: string }>;
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // The second either joined the restore in flight or found the tree it left: never a second restore.
    expect(bodies.map((x) => x.status)).toContain('restored');
    for (const body of bodies) expect(['restored', 'present']).toContain(body.status);
    // One restore, one note.
    const notes = store.readEvents(id).filter((e) => e.type === 'note' && /restored from its branch/.test(String((e as { message?: string }).message)));
    expect(notes).toHaveLength(1);
    expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(true);
  });

  it('refuses while the run is active and for an unknown run', async () => {
    const id = await reclaimed();
    vi.spyOn(manager, 'isActive').mockReturnValue(true);
    const res = await restore(id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('active');
    expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(false);
    expect((await restore('nope')).status).toBe(404);
  });
});
