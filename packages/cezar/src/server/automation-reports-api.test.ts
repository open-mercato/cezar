import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationDefinition, ManagerMessage, ManagerSummary } from '@open-mercato/cezar-contract';
import type { ManagerEngine } from '../managers/engine.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, WorkspaceEventBus } from './server.ts';

const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1' };

/** Spec 2026-10-31-managers § Automation reports: the link, its route, and the post a finished run makes. */
describe('automation reports to a manager', () => {
  let root: string;
  let home: string;
  let store: RunStore;
  let engine: ManagerEngine;
  let app: ReturnType<typeof createApp>;
  const saved = { CEZ_HOME: process.env.CEZ_HOME, CEZ_DRY_RUN: process.env.CEZ_DRY_RUN, CEZ_MANAGERS: process.env.CEZ_MANAGERS, CEZ_AUTOMATIONS: process.env.CEZ_AUTOMATIONS };

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
  const schedule = (report?: unknown) => ({
    name: 'Daily notes brief',
    kind: 'schedule',
    schedule: { type: 'daily', hour: 7, minute: 45 },
    task: { prompt: 'Write the brief for {{date}}', workflow: 'quick-task' },
    ...(report ? { report } : {}),
  });
  const createAutomation = async (report?: unknown) => {
    const response = await request('/automations', { method: 'POST', body: schedule(report) });
    expect(response.status).toBe(201);
    return ((await response.json()) as { automation: AutomationDefinition }).automation;
  };
  const read = async (id: string) => ((await (await request(`/automations/${id}`)).json()) as { automation: AutomationDefinition }).automation;
  const chat = async (managerId: string) =>
    ((await (await request(`/workspace/managers/${managerId}/messages`)).json()) as { messages: ManagerMessage[] }).messages;

  /** A run the scheduler launched for `automationId`, taken through to `status`. */
  const finishRun = (automationId: string, status: 'done' | 'failed', text?: string, error?: string) => {
    const run = store.createRun({ title: 'Daily notes brief', workflow: 'quick-task', task: 'brief', steps: [{ id: 'task', name: 'task', kind: 'agent' }] });
    store.updateRun(run.id, {
      status: 'running',
      automationTrigger: { automationId, automationRevision: 1, receiptId: 'r1', trigger: 'schedule', occurrenceAt: '2026-11-12T07:45:00.000Z' },
    });
    if (text) store.appendEvent(run.id, { type: 'text', stepId: 'task', text });
    store.updateRun(run.id, { status, finishedAt: new Date().toISOString(), ...(error ? { error } : {}) });
    return run.id;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-automation-reports-'));
    home = mkdtempSync(join(tmpdir(), 'cez-automation-reports-home-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_MANAGERS;
    delete process.env.CEZ_AUTOMATIONS;
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    app = createApp({
      repoRoot: root,
      version: 'test',
      store,
      manager: { startRun: vi.fn(), isActive: () => false } as unknown as RunManager,
      workspaceEvents: new WorkspaceEventBus(),
      onManagerEngine: (built) => { engine = built; },
    });
  });

  afterEach(async () => {
    await engine.shutdown();
    store.flush();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('stores the link on create, refuses an unknown manager, and leaves others unlinked', async () => {
    const managerId = await createManager();
    expect((await createAutomation({ managerId, mode: 'post-result' })).report).toEqual({ managerId, mode: 'post-result' });
    expect((await createAutomation()).report).toBeUndefined();
    const refused = await request('/automations', { method: 'POST', body: schedule({ managerId: 'nobody', mode: 'post-result' }) });
    expect(refused.status).toBe(400);
  });

  it('changes or drops the link without a revision bump, and an edit keeps it', async () => {
    const managerId = await createManager();
    const created = await createAutomation({ managerId, mode: 'post-result' });
    const put = await request(`/automations/${created.id}`, { method: 'PUT', body: { ...schedule(), expectedRevision: created.revision, enabled: false } });
    expect(put.status).toBe(200);
    const edited = await read(created.id);
    expect(edited.report).toEqual({ managerId, mode: 'post-result' });
    const mode = await request(`/automations/${created.id}/report`, { method: 'PUT', body: { report: { managerId, mode: 'notify-on-failure' } } });
    expect(mode.status).toBe(200);
    expect(((await mode.json()) as { automation: AutomationDefinition }).automation).toMatchObject({ revision: edited.revision, report: { mode: 'notify-on-failure' } });
    expect((await request(`/automations/${created.id}/report`, { method: 'PUT', body: { report: { managerId: 'nobody', mode: 'none' } } })).status).toBe(400);
    expect((await request('/automations/missing/report', { method: 'PUT', body: { report: null } })).status).toBe(404);
    expect((await request(`/automations/${created.id}/report`, { method: 'PUT', body: { report: null } })).status).toBe(200);
    expect(await read(created.id)).not.toHaveProperty('report');
    // Mirrored under the project scope like every automation route.
    expect((await app.request(`/api/v1/p/default/automations/${created.id}/report`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ report: null }) })).status).toBe(200);
  });

  it('posts a finished run\'s last message to the chat, once, with an unread dot and no turn', async () => {
    const managerId = await createManager();
    const automation = await createAutomation({ managerId, mode: 'post-result' });
    const runId = finishRun(automation.id, 'done', '## Brief\n- shipped the thing\nCEZ:DONE');
    await vi.waitFor(async () => expect((await chat(managerId)).some((message) => message.kind === 'assistant')).toBe(true));
    const posted = (await chat(managerId)).filter((message) => message.kind === 'assistant');
    const projectId = posted[0]?.kind === 'assistant' ? posted[0].automationReport?.projectId : undefined;
    expect(projectId).toBeTruthy();
    expect(projectId).not.toBe('default');
    expect(posted).toEqual([expect.objectContaining({
      turn: 'job',
      jobName: 'Daily notes brief',
      text: `## Brief\n- shipped the thing\n\n[[task:${projectId}/${runId}]]`,
      automationReport: { projectId, automationId: automation.id, runId, outcome: 'success' },
    })]);
    const summary = (await (await request(`/workspace/managers/${managerId}`)).json()) as ManagerSummary;
    expect(summary).toMatchObject({ unread: 1, important: 0, status: 'idle' });
    // review → done is the same success: still one post.
    store.updateRun(runId, { status: 'review' });
    store.updateRun(runId, { status: 'done' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await chat(managerId)).filter((message) => message.kind === 'assistant')).toHaveLength(1);
  });

  it('posts a failure as important, with the reason', async () => {
    const managerId = await createManager();
    const automation = await createAutomation({ managerId, mode: 'notify-on-failure' });
    finishRun(automation.id, 'done', 'all good');
    finishRun(automation.id, 'failed', undefined, 'You have hit your usage limit');
    await vi.waitFor(async () => expect((await chat(managerId)).some((message) => message.kind === 'assistant')).toBe(true));
    const posted = (await chat(managerId)).filter((message) => message.kind === 'assistant');
    expect(posted).toEqual([expect.objectContaining({ important: true, headline: 'Daily notes brief failed: You have hit your usage limit' })]);
    expect((await (await request(`/workspace/managers/${managerId}`)).json()) as ManagerSummary).toMatchObject({ important: 1 });
  });

  it('posts nothing for an unlinked automation, and drops the link of a deleted manager', async () => {
    const managerId = await createManager();
    const unlinked = await createAutomation();
    finishRun(unlinked.id, 'done', 'nobody asked');
    const linked = await createAutomation({ managerId, mode: 'post-result' });
    expect((await request(`/workspace/managers/${managerId}`, { method: 'DELETE' })).status).toBe(200);
    finishRun(linked.id, 'done', 'too late');
    await vi.waitFor(async () => expect(await read(linked.id)).not.toHaveProperty('report'));
    expect((await read(unlinked.id)).report).toBeUndefined();
  });
});
