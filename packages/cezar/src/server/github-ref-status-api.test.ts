import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { GithubRefStatusData } from './github.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `GET /api/v1/github/ref-status?prs=…&issues=…` — the batched status behind a task's PR/issue
 * chip. The contract under test is the route's, not the driver's: both lists are optional but at
 * least one must name something, each is strictly validated (positive integers, ≤100 — a 400,
 * never a throw), and the payload maps only the numbers the forge actually knew about. Driven
 * through `CEZ_DRY_RUN=1`, so no `gh` is touched; the gh-shelling and degrade paths are the
 * driver's own tests.
 */
describe('the github ref-status API', () => {
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ghrefstatus-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function refStatus(query: string): Promise<GithubRefStatusData> {
    const res = await apiRequest(app, `/api/v1/github/ref-status?${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as GithubRefStatusData;
  }

  it('answers both kinds in one request (dry-run catalog)', async () => {
    // The catalog has PR #128 open with passing checks, PR #124 a draft, and issue #142 open.
    const body = await refStatus('prs=128,124&issues=142');
    if (!body.available) throw new Error('expected available');
    expect(body.prs[128]).toBe('ready');
    expect(body.prs[124]).toBe('draft');
    expect(body.issues[142]).toBe('open');
  });

  it('takes either list alone', async () => {
    const prsOnly = await refStatus('prs=128');
    if (!prsOnly.available) throw new Error('expected available');
    expect(prsOnly.prs[128]).toBe('ready');
    expect(prsOnly.issues).toEqual({});

    const issuesOnly = await refStatus('issues=142');
    if (!issuesOnly.available) throw new Error('expected available');
    expect(issuesOnly.issues[142]).toBe('open');
    expect(issuesOnly.prs).toEqual({});
  });

  it('leaves an unknown number ABSENT rather than inventing a status', async () => {
    // The distinction the chip depends on: "not found" must not be paintable as "fine".
    const body = await refStatus('prs=99999');
    if (!body.available) throw new Error('expected available');
    expect(body.prs[99999]).toBeUndefined();
  });

  it('400s when neither list names anything', async () => {
    expect((await apiRequest(app, '/api/v1/github/ref-status')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/ref-status?prs=')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/ref-status?prs=&issues=')).status).toBe(400);
  });

  it('400s on a malformed entry in either list', async () => {
    expect((await apiRequest(app, '/api/v1/github/ref-status?prs=12,abc')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/ref-status?issues=1.5')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/ref-status?prs=0')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/ref-status?prs=-3')).status).toBe(400);
  });

  it('400s past 100 numbers in one list', async () => {
    const many = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
    expect((await apiRequest(app, `/api/v1/github/ref-status?prs=${many}`)).status).toBe(400);
    expect((await apiRequest(app, `/api/v1/github/ref-status?issues=${many}`)).status).toBe(400);
  });
});
