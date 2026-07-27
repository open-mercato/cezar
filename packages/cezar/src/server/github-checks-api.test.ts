import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import type { GithubChecksData } from './github.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

/**
 * `GET /api/github/checks?prs=…` (#664). The contract under test: the `prs` list is zod-free but
 * strictly validated at the boundary (positive integers, non-empty, ≤100 — 400 on anything else,
 * never a throw), and — driven through `CEZ_DRY_RUN=1` so no `gh` is touched — a `GithubChecksData`
 * payload mapping each requested PR number to its glyph. The gh-shelling and degrade paths live in
 * the driver; here we prove the route wiring and the param gate.
 */
describe('the github checks API', () => {
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ghchecks-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns a number → glyph map for the requested PRs (dry-run mock)', async () => {
    // The dry-run catalog has PR #128 passing and PR #124 failing.
    const res = await apiRequest(app, '/api/github/checks?prs=128,124');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GithubChecksData;
    expect(body.available).toBe(true);
    if (!body.available) throw new Error('expected available');
    expect(body.checks[128]).toBe('passing');
    expect(body.checks[124]).toBe('failing');
  });

  it('answers a PR with no CI (or unknown) as null, not an error', async () => {
    const res = await apiRequest(app, '/api/github/checks?prs=99999');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GithubChecksData;
    expect(body.available).toBe(true);
    if (!body.available) throw new Error('expected available');
    expect(body.checks[99999]).toBeNull();
  });

  it('400s when the prs query is missing', async () => {
    const res = await apiRequest(app, '/api/github/checks');
    expect(res.status).toBe(400);
  });

  it('400s on a non-numeric prs entry', async () => {
    const res = await apiRequest(app, '/api/github/checks?prs=12,abc');
    expect(res.status).toBe(400);
  });

  it('400s on an empty prs list', async () => {
    const res = await apiRequest(app, '/api/github/checks?prs=');
    expect(res.status).toBe(400);
  });

  it('400s when more than 100 PRs are requested', async () => {
    const many = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
    const res = await apiRequest(app, `/api/github/checks?prs=${many}`);
    expect(res.status).toBe(400);
  });

  it('rejects a zero or negative PR number', async () => {
    expect((await apiRequest(app, '/api/github/checks?prs=0')).status).toBe(400);
    expect((await apiRequest(app, '/api/github/checks?prs=-3')).status).toBe(400);
  });
});
