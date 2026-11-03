import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

// Every session reports 100 tokens and $0.50; `hold` keeps the run's own session (and the run) live.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      let release: () => void = () => {};
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          release = () => resolve({ text: 'ok', toolCalls: [], tokensUsed: 100 });
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId: `sess-${Math.random()}` });
            if (spec.userPrompt.includes('hold')) return;
            onEvent?.({ type: 'token-usage', tokensUsed: 100 });
            onEvent?.({ type: 'cost', usd: 0.5 });
            release();
          }, 10);
        }),
        sendMessage: () => false,
        end: () => release(),
        interrupt: () => release(),
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

const TASK: WorkflowDef = {
  name: 'one-step',
  source: 'file',
  steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
};

// council reviewers share one step id, and each wrote `its start + its own usage`,
// so the last writer erased its siblings and every multi-model run under-reported tokens and cost.
describe('concurrent sessions on one step', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-council-usage-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('adds every session to the step total instead of letting the last writer win', async () => {
    const record = manager!.startRun(TASK, { task: 'hold', worktree: false, runner: 'claude' });
    const internals = manager as unknown as {
      active: Map<string, unknown>;
      runAgentStep: (...args: unknown[]) => Promise<string | null>;
    };
    await expect.poll(() => internals.active.has(record.id), { timeout: 15_000 }).toBe(true);
    const state = internals.active.get(record.id);
    store.addStep(record.id, { id: 'council', name: 'Council', kind: 'agent' });
    const reviewer = () =>
      internals.runAgentStep.call(
        manager,
        record.id,
        state,
        { id: 'council', name: 'Council', prompt: 'review it' },
        { task: 'x', worktree: false },
        [],
        null,
        false,
        () => undefined,
        undefined,
        'claude',
        undefined,
        undefined,
        [],
        undefined,
        { concurrent: true },
      );

    await Promise.all([reviewer(), reviewer(), reviewer()]);

    const council = store.getRun(record.id)!.steps.find((s) => s.id === 'council')!;
    expect(council.tokensUsed).toBe(300);
    expect(council.costUsd).toBeCloseTo(1.5);
    manager!.cancel(record.id);
  });
});
