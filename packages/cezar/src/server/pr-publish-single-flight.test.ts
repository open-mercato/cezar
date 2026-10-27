import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createDraftPr, type DraftPrOutcome } from './pr.ts';
import { createApp } from './server.ts';

/**
 * telemetry 9119d21a: the cockpit lost the response to a PR publish and asks again. The second
 * POST must join the publish still running — two concurrent autosave commits and pushes in one
 * worktree race each other — and answer with the same pull request.
 */
vi.mock('./pr.ts', async (importActual) => {
  const actual = await importActual<typeof import('./pr.ts')>();
  return { ...actual, createDraftPr: vi.fn() };
});

describe('POST /runs/:id/pr is single-flight per run', () => {
  let repoRoot: string;
  let worktree: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    vi.mocked(createDraftPr).mockReset();
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-pr-flight-'));
    worktree = mkdtempSync(join(tmpdir(), 'cez-pr-flight-wt-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
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
    rmSync(worktree, { recursive: true, force: true });
  });

  const post = (id: string) =>
    apiRequest(app, `/api/v1/runs/${id}/pr`, { method: 'POST', headers: { origin: 'http://127.0.0.1:4321' } });

  it('joins a second request onto the publish already running', async () => {
    const run = store.createRun({ title: 'Ship it', task: 'ship it', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status: 'review', worktreePath: worktree, branch: 'cez/abc' });
    let finish!: (outcome: DraftPrOutcome) => void;
    vi.mocked(createDraftPr).mockReturnValue(new Promise((resolve) => (finish = resolve)));

    const first = post(run.id);
    await vi.waitFor(() => expect(createDraftPr).toHaveBeenCalledTimes(1));
    // Settle the first publish only once the second request is inside the handler: everything
    // between its `getRun` and the single-flight check is synchronous, so by then it has joined.
    // Settling earlier races the request's async middleware (lost on Node 22).
    const getRun = vi.spyOn(store, 'getRun');
    const second = post(run.id);
    await vi.waitFor(() => expect(getRun).toHaveBeenCalledWith(run.id));
    finish({ ok: true, url: 'https://github.com/acme/demo/pull/9', dryRun: false });

    const [a, b] = await Promise.all([first, second]);
    expect(createDraftPr).toHaveBeenCalledTimes(1);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await b.json()).toEqual({ url: 'https://github.com/acme/demo/pull/9', dryRun: false });
    expect(store.getRun(run.id)?.pullRequestUrl).toBe('https://github.com/acme/demo/pull/9');
  });

  it('publishes afresh once the previous publish settled', async () => {
    const run = store.createRun({ title: 'Ship it', task: 'ship it', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status: 'review', worktreePath: worktree, branch: 'cez/abc' });
    vi.mocked(createDraftPr).mockResolvedValue({ ok: false, error: 'git push failed — denied' });

    const refused = await post(run.id);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'git push failed — denied', manual: 'git merge cez/abc' });
    await post(run.id);
    expect(createDraftPr).toHaveBeenCalledTimes(2);
  });
});
