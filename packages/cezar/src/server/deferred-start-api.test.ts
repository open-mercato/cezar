import * as codexProbes from '../core/codex-usage-probe.ts';
import { deferredOptionsSchema, deferredAlreadyStartedSchema } from '@open-mercato/cezar-contract';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { AutomationStore } from '../automations/store.ts';

describe('deferred start API', () => {
  let root: string, store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-deferred-api-'));
    mkdirSync(join(root, 'profile'));
    vi.stubEnv('CEZ_HOME', join(root, 'home')); vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'profile')); vi.stubEnv('CEZ_AUTOMATIONS', '1');
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => { vi.restoreAllMocks(); store.flush(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const body = { task: { task: 'Keep {{user.id}} unchanged', workflow: 'quick-task', runner: 'claude' }, start: { kind: 'at', date: '2099-01-01', hour: 9, minute: 0 } };
  const app = () => createApp({ repoRoot: root, store, manager: { startRun: () => { throw new Error('must not create a run'); } } as unknown as RunManager, version: 'test' });
  async function create() {
    const api = app();
    const preview = await (await apiRequest(api, '/api/v1/deferred-start/preview', json(body))).json() as { previewRevision: string; available: boolean };
    expect(preview.available).toBe(true);
    const request = { ...body, previewRevision: preview.previewRevision, idempotencyKey: randomUUID() };
    const response = await apiRequest(api, '/api/v1/deferred-start', json(request));
    expect(response.status).toBe(201);
    return { api, request, result: await response.json() as { scheduled: { id: string } } };
  }
  it('rejects API-bound schedules instead of silently launching with native billing', async () => {
    const api = app();
    const input = { ...body, task: { ...body.task, llmProviderId: randomUUID() } };
    const preview = await apiRequest(api, '/api/v1/deferred-start/preview', json(input));
    expect(await preview.json()).toMatchObject({ available: false, message: 'Tasks using an API provider can only start now.' });
    const create = await apiRequest(api, '/api/v1/deferred-start', json({ ...input, previewRevision: 'stale', idempotencyKey: randomUUID() }));
    expect(create.status).toBe(400);
    expect(await create.json()).toEqual({ error: 'Tasks using an API provider can only start now.' });
  });
  it('describes reset eligibility and server zone without probing usage or creating a run', async () => {
    const usage = vi.spyOn(codexProbes, 'probeCodexUsageWindows').mockRejectedValue(new Error('unexpected usage probe'));
    const identity = vi.spyOn(codexProbes, 'probeCodexIdentity').mockRejectedValue(new Error('unexpected identity probe'));
    vi.stubEnv('CODEX_HOME', join(root, 'profile'));
    // CI and fresh installations have no OpenCode profile directory.
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'absent-xdg'));
    const api = app();
    const describe = async (task: unknown) => {
      const response = await apiRequest(api, '/api/v1/deferred-start/options', json({ task }));
      expect(response.status).toBe(200);
      return deferredOptionsSchema.parse(await response.json());
    };
    expect(await describe(body.task)).toMatchObject({ timeZone: expect.any(String), usageReset: { available: true, provider: 'claude' } });
    expect(await describe({ ...body.task, runner: 'opencode' })).toMatchObject({ usageReset: { available: false, reason: 'unsupported' } });
    expect(await describe({ ...body.task, steps: [{ id: 'one', prompt: 'A', runner: 'claude' }, { id: 'two', prompt: 'B', runner: 'opencode' }], workflow: undefined })).toMatchObject({ usageReset: { available: false } });
    expect(await describe({ ...body.task, runner: 'codex' })).toMatchObject({ usageReset: { available: true, provider: 'codex' } });
    // The workflow override, not the selected top-level runner, owns eligibility.
    expect(await describe({ ...body.task, runner: 'opencode', steps: [{ id: 'one', prompt: 'A', runner: 'claude' }], workflow: undefined })).toMatchObject({ usageReset: { available: true, provider: 'claude' } });
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'absent-claude'));
    expect(await describe(body.task)).toMatchObject({ usageReset: { available: false, reason: 'account-unverifiable' } });
    vi.stubEnv('CEZ_AUTOMATIONS', '0');
    expect(await describe(body.task)).toMatchObject({ timeZone: expect.any(String), usageReset: { available: false, reason: 'automations-off' } });
    expect(usage).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    expect(store.listRuns()).toEqual([]);
  });
  it('creates no run, worktree or title call; replays before validation even after cancellation and restart', async () => {
    const { request, result } = await create();
    expect(store.listRuns()).toEqual([]);
    const cancel = await apiRequest(app(), `/api/v1/automations/${result.scheduled.id}?expectedRevision=1`, { method: 'DELETE' });
    expect(cancel.status).toBe(204);
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'removed-profile'));
    const response = await apiRequest(app(), '/api/v1/deferred-start', json(request));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ scheduled: { id: result.scheduled.id, outcome: 'cancelled' } });
    const conflict = await apiRequest(app(), '/api/v1/deferred-start', json({ ...request, task: { ...request.task, task: 'Different' } }));
    expect(conflict.status).toBe(409);
  });
  it('recovers a persisted creation while disabled without accepting new schedules', async () => {
    const { request, result } = await create();
    vi.stubEnv('CEZ_AUTOMATIONS', '0');
    const api = app();
    const replay = await apiRequest(api, '/api/v1/deferred-start', json(request));
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(result);
    const different = await apiRequest(api, '/api/v1/deferred-start', json({ ...request, task: { ...request.task, task: 'Different' } }));
    expect(different.status).toBe(409);
    expect(await different.json()).toMatchObject({ error: 'This creation key belongs to a different request.' });
    const fresh = await apiRequest(api, '/api/v1/deferred-start', json({ ...request, idempotencyKey: randomUUID() }));
    expect(fresh.status).toBe(409);
    expect(await fresh.json()).toMatchObject({ error: expect.stringContaining('Automations are off') });
    expect((await apiRequest(api, '/api/v1/deferred-start/preview', json(body))).status).toBe(409);
    expect(AutomationStore.open(join(root, '.ai/cezar')).list()).toHaveLength(1);
    expect(store.listRuns()).toHaveLength(0);
  });
  it('schedules Pi through the API and executes its first step without a Claude profile', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'absent-claude'));
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_AUTONAME', '0');
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
    const manager = new RunManager(store, root);
    try {
      const api = createApp({ repoRoot: root, store, manager, version: 'test' });
      const input = { ...body, task: { ...body.task, runner: 'pi', worktree: false } };
      const preview = await (await apiRequest(api, '/api/v1/deferred-start/preview', json(input))).json() as { available: boolean; previewRevision: string };
      expect(preview.available).toBe(true);
      const created = await apiRequest(api, '/api/v1/deferred-start', json({ ...input, previewRevision: preview.previewRevision, idempotencyKey: randomUUID() }));
      expect(created.status).toBe(201);
      const { scheduled } = await created.json() as { scheduled: { id: string } };
      expect(store.listRuns()).toHaveLength(0);
      const started = await apiRequest(api, `/api/v1/automations/${scheduled.id}/run?expectedRevision=1`, { method: 'POST' });
      expect(started.status).toBe(202);
      await vi.waitFor(() => expect(store.listRuns()[0]?.steps[0]?.tokensUsed).toBeGreaterThan(0), { timeout: 10_000 });
      expect(store.listRuns()[0]?.steps[0]?.profileId).toBe('default');
      manager.cancel(store.listRuns()[0]!.id);
      await vi.waitFor(() => expect(manager.isActive(store.listRuns()[0]!.id)).toBe(false), { timeout: 10_000 });
    } finally { manager.dispose(); }
  }, 20_000);
  it('rejects stale previews, direct attachment/todo scheduling and malformed bodies', async () => {
    const response = await apiRequest(app(), '/api/v1/deferred-start', json({ ...body, previewRevision: 'stale', idempotencyKey: randomUUID() }));
    expect(response.status).toBe(409);
    const todo = await apiRequest(app(), '/api/v1/deferred-start/preview', json({ ...body, task: { ...body.task, todoId: 'todo' } }));
    expect(await todo.json()).toMatchObject({ available: false, reason: 'linked-todo' });
    const attachments = await apiRequest(app(), '/api/v1/deferred-start/preview', json({ ...body, task: { ...body.task, images: [{ mediaType: 'image/png', data: 'AA==' }] } }));
    expect(await attachments.json()).toMatchObject({ available: false, reason: 'attachments' });
    expect((await apiRequest(app(), '/api/v1/deferred-start', json({ arbitrary: true }))).status).toBe(400);
    expect(AutomationStore.open(join(root, '.ai/cezar')).list()).toEqual([]);
  });
  it('guards both POSTs when automations are disabled', async () => {
    vi.stubEnv('CEZ_AUTOMATIONS', '0');
    expect((await apiRequest(app(), '/api/v1/deferred-start/preview', json(body))).status).toBe(409);
    expect((await apiRequest(app(), '/api/v1/deferred-start', json({ ...body, previewRevision: 'r', idempotencyKey: randomUUID() }))).status).toBe(409);
    expect(store.listRuns()).toEqual([]);
  });
  it('replays creation through the default project alias', async () => {
    const { api, request, result } = await create();
    const replay = await apiRequest(api, '/api/v1/p/default/deferred-start', json(request));
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(result);
    expect(store.listRuns()).toEqual([]);
  });
  it('requires revisions and rejects ordinary automation mutation bypasses', async () => {
    const { api, result } = await create(); const id = result.scheduled.id;
    expect((await apiRequest(api, `/api/v1/automations/${id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await apiRequest(api, `/api/v1/automations/${id}/run`, { method: 'POST' })).status).toBe(409);
    expect((await apiRequest(api, `/api/v1/automations/${id}/enable`, { method: 'POST' })).status).toBe(409);
    expect((await apiRequest(api, `/api/v1/automations/${id}/pause`, { method: 'POST' })).status).toBe(409);
  });
  it('lets an uncertain launch be dismissed, recording only the runs that exist', async () => {
    const { api, result } = await create(); const id = result.scheduled.id;
    const automations = AutomationStore.open(join(root, '.ai/cezar'));
    const saved = automations.get(id)!;
    const ambiguous = automations.update(id, saved.revision, { ...saved, enabled: false, deferredStart: { ...saved.deferredStart!, status: 'failed', failureKind: 'ambiguous', runIds: ['run-a', 'run-b'] } });
    const response = await apiRequest(api, `/api/v1/automations/${id}?expectedRevision=${ambiguous.revision}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(AutomationStore.open(join(root, '.ai/cezar')).creationFor(id)).toMatchObject({ outcome: 'cancelled', runIds: [] });
  });
  it('still refuses to cancel a launch in progress, and says when the task already started', async () => {
    const { api, result } = await create(); const id = result.scheduled.id;
    const automations = AutomationStore.open(join(root, '.ai/cezar'));
    const saved = automations.get(id)!;
    const launching = automations.update(id, saved.revision, { ...saved, deferredStart: { ...saved.deferredStart!, status: 'launching', runIds: ['run-a'] } });
    expect((await apiRequest(api, `/api/v1/automations/${id}?expectedRevision=${launching.revision}`, { method: 'DELETE' })).status).toBe(409);
    automations.finishDeferred(id, 'launched', ['run-a']);
    const started = await apiRequest(api, `/api/v1/automations/${id}?expectedRevision=${launching.revision}`, { method: 'DELETE' });
    expect(started.status).toBe(409);
    const payload = await started.json();
    expect(payload).toEqual({ error: 'This scheduled task already started.', runIds: ['run-a'] });
    expect(deferredAlreadyStartedSchema.parse(payload)).toEqual(payload);
  });
});
