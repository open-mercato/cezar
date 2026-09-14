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
        timeZone: 'UTC',
        store: sharedStore,
        github: { owner: 'open-mercato', repo: 'cezar', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never },
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

    coordinator.store('default')?.setState(created.id, (current) => ({
      ...current,
      revision: 2,
      lastSuccessAt: '2026-07-27T00:00:00.000Z',
    }));
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

describe('automation API — kinds, run, templates (spec 2026-09-14)', () => {
  let root: string;
  let home: string;
  let store: RunStore;
  let manager: RunManager;
  const savedAutomations = process.env.CEZ_AUTOMATIONS;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cezar-automation-kinds-'));
    home = mkdtempSync(join(tmpdir(), 'cezar-automation-kinds-home-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_AUTOMATIONS;
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = {
      startRun: (workflow: { name: string; steps: Array<{ id: string; name?: string; command?: string }> }, input: { task: string }) =>
        store.createRun({ title: 'automation', workflow: workflow.name, task: input.task, steps: workflow.steps.map((step) => ({ id: step.id, name: step.name ?? step.id, kind: step.command ? 'check' as const : 'agent' as const })) }),
    } as unknown as RunManager;
  });
  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.CEZ_HOME;
    if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = savedAutomations;
  });

  const app = () => createApp({ repoRoot: root, store, manager, version: 'test' });
  const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const schedule = { name: 'Nightly deps', kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps on {{date}}', workflow: 'quick-task' } };
  const poll = { name: 'Review new issues', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review {{github.url}}' } };

  it('creates a schedule paused, arms it on enable, and refuses a GitHub filter on it', async () => {
    const server = app();
    const bad = await apiRequest(server, '/api/v1/automations', json({ ...schedule, intervalSeconds: 300 }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toContain('no GitHub filter');
    const noSchedule = await apiRequest(server, '/api/v1/automations', json({ name: 'x', kind: 'schedule', task: { prompt: 'x' } }));
    expect(noSchedule.status).toBe(400);
    const wrongPlaceholder = await apiRequest(server, '/api/v1/automations', json({ ...schedule, task: { prompt: '{{github.url}}' } }));
    expect(wrongPlaceholder.status).toBe(400);

    const created = ((await (await apiRequest(server, '/api/v1/automations', json(schedule))).json()) as any).automation;
    expect(created).toMatchObject({ kind: 'schedule', enabled: false, schedule: { type: 'daily', hour: 4, minute: 0 } });
    expect(created.intervalSeconds).toBeUndefined();
    expect(created.filters).toBeUndefined();

    const enabled = await apiRequest(server, `/api/v1/automations/${created.id}/enable`, { method: 'POST' });
    expect(enabled.status).toBe(200);
    const detail = (await (await apiRequest(server, `/api/v1/automations/${created.id}`)).json()) as any;
    expect(detail.state).toMatchObject({ revision: 2, nextRunAt: expect.any(String) });
    expect(detail.state.baselineAt).toBeUndefined();
    expect(Date.parse(detail.state.nextRunAt)).toBeGreaterThan(Date.now());

    const list = (await (await apiRequest(server, '/api/v1/automations')).json()) as any;
    expect(list).toMatchObject({ timeZone: expect.any(String), stats: { runs: 0, failed: 0, agentSeconds: 0, costUsd: 0 } });
    expect(list.automations[0]).toMatchObject({ id: created.id, nextRunAt: detail.state.nextRunAt, runs7d: 0, costUsd7d: 0 });
  });

  it('keeps the stored kind on a PUT without one and refuses a kind switch', async () => {
    const server = app();
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(schedule))).json()) as any).automation;
    const edited = await apiRequest(server, `/api/v1/automations/${created.id}`, json({ name: 'Nightly deps v2', schedule: { type: 'weekdays', hour: 7, minute: 30 }, task: schedule.task, expectedRevision: 1 }, 'PUT'));
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as any).automation).toMatchObject({ kind: 'schedule', schedule: { type: 'weekdays' }, revision: 2 });
    const switched = await apiRequest(server, `/api/v1/automations/${created.id}`, json({ ...poll, kind: 'github', expectedRevision: 2 }, 'PUT'));
    expect(switched.status).toBe(409);
  });

  it('clears the next occurrence when the schedule changes, so the timer recomputes', async () => {
    const server = app();
    const created = ((await (await apiRequest(server, '/api/v1/automations', json({ ...schedule, enable: true }))).json()) as any).automation;
    const before = ((await (await apiRequest(server, `/api/v1/automations/${created.id}`)).json()) as any).state.nextRunAt;
    expect(before).toEqual(expect.any(String));
    await apiRequest(server, `/api/v1/automations/${created.id}`, json({ name: schedule.name, schedule: { type: 'hours', every: 6 }, task: schedule.task, enabled: true, expectedRevision: 1 }, 'PUT'));
    const after = ((await (await apiRequest(server, `/api/v1/automations/${created.id}`)).json()) as any).state;
    expect(after.nextRunAt).toBeUndefined();
    // An unrelated edit keeps it.
    await apiRequest(server, `/api/v1/automations/${created.id}/enable`, { method: 'POST' });
    const armed = ((await (await apiRequest(server, `/api/v1/automations/${created.id}`)).json()) as any).state.nextRunAt;
    await apiRequest(server, `/api/v1/automations/${created.id}`, json({ name: 'Renamed', schedule: { type: 'hours', every: 6 }, task: schedule.task, enabled: true, expectedRevision: 3 }, 'PUT'));
    expect(((await (await apiRequest(server, `/api/v1/automations/${created.id}`)).json()) as any).state.nextRunAt).toBe(armed);
  });

  it('runs a schedule by hand while paused, links the run in the log, and refuses run/check across kinds', async () => {
    const server = app();
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(schedule))).json()) as any).automation;
    const ran = await apiRequest(server, `/api/v1/automations/${created.id}/run`, { method: 'POST' });
    expect(ran.status).toBe(202);
    const { runId } = (await ran.json()) as { runId: string };
    expect(store.getRun(runId)?.automationTrigger).toMatchObject({ automationId: created.id, trigger: 'manual' });
    expect(store.getRun(runId)?.task).toContain('trigger: started by hand');
    const log = (await (await apiRequest(server, `/api/v1/automation-log?automationId=${created.id}`)).json()) as any;
    expect(log.records[0]).toMatchObject({ result: 'manual', runId });
    expect(log.runs[runId]).toMatchObject({ title: 'automation', status: expect.any(String), children: [] });
    const list = (await (await apiRequest(server, '/api/v1/automations')).json()) as any;
    expect(list.automations[0]).toMatchObject({ enabled: false, runs7d: 1, lastRun: { runId } });
    expect(list.stats.runs).toBe(1);

    expect((await apiRequest(server, `/api/v1/automations/${created.id}/check`, json({ mode: 'preview' }))).status).toBe(409);
    const pollDef = ((await (await apiRequest(server, '/api/v1/automations', json(poll))).json()) as any).automation;
    expect((await apiRequest(server, `/api/v1/automations/${pollDef.id}/run`, { method: 'POST' })).status).toBe(409);
  });

  it('lists the other registered projects\' automations as templates', async () => {
    const server = app();
    await apiRequest(server, '/api/v1/automations', json(schedule));
    const res = await apiRequest(server, '/api/v1/workspace/automation-templates?exclude=nobody');
    expect(res.status).toBe(200);
    const { templates } = (await res.json()) as any;
    expect(Array.isArray(templates)).toBe(true);
    // The boot project is registered under CEZ_HOME; excluding it empties the palette.
    const projects = (await (await apiRequest(server, '/api/v1/projects')).json()) as any;
    const mine = projects.projects.find((project: { root: string }) => project.root === root)?.id ?? projects.bootProject;
    const excluded = (await (await apiRequest(server, `/api/v1/workspace/automation-templates?exclude=${mine}`)).json()) as any;
    expect(excluded.templates.some((template: { project: { id: string } }) => template.project.id === mine)).toBe(false);
  });

  it('is off only for CEZ_AUTOMATIONS=0', async () => {
    process.env.CEZ_AUTOMATIONS = '0';
    const off = await apiRequest(app(), '/api/v1/workspace/automation-templates');
    expect(off.status).toBe(409);
    expect(((await off.json()) as any).error).toContain('CEZ_AUTOMATIONS=0');
  });
});

function readFileOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
