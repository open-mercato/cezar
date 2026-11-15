import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeRunEngineInputSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import * as actionGate from './provider-action-gate.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

describe('POST /runs/:id/engine', () => {
  let root: string; let store: RunStore; let app: Hono;
  const change = vi.fn(() => ({ ok: true }));
  const profile = vi.fn<() => string | undefined>(() => undefined);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-engine-route-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    change.mockReset().mockReturnValue({ ok: true }); profile.mockReset().mockReturnValue(undefined);
    app = createApp({ repoRoot: root, store, manager: { changeQueuedEngine: change, queuedEngineProfile: profile } as unknown as RunManager, version: 'test', providerAuth: connectedProviderAuth() });
  });
  afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); });
  const run = () => store.createRun({ title: 'task', workflow: 'task', task: 'task', steps: [], runner: 'claude' });
  const post = (id: string, body: unknown) => apiRequest(app, `/api/v1/runs/${id}/engine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('passes a queued choice to the scheduler and returns an explicit acknowledgement', async () => {
    const task = run();
    const response = await post(task.id, { runner: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: true });
    expect(change).toHaveBeenCalledWith(task.id, { runner: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' }, 'claude');
  });
  it.each([{}, { runner: 'codex', typo: true }, { runner: 'bogus' }])('rejects an empty or unknown choice: %j', async body => {
    const response = await post(run().id, body);
    expect(response.status).toBe(400); expect(change).not.toHaveBeenCalled();
    expect(changeRunEngineInputSchema.safeParse(body).success).toBe(false);
  });
  it('rejects running tasks and scheduler races', async () => {
    const task = run(); store.updateRun(task.id, { status: 'running' });
    expect((await post(task.id, { runner: 'codex' })).status).toBe(409);
    expect(change).not.toHaveBeenCalled();
    store.updateRun(task.id, { status: 'queued' }); change.mockReturnValue({ ok: false });
    expect((await post(task.id, { runner: 'codex' })).status).toBe(409);
  });
  it('authenticates the recorded continuation login, while honoring a new explicit account', async () => {
    const task = store.createRun({ title: 'continued', workflow: 'task', task: 'task', steps: [{ id: 'work', name: 'Work', kind: 'agent' }], runner: 'claude' });
    store.updateStep(task.id, 'work', { sessionId: 'old-session', backend: 'claude', profileId: 'original' });
    const judged: (string | undefined)[] = [];
    profile.mockReturnValue('original');
    const gate = vi.spyOn(actionGate, 'withSelectedAccounts').mockImplementation(async (rows, _providers, scope) => {
      judged.push(scope.profileFor?.('claude')); return rows;
    });
    try {
      expect((await post(task.id, { model: 'sonnet' })).status).toBe(200);
      expect(judged).toEqual(['original']);
      store.updateRun(task.id, { agentProfile: 'chosen-new-login' });
      profile.mockReturnValue('chosen-new-login');
      expect((await post(task.id, { reasoningEffort: 'high' })).status).toBe(200);
      expect(judged).toEqual(['original', 'chosen-new-login']);
    } finally { gate.mockRestore(); }
  });

  it.each(['engine record', 'queued session account'])('rejects a concurrent %s change during provider validation', async (changed) => {
    const task = run();
    profile.mockReturnValue('original');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const gate = vi.spyOn(actionGate, 'withSelectedAccounts').mockImplementation(async (rows, _providers, scope) => {
      expect(scope.profileFor?.('claude')).toBe('original');
      entered();
      await blocked;
      expect(scope.profileFor?.('claude')).toBe('original');
      return rows;
    });
    try {
      const response = post(task.id, { model: 'sonnet' });
      await started;
      if (changed === 'engine record') store.updateRun(task.id, { agentProfile: 'concurrent-login' });
      else profile.mockReturnValue('concurrent-login');
      release();
      expect((await response).status).toBe(409);
      expect(change).not.toHaveBeenCalled();
    } finally { release(); gate.mockRestore(); }
  });

  it('rejects unavailable providers and locked model overrides', async () => {
    const auth = connectedProviderAuth();
    vi.spyOn(auth, 'status').mockResolvedValue({ providers: [{ provider: 'codex', status: 'disconnected' }] });
    app = createApp({ repoRoot: root, store, manager: { changeQueuedEngine: change, queuedEngineProfile: profile } as unknown as RunManager, version: 'test', providerAuth: auth });
    expect((await post(run().id, { runner: 'codex' })).status).toBe(409);
    expect(change).not.toHaveBeenCalled();
    const saved = process.env.CEZ_AGENT_MODELS_LOCKED;
    process.env.CEZ_AGENT_MODELS_LOCKED = '1';
    try {
      expect((await post(run().id, { model: 'opus' })).status).toBe(409);
      expect(change).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.CEZ_AGENT_MODELS_LOCKED; else process.env.CEZ_AGENT_MODELS_LOCKED = saved;
    }
  });

  it('rejects a nonexistent account before scheduling', async () => {
    expect((await post(run().id, { runner: 'codex', agentProfile: 'missing-account' })).status).toBe(400);
    expect(change).not.toHaveBeenCalled();
  });
});
