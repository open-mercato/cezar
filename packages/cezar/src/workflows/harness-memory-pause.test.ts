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
const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

// Every session holds until cezar ends it, and stays `open` until then.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.specs.push(spec);
      let release: () => void = () => {};
      let open = true;
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          release = () => {
            open = false;
            resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
          };
          setTimeout(() => onEvent?.({ type: 'session', sessionId: `sess-${captured.specs.length}` }), 0);
        }),
        sendMessage: () => false,
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

const TASK: WorkflowDef = {
  name: 'one-step',
  source: 'file',
  steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
};

// the memory limit ended a harness phase's session, which settled as a normal
// turn with no result file — so the driver spent an attempt, retried at once, and the ceiling stayed
// off for the rest of the run.
describe('the memory limit during a harness phase', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-memory-pause-'));
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

  it('pauses the phase as a runner failure instead of a silent, retried success', async () => {
    const record = manager!.startRun(TASK, { task: 'base session', worktree: false, runner: 'claude' });
    const internals = manager as unknown as {
      active: Map<string, unknown>;
      semaphore: { memoryLimitMb: () => number };
      runAgentStep: (...args: unknown[]) => Promise<string | null>;
      enforceMemoryLimit: (snapshot: Record<string, { rssBytes: number }>) => Promise<void>;
    };
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBe(1);
    const phase = internals.runAgentStep.call(
      manager,
      record.id,
      internals.active.get(record.id),
      { id: 'implement', name: 'Implement', prompt: 'implement it' },
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
      { resultPath: join(repoRoot, 'phase-implement-result.json'), timeoutMs: 20_000 },
    );
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBe(2);

    internals.semaphore.memoryLimitMb = () => 1;
    await internals.enforceMemoryLimit({ [record.id]: { rssBytes: 64 * 1024 * 1024 } });

    await expect(phase).resolves.toMatch(/memory limit/);
    manager!.cancel(record.id);
  }, 30_000);
});
