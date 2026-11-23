import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { questionMutationResponseSchema, questionsResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { runInRelayScope } from '../relay/scope.ts';
import type { RunManager } from '../workflows/run.ts';
import { fakeProvider, managerItem, taskItem, type FakeProvider } from '../questions/fake-provider.testkit.ts';
import { createApp } from './server.ts';
import type { SocketHub, TopicPublisher } from './ws.ts';
import { apiRequest } from './loopback-request.testkit.ts';

vi.mock('../core/backend-detect.ts', () => ({ detectEnvironment: async () => [] }));

// Spec 2026-11-17-questions-inbox: the workspace-level Questions routes, topic and push-badge count.
describe('Questions inbox routes', () => {
  const saved = { dry: process.env.CEZ_DRY_RUN, managers: process.env.CEZ_MANAGERS };
  let repoRoot: string;
  let store: RunStore;
  let task: FakeProvider;
  let manager: FakeProvider;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_MANAGERS;
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-questions-routes-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    task = fakeProvider('r', [taskItem('p1', 'run1', 'req1'), taskItem('p1', 'run2', 'req2', { closed: { reason: 'ended', at: new Date().toISOString() } })]);
    manager = fakeProvider('m', [managerItem('a', 'm1', { about: [{ task: 'p1/run1', ask: 'req1' }] }), managerItem('a', 'm2')]);
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_DRY_RUN', saved.dry], ['CEZ_MANAGERS', saved.managers]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const build = (socketHub?: SocketHub) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', questionProviders: { task, manager }, ...(socketHub ? { socketHub } : {}) });
  const post = (app: ReturnType<typeof createApp>, path: string, body?: unknown) =>
    apiRequest(app, path, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const enc = encodeURIComponent;

  it('lists open and closed questions, the relayed pair once', async () => {
    const res = await apiRequest(build(), '/api/v1/workspace/questions');
    expect(res.status).toBe(200);
    const body = questionsResponseSchema.strict().parse(await res.json());
    expect(body.open.map((item) => item.key).sort()).toEqual(['m:a:m2', 'r:p1:run1:req1']);
    expect(body.open.find((item) => item.key === 'r:p1:run1:req1')!.linked?.key).toBe('m:a:m1');
    expect(body.closed.map((item) => item.key)).toEqual(['r:p1:run2:req2']);
    expect(body.counts).toEqual({ live: 2, older: 0 });
  });

  it('answers a question, and a linked manager key answers its task', async () => {
    const app = build();
    const res = await post(app, `/api/v1/workspace/questions/${enc('m:a:m1')}/answer`, { text: 'Yes' });
    expect(res.status).toBe(200);
    const body = questionMutationResponseSchema.parse(await res.json());
    expect(body.item).toMatchObject({ key: 'r:p1:run1:req1', closed: { reason: 'answered', answer: 'Yes' } });
    expect(task.calls.filter((call) => call.op === 'answer')).toHaveLength(1);
    expect(manager.items.get('m:a:m1')!.closed).toMatchObject({ answeredIn: 'task:p1/run1' });
  });

  it('dismisses, then 409s the closed question and 404s an unknown one', async () => {
    const app = build();
    const first = await post(app, `/api/v1/workspace/questions/${enc('m:a:m2')}/dismiss`);
    expect(first.status).toBe(200);
    expect(questionMutationResponseSchema.parse(await first.json()).item.closed?.reason).toBe('dismissed');
    const again = await post(app, `/api/v1/workspace/questions/${enc('m:a:m2')}/dismiss`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'question already closed' });
    const missing = await post(app, `/api/v1/workspace/questions/${enc('r:p1:nope:x')}/answer`, { text: 'a' });
    expect(missing.status).toBe(404);
  });

  it('validates the body', async () => {
    const app = build();
    for (const body of [{}, { text: '   ' }, { text: 'a', extra: 1 }]) {
      expect((await post(app, `/api/v1/workspace/questions/${enc('m:a:m2')}/answer`, body)).status).toBe(400);
    }
    expect(manager.calls).toEqual([]);
  });

  it('serves task questions alone with managers off', async () => {
    process.env.CEZ_MANAGERS = '0';
    const body = questionsResponseSchema.parse(await (await apiRequest(build(), '/api/v1/workspace/questions')).json());
    expect(body.open.map((item) => item.key)).toEqual(['r:p1:run1:req1']);
  });

  it('adds live questions to the push badge', async () => {
    const body = await runInRelayScope({ deviceId: 'phone' }, async () => (await apiRequest(build(), '/api/v1/health')).json());
    expect((body as { attention?: { waiting: number } }).attention?.waiting).toBe(2);
  }, 30_000);

  it('registers the counts-only questions topic, trusted-only like host', async () => {
    const topics = new Map<string, { publisher: TopicPublisher; loopbackReadable?: boolean }>();
    build({ registerTopic: (name, publisher, options) => { topics.set(name, { publisher, loopbackReadable: options?.loopbackReadable }); return () => {}; }, attach: () => undefined, close: () => undefined });
    const topic = topics.get('questions')!;
    expect(topic.loopbackReadable ?? false).toBe(false);
    expect(await topic.publisher.snapshot()).toEqual({ live: 2, older: 0, revision: expect.any(String) });
  }, 30_000);
});
