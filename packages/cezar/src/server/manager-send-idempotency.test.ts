import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManagerMessage, ManagerSummary } from '@open-mercato/cezar-contract';
import type { AgentRunner, AgentSession } from '../core/agent-runner.ts';
import type { ManagerEngine } from '../managers/engine.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, WorkspaceEventBus } from './server.ts';

const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1' };

/** Relay incident 2026-11-15: a send the cockpit timed out after the server took it is resent. */
describe('POST /workspace/managers/:id/messages with an idempotencyKey', () => {
  let root: string;
  let home: string;
  let engine: ManagerEngine;
  let app: ReturnType<typeof createApp>;
  const saved = { CEZ_HOME: process.env.CEZ_HOME, CEZ_DRY_RUN: process.env.CEZ_DRY_RUN, CEZ_MANAGERS: process.env.CEZ_MANAGERS };

  /** A turn that never ends, so the chat holds exactly what the user sent. */
  const runner = {
    backend: 'claude',
    startSession: (): AgentSession =>
      ({ result: new Promise(() => undefined), sendMessage: () => true, end: () => undefined, interrupt: () => undefined, open: true }) as unknown as AgentSession,
  } as unknown as AgentRunner;

  const request = (path: string, init?: { method?: string; body?: unknown }) => app.request(`/api/v1${path}`, {
    method: init?.method ?? 'GET',
    headers: JSON_HEADERS,
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const createManager = async () => {
    const response = await request('/workspace/managers', { method: 'POST', body: { instructions: 'Watch', projects: 'all', cronMinutes: 0 } });
    expect(response.status).toBe(201);
    return ((await response.json()) as ManagerSummary).id;
  };
  const send = (id: string, body: Record<string, unknown>) => request(`/workspace/managers/${id}/messages`, { method: 'POST', body });
  const userTexts = async (id: string) =>
    ((await (await request(`/workspace/managers/${id}/messages`)).json()) as { messages: ManagerMessage[] }).messages
      .filter((message) => message.kind === 'user')
      .map((message) => (message as { text: string }).text);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-manager-send-'));
    home = mkdtempSync(join(tmpdir(), 'cez-manager-send-home-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_MANAGERS;
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    app = createApp({
      repoRoot: root,
      version: 'test',
      store: RunStore.open(join(root, '.ai/cezar')),
      manager: { isActive: () => false } as unknown as RunManager,
      workspaceEvents: new WorkspaceEventBus(),
      managerRunnerFor: () => runner,
      onManagerEngine: (built) => { engine = built; },
    });
  });

  afterEach(async () => {
    await engine.shutdown();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('answers a resend with the first result and never appends the message twice', async () => {
    const id = await createManager();
    const idempotencyKey = '0190f5d6-1c2b-7a3d-8e4f-5a6b7c8d9e30';
    const first = await send(id, { text: 'are you there?', idempotencyKey });
    const resent = await send(id, { text: 'are you there?', idempotencyKey });
    expect(first.status).toBe(200);
    expect(resent.status).toBe(200);
    expect(await resent.json()).toEqual(await first.json());
    expect(await userTexts(id)).toEqual(['are you there?']);
  });

  it('appends once when the resend races the first attempt', async () => {
    const id = await createManager();
    const idempotencyKey = '0190f5d6-1c2b-7a3d-8e4f-5a6b7c8d9e31';
    const answers = await Promise.all([send(id, { text: 'once', idempotencyKey }), send(id, { text: 'once', idempotencyKey })]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(await userTexts(id)).toEqual(['once']);
  });

  it('delivers a new key, and a send without one, as new messages', async () => {
    const id = await createManager();
    await send(id, { text: 'same', idempotencyKey: '0190f5d6-1c2b-7a3d-8e4f-5a6b7c8d9e32' });
    await send(id, { text: 'same', idempotencyKey: '0190f5d6-1c2b-7a3d-8e4f-5a6b7c8d9e33' });
    await send(id, { text: 'same' });
    expect(await userTexts(id)).toEqual(['same', 'same', 'same']);
  });

  it('forgets a refused key, so its retry is judged afresh', async () => {
    const idempotencyKey = '0190f5d6-1c2b-7a3d-8e4f-5a6b7c8d9e34';
    expect((await send('missing', { text: 'x', idempotencyKey })).status).toBe(404);
    const id = await createManager();
    expect((await send(id, { text: 'x', images: [{ uploadId: '0190f5d6-1c2b-7a3d-8e4f-5a6b7c8d9e99' }], idempotencyKey })).status).toBe(400);
    expect((await send(id, { text: 'x', idempotencyKey })).status).toBe(200);
    expect(await userTexts(id)).toEqual(['x']);
  });

  it('rejects a key that is not a uuid', async () => {
    const id = await createManager();
    expect((await send(id, { text: 'x', idempotencyKey: 'nope' })).status).toBe(400);
  });
});
