import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { track } from '../telemetry.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

vi.mock('../telemetry.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), track: vi.fn() }));

/** Feature-usage events from the automation and workflow routes (docs/telemetry.md). */
describe('feature telemetry from the API', () => {
  let root: string;
  let home: string;
  let store: RunStore;
  const savedAutomations = process.env.CEZ_AUTOMATIONS;
  const sid = '0192f0e0-0000-7000-8000-000000000000';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cezar-feature-telemetry-'));
    home = mkdtempSync(join(tmpdir(), 'cezar-feature-telemetry-home-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_AUTOMATIONS = '1';
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    vi.mocked(track).mockClear();
  });
  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.CEZ_HOME;
    if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = savedAutomations;
  });

  const app = () => createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json', 'x-cezar-sid': sid },
    body: JSON.stringify(body),
  });
  const calls = () => vi.mocked(track).mock.calls.filter(([event]) => /^(automation_|workflow_saved)/.test(event));

  it('counts an automation created, switched on and off, and deleted — by trigger, never by name', async () => {
    const created = await apiRequest(app(), '/api/v1/automations', json({
      name: 'Acme secret automation',
      events: ['issue.opened'],
      intervalSeconds: 300,
      filters: { lookbackDays: 7, maxRecords: 25 },
      task: { prompt: 'Review {{github.url}}' },
    }));
    expect(created.status).toBe(201);
    const { id } = ((await created.json()) as { automation: { id: string } }).automation;
    expect((await apiRequest(app(), `/api/v1/automations/${id}/enable`, json({}))).status).toBe(200);
    // Enabling what is already on is not a second switch.
    expect((await apiRequest(app(), `/api/v1/automations/${id}/enable`, json({}))).status).toBe(200);
    expect((await apiRequest(app(), `/api/v1/automations/${id}/pause`, json({}))).status).toBe(200);
    expect((await apiRequest(app(), `/api/v1/automations/${id}`, { method: 'DELETE', headers: { 'x-cezar-sid': sid } })).status).toBe(204);
    expect(calls()).toEqual([
      ['automation_created', { label: 'github:issue.opened' }, { sid }],
      ['automation_toggled', { label: 'enabled' }, { sid }],
      ['automation_toggled', { label: 'paused' }, { sid }],
      ['automation_deleted', { label: 'github:issue.opened' }, { sid }],
    ]);
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toContain('Acme');
  });

  it('counts a workflow saved, overwritten and deleted', async () => {
    const chain = { name: 'Acme flow', steps: [{ id: 'a', prompt: '{{task}}' }] };
    expect((await apiRequest(app(), '/api/v1/workflows', json(chain))).status).toBe(201);
    expect((await apiRequest(app(), '/api/v1/workflows', json({ ...chain, overwrite: true }))).status).toBe(201);
    // A refused save (the file exists) is not counted.
    expect((await apiRequest(app(), '/api/v1/workflows', json(chain))).status).toBe(409);
    const deleted = await apiRequest(app(), `/api/v1/workflows/${encodeURIComponent('Acme flow')}`, { method: 'DELETE', headers: { 'x-cezar-sid': sid } });
    expect(deleted.status).toBe(200);
    expect(calls()).toEqual([
      ['workflow_saved', { label: 'chain_created' }, { sid }],
      ['workflow_saved', { label: 'chain_updated' }, { sid }],
      ['workflow_saved', { label: 'deleted' }, { sid }],
    ]);
  });
});
