import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import type { ForgeCommentsData } from './github.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

/**
 * `GET /api/github/comments/:kind/:number` (#499 Phase 2). The contract under test: zod-validated
 * params (400 on garbage, never a throw), and — driven through `CEZ_DRY_RUN=1` so no `gh` is
 * touched — a `ForgeCommentsData` payload for a valid issue/PR request. The gh-shelling and the
 * degrade paths live in the driver; here we prove the route wiring and the param gate.
 */
describe('the github comments API', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const prevDryRun = process.env.CEZ_DRY_RUN;

  beforeAll(() => {
    process.env.CEZ_DRY_RUN = '1';
  });
  afterAll(() => {
    if (prevDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = prevDryRun;
  });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ghcomments-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns a dry-run thread for a valid issue request', async () => {
    const res = await apiRequest(app, '/api/github/comments/issue/142');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeCommentsData;
    expect(body.available).toBe(true);
    expect(body.comments.length).toBeGreaterThan(0);
    // Chronological, oldest first.
    for (let i = 1; i < body.comments.length; i++) {
      expect(body.comments[i - 1]!.createdAt <= body.comments[i]!.createdAt).toBe(true);
    }
  });

  it('serves timeline events beside the unchanged comments array (#525)', async () => {
    const res = await apiRequest(app, '/api/github/comments/issue/142');
    const body = (await res.json()) as ForgeCommentsData;

    // Additive: comments keeps its exact shape, events arrives alongside it.
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events!.length).toBeGreaterThan(0);
    expect(body.comments.every((c) => c.kind === 'comment' || c.kind === 'review')).toBe(true);

    // The dry-run fixtures deliberately cover the cases that are easy to get wrong.
    const kinds = body.events!.map((e) => e.kind);
    expect(kinds).toContain('committed');
    expect(kinds).toContain('labeled');
    expect(kinds).toContain('cross-referenced');

    const commits = body.events!.filter((e) => e.kind === 'committed');
    expect(commits.length).toBeGreaterThan(1); // a RUN, so grouping is exercised
    // Full 40-char SHAs — the rollup query's `oid` rejects abbreviated ones, so a fixture that
    // cheated here would look fine offline and fail against the real API.
    expect(commits.every((c) => c.sha?.length === 40)).toBe(true);
    // Mixed states, including an explicit null (no CI configured), distinct from absent.
    expect(new Set(commits.map((c) => c.checks)).size).toBeGreaterThan(1);
    expect(commits.some((c) => c.checks === null)).toBe(true);
  });

  it('gives every event a unique, stable id — they become React keys', async () => {
    const res = await apiRequest(app, '/api/github/comments/pr/137');
    const body = (await res.json()) as ForgeCommentsData;
    const ids = body.events!.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('evt-'))).toBe(true); // cannot collide with comment keys
  });

  it('includes a merge event for a PR but not for an issue', async () => {
    const pr = (await (await apiRequest(app, '/api/github/comments/pr/137')).json()) as ForgeCommentsData;
    const issue = (await (await apiRequest(app, '/api/github/comments/issue/142')).json()) as ForgeCommentsData;
    expect(pr.events!.some((e) => e.kind === 'merged')).toBe(true);
    expect(issue.events!.some((e) => e.kind === 'merged')).toBe(false);
  });

  it('includes a PR review summary for a valid pr request', async () => {
    const res = await apiRequest(app, '/api/github/comments/pr/137');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeCommentsData;
    expect(body.comments.some((c) => c.kind === 'review')).toBe(true);
  });

  it('rejects an unknown kind with 400 and an { error } body, not a throw', async () => {
    const res = await apiRequest(app, '/api/github/comments/banana/1');
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('rejects a non-numeric / non-positive number with 400', async () => {
    expect((await apiRequest(app, '/api/github/comments/issue/abc')).status).toBe(400);
    expect((await apiRequest(app, '/api/github/comments/issue/0')).status).toBe(400);
    expect((await apiRequest(app, '/api/github/comments/issue/-3')).status).toBe(400);
  });
});
