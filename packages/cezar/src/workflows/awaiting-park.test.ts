import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WaitEdge } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The engine half of cross-task waits (spec `.ai/specs/2026-10-05-cross-task-waits.md`, step 6):
 * a run holding a PENDING wait edge parks as an `awaiting` monitor at turn end — in BOTH turn-end
 * handlers (the first session's `runAgentStep` and `runContinuation`), ahead of the autonomous
 * nudge, slot-exempt, with no periodic wake timer. With `CEZ_TASK_WAITS=0` the same edge is inert.
 *
 * Driven dry through `scripts/mock-claude.mjs`: `mock:pause` holds the turn ~2 s and ends it with
 * no marker, which is exactly the turn an autonomous run would otherwise be nudged out of.
 */
describe('a waiter parks as an awaiting monitor (cross-task waits, step 6)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const started: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-awaiting-'));
    for (const key of ['CEZ_DRY_RUN', 'CEZ_TASK_WAITS']) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_TASK_WAITS;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // A cap of one plain watcher, so the exemption is observable as a count.
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2, maxMonitoringSessions: 0 } }),
    });
    started.length = 0;
  });

  afterEach(async () => {
    for (const id of started) manager.cancel(id);
    const deadline = Date.now() + 10_000;
    while (started.some((id) => manager.isActive(id)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time for ${id}: ${JSON.stringify({ status: store.getRun(id)?.status, activity: store.getRun(id)?.activity })}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const edge = (state: WaitEdge['state'] = 'pending'): WaitEdge => ({
    id: `w-${Math.random().toString(36).slice(2)}`,
    target: { projectId: 'other', runId: 'target-run-id-0001' },
    targetTitle: 'Add export endpoint',
    origin: 'agent',
    createdAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
    state,
  });

  const notes = (id: string): string[] =>
    store
      .readEvents(id)
      .filter((event) => event.type === 'note')
      .map((event) => String((event as { message?: unknown }).message ?? ''));

  const internals = () =>
    manager as unknown as {
      active: Map<string, { monitoringWakeTimer?: NodeJS.Timeout }>;
      exemptParks: Map<string, string>;
      busySlots(): number;
    };

  const start = (task: string): RunRecord => {
    const record = manager.startRun(SINGLE_STEP, { task, autonomous: true });
    started.push(record.id);
    return record;
  };

  it('the FIRST session (runAgentStep) parks awaiting instead of being nudged', async () => {
    const waiter = start('mock:pause wait for the API task');
    store.updateRun(waiter.id, { waits: [edge()] });
    await waitFor(waiter.id, (r) => r?.activity === 'monitoring');
    expect(store.getRun(waiter.id)?.status).toBe('running');
    expect(internals().exemptParks.get(waiter.id)).toBe('awaiting');
    // No periodic wake: the edge is the wake source.
    expect(internals().active.get(waiter.id)?.monitoringWakeTimer).toBeUndefined();
    expect(store.getRun(waiter.id)?.monitoringWakeAt).toBeUndefined();
    // Not nudged: the autonomous continue note never appears.
    expect(notes(waiter.id).some((n) => n.startsWith('autonomous — continuing'))).toBe(false);
    // Slot-exempt even with maxMonitoringSessions: 0.
    expect(internals().busySlots()).toBe(0);
  }, 40_000);

  it('a CONTINUATION (runContinuation) parks awaiting instead of being nudged', async () => {
    const waiter = start('mock:done first pass');
    await waitFor(waiter.id, (r) => r?.status === 'done' || r?.status === 'review');
    const resumed = manager.continueRun(waiter.id, { text: 'mock:pause now wait for the API task' });
    expect(resumed.ok).toBe(true);
    store.updateRun(waiter.id, { waits: [edge()] });
    await waitFor(waiter.id, (r) => r?.activity === 'monitoring');
    expect(internals().exemptParks.get(waiter.id)).toBe('awaiting');
    expect(internals().active.get(waiter.id)?.monitoringWakeTimer).toBeUndefined();
    expect(notes(waiter.id).some((n) => n.startsWith('autonomous — continuing'))).toBe(false);
  }, 40_000);

  it('a resolved edge does not park the run (guard)', async () => {
    const waiter = start('mock:pause nothing pending');
    store.updateRun(waiter.id, { waits: [edge('settled')] });
    await waitFor(waiter.id, () => notes(waiter.id).some((n) => n.startsWith('autonomous — continuing')));
    expect(internals().exemptParks.has(waiter.id)).toBe(false);
  }, 40_000);

  it('CEZ_TASK_WAITS=0 leaves the edge inert: the pre-feature turn-end rules apply (guard)', async () => {
    process.env.CEZ_TASK_WAITS = '0';
    const waiter = start('mock:pause waits are off');
    store.updateRun(waiter.id, { waits: [edge()] });
    await waitFor(waiter.id, () => notes(waiter.id).some((n) => n.startsWith('autonomous — continuing')));
    expect(internals().exemptParks.has(waiter.id)).toBe(false);
  }, 40_000);

  it('a plain CEZ:MONITORING park still arms its wake timer (guard)', async () => {
    const watcher = start('mock:monitoring watching my own work');
    await waitFor(watcher.id, (r) => r?.activity === 'monitoring');
    expect(internals().exemptParks.has(watcher.id)).toBe(false);
    expect(internals().active.get(watcher.id)?.monitoringWakeTimer).toBeDefined();
  }, 40_000);

  it('a restarted waiter resumes with a note naming what it still waits for', async () => {
    const record = store.createRun({ title: 'Waiter', workflow: 'quick-task', task: 't', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
    store.updateStep(record.id, 'task', { status: 'running', sessionId: 'sess-1' });
    store.updateRun(record.id, { status: 'running', activity: 'monitoring', waits: [edge()] });
    await manager.recover();
    started.push(record.id);
    const pending = (manager as unknown as { pendingContinuations: Map<string, { prompt: string }> }).pendingContinuations;
    const prompt = pending.get(record.id)?.prompt ?? '';
    expect(prompt).toContain('The cezar process restarted');
    expect(prompt).toContain('You are still waiting for "Add export endpoint" (other/target-r)');
  });
});
