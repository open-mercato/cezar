import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('the GitHub merge API', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const previousDryRun = process.env.CEZ_DRY_RUN;

  beforeAll(() => {
    process.env.CEZ_DRY_RUN = '1';
  });

  afterAll(() => {
    if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previousDryRun;
  });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ghmerge-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoRoot });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns fresh normalized state and performs an expected-head guarded merge', async () => {
    const stateResponse = await apiRequest(app, '/api/v1/github/prs/128/merge-state?refresh=1');
    expect(stateResponse.status).toBe(200);
    const state = (await stateResponse.json()) as {
      available: true;
      mergeState: { canMerge: boolean; canOverride: boolean; headSha: string; methods: string[] };
    };
    expect(state.mergeState).toMatchObject({ canMerge: true, canOverride: false, methods: ['squash', 'merge', 'rebase'] });

    const mergeResponse = await apiRequest(app, '/api/v1/github/prs/128/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
      body: JSON.stringify({ method: 'squash', expectedHeadSha: state.mergeState.headSha }),
    });
    expect(mergeResponse.status).toBe(200);
    expect(await mergeResponse.json()).toMatchObject({ merged: true, number: 128, method: 'squash' });
  });

  it('rejects invalid input and stale heads without mutating', async () => {
    expect((await apiRequest(app, '/api/v1/github/prs/nope/merge-state')).status).toBe(400);
    const invalid = await apiRequest(app, '/api/v1/github/prs/128/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
      body: JSON.stringify({ method: 'octopus', expectedHeadSha: 'bad' }),
    });
    expect(invalid.status).toBe(400);

    const stale = await apiRequest(app, '/api/v1/github/prs/128/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
      body: JSON.stringify({ method: 'squash', expectedHeadSha: 'f'.repeat(40) }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'stale-head', current: { number: 128 } });
  });

  it('keeps the existing origin guard in front of the merge mutation', async () => {
    const response = await app.request('/api/v1/github/prs/128/merge', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4321',
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'squash',
        expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      }),
    });
    expect(response.status).toBe(403);
  });
});
