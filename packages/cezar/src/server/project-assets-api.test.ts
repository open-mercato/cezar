import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PROJECT_ASSETS, projectAssetsResponseSchema, type RunSubject } from '@open-mercato/cezar-contract';
import { listProjectAssets } from '../runs/project-assets.ts';
import { artifactsDir, RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** `GET /assets` — the project Assets page (spec 2026-10-22-html-artifacts-and-impact, Phase 3). */

describe('GET /assets', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-assets-api-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    app = createApp({ repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const newRun = (title: string, subject?: RunSubject) => {
    const id = store.createRun({ title, workflow: 'quick-task', task: title, steps: [] }).id;
    if (subject) store.updateRun(id, { subject });
    return id;
  };
  const write = (runId: string, name: string, body: string, at: number) => {
    const dir = artifactsDir(dataDir, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body);
    utimesSync(join(dir, name), at, at);
  };
  const get = async (prefix = '/api/v1') => {
    const res = await apiRequest(app, `${prefix}/assets`);
    expect(res.status).toBe(200);
    return projectAssetsResponseSchema.parse(await res.json());
  };

  it('is empty, not an error, before any run wrote an artifact', async () => {
    expect(await get()).toEqual({ assets: [], truncated: false });
    newRun('no dir');
    expect(await get('/api/v1/p/default')).toEqual({ assets: [], truncated: false });
  });

  it('lists every run’s artifacts newest first, one row per (run, file), with run and version facts', async () => {
    const a = newRun('First task');
    const b = newRun('Second task');
    newRun('No artifacts');
    write(a, 'report.html', '<title>Old report</title>', 1_000);
    write(b, 'notes.md', '# Fresh notes\n', 3_000);
    write(a, 'shot.png', 'png', 2_000);
    const vdir = join(artifactsDir(dataDir, a), '.versions');
    for (const v of ['1', '2']) {
      mkdirSync(join(vdir, v), { recursive: true });
      writeFileSync(join(vdir, v, 'report.html'), '<title>r</title>');
    }
    const { assets, truncated } = await get();
    expect(truncated).toBe(false);
    expect(assets.map((r) => [r.runId, r.name])).toEqual([[b, 'notes.md'], [a, 'shot.png'], [a, 'report.html']]);
    expect(assets[0]).toEqual({
      runId: b, runTitle: 'Second task', runStatus: 'queued', name: 'notes.md', kind: 'markdown', title: 'Fresh notes',
      size: 14, updatedAt: new Date(3_000_000).toISOString(), versionCount: 1, stale: null,
    });
    expect(assets[2]).toMatchObject({ title: 'Old report', kind: 'html', versionCount: 2 });
  });

  it('skips a corrupt run directory and an orphan directory with no run', async () => {
    const a = newRun('ok');
    write(a, 'a.md', '# A', 1_000);
    const corrupt = newRun('corrupt');
    mkdirSync(join(dataDir, 'artifacts'), { recursive: true });
    writeFileSync(artifactsDir(dataDir, corrupt), 'not a directory');
    write('orphan-run', 'x.md', '# X', 2_000);
    expect((await get()).assets.map((r) => r.runId)).toEqual([a]);
  });

  it('never calls gh for a PR head; stale is null whenever it cannot be told', async () => {
    const bin = join(repoRoot, 'bin');
    const marker = join(repoRoot, 'gh-called');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\ntouch "${marker}"\necho '{"headRefOid":"ffff"}'\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const pr = newRun('PR impact', { kind: 'pr', number: 7, headSha: 'abc' });
    const spec = newRun('Spec impact', { kind: 'spec', path: '.ai/specs/x.md', blobSha: 'abc' });
    write(pr, 'impact.html', '<title>PR</title>', 1_000);
    write(spec, 'impact.html', '<title>Spec</title>', 2_000);
    const { assets } = await get();
    expect(existsSync(marker)).toBe(false);
    expect(assets.find((r) => r.runId === pr)).toMatchObject({ subject: { kind: 'pr', number: 7 }, stale: null });
    // Not a git repository: the spec blob cannot be told either.
    expect(assets.find((r) => r.runId === spec)).toMatchObject({ subject: { kind: 'spec' }, stale: null });
  });
});

describe('listProjectAssets', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-assets-list-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const run = (id: string, subject?: RunSubject) =>
    ({ id, title: id, status: 'done', ...(subject ? { subject } : {}) }) as Parameters<typeof listProjectAssets>[1][number];

  it(`caps at ${MAX_PROJECT_ASSETS} rows with truncated`, async () => {
    const runs = Array.from({ length: 9 }, (_, i) => run(`r${i}`));
    for (const r of runs) {
      const dir = join(dataDir, 'artifacts', r.id);
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 60; f += 1) writeFileSync(join(dir, `f${f}.json`), '{}');
    }
    const listing = await listProjectAssets(dataDir, runs, async () => null);
    expect(listing.assets).toHaveLength(MAX_PROJECT_ASSETS);
    expect(listing.truncated).toBe(true);
  });

  it('asks once per subject, and only for runs that have artifacts', async () => {
    const subject: RunSubject = { kind: 'spec', path: '.ai/specs/a.md', blobSha: 'b' };
    for (const id of ['a', 'b']) {
      mkdirSync(join(dataDir, 'artifacts', id), { recursive: true });
      writeFileSync(join(dataDir, 'artifacts', id, 'impact.html'), '<title>x</title>');
    }
    const staleFor = vi.fn(async () => true);
    const listing = await listProjectAssets(dataDir, [run('a', subject), run('b', subject), run('c', subject)], staleFor);
    expect(staleFor).toHaveBeenCalledTimes(1);
    expect(listing.assets.map((r) => r.stale)).toEqual([true, true]);
  });
});
