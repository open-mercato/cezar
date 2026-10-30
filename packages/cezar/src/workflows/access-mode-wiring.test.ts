import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { workflowDefSchema, type WorkflowDef } from './types.ts';
import { compileV1, nodeToStep } from './graph.ts';

const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: string) => ({
    backend,
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.specs.push(spec);
      return {
        result: new Promise<AgentRunResult>((resolve) => setTimeout(() => {
          onEvent?.({ type: 'session', sessionId: `session-${captured.specs.length}` });
          resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
        }, 0)),
        sendMessage: () => false, end: () => {}, interrupt: () => {}, open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

describe('access mode across task lifecycle construction sites', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  const workflow: WorkflowDef = { name: 'access', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}' }] };
  beforeEach(() => {
    captured.specs.length = 0;
    root = mkdtempSync(join(tmpdir(), 'cez-access-wiring-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, timeout: 15_000 });
    writeFileSync(join(root, 'a.txt'), 'base');
    execFileSync('git', ['add', '-A'], { cwd: root, timeout: 15_000 });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root, timeout: 15_000 });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
  });
  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function settled(id: string, count: number) {
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBe(count);
    await expect.poll(() => manager.isActive(id), { timeout: 15_000 }).toBe(false);
  }

  it.each(['standard', 'daybreak-blue'] as const)('persists %s across create and untouched Continue', async (accessMode) => {
    const run = manager.startRun(workflow, { task: 'work', worktree: false, runner: 'codex', model: 'gpt-eligible-a', accessMode });
    await settled(run.id, 1);
    expect(captured.specs[0]?.accessMode).toBe(accessMode);
    expect(store.getRun(run.id)?.accessMode).toBe(accessMode);
    expect(manager.continueRun(run.id)).toEqual({ ok: true });
    await settled(run.id, 2);
    expect(captured.specs[1]).toMatchObject({ accessMode, resume: true });
    expect(store.getRun(run.id)?.steps.at(-1)?.accessMode).toBe(accessMode);
  });

  it('native omission remains absent and explicit native clears a saved selection', async () => {
    const run = manager.startRun(workflow, { task: 'work', worktree: false, runner: 'codex', accessMode: 'daybreak-blue' });
    await settled(run.id, 1);
    expect(manager.continueRun(run.id, { accessMode: null })).toEqual({ ok: true });
    await settled(run.id, 2);
    expect(captured.specs[1]).not.toHaveProperty('accessMode');
    expect(store.getRun(run.id)?.accessMode).toBeUndefined();
    expect(manager.continueRun(run.id)).toEqual({ ok: true });
    await settled(run.id, 3);
    expect(captured.specs[2]).not.toHaveProperty('accessMode');
  });

  it('restores the queued selection from disk after a restart', async () => {
    const run = store.createRun({ title: 'queued', workflow: workflow.name, task: 'work', runner: 'codex', model: 'gpt-eligible-b', accessMode: 'daybreak-blue', worktree: false,
      steps: [{ id: 'work', name: 'work', kind: 'agent' }] });
    store.updateRun(run.id, { workflowDef: workflow });
    store.flush();
    manager.dispose();
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root);
    await manager.recover();
    await settled(run.id, 1);
    expect(captured.specs[0]).toMatchObject({ model: 'gpt-eligible-b', accessMode: 'daybreak-blue' });
  }, 20_000);

  it('uses step overrides and retains them when that session is continued', async () => {
    const definition: WorkflowDef = { ...workflow, steps: [{ id: 'work', prompt: '{{task}}', model: 'gpt-eligible-b', accessMode: 'standard' }] };
    const run = manager.startRun(definition, { task: 'work', worktree: false, runner: 'codex', model: 'gpt-eligible-a', accessMode: 'daybreak-blue' });
    await settled(run.id, 1);
    expect(captured.specs[0]?.accessMode).toBe('standard');
    expect(manager.continueRun(run.id)).toEqual({ ok: true });
    await settled(run.id, 2);
    expect(captured.specs[1]?.accessMode).toBe('standard');
    expect(captured.specs[1]?.model).toBe('gpt-eligible-b');
  });

  it('does not carry Codex treatment into another backend', async () => {
    const definition: WorkflowDef = { ...workflow, steps: [{ id: 'work', prompt: '{{task}}', runner: 'claude' }] };
    const run = manager.startRun(definition, { task: 'work', worktree: false, runner: 'codex', accessMode: 'daybreak-blue' });
    await settled(run.id, 1);
    expect(captured.specs[0]).not.toHaveProperty('accessMode');
    expect(manager.continueRun(run.id, { runner: 'claude' })).toEqual({ ok: true });
    await settled(run.id, 2);
    expect(captured.specs[1]).not.toHaveProperty('accessMode');
    expect(store.getRun(run.id)?.accessMode).toBeUndefined();
  });

  it('round-trips optional workflow selection through the graph adapter', () => {
    const definition = workflowDefSchema.parse({ ...workflow, steps: [{ id: 'work', prompt: '{{task}}', accessMode: 'standard' }] });
    const graph = compileV1(definition.steps);
    const agent = graph.nodes.find((node) => node.type === 'agent')!;
    expect(agent.type === 'agent' && nodeToStep(agent).accessMode).toBe('standard');
    expect(workflowDefSchema.parse(workflow).steps[0]).not.toHaveProperty('accessMode');
  });
});
