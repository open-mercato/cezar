import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, AgentSession } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { graphToSteps, type WorkflowGraph } from './graph.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

vi.mock('../telemetry.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), track: vi.fn() }));

const runner = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

// An OpenCode session that reopens what it is asked to resume and mints a new id otherwise.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    interrupt: async () => {},
    startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): AgentSession {
      runner.specs.push(spec);
      const sessionId = spec.resume && spec.sessionId ? spec.sessionId : `ses_${runner.specs.length}`;
      const result = new Promise<AgentRunResult>((resolve) => {
        setTimeout(() => {
          onEvent?.({ type: 'session', sessionId });
          onEvent?.({ type: 'text', text: 'done' });
          resolve({ text: 'done', toolCalls: [], tokensUsed: 0, sessionId });
        }, 0);
      });
      return { result, open: true, sendMessage: () => false, end: () => undefined, interrupt: () => undefined };
    },
  }),
}));

describe('graph session.continue on OpenCode (#2543)', { timeout: 20_000 }, () => {
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    runner.specs = [];
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-graph-opencode-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const GRAPH: WorkflowGraph = {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'implement', type: 'agent', runner: 'opencode', prompt: '{{task}}' },
      { id: 'address', type: 'agent', runner: 'opencode', session: { continue: 'implement' }, prompt: 'address the review' },
      { id: 'ok', type: 'end', status: 'success' },
    ],
    edges: [
      { from: 'start', to: 'implement' },
      { from: 'implement', to: 'address' },
      { from: 'address', to: 'ok' },
    ],
  };

  it('reopens the named node\'s session instead of starting fresh', async () => {
    const def: WorkflowDef = { name: 'graph', source: 'file', steps: graphToSteps(GRAPH), graph: GRAPH };
    const { id } = manager.startRun(def, { task: 'build it', worktree: false, runner: 'opencode' });
    await expect.poll(() => store.getRun(id)?.status, { timeout: 15_000 }).toBe('done');

    const byId = new Map(store.getRun(id)!.steps.map((s) => [s.id, s]));
    expect(byId.get('implement')?.sessionId).toBe('ses_1');
    expect(runner.specs.map((s) => s.resume ?? false)).toEqual([false, true]);
    expect(runner.specs[1]?.sessionId).toBe('ses_1');
    expect(byId.get('address')?.sessionId).toBe('ses_1');
    const notes = store.readEvents(id).filter((e) => e.type === 'note').map((e) => String(e.message));
    expect(notes.filter((m) => m.includes('starting fresh'))).toEqual([]);
  });
});
