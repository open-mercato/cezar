import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { graphToSteps, type WorkflowGraph } from './graph.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

describe('adaptive routing session continuity', () => {
  it('nudges the routed graph session and continues its recorded runner by default', async () => {
    const root = mkdtempSync('/tmp/cez-routing-continuity-');
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      const graph: WorkflowGraph = {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'review', type: 'agent', prompt: 'review', verdicts: ['approve', 'changes'] },
          { id: 'end', type: 'end', status: 'success' },
        ],
        edges: [{ from: 'start', to: 'review' }, { from: 'review.approve', to: 'end' }],
      };
      const workflow: WorkflowDef = { name: 'test', source: 'file', steps: graphToSteps(graph), graph };
      const record = store.createRun({ title: 'test', task: 'review', workflow: 'test', runner: 'claude',
        steps: workflow.steps.map((step) => ({ id: step.id, name: step.id, kind: 'agent' })) });
      const calls: Array<{ runner: string; model?: string; resume?: string }> = [];
      const internal = manager as unknown as {
        idleClosedFails: () => Promise<boolean>;
        runAgentStep: (...args: unknown[]) => Promise<null>;
        executeGraph: (...args: unknown[]) => Promise<unknown>;
        runContinuation: (...args: unknown[]) => Promise<void>;
      };
      internal.idleClosedFails = async () => false;
      internal.runAgentStep = async (...args) => {
        const step = args[2] as { id: string; runner?: string; model?: string };
        const hooks = args[13] as { resumeSessionId?: string; lastTurn: { text: string } };
        calls.push({ runner: step.runner ?? args[9] as string, model: step.model, resume: hooks.resumeSessionId });
        if (calls.length === 1) {
          store.updateStep(record.id, step.id, { backend: 'codex', model: 'gpt-new', adaptiveRouted: true,
            sessionId: 'codex-owned-session' });
          hooks.lastTurn.text = 'Review text without a verdict';
        } else hooks.lastTurn.text = 'CEZ:VERDICT approve';
        return null;
      };
      await internal.executeGraph(record.id, { cwd: root, cancelled: false }, workflow, graph,
        { input: { task: 'review' }, skills: [], emit: () => undefined, taskBackend: 'claude', startAttachments: [] });
      expect(calls).toEqual([
        { runner: 'claude', model: undefined, resume: undefined },
        { runner: 'codex', model: 'gpt-new', resume: 'codex-owned-session' },
      ]);

      store.updateRun(record.id, { status: 'done' });
      const continuation = vi.fn(async (..._args: unknown[]) => undefined);
      internal.runContinuation = continuation;
      expect(manager.continueRun(record.id, { text: 'continue' })).toEqual({ ok: true });
      expect(continuation.mock.calls[0]?.[2]).toBe('codex-owned-session');
      expect(continuation.mock.calls[0]?.[3]).toBe('codex');
      expect(store.getRun(record.id)?.runner).toBe('codex');
    } finally {
      manager.dispose();
      store.flush();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
