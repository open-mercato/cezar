import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
});
