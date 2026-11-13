import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { CodexAppServerRunner } from '../core/codex-app-server-runner.ts';
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

  it('carries routed ownership through graph session.continue into holds and ordinary Continue', async () => {
    const root = mkdtempSync('/tmp/cez-routing-chain-');
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      const graph: WorkflowGraph = {
        nodes: [{ id: 'start', type: 'start' }, { id: 'work', type: 'agent', prompt: 'work' },
          { id: 'follow', type: 'agent', prompt: 'follow', session: { continue: 'work' } },
          { id: 'end', type: 'end', status: 'success' }],
        edges: [{ from: 'start', to: 'work' }, { from: 'work', to: 'follow' }, { from: 'follow', to: 'end' }],
      };
      const workflow: WorkflowDef = { name: 'test', source: 'file', steps: graphToSteps(graph), graph };
      const run = store.createRun({ title: 'test', task: 'test', workflow: 'test', runner: 'claude',
        steps: workflow.steps.map((step) => ({ id: step.id, name: step.id, kind: 'agent' })) });
      const launches: Array<{ id: string; backend: string; resume?: string }> = [];
      const internal = manager as unknown as {
        idleClosedFails: () => Promise<boolean>;
        runAgentStep: (...args: unknown[]) => Promise<null>;
        executeGraph: (...args: unknown[]) => Promise<unknown>;
        runContinuation: (...args: unknown[]) => Promise<void>;
      };
      internal.idleClosedFails = async () => false;
      internal.runAgentStep = async (...args) => {
        const step = args[2] as { id: string; runner?: string };
        const hooks = args[13] as { resumeSessionId?: string };
        const backend = step.id === 'work' ? 'codex' : step.runner ?? args[9] as string;
        launches.push({ id: step.id, backend, resume: hooks.resumeSessionId });
        store.updateStep(run.id, step.id, { backend: backend as 'codex' | 'claude',
          sessionId: hooks.resumeSessionId ?? 'codex-session', profileId: 'default',
          ...(step.id === 'work' ? { model: 'gpt-new', adaptiveRouted: true } : {}) });
        return null;
      };
      await internal.executeGraph(run.id, { cwd: root, cancelled: false }, workflow, graph,
        { input: { task: 'test' }, skills: [], emit: () => undefined, taskBackend: 'claude', startAttachments: [] });
      expect(launches).toEqual([{ id: 'work', backend: 'codex', resume: undefined },
        { id: 'follow', backend: 'codex', resume: 'codex-session' }]);
      expect(store.getRun(run.id)?.steps.find((step) => step.id === 'follow')?.adaptiveRouted).toBe(true);
      store.updateRun(run.id, { status: 'failed', autoResumeAt: new Date(Date.now() + 60_000).toISOString(),
        autoResumeReason: 'usage_limit' });
      expect(manager.accountHolds().deadline.has('codex:default')).toBe(true);
      expect(manager.accountHolds().deadline.has('claude:default')).toBe(false);
      store.updateRun(run.id, { status: 'done' });
      const continuation = vi.fn(async (..._args: unknown[]) => undefined);
      internal.runContinuation = continuation;
      expect(manager.continueRun(run.id, { text: 'continue' })).toEqual({ ok: true });
      expect(continuation.mock.calls[0]?.[2]).toBe('codex-session');
      expect(continuation.mock.calls[0]?.[3]).toBe('codex');
    } finally { manager.dispose(); store.flush(); rmSync(root, { recursive: true, force: true }); }
  });

  it('retains the routed model through three real agent steps and missing-session recovery', async () => {
    const root = mkdtempSync('/tmp/cez-routing-model-chain-');
    const home = join(root, 'home');
    mkdirSync(home);
    vi.stubEnv('CEZ_HOME', home);
    vi.stubEnv('CEZ_MODEL_ROUTING', '1');
    writeFileSync(join(home, 'model-metadata.json'), JSON.stringify({ fetchedAt: Date.now(), models: {
      'openai/gpt-new': { id: 'openai/gpt-new', context: 500000, reasoning: true, toolCall: true,
        inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    } }));
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    const originalStart = CodexAppServerRunner.prototype.startSession;
    const launches: Array<{ model?: string; resume?: boolean; sessionId?: string }> = [];
    CodexAppServerRunner.prototype.startSession = function (spec) {
      launches.push({ model: spec.model, resume: spec.resume, sessionId: spec.sessionId });
      return { result: launches.length === 3 && spec.resume
        ? Promise.reject(new Error('no rollout found for thread'))
        : Promise.resolve({ tokensUsed: 0, text: '', toolCalls: 0 }),
      sendMessage: () => true, interrupt: () => undefined, end: () => undefined, open: true,
      } as ReturnType<typeof originalStart>;
    };
    try {
      const graph: WorkflowGraph = { nodes: [{ id: 'start', type: 'start' },
        { id: 'work', type: 'agent', prompt: 'work' },
        { id: 'follow', type: 'agent', prompt: 'follow', session: { continue: 'work' } },
        { id: 'third', type: 'agent', prompt: 'third', session: { continue: 'follow' } },
        { id: 'end', type: 'end', status: 'success' }],
      edges: [{ from: 'start', to: 'work' }, { from: 'work', to: 'follow' },
        { from: 'follow', to: 'third' }, { from: 'third', to: 'end' }] };
      const workflow: WorkflowDef = { name: 'test', source: 'file', steps: graphToSteps(graph), graph };
      const run = store.createRun({ title: 'test', task: 'test', workflow: 'test', runner: 'claude',
        steps: workflow.steps.map((step) => ({ id: step.id, name: step.id, kind: 'agent' })) });
      const internal = manager as unknown as {
        idleClosedFails: () => Promise<boolean>;
        provisionTaskSkills: () => Promise<[]>;
        agentEnvForStep: (_runId: string, _backend: string, options: { recordedProfileId?: string }) => Promise<{ profileId: string; env: object }>;
        privateMcpForLaunch: () => Promise<[]>;
        routingProviderAllowed: () => Promise<boolean>;
        routingCatalog: { get: (runner: string) => Promise<object> };
        active: Map<string, object>;
        executeGraph: (...args: unknown[]) => Promise<unknown>;
      };
      internal.idleClosedFails = async () => false;
      internal.provisionTaskSkills = async () => [];
      internal.agentEnvForStep = async (_id, _backend, options) => {
        if (launches.length) expect(options.recordedProfileId).toBe('default');
        return { profileId: 'default', env: {} };
      };
      internal.privateMcpForLaunch = async () => [];
      internal.routingProviderAllowed = async () => true;
      internal.routingCatalog = { get: async (runner) => ({ runner, stale: false, source: 'live',
        models: runner === 'codex' ? [{ id: 'gpt-new', label: 'New', description: '' }] : [] }) };
      const state = { cwd: root, cancelled: false, skills: [] };
      internal.active.set(run.id, state);
      await internal.executeGraph(run.id, state, workflow, graph,
        { input: { task: 'test' }, skills: [], emit: () => undefined,
          taskBackend: 'claude', startAttachments: [] });
      internal.active.delete(run.id);
      expect(launches).toHaveLength(4);
      expect(launches.map((launch) => launch.model)).toEqual(['gpt-new', 'gpt-new', 'gpt-new', 'gpt-new']);
      expect(launches.map((launch) => launch.resume)).toEqual([false, true, true, false]);
      expect(store.getRun(run.id)?.steps.filter((step) => step.kind === 'agent').map((step) => step.model))
        .toEqual(['gpt-new', 'gpt-new', 'gpt-new']);
      store.flush();
      expect(RunStore.open(join(root, '.ai/cezar')).getRun(run.id)?.steps.find((step) => step.id === 'third')?.model)
        .toBe('gpt-new');
    } finally {
      CodexAppServerRunner.prototype.startSession = originalStart;
      manager.dispose(); store.flush(); rmSync(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
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
