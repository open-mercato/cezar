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
const interrupted = vi.hoisted(() => [] as string[]);

// Every session holds until interrupted, like a reviewer CLI mid-review.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      let release: () => void = () => {};
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          release = () => resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
          setTimeout(() => onEvent?.({ type: 'session', sessionId: `sess-${Math.random()}` }), 10);
        }),
        sendMessage: () => false,
        end: () => release(),
        interrupt: () => {
          interrupted.push(spec.userPrompt);
          release();
        },
        open: true,
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

// a crash dropped the run while its concurrent council reviewers ran on, unstoppable
// and billing, with their slot already released.
describe('a crashed run stops its concurrent sessions', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    interrupted.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-crash-sessions-'));
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

  it.each(['failCrashedRun', 'failOwnedContinuation'])('%s interrupts every live reviewer', async (handler) => {
    const record = manager!.startRun(TASK, { task: 'main session', worktree: false, runner: 'claude' });
    const internals = manager as unknown as {
      active: Map<string, { ownerToken: symbol; liveSessions: Set<unknown> }>;
      runAgentStep: (...args: unknown[]) => Promise<string | null>;
    } & Record<string, (runId: string, ownerToken: symbol, message: string) => void>;
    await expect.poll(() => internals.active.has(record.id), { timeout: 15_000 }).toBe(true);
    const state = internals.active.get(record.id)!;
    store.addStep(record.id, { id: 'council', name: 'Council', kind: 'agent' });
    const reviewer = internals.runAgentStep.call(
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
    await expect.poll(() => state.liveSessions.size, { timeout: 15_000 }).toBe(2);

    internals[handler]!.call(manager, record.id, state.ownerToken, 'boom');

    expect(interrupted).toContain('review it');
    expect(internals.active.has(record.id)).toBe(false);
    expect(store.getRun(record.id)?.status).toBe('failed');
    await reviewer;
  });
});
