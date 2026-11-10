import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeDiffSummary } from '../git-worktree.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@local', ...args], { cwd, encoding: 'utf8' });

/** `POST /runs/:id/pr/draft` (#1757): the publish dialog's preview. Every path that cannot
 *  generate answers exactly what `POST /pr` would publish without an edit. */
describe('POST /runs/:id/pr/draft', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let run: RunRecord;
  let active = false;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-pr-draft-route-'));
    g(repoRoot, 'init', '-q', '-b', 'main');
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
    writeFileSync(join(repoRoot, 'a.txt'), 'base\n');
    g(repoRoot, 'add', '-A');
    g(repoRoot, 'commit', '-q', '-m', 'base');
    g(repoRoot, 'checkout', '-q', '-b', 'task');
    writeFileSync(join(repoRoot, 'a.txt'), 'base\nmore\n');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    active = false;
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => active } as unknown as RunManager,
      version: '0.0.0-test',
    });
    run = store.createRun({ title: 'make it so', workflow: 'quick-task', task: 'make it so', steps: [] });
    store.updateRun(run.id, { worktreePath: repoRoot, baseBranch: 'main', branch: 'task' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const draft = (id: string) => apiRequest(app, `/api/v1/runs/${id}/pr/draft`, { method: 'POST' });

  it.each([['CEZ_DRY_RUN', '1'], ['CEZ_PR_DESCRIBE', '0']])('answers the unchanged fallback under %s=%s', async (name, value) => {
    vi.stubEnv(name, value);
    const res = await draft(run.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      title: 'make it so',
      body: '## Goal\n\nmake it so\n\n---\n\n🤖 made with cezar',
      generated: false,
    });
    expect(store.getRun(run.id)?.costUsd).toBeUndefined();
  });

  it('404s an unknown run and 409s an active one', async () => {
    expect((await draft('nope')).status).toBe(404);
    active = true;
    expect((await draft(run.id)).status).toBe(409);
  });

  it("summarizes the task's diff, untracked files included", async () => {
    writeFileSync(join(repoRoot, 'new.txt'), 'x\n');
    const summary = await worktreeDiffSummary(repoRoot, 'main', {}, 10);
    expect(summary?.files).toEqual([
      { path: 'a.txt', added: 1, removed: 0 },
      { path: 'new.txt', added: 1, removed: 0 },
    ]);
    expect(summary?.truncated).toBe(true);
    expect(summary?.patch).toHaveLength(10);
  });
});
