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
const spawned = vi.hoisted(() => ({ count: 0 }));

// Each spawn reports a different context reading, so the record shows which handler folded it.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (_spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      const n = ++spawned.count;
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId: `sess-${n}` });
            onEvent?.({ type: 'usage-status', status: { contextTokens: n * 1000, contextWindow: 200_000 } });
            resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
          }, 0);
        }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

const DEF: WorkflowDef = { name: 'one', source: 'file', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }] };

describe('usage-status reaches the run record from both turn handlers', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    spawned.count = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-live-usage-'));
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

  const settled = (runId: string) =>
    expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));

  it('folds the opening and the Continue readings onto the record, never into the transcript', async () => {
    const record = manager!.startRun(DEF, { task: 'do it', worktree: false, runner: 'claude' });
    await expect.poll(() => store.getRun(record.id)?.liveUsage?.contextTokens, { timeout: 15_000 }).toBe(1000);
    await settled(record.id);

    expect(manager!.continueRun(record.id, { text: 'again', runner: 'claude' })).toEqual({ ok: true });
    await expect.poll(() => store.getRun(record.id)?.liveUsage?.contextTokens, { timeout: 15_000 }).toBe(2000);
    expect(store.getRun(record.id)?.liveUsage?.contextWindow).toBe(200_000);
    await settled(record.id);

    expect(store.readEvents(record.id).some((event) => event.type === 'usage-status')).toBe(false);
  }, 30_000);
});
