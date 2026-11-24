import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagerMessage, ManagerSnapshot, ManagerSummary } from '@open-mercato/cezar-contract';
import type { AgentEvent, AgentRunner, AgentRunSpec, AgentSession } from '../core/agent-runner.ts';
import type { ManagerEngine } from '../managers/engine.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, WorkspaceEventBus } from './server.ts';

const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1' };

/** Spec 2026-10-31-managers § Followed tasks: through the real routes and a real run store. */
describe('a manager hears about its tasks', () => {
  let root: string;
  let home: string;
  let store: RunStore;
  let engine: ManagerEngine;
  let app: ReturnType<typeof createApp>;
  let prompts: string[];
  const saved = { CEZ_HOME: process.env.CEZ_HOME, CEZ_DRY_RUN: process.env.CEZ_DRY_RUN, CEZ_MANAGERS: process.env.CEZ_MANAGERS };

  /** Answers every manager turn with one line, so the follow-up is observable without a CLI. */
  const runner = {
    backend: 'claude',
    startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): AgentSession {
      prompts.push(spec.userPrompt);
      const result = new Promise((resolve) => queueMicrotask(() => {
        onEvent?.({ type: 'text', text: 'Read the result: low risk. Next I open the fix task.' });
        resolve({ text: '', toolCalls: [], tokensUsed: 0 });
      }));
      return { result, sendMessage: () => false, end: () => undefined, interrupt: () => undefined, open: true } as unknown as AgentSession;
    },
  } as unknown as AgentRunner;

  const request = (path: string, init?: { method?: string; body?: unknown }) => app.request(`/api/v1${path}`, {
    method: init?.method ?? 'GET',
    headers: JSON_HEADERS,
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const createManager = async () => {
    const response = await request('/workspace/managers', { method: 'POST', body: { instructions: 'Watch', projects: 'all', cronMinutes: 0 } });
    expect(response.status).toBe(201);
    const id = ((await response.json()) as ManagerSummary).id;
    const snapshot = (await (await request(`/workspace/managers/${id}/snapshot`)).json()) as ManagerSnapshot;
    return { id, projectId: snapshot.projects[0]!.projectId };
  };
  const chat = async (managerId: string) =>
    ((await (await request(`/workspace/managers/${managerId}/messages`)).json()) as { messages: ManagerMessage[] }).messages
      .filter((message): message is Extract<ManagerMessage, { kind: 'assistant' }> => message.kind === 'assistant');
  const settle = (runId: string, status: 'done' | 'failed', text?: string) => {
    store.updateRun(runId, { status: 'running' });
    if (text) store.appendEvent(runId, { type: 'text', stepId: 'task', text });
    store.updateRun(runId, { status, finishedAt: new Date().toISOString() });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-task-reports-'));
    home = mkdtempSync(join(tmpdir(), 'cez-task-reports-home-'));
    prompts = [];
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_MANAGERS;
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    app = createApp({
      repoRoot: root,
      version: 'test',
      store,
      // A started run, as `RunManager.startRun` records it; the test drives its status.
      manager: {
        startRun: (_workflow: unknown, input: { task: string }) => store.createRun({ title: 'Assess impact', workflow: 'quick-task', task: input.task, steps: [{ id: 'task', name: 'task', kind: 'agent' }] }),
        isActive: () => false,
      } as unknown as RunManager,
      workspaceEvents: new WorkspaceEventBus(),
      managerRunnerFor: () => runner,
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

  it('posts the card of a task it started within seconds, then its own follow-up, with no user message', async () => {
    const { id, projectId } = await createManager();
    const created = await request(`/workspace/managers/${id}/tasks`, { method: 'POST', body: { projectId, task: 'Assess the impact of PR 22153' } });
    expect(created.status).toBe(201);
    const { runId } = (await created.json()) as { runId: string };
    settle(runId, 'done', '## Impact\nLow risk.\nCEZ:DONE');
    // Settled replies only: the follow-up shows as a streaming placeholder first.
    await vi.waitFor(async () => expect((await chat(id)).filter((message) => !message.streaming)).toHaveLength(2), { timeout: 8_000 });
    const [card, followUp] = await chat(id);
    expect(card).toMatchObject({
      text: `[[task:${projectId}/${runId}]]\n\n**Finished.**\n\n## Impact\nLow risk.`,
      taskReport: { projectId, runId, state: 'done' },
    });
    expect(followUp).toMatchObject({ turn: 'chat', text: 'Read the result: low risk. Next I open the fix task.' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`[[task:${projectId}/${runId}]]`);
    expect(await chat(id).then((messages) => messages.some((message) => message.important))).toBe(false);
  });

  it('hears a task the user started only once it follows it, and marks a failure important', async () => {
    const { id, projectId } = await createManager();
    expect((await request(`/workspace/managers/${id}`, { method: 'PATCH', body: { followUp: false } })).status).toBe(200);
    const own = store.createRun({ title: 'User task', workflow: 'quick-task', task: 'x', steps: [{ id: 'task', name: 'task', kind: 'agent' }] });
    const followed = store.createRun({ title: 'Followed task', workflow: 'quick-task', task: 'y', steps: [{ id: 'task', name: 'task', kind: 'agent' }] });
    const follow = await request(`/workspace/managers/${id}/follows`, { method: 'POST', body: { projectId, runId: followed.id } });
    expect(await follow.json()).toEqual({ projectId, runId: followed.id, following: true });
    expect((await request(`/workspace/managers/${id}/follows`, { method: 'POST', body: { projectId, runId: 'missing' } })).status).toBe(404);
    settle(own.id, 'failed');
    settle(followed.id, 'failed');
    await vi.waitFor(async () => expect(await chat(id)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await chat(id)).toEqual([expect.objectContaining({ important: true, taskReport: { projectId, runId: followed.id, state: 'failed' } })]);
    expect(prompts).toEqual([]);
    const unfollow = await request(`/workspace/managers/${id}/follows`, { method: 'POST', body: { projectId, runId: followed.id, follow: false } });
    expect(await unfollow.json()).toMatchObject({ following: false });
  });
});
