import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthResponseSchema } from '@open-mercato/cezar-contract';
import { ManagerStore } from '../managers/store.ts';
import { RunStore } from '../runs/store.ts';
import { runInRelayScope } from '../relay/scope.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import type { SocketHub, TopicPublisher } from './ws.ts';
import { apiRequest } from './loopback-request.testkit.ts';

vi.mock('../core/backend-detect.ts', () => ({ detectEnvironment: async () => [] }));

// Health's `attention` counts (switcher spec § Counts field): authenticated readers only.
describe('health attention counts', () => {
  const saved = { remote: process.env.CEZ_REMOTE, dry: process.env.CEZ_DRY_RUN };
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-health-attention-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const failed = (patch: Parameters<RunStore['updateRun']>[1] = {}) =>
      store.updateRun(store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] }).id, { status: 'failed', ...patch });
    failed();
    failed();
    failed({ archived: true });
    failed({ idleClosedAt: new Date().toISOString() });
    failed({ autoResumeAt: new Date().toISOString() });
    failed({ awaitingAnswerSince: new Date().toISOString() });
    store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_REMOTE', saved.remote], ['CEZ_DRY_RUN', saved.dry]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const build = (socketHub?: SocketHub) => createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...(socketHub ? { socketHub } : {}) });
  const read = async (app: ReturnType<typeof createApp>) => healthResponseSchema.strict().parse(await (await apiRequest(app, '/api/v1/health')).json());

  it('is absent in local mode, where health is CORS-open', async () => {
    expect((await read(build())).attention).toBeUndefined();
  });

  it('counts only the failed runs the cockpit still flags, in a relay scope', async () => {
    const app = build();
    const body = await runInRelayScope({ deviceId: 'phone' }, () => read(app));
    // `waiting` is the attention list: the run awaiting an answer is a task that needs you
    // (spec 2026-11-20-phone-notifications-inbox).
    expect(body.attention).toEqual({ waiting: 1, failed: 2 });
  });

  it('is present on a hosted cockpit', async () => {
    process.env.CEZ_REMOTE = '1';
    expect((await read(build())).attention).toEqual({ waiting: 1, failed: 2 });
  });

  // Spec 2026-11-20-phone-notifications-inbox, B2: what raises a push is what the badge counts.
  it('counts an unread important manager message until it is read', async () => {
    const app = build();
    const post = (path: string, body?: unknown) => apiRequest(app, path, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const created = await post('/api/v1/workspace/managers', { instructions: 'Watch', projects: 'all', cronMinutes: 0 });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const managers = new ManagerStore();
    const waiting = async () => (await runInRelayScope({ deviceId: 'phone' }, () => read(app))).attention?.waiting ?? 0;
    const before = await waiting();
    managers.persistMessage(id, { id: 'm1', seq: managers.nextSeq(id), at: new Date().toISOString(), kind: 'assistant', text: 'Blocked', turn: 'watch', streaming: false, important: true, headline: 'Blocked', commands: [] });
    expect(await waiting()).toBe(before + 1);
    expect((await post(`/api/v1/workspace/managers/${id}/read`)).status).toBe(200);
    expect(await waiting()).toBe(before);
  }, 30_000);

  it('never rides the shared health topic, even on a hosted cockpit', async () => {
    process.env.CEZ_REMOTE = '1';
    const topics = new Map<string, TopicPublisher>();
    build({ registerTopic: (name, publisher) => { topics.set(name, publisher); return () => {}; }, attach: () => undefined, close: () => undefined });
    const snapshot = await topics.get('health')!.snapshot!();
    expect(snapshot).not.toHaveProperty('attention');
  }, 30_000);
});
