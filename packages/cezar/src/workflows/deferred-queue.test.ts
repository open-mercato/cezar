import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
it('publishes queue reasons when a different project acquires, resumes and clears an account hold', () => {
  const root = mkdtempSync(join(tmpdir(), 'deferred-queue-'));
  const semaphore = new WorkspaceSemaphore();
  const a = RunStore.open(join(root, 'a'));
  const b = RunStore.open(join(root, 'b'));
  const managers = [new RunManager(a, root, { semaphore }), new RunManager(b, root, { semaphore })];
  try {
    const queued = a.createRun({ title: 'Waiting', steps: [], task: 'Waiting', workflow: 'quick-task', runner: 'claude' });
    const holder = b.createRun({ title: 'Blocked', steps: [], task: 'Blocked', workflow: 'quick-task', runner: 'claude' });
    const until = new Date(Date.now() + 60_000).toISOString();
    b.updateRun(holder.id, { status: 'failed', autoResumeAt: until });
    expect(a.getRun(queued.id)?.queueWaitReason).toEqual({ kind: 'usage-reset', until, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    b.updateRun(holder.id, { status: 'running', autoResumeAt: undefined, autoResumeAttempts: 1 });
    expect(a.getRun(queued.id)?.queueWaitReason).toEqual({ kind: 'account-resume' });
    b.updateRun(holder.id, { status: 'done', autoResumeAttempts: undefined });
    expect(a.getRun(queued.id)?.queueWaitReason).toBeUndefined();
  } finally { for (const manager of managers) manager.dispose(); a.flush(); b.flush(); rmSync(root, { recursive: true, force: true }); }
});

it('re-derives queue reasons only when a hold input changes, not on every token update (#1340)', () => {
  const root = mkdtempSync(join(tmpdir(), 'deferred-queue-'));
  const semaphore = new WorkspaceSemaphore();
  const store = RunStore.open(join(root, 'a'));
  const manager = new RunManager(store, root, { semaphore });
  try {
    const run = store.createRun({ title: 'Busy', steps: [], task: 'Busy', workflow: 'quick-task', runner: 'claude' });
    const notify = vi.spyOn(semaphore, 'notifyAccountHoldsChanged');
    store.updateRun(run.id, { costUsd: 0.5, titleSummary: 'busy' });
    store.updateRun(run.id, { costUsd: 0.75 });
    expect(notify).not.toHaveBeenCalled();
    store.updateRun(run.id, { status: 'failed', autoResumeAt: new Date(Date.now() + 60_000).toISOString() });
    expect(notify).toHaveBeenCalledOnce();
    store.updateRun(run.id, { agentProfile: 'work' });
    expect(notify).toHaveBeenCalledTimes(2);
  } finally { manager.dispose(); store.flush(); rmSync(root, { recursive: true, force: true }); }
});


it('uses the configured Codex default for omitted-runner queue reasons and refreshes config changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'deferred-default-'));
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  const config = join(root, '.ai/cezar/config.json');
  writeFileSync(config, JSON.stringify({ defaultRunner: 'codex' }));
  const semaphore = new WorkspaceSemaphore();
  const a = RunStore.open(join(root, 'a'));
  const b = RunStore.open(join(root, 'b'));
  const managers = [new RunManager(a, root, { semaphore }), new RunManager(b, root, { semaphore })];
  try {
    const queued = a.createRun({ title: 'Waiting', steps: [], task: 'Waiting', workflow: 'quick-task' });
    const holder = b.createRun({ title: 'Blocked', steps: [], task: 'Blocked', workflow: 'quick-task', runner: 'codex' });
    const until = new Date(Date.now() + 60_000).toISOString();
    b.updateRun(holder.id, { status: 'failed', autoResumeAt: until });
    await vi.waitFor(() => expect(a.getRun(queued.id)?.queueWaitReason).toEqual({ kind: 'usage-reset', until, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    b.updateRun(holder.id, { status: 'running', autoResumeAt: undefined, autoResumeAttempts: 1 });
    await vi.waitFor(() => expect(a.getRun(queued.id)?.queueWaitReason).toEqual({ kind: 'account-resume' }));
    b.updateRun(holder.id, { runner: 'claude' });
    await vi.waitFor(() => expect(a.getRun(queued.id)?.queueWaitReason).toBeUndefined());
    writeFileSync(config, JSON.stringify({ defaultRunner: 'claude' }));
    await semaphore.refresh();
    await vi.waitFor(() => expect(a.getRun(queued.id)?.queueWaitReason).toEqual({ kind: 'account-resume' }));
    expect(a.getRun(queued.id)?.runner).toBeUndefined();
  } finally { for (const manager of managers) manager.dispose(); a.flush(); b.flush(); rmSync(root, { recursive: true, force: true }); }
});

it('clears a disposed holder reason while another participant still exhausts capacity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'deferred-dispose-'));
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
  const offCapacity = semaphore.register({ busySlots: () => 1, pump: async () => {}, oldestQueuedAt: () => null });
  const a = RunStore.open(join(root, 'a'));
  const b = RunStore.open(join(root, 'b'));
  const ma = new RunManager(a, root, { semaphore });
  const mb = new RunManager(b, root, { semaphore });
  try {
    const queued = ma.startRun({ name: 'queue-test', source: 'built-in', description: 'Queue test', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] }, { task: 'Waiting', runner: 'codex' });
    const holder = b.createRun({ title: 'Blocked', steps: [], task: 'Blocked', workflow: 'quick-task', runner: 'codex' });
    const until = new Date(Date.now() + 60_000).toISOString();
    b.updateRun(holder.id, { status: 'failed', autoResumeAt: until });
    expect(a.getRun(queued.id)?.queueWaitReason).toEqual({ kind: 'usage-reset', until, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    mb.dispose();
    expect(semaphore.accountHolds().deadline.size).toBe(0);
    expect(a.getRun(queued.id)?.queueWaitReason).toBeUndefined();
    await semaphore.release();
    expect(semaphore.busy()).toBe(semaphore.maxParallel());
    expect(a.getRun(queued.id)?.status).toBe('queued');
  } finally { ma.dispose(); mb.dispose(); offCapacity(); a.flush(); b.flush(); rmSync(root, { recursive: true, force: true }); }
});
