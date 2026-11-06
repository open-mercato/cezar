import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { ForgeSearchData } from './github.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `GET /api/v1/github/search?kind=…&q=…` (#730).
 *
 * Why this route exists: `GET /api/v1/github` lists the OPEN set only, and the tab's search is an
 * in-memory filter over that payload — so a closed or merged issue/PR is not merely "outside the
 * fetched window", it was never fetched and nothing the user types can reach it. This is the
 * endpoint that asks the forge instead.
 *
 * The contract under test is the route boundary: zod-validated params (400 on anything malformed,
 * never a throw) and a `ForgeSearchData` payload. Driven through `CEZ_DRY_RUN=1` so no `gh` is
 * touched — the gh-shelling, cross-state and degrade paths are covered in the driver's own suite.
 * The route resolves the forge from the project's remote (spec 2026-08-10-forge-provider-adapters),
 * so the fixture repo carries a github.com origin; a remote-less one degrades in the payload.
 */
describe('the github search API', () => {
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ghsearch-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    // A first commit, because the forge lookup (`getRepoInfo`) needs a resolvable HEAD.
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: repoRoot,
    });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('finds a PR by number', async () => {
    const res = await apiRequest(app, '/api/v1/github/search?kind=pr&q=128');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeSearchData;
    expect(body.available).toBe(true);
    expect(body.items.map((i) => i.number)).toEqual([128]);
  });

  it('finds an issue by text', async () => {
    const res = await apiRequest(app, '/api/v1/github/search?kind=issue&q=Login');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeSearchData;
    expect(body.items.map((i) => i.number)).toEqual([142]);
  });

  it('returns an empty hit list rather than an error when nothing matches', async () => {
    const res = await apiRequest(app, '/api/v1/github/search?kind=pr&q=nothing-matches-this');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeSearchData;
    expect(body.available).toBe(true);
    expect(body.items).toEqual([]);
  });

  it('400s on a missing or unknown kind', async () => {
    expect((await apiRequest(app, '/api/v1/github/search?q=128')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/search?kind=commit&q=128')).status).toBe(400);
  });

  it('400s on a missing or blank query', async () => {
    expect((await apiRequest(app, '/api/v1/github/search?kind=pr')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/search?kind=pr&q=')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/search?kind=pr&q=%20%20')).status).toBe(400);
  });

  it('400s on an absurdly long query rather than shelling out with it', async () => {
    const long = 'a'.repeat(257);
    expect((await apiRequest(app, `/api/v1/github/search?kind=pr&q=${long}`)).status).toBe(400);
  });

  it('400s on a malformed limit', async () => {
    expect((await apiRequest(app, '/api/v1/github/search?kind=pr&q=128&limit=0')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/search?kind=pr&q=128&limit=abc')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/search?kind=pr&q=128&limit=9999')).status).toBe(400);
  });

  it('answers identically on the project-scoped mirror', async () => {
    const plain = await apiRequest(app, '/api/v1/github/search?kind=pr&q=128');
    const scoped = await apiRequest(app, '/api/v1/p/default/github/search?kind=pr&q=128');
    expect(scoped.status).toBe(plain.status);
    // Compared by identity, not deep-equality: the dry-run catalog stamps `createdAt` off the
    // clock at call time, so two calls a millisecond apart legitimately differ there.
    const numbers = async (res: Response) =>
      ((await res.json()) as ForgeSearchData).items.map((i) => i.number);
    expect(await numbers(scoped)).toEqual(await numbers(plain));
  });

  it('degrades in the payload (200, never a throw) when the project has no forge remote', async () => {
    const expectUnavailable = async () => {
      const res = await apiRequest(app, '/api/v1/github/search?kind=pr&q=128');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ available: false, reason: 'No supported forge remote detected', items: [] });
    };
    // No remote at all…
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: repoRoot });
    await expectUnavailable();
    // …and a remote on a host no driver claims.
    execFileSync('git', ['remote', 'add', 'origin', 'https://git.example.com/acme/demo.git'], { cwd: repoRoot });
    await expectUnavailable();
  });

  it('still 400s a malformed query before it looks for a forge', async () => {
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: repoRoot });
    const res = await apiRequest(app, '/api/v1/github/search?kind=pr');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid search query' });
  });

  it('a GitLab remote answers available too (Step 3.6, spec 2026-08-10-forge-provider-adapters)', async () => {
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: repoRoot });
    execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.com/acme/demo.git'], { cwd: repoRoot });
    const res = await apiRequest(app, '/api/v1/github/search?kind=pr&q=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeSearchData;
    expect(body.available).toBe(true);
    expect(body.items.map((i) => i.number)).toEqual([1]);
  });
});
