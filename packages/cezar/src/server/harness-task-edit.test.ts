import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE } from '../harness/workflows.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp } from './server.ts';

const workflow = harnessWorkflowDefs().find((item) => item.name === HARNESS_FIX_ISSUE)!;

describe('queued harness task edits', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let app: Hono;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-harness-task-edit-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ multiModel: true, skillsRepos: [] }));
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    app = createApp({ repoRoot: root, store, manager, version: 'test', providerAuth: connectedProviderAuth() });
  });
  afterEach(() => {
    for (const run of store.listRuns()) manager.cancel(run.id);
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });
  const patch = (id: string, task: string) => apiRequest(app, `/api/v1/runs/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task, title: 'edited' }),
  });

  it('returns the creation-time 400 for a queued edit with no concrete issue binding', async () => {
    const run = manager.startRun(workflow, { task: 'Fix issue #1' });
    store.updateRun(run.id, { harness: { workflow: workflow.name, profile: 'standard' } });
    const response = await patch(run.id, 'Fix the crash');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'harness fix workflow requires a concrete issue id' });
    expect(store.getRun(run.id)?.task).toBe('Fix issue #1');
    expect(store.getRun(run.id)?.title).toBe(run.title);
  });

  it('preserves an API issue binding and lets a new text reference replace it', async () => {
    const run = manager.startRun(workflow, { task: 'Fix the crash', harness: { issueId: '642' } });
    expect((await patch(run.id, 'Fix the startup crash')).status).toBe(200);
    expect(store.getRun(run.id)?.harness?.issueId).toBe('642');
    expect((await patch(run.id, 'Fix issue #999')).status).toBe(200);
    expect(store.getRun(run.id)?.harness?.issueId).toBe('999');
  });

  it.each(['issue #600', 'https://github.com/open-mercato/cezar/issues/600'])
  ('keeps an API issue binding when PATCH retains a reference to %s', async (reference) => {
    const run = manager.startRun(workflow, { task: `Same root cause as ${reference} — fix it`, harness: { issueId: '642' } });
    expect(run.harness?.issueId).toBe('642');
    expect((await patch(run.id, `Same root cause as ${reference} — fix it please`)).status).toBe(200);
    expect(store.getRun(run.id)?.harness?.issueId).toBe('642');
    const internal = manager as unknown as {
      pendingJobs: Map<string, { input: Parameters<RunManager['startRun']>[1] }>;
      hydrateQueuedInput: (id: string, input: Parameters<RunManager['startRun']>[1]) => Parameters<RunManager['startRun']>[1];
    };
    expect(internal.hydrateQueuedInput(run.id, internal.pendingJobs.get(run.id)!.input).harness?.issueId).toBe('642');
  });

  it('guard: a retained bare reference preserves the API issue binding', async () => {
    const run = manager.startRun(workflow, { task: 'Same root cause as #600 — fix it', harness: { issueId: '642' } });
    expect((await patch(run.id, 'Same root cause as #600 — fix it please')).status).toBe(200);
    expect(store.getRun(run.id)?.harness?.issueId).toBe('642');
  });

  it('keeps an API binding when an edit promotes a reference already in the old brief', async () => {
    const run = manager.startRun(workflow, { task: 'Related to issue #600 and issue #700', harness: { issueId: '642' } });
    expect((await patch(run.id, 'Related to issue #700')).status).toBe(200);
    expect(store.getRun(run.id)?.harness?.issueId).toBe('642');
  });

  it('guard: PATCH can retarget a binding inferred from the old text', async () => {
    const run = manager.startRun(workflow, { task: 'Fix issue #642' });
    expect((await patch(run.id, 'Fix issue #600')).status).toBe(200);
    expect(store.getRun(run.id)?.harness?.issueId).toBe('600');
  });

  it('guard: PATCH can restore a missing binding from a retained concrete issue reference', async () => {
    const run = manager.startRun(workflow, { task: 'Fix issue #642' });
    store.updateRun(run.id, { harness: { workflow: workflow.name, profile: 'standard' } });
    expect((await patch(run.id, 'Fix issue #642 please')).status).toBe(200);
    expect(store.getRun(run.id)?.harness?.issueId).toBe('642');
  });

  it('guard: a newly introduced reference can retarget an explicit API binding', async () => {
    const run = manager.startRun(workflow, { task: 'Related to issue #600', harness: { issueId: '642' } });
    expect((await patch(run.id, 'Fix issue #999, related to issue #600')).status).toBe(200);
    expect(store.getRun(run.id)?.harness?.issueId).toBe('999');
  });

  it('guard: a task already dequeued still returns 409 and leaves its title unchanged', async () => {
    const run = manager.startRun(workflow, { task: 'Fix issue #1' });
    (manager as unknown as { pendingJobs: Map<string, unknown> }).pendingJobs.delete(run.id);
    const response = await patch(run.id, 'Fix the crash');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'run already started' });
    expect(store.getRun(run.id)?.title).toBe(run.title);
  });

  it('guard: ordinary queued edits work with multiModel off', async () => {
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ multiModel: false }));
    const run = manager.startRun({ name: 'ordinary', source: 'file', steps: [{ id: 'work', prompt: '{{task}}' }] }, { task: 'old' });
    expect((await patch(run.id, 'new brief')).status).toBe(200);
    expect(store.getRun(run.id)).toMatchObject({ task: 'new brief', title: 'edited' });
  });
});
