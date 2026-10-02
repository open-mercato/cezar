import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { starCountSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { CEZAR_REPO_URL, StarCountReader } from './star-count.ts';

/**
 * `GET /api/v1/star-count` — the route behind the cockpit's ⭐ ask.
 *
 * The reader is injected in every case here, so the unit gate never reaches github.com; what is
 * under test is the route's contract, not the fetch (that is `star-count.test.ts`). The property
 * that matters: an unavailable count is a 200 with `available: false`, never a 5xx and never an
 * absent route. A promo that can turn a cockpit red is worse than a promo nobody sees.
 */
describe('the star-count API', () => {
  let repoRoot: string;
  let store: RunStore;

  const appWith = (read: () => Promise<{ available: boolean; count?: number; url: string }>): Hono =>
    createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      starCount: { read },
    });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-stars-api-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('answers the count and the repo URL, in the contract shape', async () => {
    const app = appWith(async () => ({ available: true, count: 1234, url: CEZAR_REPO_URL }));
    const res = await apiRequest(app, '/api/v1/star-count');
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(starCountSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ available: true, count: 1234, url: CEZAR_REPO_URL });
  });

  it('answers 200 with available:false when nothing is known — never an error status', async () => {
    const app = appWith(async () => ({ available: false, url: CEZAR_REPO_URL }));
    const res = await apiRequest(app, '/api/v1/star-count');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, url: CEZAR_REPO_URL });
  });

  it('is workspace-level: no project scope, and the default reader spends no request while silenced', async () => {
    // `CEZ_NO_BANNER=1` is the promo's single off switch, and it must stop the request itself —
    // not merely hide the chip after paying for it.
    const reader = new StarCountReader({
      env: { CEZ_NO_BANNER: '1' },
      fetchImpl: (() => {
        throw new Error('the silenced reader must not reach the network');
      }) as unknown as typeof fetch,
      cachePath: join(repoRoot, 'unused.json'),
    });
    const app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      starCount: reader,
    });
    const res = await apiRequest(app, '/api/v1/star-count');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, url: CEZAR_REPO_URL });
  });
});
