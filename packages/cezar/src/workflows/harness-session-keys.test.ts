import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, SessionOptions } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

// The run's own session holds; each phase session answers one message item and ends its turn.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts?: SessionOptions) => {
      let release: () => void = () => {};
      let open = true;
      const result = new Promise<AgentRunResult>((resolve) => {
        release = () => {
          open = false;
          resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
        };
      });
      setTimeout(() => {
        onEvent?.({ type: 'session', sessionId: `sess-${spec.userPrompt}` });
        if (spec.userPrompt.includes('hold')) return;
        opts?.onUiEvent?.({
          type: 'item.completed',
          item: { kind: 'message', id: 'item_1', role: 'assistant', text: spec.userPrompt },
        } as never);
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

// concurrent council sessions share one step and each mints `item_1`, so the
// transcript could not tell their events apart.
describe('concurrent council sessions carry their own key', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-session-keys-'));
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

  it('stamps a distinct sessionKey on every event of each concurrent session', async () => {
    const record = manager!.startRun(TASK, { task: 'hold', worktree: false, runner: 'claude' });
    await expect.poll(() => store.getRun(record.id)?.steps[0]?.sessionId, { timeout: 15_000 }).toBeDefined();
    const internals = manager as unknown as {
      active: Map<string, unknown>;
      runAgentStep: (...args: unknown[]) => Promise<string | null>;
    };
    store.addStep(record.id, { id: 'review', name: 'Review', kind: 'agent' });
    const reviewer = (label: string) => {
      const resultPath = join(repoRoot, `review-${label}.json`);
      writeFileSync(resultPath, '{}');
      return internals.runAgentStep.call(
        manager,
        record.id,
        internals.active.get(record.id),
        { id: 'review', name: `Review — ${label}`, prompt: `reviewer ${label}` },
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
        { resultPath, timeoutMs: 20_000, concurrent: true },
      );
    };

    await Promise.all([reviewer('a'), reviewer('b')]);

    const items = store
      .readEvents(record.id)
      .filter((event) => event.type === 'item.completed' && event.stepId === 'review');
    expect(items.map((event) => (event.item as { text: string }).text).sort()).toEqual(['reviewer a', 'reviewer b']);
    const keys = new Set(items.map((event) => event.sessionKey));
    expect(keys.size).toBe(2);
    expect([...keys].every((key) => typeof key === 'string' && key.length > 0)).toBe(true);
    manager!.cancel(record.id);
  });
});
