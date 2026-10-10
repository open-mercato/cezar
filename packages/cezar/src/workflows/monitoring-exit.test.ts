import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handoffPath } from '../handoff.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { DEFAULT_IDLE_TIMEOUT_MINUTES } from '../workspace/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import {
  endsWithDoneMarker,
  MAX_AUTO_CONTINUES,
  MONITORING_LIVENESS_MS,
  RunManager,
} from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MINUTES * 60_000;
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const SINGLE_STEP: WorkflowDef = {
  name: 'quick-task',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};

interface MonitorState {
  idleTimer?: NodeJS.Timeout;
  monitoringWakeTimer?: NodeJS.Timeout;
  monitoringLivenessTimer?: NodeJS.Timeout;
  monitoringLivenessAtCap?: boolean;
  monitoringWakeups?: number;
  session?: { open: boolean };
}

describe('endsWithDoneMarker tolerates trailing task-reference lines', () => {
  it.each([
    ['the bare marker', 'all done\n\nCEZ:DONE'],
    ['the marker followed by a PR declaration', 'opened the PR\nCEZ:DONE\nCEZ:PR=4242'],
    ['the marker followed by every reference', 'x\nCEZ:DONE\nCEZ:PR=1\nCEZ:ISSUE=2\nCEZ:TITLE=t'],
  ])('detects %s', (_name, turnText) => {
    expect(endsWithDoneMarker(turnText)).toBe(true);
  });

  it.each([
    ['a markerless turn', 'Which one first?'],
    ['references with no marker', 'Opened it.\nCEZ:PR=42'],
    ['a marker with prose after it', 'CEZ:DONE\nactually, one question'],
  ])('does not detect %s', (_name, turnText) => {
    expect(endsWithDoneMarker(turnText)).toBe(false);
  });

  it('is a strict superset of the plain `$`-anchored predicate', () => {
    for (const text of ['CEZ:DONE', 'a\nCEZ:DONE  \n', 'CEZ:DONE\nCEZ:PR=1', 'no']) {
      if (/CEZ:DONE\s*$/.test(text.trimEnd())) expect(endsWithDoneMarker(text)).toBe(true);
    }
  });
});

