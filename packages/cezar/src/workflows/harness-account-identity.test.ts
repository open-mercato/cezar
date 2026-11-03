import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE } from '../harness/workflows.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { AUTO_RESUME_GRACE_MS, RunManager, runAccountKey, type StartRunInput } from './run.ts';
import type { WorkflowDef } from './types.ts';

const TASK: WorkflowDef = { name: 'one-step', source: 'file', steps: [{ id: 'work', prompt: '{{task}}' }] };
const HARNESS = harnessWorkflowDefs().find((workflow) => workflow.name === HARNESS_FIX_ISSUE)!;
const LIMIT = 'Codex usage limit reached. Try again in 3 hours.';

describe('ordinary and harness account identity', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let internal: {
    queue: string[];
    requeueWhileHeld: (id: string, workflow: WorkflowDef, input: StartRunInput, backend: string) => boolean;
    scheduleAutoResumeIfLimited: (id: string, account?: string, message?: string) => void;
    applyQueueReasons: (runner: string) => void;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-account-identity-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    internal = manager as unknown as typeof internal;
  });
  afterEach(() => {
    for (const run of store.listRuns()) manager.cancel(run.id);
    manager.dispose();
    store.flush();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function limit(harness: boolean, agentProfile?: string) {
    const run = store.createRun({ title: 'limited', workflow: harness ? HARNESS.name : TASK.name, task: 'Fix #1', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    store.updateStep(run.id, 'work', { backend: 'codex', profileId: agentProfile ?? 'default', sessionId: 's-1', status: 'failed', error: LIMIT });
    store.updateRun(run.id, { runner: 'codex', agentProfile, status: 'failed', error: LIMIT,
      autoResumeAt: new Date(Date.now() + 60_000).toISOString(),
      ...(harness ? { autoResumeAccount: `codex:${agentProfile ?? 'default'}`, harness: { workflow: HARNESS.name, profile: 'standard', issueId: '1' } } : {}) });
    return store.getRun(run.id)!;
  }

  it.each([undefined, 'work'])('guard: preserves the ordinary key and admission for override %s', async (agentProfile) => {
    const limited = limit(false, agentProfile);
    // harness-only attribution may not re-key ordinary runs.
    expect(runAccountKey({ ...limited, autoResumeAccount: 'codex:foreign' }, 'claude')).toBe(`codex:${agentProfile ?? 'default'}`);
    expect(manager.accountHolds().deadline).toEqual(new Set([`codex:${agentProfile ?? 'default'}`]));
    const queued = manager.startRun(TASK, { task: 'new', runner: 'codex', agentProfile });
    expect(await manager.startNow(queued.id)).toBe('held');
    await expect.poll(() => store.getRun(queued.id)?.queueWaitReason?.kind).toBe('usage-reset');
    internal.queue.splice(internal.queue.indexOf(queued.id), 1);
    expect(internal.requeueWhileHeld(queued.id, TASK, { task: 'new' }, 'codex')).toBe(true);
  });

  it('guard: ordinary scheduling does not stamp a harness account and its spawn gate stays synchronous', () => {
    const limited = limit(false);
    store.updateRun(limited.id, { autoResumeAt: undefined });
    internal.scheduleAutoResumeIfLimited(limited.id);
    expect(store.getRun(limited.id)?.autoResumeAt).toBeDefined();
    expect(store.getRun(limited.id)?.autoResumeAccount).toBeUndefined();
    const separate = manager.startRun(TASK, { task: 'other', runner: 'claude' });
    expect(internal.requeueWhileHeld(separate.id, TASK, { task: 'other' }, 'claude')).toBe(false);
  });

  it('guard: ordinary scheduling parses the run error even if given a harness limiting message', () => {
    const limited = limit(false);
    const reset = Math.floor((Date.now() + 3_600_000) / 1000) * 1000;
    store.updateRun(limited.id, { autoResumeAt: undefined, error: `Claude AI usage limit reached|${reset / 1000}` });
    internal.scheduleAutoResumeIfLimited(limited.id, 'codex:other', LIMIT);
    expect(store.getRun(limited.id)?.autoResumeAt).toBe(new Date(reset + AUTO_RESUME_GRACE_MS).toISOString());
    expect(store.getRun(limited.id)?.autoResumeAccount).toBeUndefined();
  });

  it.each([undefined, 'work'])('guard: a normalized harness hold blocks ordinary admission for override %s', async (agentProfile) => {
    limit(true, agentProfile);
    const queued = manager.startRun(TASK, { task: 'new', runner: 'codex', agentProfile });
    expect(await manager.startNow(queued.id)).toBe('held');
    internal.queue.splice(internal.queue.indexOf(queued.id), 1);
    expect(internal.requeueWhileHeld(queued.id, TASK, { task: 'new' }, 'codex')).toBe(true);
  });

  it('guard: explicit roles do not hold an unused composer backend', () => {
    limit(false);
    const queued = manager.startRun(TASK, { task: 'Fix #1', runner: 'codex' });
    store.updateRun(queued.id, { harness: { workflow: HARNESS.name, profile: 'multi', issueId: '1', roles: {
      orchestrator: { runner: 'claude', model: 'claude' }, implementer: { runner: 'claude', model: 'claude' },
      reviewers: [{ runner: 'harness', model: 'advisor', family: 'external' }, { runner: 'claude', model: 'claude' }],
    } } });
    expect(internal.requeueWhileHeld(queued.id, HARNESS, { task: 'Fix #1' }, 'codex')).toBe(false);
  });

  it('admits an in-flight harness resume despite a different role account deadline', async () => {
    limit(false);
    const queued = manager.startRun(TASK, { task: 'Fix #1', runner: 'claude' });
    store.updateRun(queued.id, { autoResumeAttempts: 1, autoResumeAccount: 'claude:default', harness: {
      workflow: HARNESS.name, profile: 'multi', issueId: '1', roles: {
        orchestrator: { runner: 'claude', model: 'claude' }, implementer: { runner: 'claude', model: 'claude' },
        reviewers: [{ runner: 'codex', model: 'codex' }],
      },
    } });
    expect(manager.accountHolds().inFlight).toEqual(new Set(['claude:default']));
    internal.applyQueueReasons('claude');
    expect(store.getRun(queued.id)?.queueWaitReason).toBeUndefined();
    expect(internal.requeueWhileHeld(queued.id, HARNESS, { task: 'Fix #1' }, 'claude')).toBe(false);
    // Keep the queue parked while checking Start now's admission decision.
    vi.spyOn(manager as unknown as { pump: () => Promise<void> }, 'pump').mockResolvedValue();
    expect(await manager.startNow(queued.id)).toBe('started');
    const fresh = manager.startRun(TASK, { task: 'fresh', runner: 'claude' });
    expect(await manager.startNow(fresh.id)).toBe('held');
  });

  it('guard: a fresh harness run still waits for an explicit reviewer account deadline', async () => {
    limit(false);
    const queued = manager.startRun(TASK, { task: 'Fix #1', runner: 'claude' });
    store.updateRun(queued.id, { harness: { workflow: HARNESS.name, profile: 'multi', issueId: '1', roles: {
      orchestrator: { runner: 'claude', model: 'claude' }, implementer: { runner: 'claude', model: 'claude' },
      reviewers: [{ runner: 'codex', model: 'codex' }],
    } } });
    expect(await manager.startNow(queued.id)).toBe('held');
    internal.applyQueueReasons('claude');
    expect(store.getRun(queued.id)?.queueWaitReason?.kind).toBe('usage-reset');
    expect(internal.requeueWhileHeld(queued.id, HARNESS, { task: 'Fix #1' }, 'claude')).toBe(true);
  });

  it.each([
    { runner: 'claude' as const, override: 'host', limitedProfile: undefined, label: 'regression:' },
    { runner: 'codex' as const, override: 'work', limitedProfile: 'work', label: 'guard:' },
  ])('$label checks normalized explicit role accounts at admission and the spawn gate ($runner/$override)', async ({ runner, override, limitedProfile }) => {
    limit(false, limitedProfile);
    const queued = manager.startRun(TASK, { task: 'Fix #1', runner, agentProfile: override });
    store.updateRun(queued.id, { harness: { workflow: HARNESS.name, profile: 'multi', issueId: '1', roles: {
      orchestrator: { runner: 'claude', model: 'claude' }, implementer: { runner: 'codex', model: 'codex' },
      reviewers: [{ runner: 'harness', model: 'advisor', family: 'external' }, { runner: 'claude', model: 'claude' }],
    } } });
    expect(await manager.startNow(queued.id)).toBe('held');
    await expect.poll(() => store.getRun(queued.id)?.queueWaitReason?.kind).toBe('usage-reset');
    internal.queue.splice(internal.queue.indexOf(queued.id), 1);
    expect(internal.requeueWhileHeld(queued.id, HARNESS, { task: 'Fix #1' }, runner)).toBe(true);
  });
});
