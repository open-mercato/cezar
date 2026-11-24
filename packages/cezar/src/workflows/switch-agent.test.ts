import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, RunnerId } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const sessions = vi.hoisted(() => [] as Array<{
  backend: RunnerId;
  spec: AgentRunSpec;
  emit: (event: AgentEvent) => void;
  interrupt: () => void;
  settle: () => void;
}>);

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: RunnerId) => ({
    backend,
    startSession(spec: AgentRunSpec, emit: (event: AgentEvent) => void) {
      let open = true;
      let resolve!: (result: AgentRunResult) => void;
      const promise = new Promise<AgentRunResult>((done) => { resolve = done; });
      const settle = () => {
        open = false;
        resolve({ text: '', tokensUsed: 0, toolCalls: [] });
      };
      const interrupt = vi.fn();
      sessions.push({ backend, spec, emit, interrupt, settle });
      return { get open() { return open; }, result: promise, sendMessage: vi.fn(() => true), end: settle, interrupt, hardStop: settle };
    },
  }),
}));

const workflow: WorkflowDef = {
  name: 'custom', source: 'file',
  steps: [
    { id: 'work', name: 'Work', prompt: '{{task}}', runner: 'claude', model: 'opus' },
    { id: 'review', name: 'Review', prompt: 'Review {{task}}', runner: 'claude', model: 'sonnet' },
  ],
};

const selection = { runner: 'codex', model: 'gpt-6.2-sol', agentProfile: 'default', reasoningEffort: 'high', changedBy: 'Release Manager' } as const;
const wait = { timeout: 12_000, interval: 20 };