describe('a parked monitor always has an exit', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  let savedDryRun: string | undefined;

  const boot = (monitoringWakeIntervalMinutes?: number | null) => {
    manager?.dispose();
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes } }),
    });
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-monitor-exit-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    currentId = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (currentId) manager.cancel(currentId);
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const stateOf = (id: string) =>
    (manager as unknown as { active: Map<string, MonitorState> }).active.get(id);
  const notes = (id: string) => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [] as string[];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .filter((event) => event.type === 'note')
      .map((event) => String(event.message));
  };
  const heartbeats = (id: string) =>
    readFileSync(handoffPath(join(repoRoot, '.ai/cezar'), id), 'utf8')
      .split('\n')
      .filter((line) => /^- \d{4}-\d\d-\d\dT\S+ — /.test(line))
      .map((line) => line.replace(/^- \S+ — /, ''));
  const isMonitoring = (r: RunRecord | undefined) => r?.activity === 'monitoring';
  const startMonitor = async (task = 'mock:monitoring keep going') => {
    const record = manager.startRun(SINGLE_STEP, { task, worktree: false });
    currentId = record.id;
    await waitFor(record.id, isMonitoring);
    return record.id;
  };
  const addChild = (parentId: string, status: RunRecord['status']) => {
    store.updateRun(parentId, { dispatch: { rootRunId: parentId } });
    const child = store.createRun({ title: 'child', workflow: 'quick-task', task: 'child', steps: [] });
    store.updateRun(child.id, { status, dispatch: { rootRunId: parentId, parentRunId: parentId } });
    return child.id;
  };

  it('parks `waiting`, never `done`, when a childless monitor hears nothing for the liveness window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    boot(null);
    const id = await startMonitor();
    expect(stateOf(id)?.monitoringLivenessTimer).toBeDefined();

    vi.advanceTimersByTime(MONITORING_LIVENESS_MS - 1_000);
    expect(store.getRun(id)?.activity).toBe('monitoring');

    vi.advanceTimersByTime(1_000);
    const parked = store.getRun(id);
    expect(parked?.status).toBe('waiting');
    expect(parked?.activity).toBeUndefined();
    expect(parked?.askParked).toBe(true);
    expect(stateOf(id)?.session?.open).toBe(true);
    expect(stateOf(id)?.idleTimer).toBeDefined();
  }, 30_000);

  it.each([5, 30])('tracks a configured idle timeout of %s minutes through hand-off and settlement', async (idleTimeoutMinutes) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: null, idleTimeoutMinutes } }),
    });
    const id = await startMonitor();
    const timeoutMs = idleTimeoutMinutes * 60_000;

    vi.advanceTimersByTime(4 * timeoutMs - 1_000);
    expect(store.getRun(id)?.activity).toBe('monitoring');
    vi.advanceTimersByTime(1_000);
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.askParked).toBe(true);
    expect(stateOf(id)?.session?.open).toBe(true);
    expect(stateOf(id)?.idleTimer).toBeDefined();
    expect(notes(id)).toContain(`monitoring with no activity for ${4 * idleTimeoutMinutes}m; parked for your reply`);

    vi.advanceTimersByTime(timeoutMs - 1_000);
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(stateOf(id)?.session?.open).toBe(true);
    vi.advanceTimersByTime(1_000);
    await waitFor(id, (r) => r?.status === 'failed');
    expect(store.getRun(id)?.error).toBe('the session closed before you replied — continue to reply');
  }, 30_000);

  it.each([null, 0])('rests at `waiting` with attention after the fallback bound when idle timeout is %s', async (idleTimeoutMinutes) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: null, idleTimeoutMinutes } }),
    });
    const id = await startMonitor();
    vi.advanceTimersByTime(MONITORING_LIVENESS_MS - 1_000);
    expect(store.getRun(id)?.activity).toBe('monitoring');
    vi.advanceTimersByTime(1_000);
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.activity).toBeUndefined();
    expect(store.getRun(id)?.askParked).toBe(true);
    expect(stateOf(id)?.idleTimer).toBeUndefined();
    expect(stateOf(id)?.monitoringLivenessTimer).toBeUndefined();
    expect(stateOf(id)?.monitoringWakeTimer).toBeUndefined();

    vi.advanceTimersByTime(24 * 60 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.askParked).toBe(true);
    expect(store.getRun(id)?.error).toBeUndefined();
    expect(stateOf(id)?.session?.open).toBe(true);
    expect(stateOf(id)?.idleTimer).toBeUndefined();
    expect(notes(id)).toContain('monitoring with no activity for 60m; parked for your reply');
  }, 30_000);

  it('settles an unanswered hand-off `failed` with Continue, never `done` or `review`', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    boot(null);
    const id = await startMonitor();
    vi.advanceTimersByTime(MONITORING_LIVENESS_MS);
    expect(store.getRun(id)?.status).toBe('waiting');

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS);
    await waitFor(id, (r) => r?.status !== 'waiting');
    const settled = store.getRun(id);
    expect(settled?.status).toBe('failed');
    expect(settled?.error).toBe('the session closed before you replied — continue to reply');
    expect(settled?.awaitingAnswerSince).toBe(settled?.finishedAt);
    expect(settled?.steps.map((s) => s.status)).toEqual(['failed']);
    expect(settled?.askParked).toBeUndefined();
    await waitFor(id, () => stateOf(id) === undefined);
    expect(manager.continueRun(id, { text: 'carry on' }).ok).toBe(true);
  }, 30_000);

  it('settles an unanswered hand-off `failed` on the continuation session too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    boot(null);
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done finish it', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review');
    await waitFor(record.id, () => stateOf(record.id) === undefined);
    expect(manager.continueRun(record.id, { text: 'mock:monitoring keep watching' }).ok).toBe(true);
    await waitFor(record.id, isMonitoring);
    expect(stateOf(record.id)?.monitoringLivenessTimer).toBeDefined();

    vi.advanceTimersByTime(MONITORING_LIVENESS_MS);
    expect(store.getRun(record.id)?.status).toBe('waiting');
    expect(store.getRun(record.id)?.askParked).toBe(true);

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS);
    await waitFor(record.id, (r) => r?.status !== 'waiting');
    expect(store.getRun(record.id)?.status).toBe('failed');
    expect(store.getRun(record.id)?.error).toBe('the session closed before you replied — continue to reply');
  }, 30_000);

  it('a restart settles a handed-off monitor `failed`, not as a success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    boot(null);
    const id = await startMonitor();
    vi.advanceTimersByTime(MONITORING_LIVENESS_MS);
    expect(store.getRun(id)?.status).toBe('waiting');
    store.flush();

    const reopened = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    const restarted = new RunManager(reopened, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
    });
    await restarted.recover();
    restarted.dispose();
    expect(reopened.getRun(id)?.status).toBe('failed');
    expect(reopened.getRun(id)?.error).toContain('waiting for an answer');
  }, 30_000);

  it('reports a handed-off dispatched child to its parent after a restart', async () => {
    boot(null);
    const parentId = await startMonitor('mock:monitoring wait for the child');
    const childId = addChild(parentId, 'waiting');
    store.updateRun(childId, { askParked: true });
    // Keep the parent out of `recover`'s own live set so only the child's settlement is under test.
    store.updateRun(parentId, { status: 'cancelled' });
    store.flush();

    const reopened = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    const restarted = new RunManager(reopened, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
    });
    await restarted.recover();
    restarted.dispose();
    expect(reopened.getRun(childId)?.status).toBe('failed');
    expect(reopened.getRun(childId)?.error).toContain('waiting for an answer');
    expect(
      reopened.getRun(parentId)?.dispatch?.pendingReports?.some((r) => r.fromRunId === childId),
    ).toBe(true);
  }, 30_000);

  it('hands the run to the user at the wake-up cap instead of leaving it open with no timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    boot(5);
    const id = await startMonitor('mock:monitoring-sticky watch CI forever');
    for (let wake = 1; wake <= MAX_AUTO_CONTINUES; wake += 1) {
      vi.advanceTimersByTime(5 * 60_000);
      await waitFor(id, () => notes(id).some((n) => n.endsWith(`(${wake}/${MAX_AUTO_CONTINUES})`)));
      await waitFor(id, (r) => isMonitoring(r) || r?.status === 'waiting');
    }
    await waitFor(id, (r) => r?.status === 'waiting');
    const parked = store.getRun(id);
    expect(parked?.activity).toBeUndefined();
    expect(parked?.monitoringWakeCapReached).toBe(true);
    expect(parked?.askParked).toBe(true);
    expect(stateOf(id)?.session?.open).toBe(true);
    expect(stateOf(id)?.idleTimer).toBeDefined();
    // Newest first: the hand-off is the last thing that happened.
    expect(heartbeats(id).slice(0, 2)).toEqual(['monitoring ended — status=waiting', 'turn complete — status=monitoring']);
  }, 120_000);

  it('at the cap waits for an in-flight child, then hands off after the report re-parks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    boot(5);
    const id = await startMonitor('mock:monitoring-sticky watch the children');
    const childId = addChild(id, 'running');
    const state = stateOf(id);
    if (!state) throw new Error('no active state');
    state.monitoringWakeups = MAX_AUTO_CONTINUES;

    vi.advanceTimersByTime(5 * 60_000);
    expect(notes(id)).toContain(
      `automatic monitoring wake-up cap reached (${MAX_AUTO_CONTINUES}); session remains parked for its dispatched tasks' reports`,
    );
    expect(store.getRun(id)?.activity).toBe('monitoring');
    expect(stateOf(id)?.monitoringWakeTimer).toBeUndefined();

    store.updateRun(childId, { status: 'done' });
    (manager as unknown as { reportSettledChildToParent(runId: string): void }).reportSettledChildToParent(childId);
    await waitFor(id, (r) => r?.status === 'waiting');
    expect(store.getRun(id)?.askParked).toBe(true);
    expect(notes(id)).toContain(`automatic monitoring wake-up cap reached (${MAX_AUTO_CONTINUES}); parked for your reply`);
  }, 30_000);

  it('keeps a fallback exit for a capped monitor whose queued child is cancelled without delivering', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    boot(5);
    const id = await startMonitor('mock:monitoring-sticky wait on the queued child');
    const childId = addChild(id, 'queued');
    const state = stateOf(id);
    if (!state) throw new Error('no active state');
    state.monitoringWakeups = MAX_AUTO_CONTINUES;

    vi.advanceTimersByTime(5 * 60_000);
    expect(store.getRun(id)?.activity).toBe('monitoring');
    expect(stateOf(id)?.monitoringWakeTimer).toBeUndefined();
    // The cap spends the interval's exit, so the liveness bound must return as the fallback.
    expect(stateOf(id)?.monitoringLivenessTimer).toBeDefined();

    // Mirror `cancelOne`'s queued branch: it settles the child and persists the report, never
    // delivering it and never pumping the manager.
    store.updateRun(childId, { status: 'cancelled', finishedAt: new Date().toISOString() });
    (manager as unknown as { reportSettledChildToParent(runId: string): void }).reportSettledChildToParent(childId);
    expect(
      store.getRun(id)?.dispatch?.pendingReports?.some((r) => r.fromRunId === childId),
    ).toBe(true);
    expect(store.getRun(id)?.activity).toBe('monitoring');

    vi.advanceTimersByTime(MONITORING_LIVENESS_MS);
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.askParked).toBe(true);
  }, 30_000);

  it('keeps the at-cap fallback when a child outlives the first liveness window and is then cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    boot(5);
    const id = await startMonitor('mock:monitoring-sticky wait on a long child');
    const childId = addChild(id, 'queued');
    const state = stateOf(id);
    if (!state) throw new Error('no active state');
    state.monitoringWakeups = MAX_AUTO_CONTINUES;

    // The first interval reaches the cap while the child is in flight, so the liveness fallback
    // is armed at the cap.
    vi.advanceTimersByTime(5 * 60_000);
    expect(store.getRun(id)?.activity).toBe('monitoring');
    expect(stateOf(id)?.monitoringWakeTimer).toBeUndefined();
    expect(stateOf(id)?.monitoringLivenessTimer).toBeDefined();
    expect(stateOf(id)?.monitoringLivenessAtCap).toBe(true);

    // The liveness window expires with the child STILL in flight: the re-arm has to keep the cap
    // allowance, or the interval guard drops it and no timer remains.
    vi.advanceTimersByTime(MONITORING_LIVENESS_MS);
    expect(store.getRun(id)?.activity).toBe('monitoring');
    expect(stateOf(id)?.monitoringLivenessTimer).toBeDefined();
    expect(stateOf(id)?.monitoringLivenessAtCap).toBe(true);

    // Now the queued child is cancelled without a delivered report.
    store.updateRun(childId, { status: 'cancelled', finishedAt: new Date().toISOString() });
    (manager as unknown as { reportSettledChildToParent(runId: string): void }).reportSettledChildToParent(childId);
    expect(
      store.getRun(id)?.dispatch?.pendingReports?.some((r) => r.fromRunId === childId),
    ).toBe(true);
    expect(store.getRun(id)?.activity).toBe('monitoring');

    vi.advanceTimersByTime(MONITORING_LIVENESS_MS);
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.askParked).toBe(true);
  }, 30_000);

  it('hands off through the liveness bound when the in-flight child is cancelled and never reports', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    boot(null);
    const id = await startMonitor();
    const childId = addChild(id, 'running');

    vi.advanceTimersByTime(MONITORING_LIVENESS_MS);
    expect(store.getRun(id)?.activity).toBe('monitoring');
    expect(stateOf(id)?.monitoringLivenessTimer).toBeDefined();

    store.updateRun(childId, { status: 'cancelled' });
    (manager as unknown as { reportSettledChildToParent(runId: string): void }).reportSettledChildToParent(childId);
    expect(store.getRun(id)?.activity).toBe('monitoring');

    vi.advanceTimersByTime(MONITORING_LIVENESS_MS);
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.askParked).toBe(true);
  }, 30_000);

  it('does not refill the wake-up budget on a child report', async () => {
    boot();
    const id = await startMonitor();
    const childId = addChild(id, 'done');
    const state = stateOf(id);
    if (!state) throw new Error('no active state');
    state.monitoringWakeups = 7;
    (manager as unknown as { reportSettledChildToParent(runId: string): void }).reportSettledChildToParent(childId);
    expect(notes(id).some((n) => n.startsWith('report received from task'))).toBe(true);
    expect(state.monitoringWakeups).toBe(7);
  }, 30_000);

  it('spends no blind wake-up turn and keeps monitoring while a dispatched child is in flight', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    boot(5);
    const id = await startMonitor();
    addChild(id, 'running');

    vi.advanceTimersByTime(MONITORING_LIVENESS_MS + 5 * 60_000);
    await new Promise((r) => setTimeout(r, 400));
    expect(notes(id).some((n) => n.startsWith('automatic monitoring wake-up ('))).toBe(false);
    expect(store.getRun(id)?.activity).toBe('monitoring');
    expect(stateOf(id)?.monitoringWakeTimer).toBeDefined();
    // A configured interval IS the exit, so no park-mode liveness timer competes with it.
    expect(stateOf(id)?.monitoringLivenessTimer).toBeUndefined();
    // The re-armed check is a fallback the child's report will pre-empt; it must not show as a
    // promised deadline in the cockpit.
    expect(store.getRun(id)?.monitoringWakeAt).toBeUndefined();
  }, 30_000);

  it('wakes at the maximum interval instead of being pre-empted by the liveness bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    boot(60);
    const id = await startMonitor('mock:monitoring-sticky watch CI at the slowest cadence');
    expect(stateOf(id)?.monitoringWakeTimer).toBeDefined();
    expect(stateOf(id)?.monitoringLivenessTimer).toBeUndefined();

    vi.advanceTimersByTime(60 * 60_000);
    await waitFor(id, () => notes(id).some((n) => n === `automatic monitoring wake-up (1/${MAX_AUTO_CONTINUES})`));
    await waitFor(id, (r) => r?.activity === 'monitoring');
    expect(store.getRun(id)?.status).toBe('running');
  }, 30_000);

  it('a user message still resumes a parked monitor and clears its liveness timer', async () => {
    boot(null);
    const id = await startMonitor();
    expect(stateOf(id)?.monitoringLivenessTimer).toBeDefined();
    expect(manager.sendMessage(id, [{ type: 'text', text: 'thanks, carry on' }])).toBe(true);
    expect(stateOf(id)?.monitoringLivenessTimer).toBeUndefined();
    await waitFor(id, (r) => r?.status === 'waiting');
  }, 30_000);

  it('closes on `CEZ:DONE` followed by a task reference at the first-session turn-end', async () => {
    boot();
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done-refs finish it', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review' || r?.status === 'waiting');
    expect(store.getRun(record.id)?.status).not.toBe('waiting');
    expect(store.getRun(record.id)?.prNumber).toBe(4243);
  }, 30_000);

  it('closes on `CEZ:DONE` followed by a task reference at the continuation turn-end', async () => {
    boot();
    const record = manager.startRun(SINGLE_STEP, { task: 'just do the thing', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(manager.sendMessage(record.id, [{ type: 'text', text: 'mock:done-refs finish it' }])).toBe(true);
    await waitFor(record.id, (r) => r?.prNumber === 4243);
    await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review' || r?.status === 'waiting');
    expect(store.getRun(record.id)?.status).not.toBe('waiting');
  }, 30_000);
});
