import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DispatchInput, RunDispatch } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { WorkspaceSemaphore, type WorkspaceResourceLimits } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Task dispatch's ENGINE (spec `.ai/specs/2026-09-10-dispatch.md`), driven end to end through the
 * dry-run mock: a task that dispatches, refusals that are answers rather than crashes, the budget
 * brakes, the cancel cascade, the settle→parent report, the tree directory, and the Guard.
 *
 * Everything here is gated twice — `CEZ_DISPATCH=1` AND a `dispatch` on the record — so the last
 * describe block is the counterweight: the same turns on a run with no `dispatch` must behave
 * exactly as they did before this feature existed.
 *
 * The runs are real: real worktrees off a real temp repository, because the fork point IS the
 * feature and a `worktree: false` fixture could not observe it.
 */
describe('the dispatch engine (spec 2026-09-10-dispatch)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const started: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  const SINGLE_STEP: WorkflowDef = {
    name: '(planned)',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-dispatch-'));
    for (const key of ['CEZ_DRY_RUN', 'CEZ_DISPATCH']) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_DISPATCH = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = boot();
    started.length = 0;
  });

  afterEach(() => {
    for (const id of started) manager.cancel(id);
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A manager with its own semaphore, so a test can decide how much of the tree may run. */
  const boot = (limits: Partial<WorkspaceResourceLimits> = {}): RunManager =>
    new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: limits }) });

  /** Re-boot the manager with different limits (before anything has started). */
  const reboot = (limits: Partial<WorkspaceResourceLimits>): void => {
    manager.dispose();
    manager = boot(limits);
  };

  const start = (task: string, dispatch?: RunDispatch, extra: Record<string, unknown> = {}): RunRecord => {
    const record = manager.startRun(SINGLE_STEP, { task, ...(dispatch ? { dispatch } : {}), ...extra });
    started.push(record.id);
    return record;
  };

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time for ${id}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const notes = (id: string): string[] =>
    store
      .readEvents(id)
      .filter((event) => event.type === 'note')
      .map((event) => String((event as { message?: unknown }).message ?? ''));

  const childrenOf = (parentId: string): RunRecord[] =>
    store.listRuns().filter((r) => r.dispatch?.parentRunId === parentId);

  const settled = (r: RunRecord | undefined): boolean =>
    r !== undefined && ['done', 'review', 'failed', 'cancelled'].includes(r.status);

  /** Everything the mock has been handed on stdin so far — '' before its first session opens. */
  const stdin = (file: string): string => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };

  /** The full inbound message containing `needle` (the scripted replies only echo a slice). */
  const delivered = (file: string, needle: string): string | undefined =>
    stdin(file)
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { userText: string })
      .find((entry) => entry.userText.includes(needle))?.userText;

  const activeState = (id: string) =>
    (manager as unknown as {
      active: Map<string, { monitoringWakeTimer?: NodeJS.Timeout }>;
    }).active.get(id);

  /** A root's dispatch record — it names itself. */
  const rootOf = (id: string, budgetUsd?: number): RunDispatch => ({
    rootRunId: id,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
  });
  const childOf = (rootId: string, parentId = rootId): RunDispatch => ({ rootRunId: rootId, parentRunId: parentId });
  const treeDirOf = (rootId: string) => join(repoRoot, '.ai/cezar/dispatch', rootId);
  const order = (objective: string, extra: Partial<DispatchInput> = {}): DispatchInput => ({ objective, ...extra });
  /** Start a root that parks as a monitor, so dispatches against it are observable. */
  const parkedRoot = async (budgetUsd?: number): Promise<RunRecord> => {
    const record = start('mock:monitoring waiting on my tasks');
    store.updateRun(record.id, { dispatch: rootOf(record.id, budgetUsd) });
    await waitFor(record.id, (r) => r?.activity === 'monitoring');
    return record;
  };
  const dispatchOk = (parentId: string, input: DispatchInput): { id: string; branch?: string } => {
    const outcome = manager.dispatch(parentId, input);
    if ('refused' in outcome) throw new Error(`dispatch refused: ${outcome.refused}`);
    return outcome;
  };
  const refusal = (parentId: string, input: DispatchInput): string => {
    const outcome = manager.dispatch(parentId, input);
    if (!('refused' in outcome)) throw new Error('expected a refusal');
    return outcome.refused;
  };

  // ---- dispatch ------------------------------------------------------------------------------

  describe('dispatch()', () => {
    it('creates a child forked off the parent branch, with its order, budget and tree files', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const parent = await parkedRoot(20);
      const created = dispatchOk(parent.id, order('mock:done take the left flank', {
        title: 'Take the left flank',
        scope: 'src/left/**',
        max_cost: 2.5,
        success_criteria: 'the left half compiles and its tests pass',
        retry_limit: 1,
      }));
      const child = store.getRun(created.id);
      expect(child?.title).toBe('Take the left flank');
      expect(child?.dispatch).toEqual({ rootRunId: parent.id, parentRunId: parent.id, budgetUsd: 2.5 });
      expect(child?.autonomous).toBe(true);
      // The child forks off the PARENT's branch, which is what `execute()` reads.
      expect(child?.baseBranch).toBe(store.getRun(parent.id)?.branch);
      expect(child?.baseBranch).toMatch(/^cez\//);
      // The task order the child receives — its own scope, the fork point, its files.
      expect(child?.task).toContain('## Task order');
      expect(child?.task).toContain('- Scope: src/left/**');
      expect(child?.task).toContain('- Max cost: $2.50');
      expect(child?.task).toContain(`- Ordered by: run ${parent.id}`);
      expect(child?.task).toContain('brief.md');
      expect(child?.task).not.toContain('{{TREE_PATHS}}');
      const dir = join(treeDirOf(parent.id), 'units', created.id.slice(0, 8));
      expect(readFileSync(join(dir, 'order.md'), 'utf8')).toContain('Take the left flank');
      expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toContain('## Suggestions for the root');
      expect(readFileSync(join(treeDirOf(parent.id), 'brief.md'), 'utf8')).toContain('waiting on my tasks');
      expect(readFileSync(join(treeDirOf(parent.id), 'ledger.jsonl'), 'utf8')).toContain('"type":"dispatch"');
      // The parent's transcript says who it dispatched.
      expect(notes(parent.id).some((n) => n.startsWith('dispatched "Take the left flank"'))).toBe(true);
    }, 40_000);

    it('makes a plain task a root on its first dispatch — no record needed up front', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const parent = start('mock:monitoring plain task');
      await waitFor(parent.id, (r) => r?.activity === 'monitoring');
      expect(store.getRun(parent.id)?.dispatch).toBeUndefined();
      const created = dispatchOk(parent.id, order('mock:done a piece'));
      expect(store.getRun(parent.id)?.dispatch).toEqual({ rootRunId: parent.id });
      expect(store.getRun(created.id)?.dispatch?.rootRunId).toBe(parent.id);
    }, 40_000);

    it('parks the dispatching task as a monitor when its turn ends, surrendering its slot', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const stdinFile = join(repoRoot, 'mock-stdin-dispatch.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
      // A two-second turn: long enough to dispatch from "inside" it.
      const parent = start('mock:pause plan the work', undefined, { autonomous: true });
      await waitFor(parent.id, () => stdin(stdinFile).includes('plan the work'));
      dispatchOk(parent.id, order('mock:done a piece'));
      // The turn ends plainly; the dispatch makes it a monitoring park, not a nudge.
      await waitFor(parent.id, (r) => r?.activity === 'monitoring');
      expect(store.getRun(parent.id)?.status).toBe('running');
      expect(activeState(parent.id)?.monitoringWakeTimer).toBeDefined();
    }, 40_000);

    it('refuses a fifth child in flight, with the reason', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const parent = await parkedRoot(20);
      for (let i = 0; i < 4; i += 1) {
        const child = store.createRun({ title: `in flight ${i}`, workflow: '(planned)', task: 't', steps: [] });
        store.updateRun(child.id, { status: 'running', dispatch: childOf(parent.id) });
      }
      const reason = refusal(parent.id, order('one more'));
      expect(reason).toContain('the cap is 4');
      expect(childrenOf(parent.id)).toHaveLength(4);
      expect(notes(parent.id).some((n) => n.includes('dispatch refused') && n.includes('the cap is 4'))).toBe(true);
    }, 40_000);

    it('refuses a child that would overspend the parent, and hands an uncapped child the remainder', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const parent = await parkedRoot(1);
      expect(refusal(parent.id, order('too rich', { max_cost: 2.5 }))).toMatch(/only \$[\d.]+ of the budget is left/);
      const created = dispatchOk(parent.id, order('mock:done fits'));
      // The uncapped child gets the whole remainder — one child at a time, nobody to share with.
      const remainder = store.getRun(created.id)?.dispatch?.budgetUsd ?? 0;
      expect(remainder).toBeGreaterThan(0.5);
      expect(remainder).toBeLessThanOrEqual(1);
      expect(refusal(parent.id, order('nothing left'))).toContain('no budget left');
    }, 40_000);

    it('releases a settled child’s unspent budget to the parent', async () => {
      // Default slots: the parked parent and its child must both be able to run.
      const parent = await parkedRoot(5);
      const first = dispatchOk(parent.id, order('mock:done quick', { max_cost: 4 }));
      expect(refusal(parent.id, order('second', { max_cost: 3 }))).toMatch(/only \$[\d.]+ of the budget is left/);
      await waitFor(first.id, settled);
      // The first child settled far under its cap (a dry run costs cents at most), so its
      // reservation flows back and a second child of the same size fits.
      const second = dispatchOk(parent.id, order('mock:done second', { max_cost: 3 }));
      expect(store.getRun(second.id)?.dispatch?.budgetUsd).toBe(3);
    }, 60_000);

    it('refuses against a settled parent and while the feature is off', async () => {
      const parent = store.createRun({ title: 'done', workflow: 'quick-task', task: 't', steps: [] });
      store.updateRun(parent.id, { status: 'done', dispatch: rootOf(parent.id) });
      expect(refusal(parent.id, order('late'))).toContain('already settled');
      delete process.env.CEZ_DISPATCH;
      expect(refusal(parent.id, order('off'))).toContain('CEZ_DISPATCH=1');
    });
  });

  // ---- reports and the settle→parent wake ----------------------------------------------------

  describe('reports', () => {
    it('records a child’s own report and delivers it into the parent’s open session at settle', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;

      const parent = await parkedRoot();
      const child = start('mock:pause mock:done take the left flank', childOf(parent.id));
      await waitFor(child.id, (r) => r?.status === 'running');
      expect(
        manager.recordReport(child.id, {
          status: 'done',
          result: 'Took the left flank; the login handler now answers 401.',
          evidence: ['npm test -- auth → 12 passed'],
          side_effects: [],
          errors: [],
          suggestions: [],
          verdict: undefined,
        }),
      ).toBe(true);
      await waitFor(child.id, settled, 40_000);

      await waitFor(parent.id, () => stdin(stdinFile).includes('Report from task'));
      const text = delivered(stdinFile, 'Report from task');
      expect(text).toContain(`"${store.getRun(child.id)?.title}"`);
      expect(text).toContain(child.id);
      expect(text).toContain('status done');
      expect(text).toContain('evidence: npm test -- auth → 12 passed');
      // The branch is what makes a report actionable — it is what the parent has to merge.
      expect(text).toContain(`branch ${store.getRun(child.id)?.branch}`);
      // Delivering wakes the monitor: it is working again, not parked.
      expect(store.getRun(parent.id)?.activity).toBeUndefined();
      expect(notes(parent.id).some((n) => n.startsWith('report received from task'))).toBe(true);
      // Persist-then-ACK: the live session taking it retires the pending entry.
      await waitFor(parent.id, (r) => (r?.dispatch?.pendingReports?.length ?? 0) === 0);
      // And the tree directory has the report file.
      expect(readFileSync(join(treeDirOf(parent.id), 'units', child.id.slice(0, 8), 'report.md'), 'utf8')).toContain('"status": "done"');
    }, 60_000);

    it('refuses a report from a run outside any tree', () => {
      const plain = store.createRun({ title: 'plain', workflow: 'quick-task', task: 't', steps: [] });
      expect(manager.recordReport(plain.id, { status: 'done', result: 'x', evidence: [], side_effects: [], errors: [], suggestions: [] })).toBe(false);
    });

    it('persists a pending report for a parent with no session, and flushes it into its next prompt', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin-flush.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;

      // A parent that already FINISHED: no session, so the report can only be persisted.
      const parent = start('mock:done first pass');
      store.updateRun(parent.id, { dispatch: rootOf(parent.id) });
      await waitFor(parent.id, settled);
      const child = start('mock:done take the right flank', childOf(parent.id));
      await waitFor(child.id, settled);
      // Rung 4 of the delivery ladder: a finished parent is continued with the report.
      await waitFor(parent.id, () => stdin(stdinFile).includes('Report from task'), 40_000);
      const text = delivered(stdinFile, 'Report from task');
      expect(text).toContain(child.id);
    }, 60_000);

    it('forwards a settled child’s suggestions to the root’s inbox', async () => {
      const parent = await parkedRoot();
      const child = start('mock:pause mock:done take the right flank', childOf(parent.id));
      await waitFor(child.id, (r) => r?.status === 'running');
      manager.recordReport(child.id, {
        status: 'done',
        result: 'done',
        evidence: [],
        side_effects: [],
        errors: [],
        suggestions: ['split billing out of this order — it is a task of its own'],
      });
      await waitFor(child.id, settled, 40_000);
      const files = readdirSync(join(treeDirOf(parent.id), 'inbox', 'root'));
      const suggestion = files.find((name) => name.includes('suggestions'));
      expect(suggestion).toBeTruthy();
      expect(readFileSync(join(treeDirOf(parent.id), 'inbox', 'root', suggestion!), 'utf8')).toContain('split billing out of this order');
    }, 60_000);
  });

  // ---- the tree directory (the filesystem channel) -------------------------------------------

  describe('the tree directory', () => {
    it('wakes a parked parent when a file lands in its inbox', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin-inbox.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;

      const parent = await parkedRoot();
      // A child whose turn ends is the SIGNAL: it wrote into the root's inbox, then finished.
      const inbox = join(treeDirOf(parent.id), 'inbox', 'root');
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, 'scope-question.md'), '# Scope\n\nMay I touch billing?\n');
      const child = start('mock:done take the left flank', childOf(parent.id));
      await waitFor(child.id, settled);
      await waitFor(parent.id, () => stdin(stdinFile).includes('Tree inbox'));
      expect(delivered(stdinFile, 'Tree inbox')).toContain(join(inbox, 'scope-question.md'));
      expect(store.getRun(parent.id)?.dispatch?.inboxSeenAt).toBeTruthy();
      expect(notes(parent.id).some((n) => n.includes('new tree inbox message'))).toBe(true);
    }, 60_000);

    it('hands a working task its own inbox at turn end instead of parking it', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin-own-inbox.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
      const root = store.createRun({ title: 'root', workflow: 'quick-task', task: 'hold', steps: [] });
      store.updateRun(root.id, { status: 'waiting', dispatch: rootOf(root.id) });
      const child = start('mock:pause work on it', childOf(root.id), { autonomous: true });
      await waitFor(child.id, () => stdin(stdinFile).includes('work on it'));
      const inbox = join(treeDirOf(root.id), 'inbox', child.id.slice(0, 8));
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, 'from-parent.md'), '# Redirect\n\nStop at the API layer.\n');
      await waitFor(child.id, settled, 40_000);
      expect(store.getRun(child.id)?.status).toBe('done'); // the mock answers a digest with DONE
      expect(delivered(stdinFile, '## Tree inbox')).toContain('from-parent.md');
      expect(notes(child.id).some((n) => n.startsWith('tree inbox digest delivered into the session at turn end'))).toBe(true);
    }, 60_000);

    it('tells a parked parent, through its inbox, that a child is blocked on the Guard', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin-blocked.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
      const parent = await parkedRoot();
      const child = start('mock:ask which library?', childOf(parent.id), { autonomous: true });
      await waitFor(child.id, (r) => r?.status === 'waiting');
      expect(store.getRun(child.id)?.dispatch?.pendingAsk?.questions).toHaveLength(1);
      const rootInbox = join(treeDirOf(parent.id), 'inbox', 'root');
      const blocked = readdirSync(rootInbox).find((name) => name.includes('blocked-on-a-guard'));
      expect(blocked).toBeTruthy();
      await waitFor(parent.id, () => stdin(stdinFile).includes('## Tree inbox'));
      expect(store.getRun(child.id)?.status).toBe('waiting'); // nothing answered its question
    }, 60_000);
  });

  // ---- the pending question (the Guard) ------------------------------------------------------

  describe('pendingAsk', () => {
    it('records a dispatched run’s question when it parks and clears it when an answer is delivered', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:ask which library?', rootOf('m8'), { autonomous: true });
      await waitFor(record.id, (r) => r?.status === 'waiting');
      expect(store.getRun(record.id)?.dispatch?.pendingAsk?.questions).toHaveLength(1);
      expect(manager.sendMessage(record.id, [{ type: 'text', text: 'mock:done use date-fns' }])).toBe(true);
      expect(store.getRun(record.id)?.dispatch?.pendingAsk).toBeUndefined();
      await waitFor(record.id, settled);
    }, 40_000);
  });

  // ---- brakes -------------------------------------------------------------------------------

  it('parks an over-budget run at waiting — no autonomous nudge, no wake timer', async () => {
    reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
    const record = start('mock:monitoring keep going', rootOf('m6', 0), { autonomous: true });
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(store.getRun(record.id)?.dispatch?.overBudget).toBe(true);
    expect(store.getRun(record.id)?.activity).toBeUndefined();
    expect(activeState(record.id)?.monitoringWakeTimer).toBeUndefined();
    expect(notes(record.id).some((n) => n.startsWith('budget spent'))).toBe(true);
  }, 40_000);

  it('cancels a whole subtree, deepest first', async () => {
    const root = start('mock:monitoring hold', rootOf('m7'));
    await waitFor(root.id, (r) => r?.activity === 'monitoring');
    const child = store.createRun({ title: 'child', workflow: '(planned)', task: 't', steps: [] });
    store.updateRun(child.id, { status: 'waiting', dispatch: childOf(root.id) });
    const grandchild = store.createRun({ title: 'grandchild', workflow: '(planned)', task: 't', steps: [] });
    store.updateRun(grandchild.id, { status: 'queued', dispatch: { rootRunId: root.id, parentRunId: child.id } });
    // Queued in the manager's own queue so `cancel` has something to drop.
    (manager as unknown as { queue: string[] }).queue.push(grandchild.id);
    expect(manager.cancel(root.id)).toBe(true);
    expect(store.getRun(grandchild.id)?.status).toBe('cancelled');
    await waitFor(root.id, (r) => r?.status === 'cancelled');
  }, 40_000);

  // ---- the Guard: an autonomous dispatched run never answers its own CEZ:ASK ------------------

  describe('the Guard', () => {
    it('parks a dispatched run at waiting with the ask card instead of nudging it onward', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:ask which library?', rootOf('m9'), { autonomous: true });
      await waitFor(record.id, (r) => r?.status === 'waiting');
      expect(notes(record.id).some((n) => n.includes('autonomous — continuing'))).toBe(false);
    }, 40_000);

    it('leaves a NON-dispatch autonomous run auto-continuing, exactly as before', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:ask mock:autonomous which library?', undefined, { autonomous: true });
      await waitFor(record.id, settled);
      expect(notes(record.id).some((n) => n.includes('autonomous — continuing'))).toBe(true);
    }, 40_000);
  });

  // ---- the counterweight ---------------------------------------------------------------------

  describe('a run with no dispatch is untouched', () => {
    it('settles the way it always did, with no tree directory and no dispatch env', async () => {
      const record = start('mock:done plain task');
      await waitFor(record.id, settled);
      expect(store.getRun(record.id)?.dispatch).toBeUndefined();
      expect(existsSync(join(repoRoot, '.ai/cezar/dispatch'))).toBe(false);
    }, 40_000);
  });
});
