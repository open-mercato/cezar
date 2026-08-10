import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutomationCoordinator } from '../automations/coordinator.ts';
import { WorkspaceAutomationScheduler } from '../automations/scheduler.ts';
import { AutomationStore } from '../automations/store.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, WorkspaceEventBus } from './server.ts';

describe('GitHub automation API', () => {
  let root: string;
  let home: string;
  let store: RunStore;
  // #801 turned the whole family into an opt-in capability. This suite is about what the routes
  // DO, so it opts in explicitly; what they answer while the flag is off is `automations-gate.test.ts`.
  const savedAutomations = process.env.CEZ_AUTOMATIONS;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cezar-automation-api-'));
    home = mkdtempSync(join(tmpdir(), 'cezar-automation-home-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_AUTOMATIONS = '1';
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.CEZ_HOME;
    if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = savedAutomations;
  });

  const input = {
    name: 'Review new issues',
    events: ['issue.opened'],
    intervalSeconds: 300,
    filters: { lookbackDays: 7, maxRecords: 25 },
    task: { prompt: 'Review {{github.url}}' },
  };
  const app = (over: Partial<Parameters<typeof createApp>[0]> = {}) =>
    createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', ...over });
  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('creates paused definitions and rejects malformed bounds', async () => {
    const bad = await apiRequest(app(), '/api/v1/automations', json({ ...input, intervalSeconds: 5 }));
    expect(bad.status).toBe(400);
    const response = await apiRequest(app(), '/api/v1/automations', json(input));
    expect(response.status).toBe(201);
    expect(((await response.json()) as any).automation).toMatchObject({ enabled: false, revision: 1 });
  });

  it('enforces optimistic concurrency and establishes a baseline on enable', async () => {
    const created = ((await (await apiRequest(app(), '/api/v1/automations', json(input))).json()) as any).automation;
    const stale = await apiRequest(
      app(),
      `/api/v1/automations/${created.id}`,
      json({ ...input, expectedRevision: 9 }, 'PUT'),
    );
    expect(stale.status).toBe(409);
    const enabled = await apiRequest(app(), `/api/v1/automations/${created.id}/enable`, { method: 'POST' });
    expect(enabled.status).toBe(200);
    const detail = await apiRequest(app(), `/api/v1/automations/${created.id}`);
    expect(((await detail.json()) as any).state).toMatchObject({ revision: 2, baselineAt: expect.any(String) });
  });

  it('runs preview checks asynchronously without writing receipts', async () => {
    const server = app();
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(input))).json()) as any).automation;
    const queued = await apiRequest(server, `/api/v1/automations/${created.id}/check`, json({ mode: 'preview' }));
    expect(queued.status).toBe(202);
    const { checkId } = (await queued.json()) as { checkId: string };
    let check: { status: string } = { status: 'queued' };
    // Up to 2s, exiting the moment the check fails. The background pass shells out to `git` to
    // read the repo's remote before it can decide there is none, and 200ms of budget was under
    // that spawn's cost whenever the rest of the server suites were running beside this one.
    for (let attempt = 0; attempt < 200 && check.status !== 'error'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      check = (await (await apiRequest(server, `/api/v1/automation-checks/${checkId}`)).json()) as { status: string };
    }
    expect(check.status).toBe('error');
    const list = await apiRequest(server, '/api/v1/automations');
    expect(((await list.json()) as any).automations).toHaveLength(1);
    expect(readFileOrEmpty(join(root, '.ai/cezar/automation-receipts.ndjson'))).toBe('');
  });

  it('shares API mutations with the workspace scheduler store', async () => {
    const coordinator = new AutomationCoordinator({
      listProjects: async () => [{ id: 'default', root, status: 'ok' }],
    });
    const automationStore = coordinator.store('default', root)!;
    let rescheduled: Promise<void> | undefined;
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator,
      handle: (_projectId, sharedStore) => ({
        projectId: 'default',
        owner: 'open-mercato',
        repo: 'cezar',
        store: sharedStore,
        poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never,
      }),
    });
    const server = app({
      automationStore,
      automationsChanged: () => {
        rescheduled = scheduler.reschedule();
      },
    });

    await scheduler.start();
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(input))).json()) as any).automation;
    expect(scheduler.hasTimer()).toBe(false);

    const enabled = await apiRequest(server, `/api/v1/automations/${created.id}/enable`, { method: 'POST' });
    expect(enabled.status).toBe(200);
    await rescheduled;
    expect(coordinator.store('default')).toBe(automationStore);
    expect(coordinator.store('default')?.get(created.id)?.enabled).toBe(true);
    expect(scheduler.hasTimer()).toBe(true);

    coordinator.store('default')?.setState(created.id, {
      revision: 2,
      lastSuccessAt: '2026-07-27T00:00:00.000Z',
    });
    const detail = await apiRequest(server, `/api/v1/automations/${created.id}`);
    expect(((await detail.json()) as any).state.lastSuccessAt).toBe('2026-07-27T00:00:00.000Z');
    scheduler.stop();
  });

  it('accepts preview as an automation-log result filter', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    automationStore.appendLog({
      automationId: 'previewed',
      revision: 1,
      result: 'preview',
      reason: 'test preview',
    });
    const response = await apiRequest(
      app({ automationStore }),
      '/api/v1/automation-log?result=preview',
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).records).toEqual([
      expect.objectContaining({ automationId: 'previewed', result: 'preview' }),
    ]);
  });

  it('marks delete events explicitly while retaining a positive revision', async () => {
    const bus = new WorkspaceEventBus();
    const changes: unknown[] = [];
    bus.on((event, data) => {
      if (event === 'automation-change') changes.push(data);
    });
    const server = app({ workspaceEvents: bus });
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(input))).json()) as any).automation;
    const response = await apiRequest(server, `/api/v1/automations/${created.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(changes.at(-1)).toEqual({
      project: 'default',
      automationId: created.id,
      revision: 1,
      deleted: true,
    });
  });
});

function readFileOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
