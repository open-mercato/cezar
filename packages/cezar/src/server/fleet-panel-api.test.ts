import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fleetPanelSchema } from '@open-mercato/cezar-contract';
import { FleetHub } from '../fleet/hub.ts';
import { hubView, remoteView, setFleetView } from '../fleet/view.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** `GET /api/v1/workspace/fleet` and its cancel: the cockpit's Fleet panel (spec 2026-10-21-fleet-coordination). */
describe('the fleet panel API', () => {
  let repoRoot: string;
  let store: RunStore;
  const app = () => createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-fleet-api-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });
  afterEach(() => {
    setFleetView(undefined);
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('is disabled (and empty) when this cezar has no fleet role', async () => {
    const res = await apiRequest(app(), '/api/v1/workspace/fleet');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, nodes: [], jobs: [] });
    const cancel = await apiRequest(app(), '/api/v1/workspace/fleet/jobs/abc/cancel', { method: 'POST' });
    expect(cancel.status).toBe(404);
  });

  it('shows a hub its nodes and jobs, and cancels a job', async () => {
    const hub = new FleetHub();
    hub.heartbeat({ nodeId: 'n1', version: '1', capacity: { free: 1, max: 2 }, host: {}, jobs: [] });
    const job = hub.submit({ repoUrl: 'a/b', task: 'do it' });
    setFleetView(hubView(hub, 'hub'));
    const res = await apiRequest(app(), '/api/v1/workspace/fleet');
    const body = fleetPanelSchema.parse(await res.json());
    expect(body).toMatchObject({ enabled: true, role: 'hub', nodeId: 'hub' });
    expect(body.nodes.map((n) => n.nodeId)).toEqual(['n1']);
    expect(body.jobs.map((j) => j.id)).toContain(job.id);

    const cancel = await apiRequest(app(), `/api/v1/workspace/fleet/jobs/${job.id}/cancel`, { method: 'POST' });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({ id: job.id, status: 'cancelled' });
    expect((await apiRequest(app(), '/api/v1/workspace/fleet/jobs/nope/cancel', { method: 'POST' })).status).toBe(404);
  });

  it('on a worker asks the hub with the token server-side and never returns it', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const hub = new FleetHub();
    const job = hub.submit({ repoUrl: 'a/b', task: 'remote' });
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return url.endsWith('/status')
        ? Response.json(hub.status())
        : Response.json(hub.cancel(url.split('/').slice(-2)[0] as string));
    }) as unknown as typeof fetch;
    setFleetView(remoteView('http://hub:4330', 'x'.repeat(40), 'w1', fake));
    const res = await apiRequest(app(), '/api/v1/workspace/fleet');
    const text = await res.text();
    expect(text).not.toContain('x'.repeat(40));
    expect(JSON.parse(text)).toMatchObject({ enabled: true, role: 'worker', nodeId: 'w1', jobs: [{ id: job.id }] });
    expect(seen[0]).toEqual({ url: 'http://hub:4330/api/v1/fleet/status', auth: `Bearer ${'x'.repeat(40)}` });
    const cancel = await apiRequest(app(), `/api/v1/workspace/fleet/jobs/${job.id}/cancel`, { method: 'POST' });
    expect(cancel.status).toBe(200);
  });

  it('reports an unreachable hub as an error field, not a failed request', async () => {
    const down = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    setFleetView(remoteView('http://hub:4330', 'x'.repeat(40), 'w1', down));
    const res = await apiRequest(app(), '/api/v1/workspace/fleet');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, role: 'worker', nodes: [], jobs: [], error: 'connect ECONNREFUSED' });
  });
});
