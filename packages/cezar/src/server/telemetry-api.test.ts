import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, type ServerDeps } from './server.ts';

/**
 * The telemetry relay (`POST /api/v1/telemetry/{page,event,error}`), the consent routes and `open_in`: the server is
 * what keeps every label a closed set, so these pin the enforcement at the route, not the schema.
 */
vi.mock('../telemetry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry.ts')>();
  return { ...actual, track: vi.fn(), reportError: vi.fn() };
});
vi.mock('./open-in-app.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./open-in-app.ts')>();
  return {
    ...actual,
    detectOpenTargets: vi.fn(() => [{ id: 'finder', label: 'Finder', icon: 'folder' }]),
    openInApp: vi.fn(async (target: string) => target === 'finder'),
  };
});

import { TELEMETRY_POLICY_VERSION, reportError, track } from '../telemetry.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { telemetryConsentSchema } from '@open-mercato/cezar-contract';
import { apiRequest } from './loopback-request.testkit.ts';

describe('telemetry routes', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    vi.clearAllMocks();
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-telemetry-api-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const post = (path: string, body: unknown, over: Partial<ServerDeps> = {}) =>
    apiRequest(createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over }), path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('forwards a route shape as page_viewed and refuses a raw path', async () => {
    expect((await post('/api/v1/telemetry/page', { route: '/p/:param/tasks/:param/changes' })).status).toBe(204);
    expect(track).toHaveBeenCalledWith('page_viewed', { label: '/p/:param/tasks/:param/changes' }, { sid: undefined });

    vi.mocked(track).mockClear();
    expect((await post('/api/v1/telemetry/page', { route: '/p/acme-shop/tasks' })).status).toBe(400);
    expect(track).not.toHaveBeenCalled();
  });

  it('labels archive and pin with the button that sent them, never the task status', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    expect((await post(`/api/v1/runs/${run.id}/pin`, { surface: 'sidebar' })).status).toBe(200);
    expect(track).toHaveBeenCalledWith('task_pinned', { label: 'sidebar' }, { sid: undefined });
    expect((await post(`/api/v1/runs/${run.id}/archive`, { archived: true, surface: 'task_view' })).status).toBe(200);
    expect(track).toHaveBeenCalledWith('task_archived', { label: 'task_view' }, { sid: undefined });
    expect((await post(`/api/v1/runs/${run.id}/archive`, { archived: false })).status).toBe(200);
    expect(track).toHaveBeenCalledWith('task_unarchived', { label: 'api' }, { sid: undefined });

    vi.mocked(track).mockClear();
    expect((await post(`/api/v1/runs/${run.id}/pin`, { surface: 'my-secret-repo' })).status).toBe(400);
    expect(track).not.toHaveBeenCalled();
  });

  it('relays only the closed event labels', async () => {
    expect((await post('/api/v1/telemetry/event', { event: 'message_sent', label: 'github' })).status).toBe(204);
    expect(track).toHaveBeenCalledWith('message_sent', { label: 'github' }, { sid: undefined });

    vi.mocked(track).mockClear();
    expect((await post('/api/v1/telemetry/event', { event: 'message_sent', label: 'fix the login bug' })).status).toBe(400);
    expect((await post('/api/v1/telemetry/event', { event: 'message_sent', label: 'cli' })).status).toBe(400);
    expect(track).not.toHaveBeenCalled();
  });

  it('relays add_project_opened with its closed dialog labels only', async () => {
    for (const label of ['new', 'clone', 'folder']) {
      expect((await post('/api/v1/telemetry/event', { event: 'add_project_opened', label })).status).toBe(204);
      expect(track).toHaveBeenCalledWith('add_project_opened', { label }, { sid: undefined });
    }
    vi.mocked(track).mockClear();
    expect((await post('/api/v1/telemetry/event', { event: 'add_project_opened', label: 'my-secret-repo' })).status).toBe(400);
    expect(track).not.toHaveBeenCalled();
  });

  /** Telemetry 7054e5f2: attachment counts as buckets, re-stage outcomes — closed sets only. */
  it('relays attachments_sent and attachments_restaged with their closed labels only', async () => {
    for (const label of ['1', '2-4', '5-10', '11-20']) {
      expect((await post('/api/v1/telemetry/event', { event: 'attachments_sent', label })).status).toBe(204);
      expect(track).toHaveBeenCalledWith('attachments_sent', { label }, { sid: undefined });
    }
    for (const label of ['recovered', 'failed']) {
      expect((await post('/api/v1/telemetry/event', { event: 'attachments_restaged', label })).status).toBe(204);
    }
    vi.mocked(track).mockClear();
    expect((await post('/api/v1/telemetry/event', { event: 'attachments_sent', label: '7' })).status).toBe(400);
    expect((await post('/api/v1/telemetry/event', { event: 'attachments_restaged', label: 'shot.png' })).status).toBe(400);
    expect(track).not.toHaveBeenCalled();
  });

  it('relays skills_update_apply_dropped with its closed outcome labels only', async () => {
    for (const label of ['recovered', 'not_applied', 'unreachable', 'timed_out']) {
      expect((await post('/api/v1/telemetry/event', { event: 'skills_update_apply_dropped', label })).status).toBe(204);
      expect(track).toHaveBeenCalledWith('skills_update_apply_dropped', { label }, { sid: undefined });
    }
    vi.mocked(track).mockClear();
    expect((await post('/api/v1/telemetry/event', { event: 'skills_update_apply_dropped', label: 'fetch failed' })).status).toBe(400);
    expect(track).not.toHaveBeenCalled();
  });

  it('relays a cockpit error and rejects an oversized context', async () => {
    const res = await post('/api/v1/telemetry/error', { type: 'TypeError', message: 'boom', context: { 'page.route': '/tasks' } });
    expect(res.status).toBe(204);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({ source: 'cockpit', 'page.route': '/tasks' });

    const context = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]));
    expect((await post('/api/v1/telemetry/error', { type: 'Error', message: 'x', context })).status).toBe(400);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  describe('consent', () => {
    const app = () => createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const consentOf = async (res: Response) => telemetryConsentSchema.parse(await res.json());
    const put = (body: unknown) =>
      apiRequest(app(), '/api/v1/telemetry/consent', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    beforeEach(() => {
      vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'cez-consent-api-')));
    });
    afterEach(() => vi.unstubAllEnvs());

    it('starts unanswered, and says when the server could never send', async () => {
      const body = telemetryConsentSchema.parse(await (await apiRequest(app(), '/api/v1/telemetry/consent')).json());
      expect(body).toMatchObject({ consent: 'unknown', policyVersion: TELEMETRY_POLICY_VERSION, blockedBy: 'automation' });
      vi.stubEnv('DO_NOT_TRACK', '1');
      expect((await consentOf(await apiRequest(app(), '/api/v1/telemetry/consent'))).blockedBy).toBe('env');
    });

    it('records a yes and a no in the workspace config', async () => {
      expect((await consentOf(await put({ consent: 'granted' }))).consent).toBe('granted');
      expect((await loadWorkspaceConfig()).telemetry?.consent).toBe('granted');
      expect((await consentOf(await put({ consent: 'denied' }))).consent).toBe('denied');
      expect((await consentOf(await apiRequest(app(), '/api/v1/telemetry/consent'))).consent).toBe('denied');
    });

    it('refuses anything but an explicit answer', async () => {
      expect((await put({ consent: 'unknown' })).status).toBe(400);
      expect((await put({})).status).toBe(400);
      expect((await loadWorkspaceConfig()).telemetry).toBeUndefined();
    });
  });

  describe('open_in', () => {
    const openInCalls = () => vi.mocked(track).mock.calls.filter(([event]) => event === 'open_in');

    it('counts a run open-in only once an allowlisted app opened', async () => {
      const runId = store.createRun({ title: 't', workflow: 'quick-task', task: 'do it', steps: [] }).id;
      expect((await post(`/api/v1/runs/${runId}/open-in`, { target: 'my secret project name' })).status).toBe(409);
      expect(openInCalls()).toEqual([]);

      expect((await post(`/api/v1/runs/${runId}/open-in`, { target: 'finder' })).status).toBe(200);
      expect(openInCalls().map(([, extra]) => extra)).toEqual([{ label: 'finder' }]);
    });

    it('never counts a refused project open-in', async () => {
      expect((await post('/api/v1/open-in', { target: 'free text here' })).status).toBe(400);
      process.env.CEZ_REMOTE = '1';
      expect((await post('/api/v1/open-in', { target: 'finder' })).status).toBe(409);
      expect(openInCalls()).toEqual([]);

      delete process.env.CEZ_REMOTE;
      expect((await post('/api/v1/open-in', { target: 'finder' })).status).toBe(200);
      expect(openInCalls().map(([, extra]) => extra)).toEqual([{ label: 'project:finder' }]);
    });
  });
});
