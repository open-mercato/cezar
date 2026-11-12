import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/** `POST /runs/:id/cancel` keeps a canceller's reason on the run (spec 2026-10-31-managers, `task cancel`). */
describe('POST /runs/:id/cancel reason', () => {
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-cancel-reason-'));
    const dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const manager = {
    cancel: (id: string) => {
      if (store.getRun(id)?.status !== 'running') return false;
      store.updateRun(id, { status: 'cancelled' });
      return true;
    },
  } as unknown as RunManager;
  const app = () => createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  const running = () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    return run.id;
  };
  const cancel = (id: string, body?: unknown) => apiRequest(app(), `/api/v1/runs/${id}/cancel`, {
    method: 'POST',
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });

  it('records why and by whom', async () => {
    const id = running();
    const res = await cancel(id, { reason: 'review only', cancelledBy: 'Coding Manager' });
    expect(await res.json()).toEqual({ cancelled: true });
    expect(store.getRun(id)).toMatchObject({ status: 'cancelled', cancelReason: 'review only', cancelledBy: 'Coding Manager' });
  });

  it('still takes an empty POST, as the cockpit sends it', async () => {
    const id = running();
    expect(await (await cancel(id)).json()).toEqual({ cancelled: true });
    expect(store.getRun(id)?.cancelReason).toBeUndefined();
  });

  it('leaves a settled run as it was', async () => {
    const id = running();
    store.updateRun(id, { status: 'done' });
    expect(await (await cancel(id, { reason: 'late' })).json()).toEqual({ cancelled: false });
    expect(store.getRun(id)?.cancelReason).toBeUndefined();
  });

  it('refuses a body that is not the schema', async () => {
    expect((await cancel(running(), { reason: 42 })).status).toBe(400);
  });
});
