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
const captured = vi.hoisted(() => ({ specs: 0 }));

// The run's own session holds; any other session completes one turn and waits to be ended.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.specs += 1;
      let release: () => void = () => {};
      let open = true;
      const result = new Promise<AgentRunResult>((resolve) => {
        release = () => {
          open = false;
          resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
        };
      });
      setTimeout(() => {
        onEvent?.({ type: 'session', sessionId: `sess-${captured.specs}` });
        if (spec.userPrompt.includes('hold')) return;
        onEvent?.({ type: 'text', text: 'phase work done' });
        onEvent?.({ type: 'turn-end' } as AgentEvent);
      }, 20);
      return {
        result,
        sendMessage: () => true,
        end: () => release(),
        interrupt: () => release(),
        get open() {
          return open;
        },
      };
    },
    interrupt: async () => {},
  }),
}));

const TASK: WorkflowDef = { name: 'one-step', source: 'file', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }] };

// a harness phase's turn-end returned before the reset an ordinary turn does, so an
// auto-resumed harness run held its account against every new task for the rest of the run.
describe('a completed harness phase turn proves the usage window open', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    captured.specs = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-harness-turn-end-'));
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

  it('retires the resume counter and releases the account hold', async () => {
    const record = manager!.startRun(TASK, { task: 'hold', worktree: false, runner: 'claude' });
    await expect.poll(() => captured.specs, { timeout: 15_000 }).toBe(1);
    const internals = manager as unknown as {
      active: Map<string, unknown>;
      runAgentStep: (...args: unknown[]) => Promise<string | null>;
    };
    store.updateRun(record.id, { autoResumeAttempts: 2 });
    expect(manager!.accountHolds().inFlight.has('claude:default')).toBe(true);
    store.addStep(record.id, { id: 'implement', name: 'Implement', kind: 'agent' });
    const resultPath = join(repoRoot, 'phase-implement-result.json');
    writeFileSync(resultPath, '{}');

    await internals.runAgentStep.call(
      manager,
      record.id,
      internals.active.get(record.id),
      { id: 'implement', name: 'Implement', prompt: 'phase prompt' },
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
      { resultPath, timeoutMs: 20_000 },
    );

    expect(store.getRun(record.id)?.status).toBe('running');
    expect(store.getRun(record.id)?.autoResumeAttempts).toBeUndefined();
    expect(manager!.accountHolds().inFlight.has('claude:default')).toBe(false);
    manager!.cancel(record.id);
  });
});
