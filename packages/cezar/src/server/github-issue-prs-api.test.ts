import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { GithubIssuePrsData } from './github.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `GET /api/v1/github/issue-prs?issues=…` (#816). The contract under test mirrors its sibling
 * `/github/checks`: the `issues` list is strictly validated at the boundary (positive integers,
 * non-empty, ≤100 — 400 on anything else, never a throw), and — driven through `CEZ_DRY_RUN=1` so
 * no `gh` is touched — a `GithubIssuePrsData` payload mapping each requested issue number to its
 * linked pull requests. The gh-shelling, caching and degrade paths live in the driver and are
 * covered by `forge/github.test.ts`; here we prove the route wiring, the param gate, and that the
 * route reached the app at all.
 */
describe('the github issue-prs API', () => {
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ghissueprs-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns a number → linked-PR map for the requested issues (dry-run mock)', async () => {
    // The dry-run catalog links issue #142 to an open and a merged PR, #135 to a closed one.
    const res = await apiRequest(app, '/api/v1/github/issue-prs?issues=142,135');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GithubIssuePrsData;
    expect(body.available).toBe(true);
    if (!body.available) throw new Error('expected available');
    expect(body.links[142]).toEqual([
      { number: 128, url: 'https://github.com/mock/repo/pull/128', state: 'open', isDraft: false },
      { number: 91, url: 'https://github.com/mock/repo/pull/91', state: 'merged' },
    ]);
    expect(body.links[135]?.map((l) => l.state)).toEqual(['closed']);
  });

  it('leaves an issue with no linked PRs ABSENT rather than present-and-empty', async () => {
    // Absent means "nothing is known / nothing to show" across this whole route family; an empty
    // array would be a second spelling of the same thing for every consumer to handle.
    const res = await apiRequest(app, '/api/v1/github/issue-prs?issues=139,99999');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GithubIssuePrsData;
    expect(body.available).toBe(true);
    if (!body.available) throw new Error('expected available');
    expect(139 in body.links).toBe(false);
    expect(99999 in body.links).toBe(false);
  });

  it('accepts refresh=1 and still answers the same shape', async () => {
    const res = await apiRequest(app, '/api/v1/github/issue-prs?issues=142&refresh=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GithubIssuePrsData;
    expect(body.available).toBe(true);
    if (!body.available) throw new Error('expected available');
    expect(body.links[142]).toHaveLength(2);
  });

  it('400s "missing issues query" when the issues query is absent or empty', async () => {
    // Two spellings, two words — the same distinction `/github/checks` keeps for `prs`.
    for (const path of ['/api/v1/github/issue-prs', '/api/v1/github/issue-prs?issues=']) {
      const res = await apiRequest(app, path);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'missing issues query' });
    }
  });

  it('400s "invalid issues query" on a non-numeric entry', async () => {
    const res = await apiRequest(app, '/api/v1/github/issue-prs?issues=12,abc');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid issues query' });
  });

  it('400s when more than 100 issues are requested', async () => {
    const many = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
    const res = await apiRequest(app, `/api/v1/github/issue-prs?issues=${many}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid issues query' });
  });

  it('rejects a zero, negative or padded issue number', async () => {
    for (const bad of ['0', '-3', '007']) {
      expect((await apiRequest(app, `/api/v1/github/issue-prs?issues=${bad}`)).status).toBe(400);
    }
  });

  it('is mounted under the project-scoped alias too', async () => {
    // `route-parity.test.ts` proves this for the whole manifest; asserting it here as well makes
    // the failure legible when a hand-written route forgets the dual mount.
    const res = await apiRequest(app, '/api/v1/p/default/github/issue-prs?issues=142');
    expect(res.status).toBe(200);
  });
});
