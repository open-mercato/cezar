import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { forgetRefStatus } from './github.ts';
import { createApp } from './server.ts';

/**
 * The two places cezar changes a pull request itself — and therefore the two places it must stop
 * trusting what it cached about one.
 *
 * Everything else about a reference has to be polled: GitHub cannot push to a cockpit with no
 * public endpoint. But waiting out a TTL to notice OUR OWN merge is self-inflicted staleness — for
 * up to a minute every chip would keep showing the pre-merge status of a pull request the user
 * just watched this server merge. These tests pin the wiring; `forge/github.test.ts` pins what
 * `forgetRefStatus` and `refNumberFromUrl` actually do.
 *
 * Driven through `CEZ_DRY_RUN=1`, so no `gh` is touched: the assertion is that the routes CALL
 * the invalidation with the right reference, which is the part that can silently not happen.
 */
vi.mock('./github.ts', async (importActual) => {
  const actual = await importActual<typeof import('./github.ts')>();
  return { ...actual, forgetRefStatus: vi.fn(actual.forgetRefStatus) };
});

describe('a reference cezar changes itself is forgotten, not waited out', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const previousDryRun = process.env.CEZ_DRY_RUN;

  beforeAll(() => {
    process.env.CEZ_DRY_RUN = '1';
  });
  afterAll(() => {
    if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previousDryRun;
  });

  beforeEach(() => {
    vi.mocked(forgetRefStatus).mockClear();
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-refinvalidate-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoRoot });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('forgets the pull request it merged', async () => {
    const state = await apiRequest(app, '/api/v1/github/prs/128/merge-state?refresh=1');
    const { mergeState } = (await state.json()) as { mergeState: { headSha: string } };

    const merged = await apiRequest(app, '/api/v1/github/prs/128/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
      body: JSON.stringify({ method: 'squash', expectedHeadSha: mergeState.headSha }),
    });

    expect(merged.status).toBe(200);
    expect(forgetRefStatus).toHaveBeenCalledWith(repoRoot, 128);
  });

  it('leaves the cache alone when the merge was REFUSED', async () => {
    // Nothing changed on the forge, so nothing we hold about it became wrong. Forgetting anyway
    // would spend a query to be told the same thing.
    const refused = await apiRequest(app, '/api/v1/github/prs/128/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
      body: JSON.stringify({ method: 'squash', expectedHeadSha: 'f'.repeat(40) }),
    });

    expect(refused.status).not.toBe(200);
    expect(forgetRefStatus).not.toHaveBeenCalled();
  });

  it('forgets the pull request it opened', async () => {
    // A number asked about BEFORE the pull request existed is cached as "this repository has no
    // such number" — exactly what a `CEZ:PR=N` marker declared ahead of the push looks like.
    const worktree = mkdtempSync(join(tmpdir(), 'cez-refinvalidate-wt-'));
    execFileSync('git', ['init', '-b', 'cez/abc'], { cwd: worktree });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktree });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktree });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'work'], { cwd: worktree });
    const run = store.createRun({ title: 'Ship it', task: 'ship it', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status: 'review', worktreePath: worktree, branch: 'cez/abc' });

    const created = await apiRequest(app, `/api/v1/runs/${run.id}/pr`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4321' },
    });

    try {
      expect(created.status).toBe(201);
      // The dry-run catalog's fake PR URL is `…/pull/777`.
      expect(forgetRefStatus).toHaveBeenCalledWith(repoRoot, 777);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
