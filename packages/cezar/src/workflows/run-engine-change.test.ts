import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const workflow: WorkflowDef = { name: 'task', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}' }] };

describe('queued engine reassignment', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let semaphore: WorkspaceSemaphore;
  let cap: number;
  const oldDry = process.env.CEZ_DRY_RUN;
  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    root = mkdtempSync(join(tmpdir(), 'cez-engine-change-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
    cap = 0;
    semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 0, memoryLimitMb: null }, load: async () => ({ maxParallel: cap, memoryLimitMb: null }) });
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root, { semaphore });
  });
  afterEach(() => {
    manager.dispose(); store.flush();
    rmSync(root, { recursive: true, force: true });
    if (oldDry === undefined) delete process.env.CEZ_DRY_RUN; else process.env.CEZ_DRY_RUN = oldDry;
  });
  const queued = () => manager.startRun(workflow, { task: 'keep this prompt', runner: 'claude', model: 'opus', reasoningEffort: 'high', worktree: false });

  it('changes a never-started task without losing ordering, data or bypassing capacity', async () => {
    const first = queued(); const second = queued();
    manager.promote(second.id);
    const before = structuredClone(store.getRun(second.id)!);
    expect(manager.changeQueuedEngine(second.id, { runner: 'codex' })).toEqual({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 30));
    const after = store.getRun(second.id)!;
    expect(after).toMatchObject({ id: before.id, task: before.task, createdAt: before.createdAt, promotedAt: before.promotedAt, status: 'queued', runner: 'codex' });
    expect(after.model).toBeUndefined(); expect(after.reasoningEffort).toBeUndefined();
    expect(after.steps).toEqual(before.steps);
    expect((manager as unknown as { queue: string[] }).queue).toEqual([second.id, first.id]);
    const input = (manager as unknown as { pendingJobs: Map<string, { input: object }> }).pendingJobs.get(second.id)!.input;
    expect(input).toMatchObject({ runner: 'codex', model: undefined, task: before.task });
  });

  it('re-evaluates the selected account hold while keeping other exhausted accounts held', async () => {
    const run = queued();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    store.updateRun(run.id, { usageLimitHolds: [{ account: 'claude:default', until }, { account: 'codex:default', until }] });
    expect(manager.changeQueuedEngine(run.id, { runner: 'codex' })).toEqual({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(store.getRun(run.id)?.queueWaitReason).toMatchObject({ kind: 'usage-reset', until });
    expect(manager.accountHolds().deadline).toEqual(new Set(['claude:default', 'codex:default']));
    expect(store.getRun(run.id)?.status).toBe('queued');
  });

  it('rejects foreign models and a task which has left the queue without changing it', () => {
    const run = queued(); const before = structuredClone(store.getRun(run.id));
    expect(manager.changeQueuedEngine(run.id, { runner: 'codex', model: 'opus' }).ok).toBe(false);
    expect(store.getRun(run.id)).toEqual(before);
    manager.cancel(run.id);
    expect(manager.changeQueuedEngine(run.id, { runner: 'codex' }).ok).toBe(false);
  });

  it('removes old continuation session affinity and model when switching backend', () => {
    const run = store.createRun({ title: 'continued', workflow: 'task', task: 'keep context', steps: [{ id: 'work', name: 'Work', kind: 'agent' }], runner: 'claude', model: 'opus', agentProfile: 'old-login' });
    store.updateStep(run.id, 'work', { sessionId: 'claude-session', backend: 'claude', profileId: 'old-login', status: 'done' });
    store.updateRun(run.id, { status: 'done' });
    expect(manager.continueRun(run.id, { text: 'pending instruction' }, true)).toEqual({ ok: true });
    expect(manager.changeQueuedEngine(run.id, { runner: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' })).toEqual({ ok: true });
    const pending = (manager as unknown as { pendingContinuations: Map<string, { sessionId?: string; backend: string; prompt: string; stepId: string }> }).pendingContinuations.get(run.id)!;
    expect(pending).toMatchObject({ backend: 'codex', prompt: 'pending instruction', sessionId: undefined });
    expect(store.getRun(run.id)?.agentProfile).toBeUndefined();
    expect(store.getRun(run.id)?.steps.find(step => step.id === pending.stepId)).toMatchObject({ model: 'gpt-6.1-sol', reasoningEffort: 'high' });
    expect(store.getRun(run.id)?.steps[0]?.sessionId).toBe('claude-session');
  });

  it('preserves a mixed workflow continuation model and effort on account-only and effort-only changes', () => {
    const run = store.createRun({ title: 'continued', workflow: 'task', task: 'context', steps: [{ id: 'work', name: 'Work', kind: 'agent' }], runner: 'claude', model: 'opus' });
    store.updateStep(run.id, 'work', { sessionId: 'session', backend: 'claude', model: 'sonnet', reasoningEffort: 'high', status: 'done' });
    store.updateRun(run.id, { status: 'done' });
    manager.continueRun(run.id, {}, true);
    manager.changeQueuedEngine(run.id, { reasoningEffort: 'medium' });
    const turn = store.getRun(run.id)?.steps.at(-1);
    expect(turn?.model).toBeUndefined(); expect(turn?.reasoningEffort).toBe('medium');
    manager.changeQueuedEngine(run.id, { agentProfile: 'other' });
    expect(store.getRun(run.id)?.steps.at(-1)).toMatchObject({ model: 'sonnet', reasoningEffort: 'medium' });
  });

  it('authenticates the actual queued launch after switching away and back, including restart', async () => {
    const run = store.createRun({ title: 'continued', workflow: 'task', task: 'context', steps: [{ id: 'work', name: 'Work', kind: 'agent' }], runner: 'claude' });
    store.updateStep(run.id, 'work', { sessionId: 'session', backend: 'claude', profileId: 'original', status: 'done' });
    store.updateRun(run.id, { status: 'done' });
    manager.continueRun(run.id, {}, true);
    expect(manager.queuedEngineProfile(run.id, 'claude')).toBe('original');
    manager.changeQueuedEngine(run.id, { runner: 'codex' });
    manager.changeQueuedEngine(run.id, { runner: 'claude' });
    expect(manager.queuedEngineProfile(run.id, 'claude')).toBeUndefined();
    manager.dispose(); store.flush();
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root, { semaphore });
    await manager.recover();
    expect(manager.queuedEngineProfile(run.id, 'claude')).toBeUndefined();
    manager.changeQueuedEngine(run.id, { agentProfile: 'new-login' });
    expect(manager.queuedEngineProfile(run.id, 'claude')).toBe('new-login');
  });

  it('preserves a reassigned continuation instruction and attachment across restart', async () => {
    const run = store.createRun({ title: 'continued', workflow: 'task', task: 'original task', steps: [{ id: 'work', name: 'Work', kind: 'agent' }], runner: 'claude' });
    store.updateStep(run.id, 'work', { sessionId: 'session', backend: 'claude', status: 'done' });
    store.updateRun(run.id, { status: 'done' });
    manager.continueRun(run.id, { text: 'Only investigate the new symptom.', images: [
      { type: 'file', mediaType: 'text/plain', data: Buffer.from('diagnostic evidence').toString('base64') },
    ] }, true);
    manager.changeQueuedEngine(run.id, { runner: 'codex' });
    const urls = store.getRun(run.id)?.steps.at(-1)?.queuedImages;
    expect(urls).toHaveLength(1);
    manager.changeQueuedEngine(run.id, { reasoningEffort: 'high' });
    expect(store.getRun(run.id)?.steps.at(-1)?.queuedImages).toEqual(urls);
    manager.dispose(); store.flush();
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root, { semaphore });
    await manager.recover();
    const engine = manager as unknown as {
      pendingContinuations: Map<string, { prompt: string }>;
      hydrateQueuedContinuation(id: string, continuation: unknown): { prompt: string; persistedAttachments: { path: string }[] };
    };
    const pending = engine.pendingContinuations.get(run.id)!;
    expect(pending.prompt).toBe('Only investigate the new symptom.');
    const hydrated = engine.hydrateQueuedContinuation(run.id, pending);
    expect(hydrated.prompt).toContain('Only investigate the new symptom.');
    expect(hydrated.persistedAttachments).toHaveLength(1);
    expect(readFileSync(hydrated.persistedAttachments[0]!.path, 'utf8')).toBe('diagnostic evidence');
  });

  it('records legacy session ownership before changing the run backend so recovery cannot reuse it', () => {
    const run = store.createRun({ title: 'legacy', workflow: 'task', task: 'context', steps: [{ id: 'work', name: 'Work', kind: 'agent' }], runner: 'claude' });
    store.updateStep(run.id, 'work', { sessionId: 'legacy-session', status: 'done' });
    store.updateRun(run.id, { status: 'done' });
    manager.continueRun(run.id, {}, true);
    manager.changeQueuedEngine(run.id, { runner: 'codex' });
    expect(store.getRun(run.id)?.steps[0]).toMatchObject({ backend: 'claude', sessionId: 'legacy-session' });
  });

  it('keeps a same-account session but drops it when the login changes', () => {
    const run = store.createRun({ title: 'continued', workflow: 'task', task: 'keep context', steps: [{ id: 'work', name: 'Work', kind: 'agent' }], runner: 'claude' });
    store.updateStep(run.id, 'work', { sessionId: 'claude-session', backend: 'claude', status: 'done' });
    store.updateRun(run.id, { status: 'done' });
    manager.continueRun(run.id, {}, true);
    const pending = (manager as unknown as { pendingContinuations: Map<string, { sessionId?: string }> }).pendingContinuations;
    manager.changeQueuedEngine(run.id, { model: 'sonnet' });
    expect(pending.get(run.id)?.sessionId).toBe('claude-session');
    manager.changeQueuedEngine(run.id, { agentProfile: 'other' });
    expect(pending.get(run.id)?.sessionId).toBeUndefined();
  });
});
