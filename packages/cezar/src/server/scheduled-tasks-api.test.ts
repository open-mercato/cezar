import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('scheduled tasks API', () => {
  let root: string;
  let home: string;
  let store: RunStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cezar-scheduled-api-'));
    home = mkdtempSync(join(tmpdir(), 'cezar-scheduled-home-'));
    process.env.CEZ_HOME = home;
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.CEZ_HOME;
  });

  // A manager stub that bakes provenance in at creation, matching the real durable-launch path.
  const stubManager = () => ({
    startRun: (
      workflow: { name: string; steps: Array<{ id: string; name?: string; command?: string }> },
      input: { task: string },
      _group: unknown,
      options?: { scheduledTask?: never },
    ) => store.createRun({
      title: 'scheduled', workflow: workflow.name, task: input.task,
      scheduledTask: options?.scheduledTask,
      steps: workflow.steps.map((s) => ({ id: s.id, name: s.name ?? s.id, kind: s.command ? 'check' as const : 'agent' as const })),
    }),
    startVariants: () => [],
    pumpQueue: () => {},
  } as unknown as RunManager);

  const app = (manager: RunManager = {} as RunManager) =>
    createApp({ repoRoot: root, store, manager, version: 'test' });
  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const future = { kind: 'once', localAt: '2099-01-01T09:30', timezone: 'UTC' };
  const input = { name: 'Nightly report', timing: future, task: { prompt: 'Summarize', workflow: 'quick-task' } };

  it('rejects a time under a minute in the future and creates an enabled definition otherwise', async () => {
    const past = await apiRequest(app(), '/api/v1/scheduled-tasks', json({ ...input, timing: { kind: 'once', localAt: '2000-01-01T00:00', timezone: 'UTC' } }));
    expect(past.status).toBe(400);
    const created = await apiRequest(app(), '/api/v1/scheduled-tasks', json(input));
    expect(created.status).toBe(201);
    expect(((await created.json()) as any).scheduledTask).toMatchObject({ enabled: true, revision: 1, timing: { kind: 'once', at: '2099-01-01T09:30:00.000Z', timezone: 'UTC' } });
  });

  it('rejects an invalid timezone', async () => {
    const bad = await apiRequest(app(), '/api/v1/scheduled-tasks', json({ ...input, timing: { kind: 'once', localAt: '2099-01-01T09:30', timezone: 'Not/AZone' } }));
    expect(bad.status).toBe(400);
  });

  it('previews the authoritative local/UTC rendering', async () => {
    const preview = await apiRequest(app(), '/api/v1/scheduled-tasks/preview', json({ localAt: '2099-01-01T09:30', timezone: 'America/New_York' }));
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as any;
    expect(body.utcLabel).toBe('14:30 UTC');
    expect(body.timezone).toBe('America/New_York');
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it('enforces optimistic concurrency on update', async () => {
    const created = ((await (await apiRequest(app(), '/api/v1/scheduled-tasks', json(input))).json()) as any).scheduledTask;
    const stale = await apiRequest(app(), `/api/v1/scheduled-tasks/${created.id}`, json({ ...input, expectedRevision: 9 }, 'PUT'));
    expect(stale.status).toBe(409);
    const ok = await apiRequest(app(), `/api/v1/scheduled-tasks/${created.id}`, json({ ...input, name: 'Renamed', expectedRevision: 1 }, 'PUT'));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).scheduledTask).toMatchObject({ name: 'Renamed', revision: 2 });
  });

  it('pauses and resumes a definition', async () => {
    const created = ((await (await apiRequest(app(), '/api/v1/scheduled-tasks', json(input))).json()) as any).scheduledTask;
    const paused = await apiRequest(app(), `/api/v1/scheduled-tasks/${created.id}/pause`, { method: 'POST' });
    expect(((await paused.json()) as any).scheduledTask.enabled).toBe(false);
    const resumed = await apiRequest(app(), `/api/v1/scheduled-tasks/${created.id}/resume`, { method: 'POST' });
    expect(((await resumed.json()) as any).scheduledTask.enabled).toBe(true);
  });

  it('Run now launches once, consumes the definition, and leaves the run in place', async () => {
    const server = app(stubManager());
    const created = ((await (await apiRequest(server, '/api/v1/scheduled-tasks', json(input))).json()) as any).scheduledTask;
    const runNow = await apiRequest(server, `/api/v1/scheduled-tasks/${created.id}/run-now`, { method: 'POST' });
    expect(runNow.status).toBe(202);
    const body = (await runNow.json()) as any;
    expect(body.occurrenceId).toEqual(expect.any(String));
    expect(store.getRun(body.runId)?.scheduledTask).toMatchObject({ scheduledTaskId: created.id, trigger: 'manual' });
    // A completed definition cannot Run now again.
    const again = await apiRequest(server, `/api/v1/scheduled-tasks/${created.id}/run-now`, { method: 'POST' });
    expect(again.status).toBe(409);
    const detail = ((await (await apiRequest(server, `/api/v1/scheduled-tasks/${created.id}`)).json()) as any);
    expect(detail.displayStatus).toBe('completed');
    const occurrences = ((await (await apiRequest(server, `/api/v1/scheduled-task-occurrences?scheduledTaskId=${created.id}`)).json()) as any).occurrences;
    expect(occurrences[0]).toMatchObject({ status: 'launched', trigger: 'manual' });
  });

  it('deletes a definition without touching launched runs', async () => {
    const created = ((await (await apiRequest(app(), '/api/v1/scheduled-tasks', json(input))).json()) as any).scheduledTask;
    const removed = await apiRequest(app(), `/api/v1/scheduled-tasks/${created.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    const missing = await apiRequest(app(), `/api/v1/scheduled-tasks/${created.id}`);
    expect(missing.status).toBe(404);
  });

  it('mirrors the surface under /api/v1/p/default', async () => {
    const created = await apiRequest(app(), '/api/v1/p/default/scheduled-tasks', json(input));
    expect(created.status).toBe(201);
  });
});
