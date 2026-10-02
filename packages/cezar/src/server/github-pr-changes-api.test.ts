import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { ForgePrDiffResult } from './github.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('the GitHub PR changes API', () => {
  let repoRoot: string;
  let store: RunStore;
  const previous = process.env.CEZ_DRY_RUN;

  beforeAll(() => { process.env.CEZ_DRY_RUN = '1'; });
  afterAll(() => {
    if (previous === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previous;
  });
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-pr-changes-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    // The route now resolves the forge from the project's remote (spec
    // 2026-08-10-forge-provider-adapters, Step 1.8), so the fixture repo needs a resolvable HEAD
    // and a github.com origin — same convention as `github-checks-api.test.ts`.
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: repoRoot,
    });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('serves deterministic bounded structured changes through both route mounts', async () => {
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: 'test' });
    const legacy = await apiRequest(app, '/api/v1/github/prs/128/changes');
    const scoped = await apiRequest(app, '/api/v1/p/default/github/prs/128/changes');
    expect(legacy.status).toBe(200);
    expect(await scoped.json()).toEqual(await legacy.clone().json());
    const body = (await legacy.json()) as ForgePrDiffResult;
    expect(body.available).toBe(true);
    if (body.available) {
      expect(body.files.some((file) => file.status === 'renamed' && file.previousPath)).toBe(true);
      expect(body.files.some((file) => file.patchUnavailableReason === 'binary')).toBe(true);
      expect(body.truncated).toBe(true);
    }
  });

  it('validates the number and exact refresh flag', async () => {
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: 'test' });
    expect((await apiRequest(app, '/api/v1/github/prs/0/changes')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/prs/abc/changes')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/prs/1/changes?refresh=true')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/prs/1/changes?refresh=1')).status).toBe(200);
  });

  it('answers unavailable, not a throw, when the project has no supported forge remote', async () => {
    const bareRoot = mkdtempSync(join(tmpdir(), 'cez-pr-changes-noforge-'));
    mkdirSync(join(bareRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: bareRoot });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: bareRoot,
    });
    const bareStore = RunStore.open(join(bareRoot, '.ai/cezar'));
    try {
      const app = createApp({ repoRoot: bareRoot, store: bareStore, manager: {} as RunManager, version: 'test' });
      const res = await apiRequest(app, '/api/v1/github/prs/128/changes');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ available: false, reason: 'No supported forge remote detected' });
    } finally {
      bareStore.flush();
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  it('still 404s a not-found merge request through the GitLab driver (Step 3.5)', async () => {
    const previousDryRun = process.env.CEZ_DRY_RUN;
    delete process.env.CEZ_DRY_RUN;
    const glRoot = mkdtempSync(join(tmpdir(), 'cez-pr-changes-gitlab-'));
    mkdirSync(join(glRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: glRoot });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: glRoot,
    });
    execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.com/acme/demo.git'], { cwd: glRoot });
    const glStore = RunStore.open(join(glRoot, '.ai/cezar'));
    const bin = mkdtempSync(join(tmpdir(), 'cez-fakeglab-'));
    writeFileSync(
      join(bin, 'glab'),
      '#!/bin/sh\n' +
        'if [ "$1" = "api" ]; then\n' +
        '  echo "glab: 404 Not Found (HTTP 404)" >&2\n' +
        '  exit 1\n' +
        'fi\n' +
        'exit 1\n',
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    try {
      const app = createApp({ repoRoot: glRoot, store: glStore, manager: {} as RunManager, version: 'test' });
      const res = await apiRequest(app, '/api/v1/github/prs/999/changes');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Merge request #999 was not found' });
    } finally {
      vi.unstubAllEnvs();
      rmSync(bin, { recursive: true, force: true });
      glStore.flush();
      rmSync(glRoot, { recursive: true, force: true });
      if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = previousDryRun;
    }
  });

  it('still 404s a not-found pull request through the driver', async () => {
    const previousDryRun = process.env.CEZ_DRY_RUN;
    delete process.env.CEZ_DRY_RUN;
    const bin = mkdtempSync(join(tmpdir(), 'cez-fakegh-'));
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\n' +
        'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then\n' +
        '  echo "Could not resolve to a PullRequest with the number of $3." >&2\n' +
        '  exit 1\n' +
        'fi\n' +
        'exit 1\n',
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    try {
      const app = createApp({ repoRoot, store, manager: {} as RunManager, version: 'test' });
      const res = await apiRequest(app, '/api/v1/github/prs/999/changes');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Pull request #999 was not found' });
    } finally {
      vi.unstubAllEnvs();
      rmSync(bin, { recursive: true, force: true });
      if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = previousDryRun;
    }
  });
});