describe('switching a task agent', { timeout: 20_000 }, () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    sessions.length = 0;
    root = mkdtempSync(join(tmpdir(), 'cez-agent-switch-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'README'), 'start\n');
    execFileSync('git', ['add', 'README'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'initial'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    manager = new RunManager(store, root, { semaphore });
  });

  afterEach(async () => {
    for (const { id } of store.listRuns()) manager.cancel(id);
    for (const session of sessions) session.settle();
    await vi.waitFor(() => expect(store.listRuns().some(({ id }) => manager.isActive(id))).toBe(false), wait);
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.unstubAllEnvs();
  });

  it('changes a queued task before its first launch, preserving its prompt stack and queue position', async () => {
    const blocker = manager.startRun(workflow, { task: 'first', worktree: false });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    const target = manager.startRun(workflow, { task: 'second' });
    manager.startRun(workflow, { task: 'third' });
    expect(manager.enqueueMessage(target.id, [{ type: 'text', text: 'queued update' }])).toBeTruthy();
    expect(manager.switchAgent(target.id, selection)).toHaveProperty('summary');
    expect(store.getRun(target.id)).toMatchObject({ status: 'queued', runner: 'codex', model: 'gpt-6.2-sol', agentProfile: 'default' });
    expect(sessions).toHaveLength(1);
    manager.cancel(blocker.id);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(sessions[1]).toMatchObject({ backend: 'codex', spec: { model: 'gpt-6.2-sol', reasoningEffort: 'high' } });
    expect(sessions[1]!.spec.userPrompt).toContain('queued update');
    expect(store.getRun(target.id)).toMatchObject({ status: 'running' });
  });

  it.each(['running', 'waiting'] as const)('hands over a %s workflow, keeps its worktree, and runs the remaining steps', async (status) => {
    const { id } = manager.startRun(workflow, { task: 'implement it', runner: 'claude' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    const old = sessions[0]!;
    old.emit({ type: 'text', text: 'The first part is already implemented.' });
    if (status === 'waiting') {
      old.emit({ type: 'text', text: '\nCEZ:ASK {"questions":[{"header":"Choice","question":"Which one?","options":[{"label":"A"},{"label":"B"}]}]}' });
      old.emit({ type: 'turn-end' });
      await vi.waitFor(() => expect(store.getRun(id)?.status).toBe('waiting'), wait);
    }
    const { branch, worktreePath } = store.getRun(id)!;
    expect(branch).toBeTruthy();
    expect(worktreePath).toBeTruthy();
    writeFileSync(join(worktreePath!, 'in-progress'), 'saved work');
    const result = manager.switchAgent(id, selection);
    expect(result).toHaveProperty('summary', 'Switched from claude (opus, default) to codex (gpt-6.2-sol, default) by Release Manager');
    expect(old.interrupt).toHaveBeenCalledOnce();
    expect(sessions).toHaveLength(1);
    expect(store.getRun(id)?.status).toBe('queued');
    expect(manager.switchAgent(id, selection)).toEqual({ error: 'the task is already stopping' });
    old.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(sessions[1]).toMatchObject({ backend: 'codex', spec: { cwd: worktreePath, resume: false, model: 'gpt-6.2-sol' } });
    expect(sessions[1]!.spec.userPrompt).toContain('The first part is already implemented.');
    expect(sessions[1]!.spec.userPrompt).toContain('implement it');
    expect(sessions[1]!.spec.sessionId).not.toBe(old.spec.sessionId);
    expect(readFileSync(join(sessions[1]!.spec.cwd, 'in-progress'), 'utf8')).toBe('saved work');
    sessions[1]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    expect(sessions[2]).toMatchObject({ backend: 'codex', spec: { cwd: worktreePath, model: 'gpt-6.2-sol' } });
    sessions[2]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    expect(store.listRuns()).toHaveLength(1);
    expect(store.getRun(id)).toMatchObject({ id, branch, worktreePath, agentSwitch: result, steps: [{ id: 'work', status: 'done' }, { id: 'review', status: 'done' }] });
    expect(store.readEvents(id)).toContainEqual(expect.objectContaining({ type: 'lifecycle', message: 'Switched from claude (opus, default) to codex (gpt-6.2-sol, default) by Release Manager' }));
    expect(store.readEvents(id).some((event) => event.message === 'run cancelled')).toBe(false);
  });

  it('hands over a live Continue after releasing its session', async () => {
    const { id } = store.createRun({ title: 'Original', task: 'Review the build', workflow: 'old', runner: 'claude', worktree: false, steps: [
      { id: 'work', name: 'Work', kind: 'agent' },
    ] });
    store.updateStep(id, 'work', { status: 'done', backend: 'claude', sessionId: 'original' });
    store.updateRun(id, { status: 'done' });
    expect(manager.continueRun(id, { text: 'Check the test results' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
    expect(sessions[0]!.interrupt).toHaveBeenCalledOnce();
    expect(sessions).toHaveLength(1);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(sessions[1]).toMatchObject({ backend: 'codex', spec: { resume: false } });
    expect(sessions[1]!.spec.userPrompt).toContain('Check the test results');
    expect(store.getRun(id)?.steps.map((step) => [step.id, step.status])).toEqual([
      ['work', 'done'], ['continue-1', 'cancelled'], ['continue-2', 'running'],
    ]);
  });

  it.each(['done', 'review', 'failed'] as const)('continues a %s task with its transcript', async (status) => {
    const { id } = store.createRun({ title: 'Original', task: 'Review the build', workflow: 'old', runner: 'claude', worktree: false, steps: [
      { id: 'work', name: 'Work', kind: 'agent' },
    ] });
    store.updateStep(id, 'work', { status: status === 'failed' ? 'failed' : 'done', backend: 'claude', sessionId: 'original' });
    store.updateRun(id, { status, finishedAt: new Date().toISOString() });
    store.appendEvent(id, { type: 'user-message', stepId: 'work', text: 'Focus on the tests' });
    expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(sessions[0]).toMatchObject({ backend: 'codex', spec: { resume: false, model: 'gpt-6.2-sol' } });
    expect(sessions[0]!.spec.userPrompt).toContain('Focus on the tests');
    expect(store.listRuns()).toHaveLength(1);
    expect(store.getRun(id)?.steps.map((step) => step.id)).toEqual(['work', 'continue-1']);
  });

  it('retries a failed task with no prior session through its original workflow', async () => {
    const { id } = store.createRun({ title: 'Original', task: 'Review the build', workflow: 'custom',
      runner: 'claude', steps: [
        { id: 'work', name: 'Work', kind: 'agent' },
        { id: 'review', name: 'Review', kind: 'agent' },
      ],
    });
    store.updateRun(id, { status: 'failed', error: 'agent never started', workflowDef: workflow });
    expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    const run = store.getRun(id)!;
    expect(run.worktreePath).toBeTruthy();
    expect(sessions[0]).toMatchObject({ backend: 'codex', spec: { cwd: run.worktreePath, resume: false } });
  });
});
