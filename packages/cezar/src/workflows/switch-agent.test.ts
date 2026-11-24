import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bypassPolicy from '../bypass-permissions.ts';
import { AGENT_MODELS_LOCKED_ENV } from '../core/agent-model-policy.ts';
import type { AgentEvent, AgentRunResult, AgentRunSpec, RunnerId } from '../core/agent-runner.ts';
import { createWorktree } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { compileV1, graphIssues, graphToSteps } from './graph.ts';
import { READ_ONLY_TOOLS } from './landing.ts';
import { RunManager } from './run.ts';
import { DEFAULT_ALLOWED_TOOLS, type WorkflowDef } from './types.ts';

const sessions = vi.hoisted(() => [] as Array<{
  backend: RunnerId;
  spec: AgentRunSpec;
  emit: (event: AgentEvent) => void;
  interrupt: () => void;
  hardStop: () => void;
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
      const hardStop = vi.fn(settle);
      sessions.push({ backend, spec, emit, interrupt, hardStop, settle });
      return { get open() { return open; }, result: promise, sendMessage: vi.fn(() => true), end: settle, interrupt, hardStop };
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
const screenshot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('switching a task agent', { timeout: 20_000 }, () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let semaphore: WorkspaceSemaphore;

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    sessions.length = 0;
    root = mkdtempSync(join(tmpdir(), 'cez-agent-switch-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'README'), 'start\n');
    execFileSync('git', ['add', 'README'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'initial'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    manager = new RunManager(store, root, { semaphore });
  });

  afterEach(async () => {
    for (const { id } of store.listRuns()) manager.cancel(id);
    for (const session of sessions) session.settle();
    await vi.waitFor(() => expect(store.listRuns().some(({ id }) => manager.isActive(id))).toBe(false), wait);
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function finishedRun(withSession = true) {
    const { id } = store.createRun({ title: 'Original', task: 'Review the build', workflow: 'old', runner: 'claude', worktree: false, steps: [
      { id: 'work', name: 'Work', kind: 'agent' },
    ] });
    store.updateStep(id, 'work', { status: 'done', backend: 'claude', ...(withSession ? { sessionId: 'original' } : {}) });
    store.updateRun(id, { status: 'done' });
    return id;
  }

  async function expectFinished(id: string, steps: string[]) {
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    expect(store.getRun(id)?.status).toMatch(/^(done|review)$/);
    expect(store.getRun(id)?.steps.map((step) => [step.id, step.status])).toEqual(steps.map((step) => [step, 'done']));
  }

  async function addWorkAccount(runner: 'claude' | 'codex') {
    const configDir = join(root, `${runner}-work`);
    mkdirSync(configDir);
    await mergeWriteAgentAccounts((state) => {
      state.accounts.push({ id: 'work', provider: runner, configDir, label: 'Work', addedAt: '' });
    });
  }

  async function restart() {
    manager.dispose();
    store.flush();
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root, { semaphore });
    await manager.recover();
  }

  async function restartWithQueuedUsageLimitResume(id: string) {
    await vi.waitFor(() => expect(store.getRun(id)).toMatchObject({ status: 'failed', autoResumeReason: 'usage_limit' }), wait);
    const release = semaphore.register({ busySlots: () => 1, oldestQueuedAt: () => null, pump: () => undefined });
    try {
      const resumes = manager as unknown as {
        autoResumeTimers: Map<string, ReturnType<typeof setTimeout>>;
        fireAutoResume(runId: string): void;
      };
      clearTimeout(resumes.autoResumeTimers.get(id));
      resumes.fireAutoResume(id);
      expect(store.getRun(id)).toMatchObject({ status: 'queued', autoResumeAttempts: 1 });
      await restart();
    } finally {
      release();
    }
    await semaphore.release();
  }

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

  it.each(['claude', 'codex'] as const)('scopes a switch to %s to the replaced runner and unpinned steps', async (runner) => {
    await addWorkAccount(runner);
    const mixed = { ...workflow, steps: [
      { ...workflow.steps[0]!, reasoningEffort: 'high' },
      { ...workflow.steps[1]!, id: 'same-runner', reasoningEffort: 'low' },
      { id: 'unpinned', name: 'Unpinned', prompt: '{{task}}' },
      { id: 'review', name: 'Review', runner: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'medium' },
    ] } satisfies WorkflowDef;
    const { id } = manager.startRun(mixed, { task: 'Implement it', runner: 'claude', model: 'haiku', reasoningEffort: 'medium' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    const before = sessions[0]!;
    expect(manager.switchAgent(id, { runner, agentProfile: 'work', changedBy: selection.changedBy })).toHaveProperty('summary');
    before.settle();
    for (let count = 2; count <= 5; count++) {
      await vi.waitFor(() => expect(sessions).toHaveLength(count), wait);
      sessions[count - 1]!.settle();
    }
    await expectFinished(id, ['work', 'same-runner', 'unpinned', 'review']);
    const affected = sessions.slice(1, 4);
    expect(affected.map((s) => s.backend)).toEqual([runner, runner, runner]);
    expect(affected.map((s) => s.spec.model)).toEqual(runner === 'claude'
      ? ['opus', 'sonnet', 'haiku'] : [undefined, undefined, undefined]);
    expect(affected.map((s) => s.spec.reasoningEffort)).toEqual(runner === 'claude'
      ? ['high', 'low', 'medium'] : [undefined, undefined, undefined]);
    expect(sessions[4]).toMatchObject({ backend: 'codex', spec: { model: 'gpt-6.2-sol', reasoningEffort: 'medium' } });
    expect(store.getRun(id)?.steps.map((step) => step.profileId)).toEqual(['work', 'work', 'work', 'default']);
  });

  it.each(['codex', 'opencode'] as const)('keeps unpinned Claude steps when switching a pinned Codex step to %s', async (runner) => {
    await addWorkAccount('codex');
    const mixed = { ...workflow, steps: [
      { id: 'review', prompt: '{{task}}', runner: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'low' },
      { id: 'work', prompt: '{{task}}', model: 'opus', reasoningEffort: 'high' },
      { id: 'verify', prompt: '{{task}}' },
    ] } satisfies WorkflowDef;
    const { id } = manager.startRun(mixed, { task: 'Review and verify', runner: 'claude', model: 'sonnet', reasoningEffort: 'medium' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(sessions[0]?.backend).toBe('codex');
    expect(manager.switchAgent(id, {
      runner, agentProfile: runner === 'codex' ? 'work' : 'default', changedBy: selection.changedBy,
    })).toHaveProperty('summary');
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(sessions[1]).toMatchObject({ backend: runner, spec: {
      model: runner === 'codex' ? 'gpt-6.2-sol' : undefined, reasoningEffort: runner === 'codex' ? 'low' : undefined,
    } });
    sessions[1]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    expect(sessions[2]).toMatchObject({ backend: 'claude', spec: { model: 'opus', reasoningEffort: 'high' } });
    sessions[2]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(4), wait);
    expect(sessions[3]).toMatchObject({ backend: 'claude', spec: { model: 'sonnet', reasoningEffort: 'medium' } });
    sessions[3]!.settle();
    await expectFinished(id, ['review', 'work', 'verify']);
    expect(store.getRun(id)?.steps.map((step) => step.profileId)).toEqual([
      runner === 'codex' ? 'work' : 'default', 'default', 'default',
    ]);
  });

  it('targets the effective runner and retains explicitly selected model and effort on a second switch', async () => {
    await addWorkAccount('codex');
    const mixed = { ...workflow, steps: [
      workflow.steps[0]!, { id: 'review', prompt: '{{task}}' }, { id: 'other', prompt: '{{task}}', runner: 'pi' },
    ] } satisfies WorkflowDef;
    const { id } = manager.startRun(mixed, { task: 'Implement it', runner: 'claude' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(manager.switchAgent(id, { runner: 'codex', agentProfile: 'work', changedBy: selection.changedBy })).toHaveProperty('summary');
    sessions[1]!.settle();
    for (let i = 2; i <= 3; i++) {
      await vi.waitFor(() => expect(sessions).toHaveLength(i + 1), wait);
      expect(sessions[i]).toMatchObject({ backend: 'codex', spec: { model: selection.model, reasoningEffort: selection.reasoningEffort } });
      sessions[i]!.settle();
    }
    await vi.waitFor(() => expect(sessions).toHaveLength(5), wait);
    expect(sessions[4]?.backend).toBe('pi');
    sessions[4]!.settle();
    await expectFinished(id, ['work', 'review', 'other']);
    expect(store.getRun(id)?.steps.map((step) => step.profileId)).toEqual(['work', 'work', 'default']);
  });

  it('restores the selected runner, model and effort on older switched workflow records', async () => {
    const mixed = { ...workflow, steps: [workflow.steps[0]!, { id: 'review', prompt: '{{task}}', runner: 'pi' }] } satisfies WorkflowDef;
    const { id } = store.createRun({ title: 'Legacy switch', task: 'Keep working', workflow: mixed.name, worktree: false,
      steps: mixed.steps.map((step) => ({ id: step.id, name: step.id, kind: 'agent' as const })),
    });
    store.updateRun(id, {
      status: 'queued', workflowDef: mixed, runner: selection.runner, model: selection.model, agentProfile: selection.agentProfile,
      reasoningEffort: selection.reasoningEffort, agentSwitch: { summary: 'Old switch record', workflow: true },
    });
    await restart();
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(sessions).toHaveLength(i + 1), wait);
      expect(sessions[i]).toMatchObject({ backend: 'codex', spec: { model: selection.model, reasoningEffort: selection.reasoningEffort } });
      sessions[i]!.settle();
    }
    await expectFinished(id, ['work', 'review']);
  });

  it('resumes the recorded default account after a legacy switch with no task account', async () => {
    const { id } = store.createRun({
      title: 'Legacy switch', task: 'Keep working', workflow: workflow.name, worktree: false,
      steps: workflow.steps.map(({ id, name }) => ({ id, name: name ?? id, kind: 'agent' })),
    });
    store.updateRun(id, {
      status: 'queued', workflowDef: workflow, runner: 'codex', model: selection.model,
      agentSwitch: { summary: 'Old switch record', workflow: true },
      graphState: { loops: {}, taken: ['start.next->work'], cursor: 'work' },
    });
    store.updateStep(id, 'work', {
      status: 'failed', backend: 'codex', profileId: 'default', model: selection.model,
      sessionId: 'codex-before-restart', error: 'Usage limit reached, try again in 60 minutes',
    });
    await restart();
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(sessions[0]).toMatchObject({
      backend: 'codex', spec: { resume: true, sessionId: 'codex-before-restart', model: selection.model },
    });
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    sessions[1]!.settle();
    await expectFinished(id, ['work', 'review']);
  });

  it('applies gate instructions in the switched implementer’s session', async () => {
    await addWorkAccount('codex');
    const graph = compileV1(workflow.steps);
    graph.nodes.push({ id: 'approval', type: 'gate.human', message: 'Ready for review?' });
    graph.edges.find((edge) => edge.from === 'work.done')!.to = 'approval';
    graph.edges.push({ from: 'approval.approve', to: 'review' });
    const { id } = manager.startRun({ ...workflow, graph, steps: graphToSteps(graph) }, { task: 'Implement it' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(manager.switchAgent(id, { ...selection, agentProfile: 'work' })).toHaveProperty('summary');
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    const worker = sessions[1]!;
    worker.settle();
    await vi.waitFor(() => expect(store.getRun(id)).toMatchObject({ status: 'waiting', currentStepId: 'approval' }), wait);
    expect(manager.sendMessage(id, [{ type: 'text', text: 'Update the release note first.' }])).toBe(true);
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    const gate = sessions[2]!;
    expect(gate).toMatchObject({ backend: 'codex', spec: {
      resume: true, sessionId: worker.spec.sessionId, model: selection.model, reasoningEffort: selection.reasoningEffort,
    } });
    expect(gate.spec.userPrompt).toContain('Update the release note first.');
    expect(store.getRun(id)?.steps.find((step) => step.id === 'approval')?.profileId).toBe('work');
    gate.emit({ type: 'text', text: 'CEZ:VERDICT applied' });
    gate.emit({ type: 'turn-end' });
    gate.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(4), wait);
    sessions[3]!.settle();
    await expectFinished(id, ['work', 'approval', 'review']);
  });

  it('starts a fresh session when a continued workflow node would reuse another account’s session', async () => {
    await addWorkAccount('claude');
    const graph = compileV1([...workflow.steps, { id: 'follow-up', prompt: '{{task}}' }]);
    const followUp = graph.nodes.find((node) => node.id === 'follow-up');
    if (followUp?.type !== 'agent') throw new Error('missing follow-up agent in fixture');
    followUp.session = { continue: 'work' };
    const { id } = manager.startRun({ ...workflow, graph, steps: graphToSteps(graph) }, { task: 'Implement it' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(manager.switchAgent(id, { runner: 'claude', agentProfile: 'work', changedBy: selection.changedBy })).toHaveProperty('summary');
    sessions[1]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    sessions[2]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(4), wait);
    expect(sessions[3]!.spec.resume).toBe(false);
    expect(sessions[3]!.spec.sessionId).not.toBe(sessions[0]!.spec.sessionId);
    expect(store.readEvents(id)).toContainEqual(expect.objectContaining({
      stepId: 'follow-up', message: 'session.continue: starting fresh — "work" used a different account',
    }));
    sessions[3]!.settle();
    await expectFinished(id, ['work', 'review', 'follow-up']);
    expect(store.getRun(id)?.steps.map((step) => step.profileId)).toEqual(['default', 'work', 'work']);
  });

  it('resumes an unaffected runner’s earlier graph session on its default account', async () => {
    await addWorkAccount('claude');
    const graph = compileV1([
      { id: 'prepare', prompt: 'Read the original task', runner: 'codex' },
      workflow.steps[0]!,
      { id: 'review', prompt: 'Review {{task}}', runner: 'codex' },
    ]);
    const review = graph.nodes.find((node) => node.id === 'review');
    if (review?.type !== 'agent') throw new Error('missing review agent in fixture');
    review.session = { continue: 'prepare' };
    const { id } = manager.startRun({ ...workflow, graph, steps: graphToSteps(graph) }, { task: 'Implement it', runner: 'claude' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    const original = sessions[0]!;
    expect(original).toMatchObject({ backend: 'codex', spec: { resume: false } });
    original.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(manager.switchAgent(id, { runner: 'claude', agentProfile: 'work', changedBy: selection.changedBy })).toHaveProperty('summary');
    sessions[1]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    sessions[2]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(4), wait);
    expect(store.getRun(id)?.agentSwitch?.workflowSelection?.overrides.codex).toBeUndefined();
    expect(sessions[3]).toMatchObject({ backend: 'codex', spec: { resume: true, sessionId: original.spec.sessionId } });
    sessions[3]!.settle();
    await expectFinished(id, ['prepare', 'work', 'review']);
    expect(store.getRun(id)?.steps.map((step) => step.profileId)).toEqual(['default', 'work', 'default']);
  });

  it.each([false, true])('reopens the switched session after usage-limit recovery (check repair: %s)', async (repair) => {
    await addWorkAccount('codex');
    const definition = repair ? { ...workflow, steps: [
      workflow.steps[0]!, { id: 'verify', command: 'test -f ready' }, workflow.steps[1]!,
    ] } : workflow;
    const { id } = manager.startRun(definition, { task: 'Implement it' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    if (repair) {
      sessions[0]!.settle();
      await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
      expect(store.getRun(id)?.status).toBe('failed');
    }
    expect(manager.switchAgent(id, { ...selection, agentProfile: 'work' })).toHaveProperty('summary');
    const repairId = store.getRun(id)?.agentSwitch?.checkRepair?.stepId;
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    sessions[1]!.emit({ type: 'error', message: 'Usage limit reached, try again in 60 minutes' });
    sessions[1]!.settle();
    await restartWithQueuedUsageLimitResume(id);
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    expect(sessions[2]).toMatchObject({ backend: 'codex', spec: { resume: true, sessionId: sessions[1]!.spec.sessionId, model: selection.model } });
    if (repair) writeFileSync(join(sessions[2]!.spec.cwd, 'ready'), '');
    sessions[2]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(4), wait);
    expect(sessions[3]).toMatchObject({ backend: 'codex', spec: { resume: false } });
    sessions[3]!.settle();
    await expectFinished(id, repair ? ['work', 'verify', 'review', repairId!] : ['work', 'review']);
    expect(store.getRun(id)?.steps.find((step) => step.id === (repairId ?? 'work'))?.profileId).toBe('work');
    expect(store.getRun(id)?.steps.find((step) => step.id === 'review')?.profileId).toBe('work');
  });

  it('reopens the untouched pinned agent after recovering its queued usage-limit resume', async () => {
    await addWorkAccount('codex');
    const pinnedModel = 'gpt-5.1-codex';
    const definition = { ...workflow, steps: [
      workflow.steps[0]!,
      { ...workflow.steps[1]!, runner: 'codex', model: pinnedModel, reasoningEffort: 'medium' },
      { id: 'verify', command: 'test -f README' },
    ] } satisfies WorkflowDef;
    const { id } = manager.startRun(definition, { task: 'Implement it', runner: 'claude' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(manager.switchAgent(id, { ...selection, agentProfile: 'work' })).toHaveProperty('summary');
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    sessions[1]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    const pinned = sessions[2]!;
    expect(pinned).toMatchObject({ backend: 'codex', spec: { resume: false, model: pinnedModel, reasoningEffort: 'medium' } });
    expect(store.getRun(id)).toMatchObject({ agentProfile: 'work', model: selection.model });
    expect(store.getRun(id)?.steps.find((step) => step.id === 'review')?.profileId).toBe('default');
    pinned.emit({ type: 'error', message: 'Usage limit reached, try again in 60 minutes' });
    pinned.settle();
    await restartWithQueuedUsageLimitResume(id);
    await vi.waitFor(() => expect(sessions).toHaveLength(4), wait);
    expect(sessions[3]).toMatchObject({
      backend: 'codex', spec: { resume: true, sessionId: pinned.spec.sessionId, model: pinnedModel, reasoningEffort: 'medium' },
    });
    sessions[3]!.settle();
    await expectFinished(id, ['work', 'review', 'verify']);
    expect(store.getRun(id)?.steps.find((step) => step.id === 'review')?.profileId).toBe('default');
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

  it.each([false, true])('switches the account on Continue with the expected model and effort (locked: %s)', async (locked) => {
    vi.stubEnv(AGENT_MODELS_LOCKED_ENV, locked ? '1' : '0');
    await addWorkAccount('codex');
    const id = finishedRun();
    store.updateRun(id, { runner: 'codex', model: 'gpt-5.1-codex', reasoningEffort: 'low' });
    store.updateStep(id, 'work', {
      backend: 'codex', profileId: 'default', model: selection.model, reasoningEffort: selection.reasoningEffort,
    });
    const accountSwitch = { runner: 'codex', agentProfile: 'work', changedBy: selection.changedBy } as const;
    if (locked) {
      expect(manager.switchAgent(id, { ...accountSwitch, model: selection.model })).toHaveProperty('error', expect.stringContaining('models are locked'));
    }
    expect(manager.switchAgent(id, accountSwitch)).toHaveProperty('summary');
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(sessions[0]).toMatchObject({ backend: 'codex', spec: { resume: false } });
    expect(sessions[0]!.spec.model).toBe(locked ? undefined : selection.model);
    expect(sessions[0]!.spec.reasoningEffort).toBe(locked ? undefined : selection.reasoningEffort);
    expect(store.getRun(id)?.steps.at(-1)).toMatchObject({ id: 'continue-1', profileId: 'work' });
    sessions[0]!.settle();
    await expectFinished(id, ['work', 'continue-1']);
  });

  it.each(['starting', 'prepare', 'lease'] as const)('keeps a dequeued Continue through a switch while it awaits %s', async (phase) => {
    const id = finishedRun();
    const tree = join(root, 'existing-worktree');
    mkdirSync(tree);
    store.updateRun(id, { worktreePath: tree });
    const hold = deferred<void>();
    const entered = vi.fn();
    let prepareSignal: AbortSignal | undefined;
    const requiresGate = vi.spyOn(manager.lifecycle, 'requiresGate').mockResolvedValue(false);
    if (phase === 'starting') {
      requiresGate.mockImplementationOnce(async () => {
        entered();
        await hold.promise;
        return false;
      });
    } else if (phase === 'prepare') {
      requiresGate.mockResolvedValueOnce(true);
      vi.spyOn(manager.lifecycle, 'prepare').mockImplementationOnce(async (runId, baseBranch, _launch, signal) => {
        prepareSignal = signal;
        store.updateRun(runId, { worktreeLifecycle: { worktreeId: runId, generation: 1, phase: 'setup', state: 'running', needsAttention: false } });
        entered();
        await hold.promise;
        store.updateRun(runId, { worktreeLifecycle: undefined });
        return { ready: false, path: tree, branch: 'main', baseBranch };
      });
    } else {
      vi.spyOn(manager.lifecycle, 'acquireAgentLease').mockImplementationOnce(async () => {
        entered();
        await hold.promise;
        return () => undefined;
      });
    }
    const text = 'Use the attached screenshot';
    expect(manager.continueRun(id, { text, images: [screenshot] }, true)).toEqual({ ok: true });
    try {
      await semaphore.release();
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce(), wait);
      expect(store.readEvents(id).filter((event) => event.type === 'user-message')).toEqual([]);
      expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
      if (phase === 'prepare') expect(prepareSignal?.aborted).toBe(true);
      expect(store.getRun(id)?.agentSwitch?.continuationStepId).toBe('continue-1');
      expect(store.getRun(id)?.steps.at(-1)?.status).toBe('pending');
      expect(sessions).toHaveLength(0);
    } finally {
      hold.resolve();
    }
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(sessions[0]).toMatchObject({ backend: 'codex', spec: { resume: false, images: [screenshot] } });
    expect(sessions[0]!.spec.userPrompt).toContain(text);
    expect(sessions[0]!.spec.userPrompt).not.toContain('Continue this task on the newly selected agent');
    const messages = store.readEvents(id).filter((event) => event.type === 'user-message');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ stepId: 'continue-1', text: expect.stringContaining(text), imageCount: 1 });
    sessions[0]!.settle();
    await expectFinished(id, ['work', 'continue-1']);
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

  it.each([false, true])('recovers a pending switch after server restart (existing Continue: %s)', async (withContinue) => {
    const release = semaphore.register({ busySlots: () => 1, oldestQueuedAt: () => null, pump: () => undefined });
    const id = finishedRun(withContinue);
    const text = 'Preserve this requested follow-up';
    if (withContinue) {
      expect(manager.continueRun(id, { text, images: [screenshot] }, true)).toEqual({ ok: true });
    }
    expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
    expect(store.getRun(id)?.agentSwitch?.continuationStepId).toBe('continue-1');
    expect(store.getRun(id)?.status).toBe('queued');
    expect(sessions).toHaveLength(0);
    manager.dispose();
    store.flush();
    release();
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root, { semaphore });
    await manager.recover();
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(sessions[0]).toMatchObject({ backend: 'codex', spec: { resume: false, model: 'gpt-6.2-sol', reasoningEffort: 'high' } });
    expect(sessions[0]!.spec.userPrompt).toContain(withContinue ? text : 'Continue this task on the newly selected agent');
    if (withContinue) expect(sessions[0]!.spec.images).toEqual([screenshot]);
    expect(store.getRun(id)?.steps.map((step) => step.id)).toEqual(['work', 'continue-1']);
    sessions[0]!.settle();
    await expectFinished(id, ['work', 'continue-1']);
  });

  it('cancels the replacement while the interrupted agent still owns the run', async () => {
    const id = finishedRun();
    expect(manager.continueRun(id, { text: 'Check the results' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
    expect(sessions[0]!.interrupt).toHaveBeenCalledOnce();
    expect(manager.cancel(id)).toBe(true);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    expect(sessions).toHaveLength(1);
    expect(store.getRun(id)).toMatchObject({ status: 'cancelled', steps: [
      { id: 'work', status: 'done' }, { id: 'continue-1', status: 'cancelled' }, { id: 'continue-2', status: 'cancelled' },
    ] });
    expect(store.getRun(id)?.agentSwitch).toEqual({ summary: expect.stringContaining('Switched from claude') });
    expect(store.readEvents(id)).toContainEqual(expect.objectContaining({ message: 'run cancelled during agent switch' }));
  });

  it.each(['cancel', 'restart', 'cancel after restart'] as const)('handles %s after switching during a blocked worktree setup', async (outcome) => {
    const id = finishedRun();
    const tree = await createWorktree(root, id, 'main');
    store.updateRun(id, { worktreePath: tree.path, branch: tree.branch, baseBranch: tree.baseBranch });
    const operationId = randomUUID();
    const worktreeId = randomUUID();
    const hold = deferred<void>();
    let prepareSignal: AbortSignal | undefined;
    vi.spyOn(manager.lifecycle, 'requiresGate').mockResolvedValue(true);
    vi.spyOn(manager.lifecycle, 'prepare').mockImplementationOnce(async (_id, baseBranch, pendingLaunch, signal) => {
      prepareSignal = signal;
      const now = new Date().toISOString();
      await manager.lifecycle.store.writeWorktree({
        schemaVersion: 1, worktreeId, runId: id, projectRoot: root, worktreePath: tree.path, branch: tree.branch,
        generation: 1, autoCleanupSuppressed: false, activeOperationId: operationId, createdAt: now, updatedAt: now,
      });
      await manager.lifecycle.store.writeOperation({
        schemaVersion: 1, id: operationId, worktreeId, generation: 1, phase: 'setup', intent: 'create', state: 'running',
        revision: 1, createdAt: now, updatedAt: now, pendingLaunch, executions: [], successfulEntries: [], requests: [],
      });
      store.updateRun(id, { worktreeLifecycle: {
        worktreeId, generation: 1, activeOperationId: operationId, phase: 'setup', state: 'running', needsAttention: false,
      } });
      await hold.promise;
      return { ready: false, path: tree.path, branch: tree.branch, baseBranch, operationId };
    });
    const text = 'Use the attached reproduction once setup finishes';
    expect(manager.continueRun(id, { text, images: [screenshot] })).toEqual({ ok: true });
    try {
      await vi.waitFor(() => expect(manager.lifecycle.isBlocked(id)).toBe(true), wait);
      expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
      expect(prepareSignal?.aborted).toBe(true);
      expect(store.getRun(id)?.agentSwitch?.continuationStepId).toBe('continue-1');
      expect(sessions).toHaveLength(0);
      if (outcome === 'cancel') expect(manager.cancel(id)).toBe(true);
    } finally {
      hold.resolve();
    }
    if (outcome === 'cancel') {
      await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
      expect(store.getRun(id)).toMatchObject({ status: 'cancelled', steps: [{ status: 'done' }, { id: 'continue-1', status: 'cancelled' }] });
      expect(store.getRun(id)?.agentSwitch?.continuationStepId).toBeUndefined();
      expect(sessions).toHaveLength(0);
      return;
    }
    await restart();
    const operation = await manager.lifecycle.operation(operationId);
    expect(operation.state).toBe('interrupted');
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(sessions).toHaveLength(0);
    expect((await manager.lifecycle.store.readOperation(operationId))?.pendingLaunch).toMatchObject({ backend: 'claude', sessionId: 'original' });
    if (outcome === 'cancel after restart') {
      await manager.lifecycle.action(operationId, { action: 'cancel-task', expectedRevision: operation.revision, requestId: randomUUID() });
      expect(store.getRun(id)).toMatchObject({ status: 'cancelled', steps: [{ status: 'done' }, { id: 'continue-1', status: 'cancelled' }] });
      expect(store.getRun(id)?.agentSwitch?.continuationStepId).toBeUndefined();
      expect(sessions).toHaveLength(0);
      return;
    }
    await manager.lifecycle.action(operationId, { action: 'start-anyway', expectedRevision: operation.revision, requestId: randomUUID() });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(sessions[0]).toMatchObject({ backend: 'codex', spec: { resume: false, model: selection.model, images: [screenshot] } });
    expect(sessions[0]!.spec.userPrompt).toContain(text);
    expect(sessions[0]!.spec.sessionId).not.toBe('original');
    sessions[0]!.settle();
    await expectFinished(id, ['work', 'continue-1']);
  });

  it('does not requeue the replacement when a switch is cancelled during Continue startup', async () => {
    const id = finishedRun();
    store.updateRun(id, { worktreePath: root });
    const hold = deferred<boolean>();
    const requiresGate = vi.spyOn(manager.lifecycle, 'requiresGate').mockImplementationOnce(() => hold.promise);
    expect(manager.continueRun(id, { text: 'Check the results' }, true)).toEqual({ ok: true });
    try {
      await semaphore.release();
      await vi.waitFor(() => expect(requiresGate).toHaveBeenCalledOnce(), wait);
      expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
      expect(manager.cancel(id)).toBe(true);
    } finally {
      hold.resolve(false);
    }
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    expect(sessions).toHaveLength(0);
    expect(store.getRun(id)).toMatchObject({ status: 'cancelled', steps: [
      { id: 'work', status: 'done' }, { id: 'continue-1', status: 'cancelled' },
    ] });
    expect(store.readEvents(id).some((event) => event.type === 'user-message')).toBe(false);
    expect(store.getRun(id)?.agentSwitch?.continuationStepId).toBeUndefined();
  });

  it('hard-stops an agent that ignores the interrupt before starting its replacement', async () => {
    const id = finishedRun();
    expect(manager.continueRun(id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    const old = sessions[0]!;
    expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
    expect(old.interrupt).toHaveBeenCalledOnce();
    expect(old.hardStop).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(old.hardStop).toHaveBeenCalledOnce();
    expect(sessions[1]).toMatchObject({ backend: 'codex', spec: { resume: false } });
    sessions[1]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    expect(sessions).toHaveLength(2);
    expect(store.getRun(id)?.steps.map((step) => [step.id, step.status])).toEqual([
      ['work', 'done'], ['continue-1', 'cancelled'], ['continue-2', 'done'],
    ]);
  });

  it('resumes a cancelled workflow with existing sessions and runs its remaining checks', async () => {
    const withCheck = { ...workflow, steps: [...workflow.steps, { id: 'verify', name: 'Verify', command: 'test -f README' }] };
    const { id } = manager.startRun(withCheck, { task: 'Implement it' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(manager.cancel(id)).toBe(true);
    sessions[1]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    expect(store.getRun(id)).toMatchObject({ status: 'cancelled', graphState: { cursor: 'review' } });
    expect(store.getRun(id)?.steps.every((step) => step.kind !== 'agent' || !!step.sessionId)).toBe(true);
    expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    expect(sessions[2]).toMatchObject({ backend: 'codex', spec: { resume: false, model: 'gpt-6.2-sol' } });
    sessions[2]!.settle();
    await expectFinished(id, ['work', 'review', 'verify']);
    expect(store.getRun(id)?.steps.map((step) => step.iterations)).toEqual([1, 2, 1]);
  });

  it.each([false, true])('continues the newest conversation after cancelling a Continue (legacy cursor: %s)', async (legacyCursor) => {
    const { id } = manager.startRun(workflow, { task: 'Implement it' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    expect(manager.cancel(id)).toBe(true);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    const walk = store.getRun(id)?.graphState;
    expect(walk?.cursor).toBe('work');
    expect(manager.continueRun(id, { text: 'Focus on the new reproduction notes' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(store.getRun(id)?.graphState?.cursor).toBeUndefined();
    sessions[1]!.emit({ type: 'text', text: 'The new reproduction found a missing setting.' });
    expect(manager.cancel(id)).toBe(true);
    sessions[1]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    if (legacyCursor) store.updateRun(id, { graphState: walk });
    expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    expect(store.getRun(id)?.currentStepId).toBe('continue-2');
    expect(sessions[2]!.spec.userPrompt).toContain('Focus on the new reproduction notes');
    expect(sessions[2]!.spec.userPrompt).toContain('The new reproduction found a missing setting.');
    sessions[2]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    expect(store.getRun(id)?.steps.map((step) => [step.id, step.status])).toEqual([
      ['work', 'cancelled'], ['review', 'pending'], ['continue-1', 'cancelled'], ['continue-2', 'done'],
    ]);
  });

  it('retries a failed check and continues through a gate and the remaining workflow', async () => {
    const graph = compileV1([
      workflow.steps[0]!, { id: 'verify', name: 'Verify', command: 'test -f ready || { echo "missing ready flag"; exit 1; }' }, workflow.steps[1]!,
    ]);
    graph.nodes.push({ id: 'approval', type: 'gate.human', message: 'Ready for review?' });
    graph.edges.find((edge) => edge.from === 'verify.pass')!.to = 'approval';
    graph.edges.push({ from: 'approval.approve', to: 'review' });
    const check = graph.nodes.find((node) => node.id === 'verify');
    if (check?.type !== 'check') throw new Error('missing verification check in fixture');
    check.retryOn = [2];
    const withCheck = { ...workflow, graph, steps: graphToSteps(graph) };
    const { id } = manager.startRun(withCheck, { task: 'Implement it' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    const failed = store.getRun(id)!;
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringContaining('check "verify" exited 1') });
    expect(failed.graphState?.cursor).toBe('verify');
    const release = semaphore.register({ busySlots: () => 1, oldestQueuedAt: () => null, pump: () => undefined });
    try {
      expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
      expect(store.getRun(id)?.status).toBe('queued');
      await restart();
    } finally {
      release();
    }
    await semaphore.release();
    const repairId = store.getRun(id)?.agentSwitch?.checkRepair?.stepId;
    expect(repairId).toBeTruthy();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(sessions[1]).toMatchObject({ backend: 'codex', spec: { resume: false, model: selection.model } });
    expect(sessions[1]!.spec.userPrompt).toContain('fixing the failed check "Verify"');
    expect(sessions[1]!.spec.userPrompt).toContain('missing ready flag');
    expect(store.getRun(id)?.steps.find((step) => step.id === 'verify')?.iterations).toBe(1);
    writeFileSync(join(sessions[1]!.spec.cwd, 'ready'), '');
    sessions[1]!.settle();
    await vi.waitFor(() => expect(store.getRun(id)).toMatchObject({ status: 'waiting', graphState: { cursor: 'approval' } }), wait);
    expect(sessions).toHaveLength(2);
    expect(manager.sendMessage(id, [{ type: 'text', text: 'Approve' }])).toBe(true);
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    expect(sessions[2]).toMatchObject({ backend: 'codex', spec: { resume: false, model: 'gpt-6.2-sol' } });
    sessions[2]!.settle();
    await expectFinished(id, ['work', 'verify', 'approval', 'review', repairId!]);
    expect(store.getRun(id)?.steps.map((step) => step.iterations)).toEqual([1, 2, 1, 1, 1]);
    expect(store.getRun(id)?.agentSwitch?.checkRepair).toBeUndefined();
  });

  it.each(['saved', 'preceding definition', 'read-only'] as const)('keeps the %s tool policy on a failed-check repair spawn', async (policy) => {
    if (policy === 'saved') {
      const configDir = join(root, '.ai', 'cezar');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ bypassPermissions: true }));
      // Exercise the non-root bypass policy without affecting filesystem ownership checks.
      const blocked = bypassPolicy.bypassPermissionsBlocked;
      vi.spyOn(bypassPolicy, 'bypassPermissionsBlocked').mockImplementation((repoRoot, config, options) =>
        blocked(repoRoot, config, { ...options, uid: 501 }));
    }
    const workerTools = { allowedTools: ['Read', 'Bash'], bashAllowlist: ['npm test'] };
    const reviewTools = { allowedTools: ['Read', 'Grep', 'Bash'], bashAllowlist: ['git diff'] };
    const definition = { ...workflow, steps: [
      { ...workflow.steps[0]!, ...workerTools },
      { id: 'verify', command: 'test -f ready' },
      { ...workflow.steps[1]!, ...reviewTools },
    ] } satisfies WorkflowDef;
    const readOnly = policy === 'read-only';
    const { id } = manager.startRun(definition, {
      task: 'Implement it', ...(readOnly ? { worktree: false, readOnly: true, enforceReadOnly: true } : {}),
    });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    if (!readOnly) expect(sessions[0]!.spec).toMatchObject(workerTools);
    if (policy === 'saved') expect(sessions[0]!.spec.bypassPermissions).toBe(true);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    expect(store.getRun(id)?.status).toBe('failed');
    // Legacy steps may lack the snapshot. A persisted enforcement flag must still apply
    // when the surrounding run is writable.
    store.updateStep(id, 'work', { toolPolicy: policy === 'saved' ? { ...workerTools, enforceReadOnly: true } : undefined });
    if (!readOnly) store.updateStep(id, 'review', { toolPolicy: reviewTools });
    const walk = store.getRun(id)?.graphState;
    if (policy === 'preceding definition' && walk) {
      store.updateRun(id, { graphState: { ...walk, cursor: 'verify', taken: [] } });
    }
    expect(manager.switchAgent(id, { runner: 'claude', agentProfile: 'default', changedBy: selection.changedBy })).toHaveProperty('summary');
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(sessions[1]!.spec.userPrompt).toContain('fixing the failed check "verify"');
    const expected = readOnly ? { allowedTools: READ_ONLY_TOOLS, enforceReadOnly: true }
      : policy === 'saved' ? { ...workerTools, enforceReadOnly: true } : workerTools;
    expect(sessions[1]!.spec).toMatchObject(expected);
    if (readOnly) expect(sessions[1]!.spec.bashAllowlist).toBeUndefined();
    if ('enforceReadOnly' in expected && expected.enforceReadOnly) {
      expect(sessions[1]!.spec.env?.GH_TOKEN).toBe('');
      expect(sessions[1]!.spec.mcpServers).toEqual([]);
      expect(sessions[1]!.spec.bypassPermissions).toBeUndefined();
    }
    expect(store.getRun(id)?.steps.at(-1)?.toolPolicy).toEqual(expected);
  });

  it('uses the agent on a direct check fail edge as the repair policy source', async () => {
    const edgeTools = { allowedTools: ['Read', 'Edit', 'Bash'], bashAllowlist: ['npm test'] };
    const graph = compileV1([
      workflow.steps[0]!, { id: 'verify', command: 'test -f ready || exit 2' }, workflow.steps[1]!,
    ]);
    const check = graph.nodes.find((node) => node.id === 'verify');
    if (check?.type !== 'check') throw new Error('missing check in fixture');
    // Exit 2 stops the walk before it takes the fail edge. A switch still uses that edge's agent.
    check.retryOn = [7];
    graph.nodes.push({ id: 'remediate', type: 'agent', prompt: 'Fix the check', ...edgeTools });
    graph.edges.push({ from: 'verify.fail', to: 'remediate' }, { from: 'remediate.done', to: 'end' });
    expect(graphIssues(graph)).toEqual([]);
    const { id } = manager.startRun({ ...workflow, graph, steps: graphToSteps(graph) }, { task: 'Implement it' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    expect(store.getRun(id)).toMatchObject({ status: 'failed', graphState: { cursor: 'verify' } });
    expect(manager.switchAgent(id, { runner: 'claude', agentProfile: 'default', changedBy: selection.changedBy })).toHaveProperty('summary');
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(sessions[1]!.spec).toMatchObject(edgeTools);
    writeFileSync(join(sessions[1]!.spec.cwd, 'ready'), '');
    sessions[1]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    sessions[2]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    expect(store.getRun(id)?.status).toMatch(/^(done|review)$/);
    expect(store.getRun(id)?.steps.find((step) => step.id === 'verify')?.iterations).toBe(2);
  });

  it.each([true, false])('repairs with the implement retry target’s tools after review ran (saved policy: %s)', async (saved) => {
    const implementTools = { allowedTools: [...DEFAULT_ALLOWED_TOOLS], bashAllowlist: ['npm test', 'git diff'] };
    const reviewTools = { allowedTools: ['Read', 'Grep'] };
    const definition = { ...workflow, steps: [
      { ...workflow.steps[0]!, id: 'implement', ...implementTools },
      { ...workflow.steps[1]!, ...reviewTools },
      { id: 'verify', command: 'test -f ready', onFail: { retry: 'implement', max: 1 } },
    ] } satisfies WorkflowDef;
    const { id } = manager.startRun(definition, { task: 'Implement it' });
    for (const [index, tools] of [implementTools, reviewTools, implementTools, reviewTools].entries()) {
      await vi.waitFor(() => expect(sessions).toHaveLength(index + 1), wait);
      expect(sessions[index]!.spec).toMatchObject(tools);
      sessions[index]!.settle();
    }
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    expect(store.getRun(id)?.status).toBe('failed');
    expect(store.getRun(id)?.steps.find((step) => step.id === 'review')?.toolPolicy).toEqual(reviewTools);
    expect(store.getRun(id)?.steps.find((step) => step.id === 'review')?.iterations).toBe(2);
    // A saved effective policy can be narrower than the current definition.
    const savedImplementTools = { ...implementTools, bashAllowlist: ['npm test'] };
    store.updateStep(id, 'implement', { toolPolicy: saved ? savedImplementTools : undefined });
    expect(manager.switchAgent(id, { runner: 'claude', agentProfile: 'default', changedBy: selection.changedBy })).toHaveProperty('summary');
    const repairId = store.getRun(id)?.agentSwitch?.checkRepair?.stepId;
    await vi.waitFor(() => expect(sessions).toHaveLength(5), wait);
    expect(sessions[4]!.spec).toMatchObject(saved ? savedImplementTools : implementTools);
    writeFileSync(join(sessions[4]!.spec.cwd, 'ready'), '');
    sessions[4]!.settle();
    await expectFinished(id, ['implement', 'review', 'verify', repairId!]);
  });

  it('preserves a failed repair checkpoint and retries that same repair on a later switch', async () => {
    const definition = { ...workflow, steps: [
      workflow.steps[0]!, { id: 'verify', command: 'test -f ready' }, workflow.steps[1]!,
    ] } satisfies WorkflowDef;
    const { id } = manager.startRun(definition, { task: 'Implement it' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), wait);
    sessions[0]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    const checkError = store.getRun(id)?.steps.find((step) => step.id === 'verify')?.error;
    expect(checkError).toBeTruthy();
    expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
    const repair = store.getRun(id)?.agentSwitch?.checkRepair;
    expect(repair).toMatchObject({ checkId: 'verify', stepId: expect.any(String) });
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    const failure = 'Repair could not update the worktree';
    sessions[1]!.emit({ type: 'error', message: failure });
    sessions[1]!.settle();
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    const failed = store.getRun(id)!;
    expect(failed).toMatchObject({
      status: 'failed', error: `repair for check "verify" failed: ${failure}`,
      graphState: { cursor: 'verify' }, agentSwitch: { checkRepair: repair },
    });
    expect(failed.steps.find((step) => step.id === 'verify')).toMatchObject({ status: 'pending', iterations: 1, error: checkError });
    expect(failed.steps.find((step) => step.id === repair!.stepId)).toMatchObject({ status: 'failed', iterations: 1, error: failure });
    expect(manager.switchAgent(id, { runner: 'claude', agentProfile: 'default', changedBy: selection.changedBy })).toHaveProperty('summary');
    expect(store.getRun(id)?.agentSwitch?.checkRepair).toEqual(repair);
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    expect(sessions[2]).toMatchObject({ backend: 'claude', spec: { resume: false } });
    expect(store.getRun(id)?.currentStepId).toBe(repair!.stepId);
    writeFileSync(join(sessions[2]!.spec.cwd, 'ready'), '');
    sessions[2]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(4), wait);
    sessions[3]!.settle();
    await expectFinished(id, ['work', 'verify', 'review', repair!.stepId]);
    expect(store.getRun(id)?.agentSwitch?.checkRepair).toBeUndefined();
    expect(store.getRun(id)?.steps.find((step) => step.id === 'verify')?.iterations).toBe(2);
    expect(store.getRun(id)?.steps.find((step) => step.id === repair!.stepId)?.iterations).toBe(2);
  });

  it.each(['step list', 'saved graph'] as const)('gives the repaired check a fresh onFail retry budget (%s)', async (format) => {
    const workerTools = { allowedTools: ['Read', 'Bash'], bashAllowlist: ['npm test'] };
    const base = { ...workflow, steps: [
      { ...workflow.steps[0]!, ...workerTools },
      { id: 'verify', command: 'test -f ready || exit 7', onFail: { retry: 'work', max: 1, retryOn: [7] } },
      { ...workflow.steps[1]!, allowedTools: ['Read'], bashAllowlist: [] },
    ] } satisfies WorkflowDef;
    const savedGraph = format === 'saved graph';
    const graph = compileV1(base.steps);
    const withRetries = savedGraph ? { ...base, graph, steps: graphToSteps(graph) } : base;
    const { id } = manager.startRun(withRetries, { task: 'Implement it' });
    for (let count = 1; count <= 2; count++) {
      await vi.waitFor(() => expect(sessions).toHaveLength(count), wait);
      sessions[count - 1]!.settle();
    }
    await vi.waitFor(() => expect(store.getRun(id)).toMatchObject({ status: 'failed' }), wait);
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false), wait);
    if (savedGraph) {
      // Recover a graph whose retry loop was exhausted, with legacy steps that have no tool snapshot.
      store.updateStep(id, 'work', { toolPolicy: undefined });
      await restart();
      expect(store.getRun(id)?.workflowDef?.graph).toBeDefined();
    }
    const retriesUsed = () => savedGraph
      ? store.getRun(id)?.graphState?.loops['verify-retry']
      : store.getRun(id)?.steps.find((step) => step.id === 'verify')?.retriesUsed;
    // The saved graph counts the exhausting visit too. The v1 step counts actual retries.
    expect(retriesUsed()).toBe(savedGraph ? 2 : 1);
    expect(store.getRun(id)?.steps.find((step) => step.id === 'verify')?.iterations).toBe(2);
    expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
    const repairId = store.getRun(id)?.agentSwitch?.checkRepair?.stepId;
    expect(repairId).toBeTruthy();
    await vi.waitFor(() => expect(sessions).toHaveLength(3), wait);
    expect(retriesUsed()).toBe(0);
    expect(sessions[2]!.spec.userPrompt).toContain('fixing the failed check "verify"');
    expect(sessions[2]!.spec).toMatchObject(workerTools);
    sessions[2]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(4), wait);
    expect(store.getRun(id)?.currentStepId).toBe('work');
    expect(retriesUsed()).toBe(1);
    writeFileSync(join(sessions[3]!.spec.cwd, 'ready'), '');
    sessions[3]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(5), wait);
    sessions[4]!.settle();
    await expectFinished(id, ['work', 'verify', 'review', repairId!]);
    expect(retriesUsed()).toBe(1);
    expect(store.getRun(id)?.steps.find((step) => step.id === 'verify')?.iterations).toBe(4);
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
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(sessions[1]).toMatchObject({ backend: 'codex', spec: { model: 'gpt-6.2-sol' } });
    sessions[1]!.settle();
    await expectFinished(id, ['work', 'review']);
  });

  it('retries the failed agent node when model validation stopped a graph before launch', async () => {
    const graph = compileV1(workflow.steps);
    const { id } = store.createRun({ title: 'Original', task: 'Review the build', workflow: 'custom',
      runner: 'claude', steps: [
        { id: 'work', name: 'Work', kind: 'agent' },
        { id: 'review', name: 'Review', kind: 'agent' },
      ],
    });
    // The engine pins a session id before model validation and records the tool policy later.
    store.updateStep(id, 'work', { status: 'failed', iterations: 1, backend: 'claude', sessionId: 'never-opened' });
    store.updateRun(id, {
      status: 'failed', error: 'unsupported model', workflowDef: { ...workflow, graph },
      graphState: { taken: ['work.failed->'], loops: {} },
    });
    expect(manager.switchAgent(id, selection)).toHaveProperty('summary');
    await vi.waitFor(() => expect(sessions.length > 0 || store.getRun(id)?.status === 'failed').toBe(true), wait);
    expect(store.getRun(id)?.steps.map((step) => step.id)).toEqual(['work', 'review']);
    expect(sessions[0]).toMatchObject({ backend: 'codex', spec: { resume: false, model: 'gpt-6.2-sol' } });
    sessions[0]!.settle();
    await vi.waitFor(() => expect(sessions).toHaveLength(2), wait);
    expect(sessions[1]).toMatchObject({ backend: 'codex' });
    sessions[1]!.settle();
    await expectFinished(id, ['work', 'review']);
  });
});
