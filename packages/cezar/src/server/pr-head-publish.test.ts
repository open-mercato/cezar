import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * A run that verified a pull request's head cannot publish (spec 2026-10-06-agentic-e2e-checks
 * Phase 3): its branch holds the whole foreign PR, so a draft PR into the default base would
 * re-propose it. Every other run answers exactly as before.
 */
describe('POST /runs/:id/pr on a pull-request head run', () => {
  let root: string;
  let store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-pr-head-publish-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const app = () =>
    createApp({ repoRoot: root, store, manager: { isActive: () => false } as unknown as RunManager, version: 'test' });

  it('refuses with a 409 naming the pull request', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
    store.updateRun(run.id, {
      status: 'review',
      prHead: { number: 42, repo: 'acme/shop', headRepo: 'acme/shop', headRef: 'f', headSha: 'a'.repeat(40), baseRef: 'main', ref: 'refs/cezar/pr/42' },
    });
    const response = await apiRequest(app(), `/api/v1/runs/${run.id}/pr`, { method: 'POST' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'this run verified pull request #42; publishing its changes is not supported yet',
    });
  });

  it('leaves an ordinary run on its existing answer', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
    store.updateRun(run.id, { status: 'review' });
    const response = await apiRequest(app(), `/api/v1/runs/${run.id}/pr`, { method: 'POST' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('no worktree/branch to publish');
  });
});
