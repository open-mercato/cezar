import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, SessionOptions } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { graphIssues, graphToSteps, type WorkflowGraph } from './graph.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const h = vi.hoisted(() => ({ sessions: 0, release: undefined as (() => void) | undefined }));

// Session 1 raises a native ask, then dies (no-output timeout); session 2 stays open until released.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (_spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts?: SessionOptions) => {
      const n = ++h.sessions;
      const result = new Promise<AgentRunResult>((resolve, reject) => {
        setTimeout(() => {
          onEvent?.({ type: 'session', sessionId: `sess-${n}` });
          if (n === 1) {
            opts?.onUiEvent?.({
              type: 'ask.requested',
              requestId: 'req-1',
              questions: [{ question: 'Proceed?', header: 'Go', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }],
            } as never);
            setTimeout(() => reject(new Error('no output for 1s')), 50);
          } else {
            h.release = () => resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
          }
        }, 0);
      });
      return { result, sendMessage: () => false, end: () => {}, interrupt: () => {}, open: false };
    },
    interrupt: async () => {},
  }),
}));

/** #2296: a session that dies on an unanswered native ask must not leave the run `waiting`. */
describe('graph node retry after a native ask whose session died (#2296)', { timeout: 30_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const graph: WorkflowGraph = {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'work', type: 'agent', prompt: '{{task}}' },
      { id: 'retry', type: 'loop', max: 2 },
      { id: 'after', type: 'check', command: 'true' },
    ],
    edges: [
      { from: 'start', to: 'work' },
      { from: 'work.failed', to: 'retry' },
      { from: 'retry.repeat', to: 'work' },
      { from: 'work.done', to: 'after' },
    ],
  };

  beforeEach(async () => {
    h.sessions = 0;
    h.release = undefined;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-dead-ask-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('clears waiting + attentionRequest once the node re-runs on its failed edge', async () => {
    expect(graphIssues(graph)).toEqual([]);
    const def: WorkflowDef = { name: 'graph', source: 'file', steps: graphToSteps(graph), graph };
    const id = manager.startRun(def, { task: 'x', worktree: false }).id;
    await expect.poll(() => h.sessions, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => h.release !== undefined, { timeout: 15_000 }).toBe(true);
    const mid = store.getRun(id)!;
    expect(mid.steps.find((s) => s.id === 'work')?.iterations).toBe(2);
    expect(mid.status).toBe('running');
    expect(mid.attentionRequest).toBeUndefined();
    h.release!();
    await expect.poll(() => store.getRun(id)?.status, { timeout: 15_000 }).toSatisfy((s) => ['done', 'review'].includes(String(s)));
  });
});
