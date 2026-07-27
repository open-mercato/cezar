import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

/**
 * Anti-buffering contract for both SSE endpoints (#424): `no-transform` +
 * `X-Accel-Buffering: no`, or an intermediary (reverse proxy, compression
 * middleware) may buffer the stream and the cockpit silently freezes while the
 * server keeps writing. hono's streamSSE alone answers a bare `no-cache`.
 */
describe('SSE responses defeat intermediary buffering', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-sse-headers-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function headersOf(path: string): Promise<Headers> {
    const res = await apiRequest(app, path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
    return res.headers;
  }

  it('global /api/events carries no-transform and X-Accel-Buffering: no', async () => {
    const headers = await headersOf('/api/events');
    expect(headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(headers.get('x-accel-buffering')).toBe('no');
  });

  it('per-run /api/runs/:id/events carries the same contract', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    const headers = await headersOf(`/api/runs/${run.id}/events`);
    expect(headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(headers.get('x-accel-buffering')).toBe('no');
  });
});
