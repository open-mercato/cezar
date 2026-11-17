import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { MAX_CONSECUTIVE_EMPTY_TURNS, RunManager } from './run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

describe('work continuation gate at the live engine seam', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let id: string;
  let dry: string | undefined;
  const wait = async (predicate: () => boolean) => {
    const end = Date.now() + 15000;
    while (!predicate()) { if (Date.now() > end) throw new Error('engine did not reach expected state'); await new Promise(r => setTimeout(r, 20)); }
  };
  beforeEach(() => {
    dry = process.env.CEZ_DRY_RUN; process.env.CEZ_DRY_RUN = '1';
    root = mkdtempSync(join(tmpdir(), 'cez-hygiene-engine-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'base'), 'base'); execFileSync('git', ['add', 'base'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: null } }) });
  });
  afterEach(async () => {
    if (id) manager.cancel(id);
    manager.dispose();
    await wait(() => !id || !manager.isActive(id));
    store.flush(); rmSync(root, { recursive: true, force: true });
    if (dry === undefined) delete process.env.CEZ_DRY_RUN; else process.env.CEZ_DRY_RUN = dry;
  });
  it('refuses work and monitoring wake at three; a stale choice cannot buy a turn', async () => {
    id = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:monitoring keep going', worktree: false }).id;
    await wait(() => store.getRun(id)?.activity === 'monitoring');
    store.updateRun(id, { threadHygiene: { continuations: 3, historyKnown: true } });
    const state = (manager as any).active.get(id);
    let sends = 0;
    const original = state.session.sendMessage.bind(state.session);
    state.session.sendMessage = (...args: any[]) => { sends++; return original(...args); };
    (manager as any).monitoringWake(id, state);
    expect(sends).toBe(0); expect(store.getRun(id)?.threadHygiene?.pending).toBeDefined();
    expect(manager.sendMessage(id, [{ type: 'text', text: 'work' }])).toBe(false);
    expect(manager.resumeThreadHygiene(id, { action: 'continue', expectedCount: 2 }, [{ type: 'text', text: 'work' }]).ok).toBe(false);
    expect(sends).toBe(0);
    expect(manager.resumeThreadHygiene(id, { action: 'continue', expectedCount: 3 }, [{ type: 'text', text: 'mock:monitoring keep going' }]).ok).toBe(true);
    expect(sends).toBe(1); expect(store.getRun(id)?.threadHygiene?.continuations).toBe(4);
    await wait(() => store.getRun(id)?.activity === 'monitoring');
    expect(manager.sendMessage(id, [{ type: 'text', text: 'again' }])).toBe(false);
    expect(sends).toBe(1);
  });
  it('retains a child report without a parent model call or cancelling the child', async () => {
    id = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:monitoring keep going', worktree: false }).id;
    await wait(() => store.getRun(id)?.activity === 'monitoring');
    store.updateRun(id, { dispatch: { rootRunId: id }, threadHygiene: { continuations: 3, historyKnown: true } });
    const child = store.createRun({ title: 'child', workflow: 'quick-task', task: 'result', steps: [] });
    store.updateRun(child.id, { dispatch: { rootRunId: id, parentRunId: id }, status: 'done', finishedAt: new Date().toISOString() });
    const state = (manager as any).active.get(id); let sends = 0;
    state.session.sendMessage = () => { sends++; return true; };
    (manager as any).reportSettledChildToParent(child.id);
    expect(sends).toBe(0); expect(store.getRun(child.id)?.status).toBe('done');
    expect(store.getRun(id)?.dispatch?.pendingReports?.some(report => report.fromRunId === child.id)).toBe(true);
    expect(store.getRun(id)?.threadHygiene?.pending).toBeDefined();
  });
  it('the unmocked default stops autonomous nudges at three before the older empty-turn brake', async () => {
    id = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:empty keep going', worktree: false, autonomous: true }).id;
    await wait(() => store.getRun(id)?.threadHygiene?.pending !== undefined);
    const record = store.getRun(id)!;
    expect(record.threadHygiene?.continuations).toBe(3);
    const events = readFileSync(join(root, '.ai/cezar/runs', `${id}.ndjson`), 'utf8');
    expect(events.match(/autonomous — continuing without pausing/g)).toHaveLength(3);
    expect(events).not.toContain('consecutive turns produced no output');
    const state = (manager as any).active.get(id);
    expect(state.autoContinues).toBe(3);
  });
  it('the pre-existing empty-turn brake still wins when both boundaries apply', async () => {
    id = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:monitoring keep going', worktree: false }).id;
    await wait(() => store.getRun(id)?.activity === 'monitoring');
    store.updateRun(id, { threadHygiene: { continuations: 3, historyKnown: true } });
    const state = (manager as any).active.get(id);
    state.autonomous = true; state.emptyTurnStreak = MAX_CONSECUTIVE_EMPTY_TURNS;
    expect((manager as any).tryAutonomousNudge(id, state, 'task', null, { hasDispatch: false, dispatched: false, overBudget: false, rePrompted: false })).toBe(false);
    expect(store.getRun(id)?.threadHygiene?.pending).toBeUndefined();
  });
  it('a child report during approved ongoing work does not spend another continuation', async () => {
    id = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:monitoring keep going', worktree: false }).id;
    await wait(() => store.getRun(id)?.activity === 'monitoring');
    (manager as any).leaveMonitoring(id); (manager as any).waiting.delete(id);
    store.updateRun(id, { status: 'running', activity: undefined, dispatch: { rootRunId: id }, threadHygiene: { continuations: 4, historyKnown: true } });
    const child = store.createRun({ title: 'child', workflow: 'quick-task', task: 'result', steps: [] });
    store.updateRun(child.id, { dispatch: { rootRunId: id, parentRunId: id }, status: 'done', finishedAt: new Date().toISOString() });
    const state = (manager as any).active.get(id); state.supervisedContinues = 7; let sends = 0;
    state.session.sendMessage = () => { sends++; return true; };
    (manager as any).reportSettledChildToParent(child.id);
    expect(sends).toBe(1); expect(store.getRun(id)?.threadHygiene?.continuations).toBe(4);
    expect(store.getRun(id)?.threadHygiene?.pending).toBeUndefined(); expect(state.supervisedContinues).toBe(0);
  });

  it('counts one accepted resumption across asynchronous repository lease reacquisition', async () => {
    id = store.createRun({ title: 'lease', workflow: 'quick-task', task: 't', steps: [] }).id;
    store.updateRun(id, { status: 'waiting', threadHygiene: { continuations: 2, historyKnown: true } });
    const sent: unknown[][] = [];
    const state: any = { ownerToken: Symbol('test'), cancelled: false, interrupt: () => {}, repoRootParked: true,
      session: { open: true, sendMessage: (blocks: unknown[]) => { sent.push(blocks); return true; } } };
    (manager as any).active.set(id, state); (manager as any).waiting.add(id);
    (manager as any).claimFreeRepoRoot = () => false;
    let release!: (ok: boolean) => void;
    (manager as any).resumeRepoRoot = () => new Promise<boolean>(resolve => { release = resolve; });
    try {
      expect(manager.sendMessage(id, [{ type: 'text', text: 'actual work' }], undefined, 'lease-operation')).toBe(true);
      expect(store.getRun(id)?.threadHygiene?.continuations).toBe(3);
      state.repoRootParked = false; release(true); await new Promise(r => setTimeout(r, 0));
      expect(sent).toHaveLength(1); expect(JSON.stringify(sent)).toContain('actual work');
      expect(JSON.stringify(sent)).toContain('another task held this repository');
      expect(store.getRun(id)?.threadHygiene?.continuations).toBe(3);
      expect(manager.sendMessage(id, [{ type: 'text', text: 'actual work' }], undefined, 'lease-operation')).toBe(true);
      expect(sent).toHaveLength(1);
      (manager as any).waiting.add(id);
      expect(manager.sendMessage(id, [{ type: 'text', text: 'next work' }])).toBe(false);
      expect(sent).toHaveLength(1);
    } finally { (manager as any).active.delete(id); }
  });
  it('counts only the report releasing an all-child graph wait and gates the next release', async () => {
    id = store.createRun({ title: 'graph', workflow: 'quick-task', task: 't', steps: [] }).id;
    store.updateRun(id, { status: 'running', dispatch: { rootRunId: id }, threadHygiene: { continuations: 2, historyKnown: true } });
    const state: any = { ownerToken: Symbol('graph'), cancelled: false, interrupt: () => {} };
    (manager as any).active.set(id, state);
    const child = () => {
      const run = store.createRun({ title: 'child', workflow: 'quick-task', task: 'result', steps: [] });
      store.updateRun(run.id, { status: 'running', dispatch: { rootRunId: id, parentRunId: id } });
      return run;
    };
    const settle = (childId: string) => {
      store.updateRun(childId, { status: 'done', finishedAt: new Date().toISOString() });
      (manager as any).reportSettledChildToParent(childId);
    };
    const first = child(), second = child();
    let waiting = (manager as any).awaitChildren(id, state, 'task', [first.id, second.id], 'all');
    try {
      settle(first.id); expect(store.getRun(id)?.threadHygiene?.continuations).toBe(2);
      expect(store.getRun(id)?.threadHygiene?.pending).toBeUndefined();
      settle(second.id); await waiting;
      expect(store.getRun(id)?.threadHygiene?.continuations).toBe(3);
      const third = child();
      waiting = (manager as any).awaitChildren(id, state, 'task', [third.id], 'all');
      settle(third.id);
      expect(store.getRun(id)?.threadHygiene?.continuations).toBe(3);
      expect(store.getRun(id)?.threadHygiene?.pending).toBeDefined();
      expect(store.getRun(id)?.dispatch?.pendingReports?.some(report => report.fromRunId === third.id)).toBe(true);
      expect(manager.resumeThreadHygiene(id, { action: 'continue', expectedCount: 3 }, [{ type: 'text', text: 'continue' }]).ok).toBe(true);
      await waiting; expect(store.getRun(id)?.threadHygiene?.continuations).toBe(4);
    } finally { state.cancelled = true; state.interrupt(); await waiting; (manager as any).active.delete(id); }
  });
  it('rejected model selection spends no continuation and pending choices retain engine overrides', () => {
    id = store.createRun({ title: 'closed', workflow: 'quick-task', task: 't', runner: 'claude', steps: [{ id: 'task', kind: 'agent', name: 'Task' }] }).id;
    store.updateStep(id, 'task', { sessionId: 'old-session', status: 'done', backend: 'claude' });
    store.updateRun(id, { status: 'done', threadHygiene: { continuations: 2, historyKnown: true } });
    expect(manager.continueRun(id, { model: 'gpt-5' }).ok).toBe(false);
    expect(store.getRun(id)?.threadHygiene?.continuations).toBe(2);
    store.updateRun(id, { threadHygiene: { continuations: 3, historyKnown: true, pending: { reason: 'continue', since: new Date().toISOString() } } });
    let captured: unknown;
    manager.continueRun = (_id, opts) => { captured = opts; return { ok: true }; };
    expect(manager.resumeThreadHygiene(id, { action: 'continue', expectedCount: 3 }, [{ type: 'text', text: 'next' }], { runner: 'codex', model: 'gpt-5', agentProfile: 'chosen', reasoningEffort: 'high' }).ok).toBe(true);
    expect(captured).toMatchObject({ runner: 'codex', model: 'gpt-5', agentProfile: 'chosen', reasoningEffort: 'high', text: 'next' });
  });

  it('startup recovery keeps a gated monitor resumable without buying a model turn', async () => {
    id = store.createRun({ title: 'restored monitor', workflow: 'quick-task', task: 't', worktree: false, steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }).id;
    store.updateStep(id, 'task', { status: 'waiting', sessionId: '22222222-2222-4222-8222-222222222222', backend: 'claude' });
    store.updateRun(id, { status: 'running', activity: 'monitoring', threadHygiene: { continuations: 3, historyKnown: true, pending: { reason: 'monitoring', since: '2026-11-17T10:00:00.000Z' } } });
    await manager.recover();
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.idleClosedAt).toBe('2026-11-17T10:00:00.000Z');
    expect(manager.isActive(id)).toBe(false);
    expect(store.getRun(id)?.threadHygiene?.continuations).toBe(3);
    expect(manager.resumeThreadHygiene(id, { action: 'continue', expectedCount: 3 }, [{ type: 'text', text: 'mock:done next' }]).ok).toBe(true);
    expect(store.getRun(id)?.threadHygiene?.continuations).toBe(4);
  });

});
