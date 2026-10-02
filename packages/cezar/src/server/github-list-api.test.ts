import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { fetchGithub, type GithubData } from './github.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `GET /api/v1/github` through the forge-driver seam (spec 2026-08-10-forge-provider-adapters,
 * Step 1.4). The route resolves the project's forge and asks its driver for the whole listing; a
 * GitHub remote must answer exactly what `fetchGithub` always served (BACKWARD_COMPATIBILITY.md
 * §2), and a project that resolves to no forge degrades in the payload — 200, never a throw.
 * Driven through `CEZ_DRY_RUN=1` so no `gh` is touched.
 */
describe('the github list API', () => {
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ghlist-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    // A first commit, because the forge lookup (`getRepoInfo`) needs a resolvable HEAD.
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: repoRoot,
    });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** The dry-run catalog stamps `createdAt`/`syncedAt` off the clock per call. */
  const stripTimestamps = (body: string): string => body.replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '<ts>');

  it('serves the driver payload byte-identical to fetchGithub for a GitHub remote', async () => {
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/demo.git'], { cwd: repoRoot });
    const res = await apiRequest(app, '/api/v1/github?limit=5&refresh=1');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(stripTimestamps(body)).toBe(stripTimestamps(JSON.stringify(await fetchGithub(repoRoot, true, 5))));
    const parsed = JSON.parse(body) as GithubData;
    expect(parsed.available).toBe(true);
    expect(parsed.labelColors).toBeDefined();
  });

  it('degrades in the payload when the project has no remote', async () => {
    const res = await apiRequest(app, '/api/v1/github');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: false,
      reason: 'No supported forge remote detected',
      issues: [],
      prs: [],
    });
  });

  it('degrades in the payload for a remote on a host no driver claims', async () => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://git.example.com/acme/demo.git'], { cwd: repoRoot });
    const res = await apiRequest(app, '/api/v1/github?limit=banana');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: false,
      reason: 'No supported forge remote detected',
      issues: [],
      prs: [],
    });
  });

  it('serves the GitLab driver listAll payload for a GitLab remote (Step 3.2)', async () => {
    // Dry-run: the GitLab driver's `listAll` now answers its own demo catalog, mirroring
    // `mockGithub` — no `glab` is touched here either.
    execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.com:acme/demo.git'], { cwd: repoRoot });
    const res = await apiRequest(app, '/api/v1/github');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GithubData;
    expect(body.available).toBe(true);
    expect(body.repo).toBe('demo/demo');
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.prs.length).toBeGreaterThan(0);
    expect(body.labelColors).toBeDefined();
  });
});
