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
      const calls: Array<{ runner: string; model?: string; resume?: string; profile?: string }> = [];
      const internal = manager as unknown as {
        idleClosedFails: () => Promise<boolean>;
        runAgentStep: (...args: unknown[]) => Promise<null>;
        executeGraph: (...args: unknown[]) => Promise<unknown>;
        runContinuation: (...args: unknown[]) => Promise<void>;
      };
      internal.idleClosedFails = async () => false;
      internal.runAgentStep = async (...args) => {
        const step = args[2] as { id: string; runner?: string; model?: string };
        const hooks = args[13] as { resumeSessionId?: string; recordedProfileId?: string; lastTurn: { text: string } };
        calls.push({ runner: step.runner ?? args[9] as string, model: step.model,
          resume: hooks.resumeSessionId, profile: hooks.recordedProfileId });
        if (calls.length === 1) {
          store.updateStep(record.id, step.id, { backend: 'codex', model: 'gpt-new', adaptiveRouted: true,
            sessionId: 'codex-owned-session', profileId: 'default' });
          hooks.lastTurn.text = 'Review text without a verdict';
        } else hooks.lastTurn.text = 'CEZ:VERDICT approve';
        return null;
      };
      await internal.executeGraph(record.id, { cwd: root, cancelled: false }, workflow, graph,
        { input: { task: 'review' }, skills: [], emit: () => undefined, taskBackend: 'claude', startAttachments: [] });
      expect(calls).toEqual([
        { runner: 'claude', model: undefined, resume: undefined, profile: undefined },
        { runner: 'codex', model: 'gpt-new', resume: 'codex-owned-session', profile: 'default' },
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

  it('recovers an explicitly switched queued Continue instead of reopening the routed owner', async () => {
    const root = mkdtempSync('/tmp/cez-routing-queue-');
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      const run = store.createRun({ title: 'test', task: 'test', workflow: 'test', runner: 'claude',
        steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
      store.updateStep(run.id, 'work', { status: 'done', backend: 'codex', model: 'gpt-new',
        adaptiveRouted: true, sessionId: 'codex-owned-session', profileId: 'default' });
      store.updateRun(run.id, { status: 'done' });
      expect(manager.continueRun(run.id, { runner: 'claude', model: 'sonnet' }, true)).toEqual({ ok: true });
      const internal = manager as unknown as {
        pendingContinuations: Map<string, { backend: string; sessionId?: string }>;
        enqueue: (id: string) => void;
        reviveQueuedRun: (run: NonNullable<ReturnType<typeof store.getRun>>, reason: string) => Promise<void>;
      };
      expect(internal.pendingContinuations.get(run.id)).toMatchObject({ backend: 'claude' });
      expect(internal.pendingContinuations.get(run.id)?.sessionId).toBeUndefined();
      internal.pendingContinuations.clear();
      internal.enqueue = () => undefined;
      await internal.reviveQueuedRun(store.getRun(run.id)!, 'restart');
      expect(internal.pendingContinuations.get(run.id)).toMatchObject({ backend: 'claude' });
      expect(internal.pendingContinuations.get(run.id)?.sessionId).toBeUndefined();
    } finally {
      manager.dispose(); store.flush(); rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds the routed provider when its account reaches a usage limit', () => {
    const root = mkdtempSync('/tmp/cez-routing-hold-');
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      const run = store.createRun({ title: 'test', task: 'test', workflow: 'test', runner: 'claude',
        steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
      store.updateStep(run.id, 'work', { status: 'failed', backend: 'codex', model: 'gpt-new',
        adaptiveRouted: true, sessionId: 'codex-owned-session', profileId: 'default' });
      store.updateRun(run.id, { status: 'failed', autoResumeAt: new Date(Date.now() + 60_000).toISOString(),
        autoResumeReason: 'usage_limit' });
      expect(manager.accountHolds().deadline.has('codex:default')).toBe(true);
      expect(manager.accountHolds().deadline.has('claude:default')).toBe(false);
    } finally {
      manager.dispose(); store.flush(); rmSync(root, { recursive: true, force: true });
    }
  });
});
