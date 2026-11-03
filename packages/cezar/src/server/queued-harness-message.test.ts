import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runEventSchema } from '@open-mercato/cezar-contract';
import { createLedger, readLedger, saveLedger } from '../harness/ledger.ts';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE } from '../harness/workflows.ts';
import { readRunHistoryPage } from '../runs/event-history.ts';
import { RunStore } from '../runs/store.ts';
import { freshContinuationContext } from '../workflows/continuation-context.ts';
import { RunManager } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp } from './server.ts';

describe('queued message wire intent', () => {
  let root: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const workflow = harnessWorkflowDefs().find((item) => item.name === HARNESS_FIX_ISSUE)!;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-queued-message-'));
    dataDir = join(root, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ multiModel: true }));
    store = RunStore.open(dataDir);
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  const appFor = (overrides: Partial<RunManager> = {}) => createApp({
    repoRoot: root,
    store,
    version: 'test',
    providerAuth: connectedProviderAuth(),
    manager: {
      isActive: () => false,
      sendMessage: () => false,
      enqueueMessage: () => null,
      deferMessage: () => false,
      ...overrides,
    } as unknown as RunManager,
  });
  const post = (app: Hono, path: string, body: unknown) => apiRequest(app, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const harnessRun = (status: 'queued' | 'running' | 'waiting' | 'failed', existingLedger: boolean) => {
    const run = store.createRun({ title: 't', task: 'Fix issue #642', workflow: workflow.name, steps: [] });
    store.updateRun(run.id, { status, workflowDef: workflow, harness: { profile: 'standard', workflow: workflow.name, issueId: '642' } });
    if (existingLedger) saveLedger(dataDir, run.id, createLedger({
      workflow: workflow.name, requestedProfile: 'standard', subject: { kind: 'issue', id: '642', text: run.task },
    }));
    return run;
  };

  describe.each([false, true])('existing ledger=%s', (existingLedger) => {
    it.each(['queued', 'running', 'waiting'] as const)('marks a phase-queued POST on a %s run', async (status) => {
      const run = harnessRun(status, existingLedger);
      const response = await post(appFor(), `/api/v1/runs/${run.id}/messages`, { text: 'Also check tests' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ queuedForPhase: true });
      const events = store.readEvents(run.id);
      expect(events.map((event) => event.type)).toEqual(['user-message', 'harness.message.queued']);
      expect(events[0]).toMatchObject({ type: 'user-message', text: 'Also check tests', queued: true });
      expect(runEventSchema.parse(events[0])).toEqual(events[0]);
      const page = await readRunHistoryPage(join(dataDir, 'runs', `${run.id}.ndjson`));
      expect(page.events.find((event) => event.type === 'user-message')?.queued).toBe(true);
    });
  });

  it('guard: Continue with text writes an unflagged adoptable reply through the real manager', async () => {
    const run = harnessRun('failed', true);
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    const app = createApp({ repoRoot: root, store, manager, version: 'test', providerAuth: connectedProviderAuth() });
    const response = await post(app, `/api/v1/runs/${run.id}/continue`, { text: 'Continue with tests' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ continued: true });
    const events = store.readEvents(run.id);
    expect(events[0]).toMatchObject({ type: 'user-message', text: 'Continue with tests' });
    expect(events[0]).not.toHaveProperty('queued');
    expect(events[1]?.type).toBe('harness.message.queued');
  });

  it('guard: a retried phase-queue POST still writes only one message', async () => {
    const run = harnessRun('running', true);
    const app = appFor();
    const body = { text: 'Also check tests', idempotencyKey: '0192f2a4-7c1e-7d4a-9b2f-3c4d5e6f7a8b' };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await post(app, `/api/v1/runs/${run.id}/messages`, body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ queuedForPhase: true });
    }
    expect(store.readEvents(run.id).map((event) => event.type)).toEqual(['user-message', 'harness.message.queued']);
    const read = readLedger(dataDir, run.id);
    expect(read.status === 'valid' ? read.ledger.pendingMessages : []).toHaveLength(1);
  });

  it('guard: extra message metadata does not change continuation context', () => {
    const run = harnessRun('running', true);
    const event = { seq: 1, ts: '2026-09-23T10:00:00.000Z', type: 'user-message', text: 'Also check tests', images: [] };
    const attachments = join(dataDir, 'attachments');
    expect(freshContinuationContext(run, [{ ...event, queued: true }], attachments)).toBe(
      freshContinuationContext(run, [event], attachments),
    );
    expect(freshContinuationContext(run, [event], attachments)).toContain('Also check tests');
  });

  it('guard: existing harness runs still queue feedback with multiModel disabled', async () => {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ multiModel: false }));
    const run = harnessRun('running', true);
    const response = await post(appFor(), `/api/v1/runs/${run.id}/messages`, { text: 'Also check tests' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queuedForPhase: true });
    const read = readLedger(dataDir, run.id);
    expect(read.status === 'valid' ? read.ledger.pendingMessages[0]?.text : undefined).toBe('Also check tests');
  });

  it.each(['delivered', 'queued', 'deferred', 'closed'] as const)('guard: ordinary multiModel-off %s delivery never emits a harness message', async (outcome) => {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ multiModel: false }));
    const run = store.createRun({ title: 't', task: 'ordinary', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status: outcome === 'queued' ? 'queued' : 'running' });
    const message = { id: 'stacked', text: 'Follow up', createdAt: '2026-09-23T10:00:00.000Z' };
    const app = appFor({
      sendMessage: () => outcome === 'delivered',
      enqueueMessage: () => outcome === 'queued' ? message : null,
      deferMessage: () => outcome === 'deferred',
    });
    const response = await post(app, `/api/v1/runs/${run.id}/messages`, { text: message.text });
    expect(response.status).toBe(outcome === 'closed' ? 409 : 200);
    expect(await response.json()).toEqual(outcome === 'closed' ? { error: 'session closed' }
      : outcome === 'queued' ? { queued: true, message } : { [outcome]: true });
    expect(store.readEvents(run.id)).toEqual([]);
    expect(readLedger(dataDir, run.id).status).toBe('missing');
  });
});
