import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { onRunFrames } from './run-frames.ts';
import { createApp } from './server.ts';

const PRIVATE_KEYS = ['chatId', 'userId', 'botId', 'grantId', 'grantGeneration', 'enableGeneration', 'sourceMessageId', 'updateId', 'epoch', 'episodeId', 'state', 'policyReason', 'updatedAt'];

function expectPublic(value: unknown): void {
  const source = (value as { telegramSource?: Record<string, unknown> }).telegramSource;
  expect(source).toMatchObject({ projectId: 'project', receiverId: 'receiver', createdAt: 1 });
  for (const key of PRIVATE_KEYS) expect(source).not.toHaveProperty(key);
}

// Every route that answers a run, and every SSE frame, carries the status projection only (spec 2026-10-29).
describe('run responses never expose Telegram delivery identifiers', () => {
  let repoRoot: string;
  let store: RunStore;
  let id: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-run-public-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    id = store.createRun({ title: 'telegram', workflow: 'w', task: 't', steps: [], telegramSource: {
      id: randomUUID(), botId: 'bot-123', epoch: randomUUID(), projectId: 'project', receiverId: 'receiver',
      grantId: randomUUID(), grantGeneration: randomUUID(), enableGeneration: randomUUID(), chatId: 'chat-456',
      userId: 'user-456', sourceMessageId: 7, updateId: 8, episodeId: 'episode', requestId: randomUUID(),
      state: 'finished', createdAt: 1, updatedAt: 2,
    } }).id;
    store.updateRun(id, { status: 'done' });
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const send = async (method: string, path: string, body?: unknown) => {
    const app = createApp({ repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
    expect(res.status).toBe(200);
    return res.json();
  };

  it.each([
    ['POST', 'pin', { pinned: true }],
    ['POST', 'read', undefined],
    ['POST', 'unread', undefined],
    ['PATCH', '', { title: 'renamed' }],
    ['POST', 'archive', {}],
  ])('%s /runs/:id/%s', async (method, action, body) => {
    expectPublic(await send(method, `/api/v1/runs/${id}${action ? `/${action}` : ''}`, body));
  });

  it('POST /runs/:id/promote', async () => {
    store.updateRun(id, { status: 'queued' });
    const app = createApp({ repoRoot, store, manager: { isActive: () => false, promote: () => true } as unknown as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, `/api/v1/runs/${id}/promote`, { method: 'POST' });
    expect(res.status).toBe(200);
    expectPublic(await res.json());
  });

  it('SSE record and workspace frames', () => {
    const frames: string[] = [];
    const off = onRunFrames(store, (_run, built) => { frames.push(built.record(), built.workspace('p'), built.workspace('p', false)); });
    store.updateRun(id, { title: 'again' });
    off();
    expect(frames).toHaveLength(3);
    for (const frame of frames) expectPublic(JSON.parse(frame));
  });
});
