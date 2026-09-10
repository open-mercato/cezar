import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunDispatch } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager, type StartRunInput } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Restart recovery vs task dispatch (spec 2026-09-10-dispatch), the sibling of
 * `recover-autonomous.test.ts` and for the identical reason: `recover()` re-queues a `queued` run
 * by rebuilding its `StartRunInput` from the persisted record, and it is the ONE engine path that
 * does not go through `startRun`. A field it forgets to re-thread is simply gone from the
 * rebuilt input, silently, with the record still carrying it.
 *
 * That silence is why the second assertion here reaches for the rebuilt input rather than
 * settling for the record. `recover()` never *writes* `dispatch`, so a record-only check is green
 * with or without the fix — the exact shape of green-either-way test AGENTS.md warns about. The
 * hydration spy is what actually fails when the re-thread is removed.
 *
 * A workspace semaphore capped at 0 freezes the queue, so nothing is ever dispatched and no
 * agent process is spawned.
 */
describe('recover() and the dispatch field', () => {
  let repoRoot: string;
  let store: RunStore;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-dispatch-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const frozen = () => new WorkspaceSemaphore({ initial: { maxParallel: 0 } });

  const WORKFLOW_DEF = {
    name: 'quick-task',
    description: 'x',
    source: 'built-in' as const,
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  /** A queued run mid-tree: a child dispatched by a root, with a carved-out budget. */
  const queuedDispatchedRun = (): { id: string; dispatch: RunDispatch } => {
    const { id } = store.createRun({
      title: 'flank left',
      workflow: 'quick-task',
      task: 'take the left flank',
      autonomous: true,
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    const dispatch: RunDispatch = {
      rootRunId: 'root-1',
      parentRunId: 'root-1',
      budgetUsd: 4,
    };
    store.updateRun(id, { workflowDef: WORKFLOW_DEF, dispatch });
    return { id, dispatch };
  };

  /** Capture what `reviveQueuedRun` hands `hydrateQueuedInput` — the rebuilt input itself,
   *  which is the thing `execute()` will later run from. Private by design, so the spy reaches
   *  through the prototype; that is the only seam between recovery and dispatch. */
  const captureRebuiltInput = (): StartRunInput[] => {
    const seen: StartRunInput[] = [];
    vi.spyOn(
      RunManager.prototype as unknown as { hydrateQueuedInput: (id: string, input: StartRunInput) => StartRunInput },
      'hydrateQueuedInput',
    ).mockImplementation((_id, input) => {
      seen.push(input);
      return input;
    });
    return seen;
  };

  it('keeps the dispatch on the record across a restart', async () => {
    const { id, dispatch } = queuedDispatchedRun();
    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();
    expect(store.getRun(id)?.status).toBe('queued');
    expect(store.getRun(id)?.dispatch).toEqual(dispatch);
  });

  it('re-threads the dispatch into the rebuilt input, so the run resumes IN its tree', async () => {
    const rebuilt = captureRebuiltInput();
    const { dispatch } = queuedDispatchedRun();

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]?.dispatch).toEqual(dispatch);
    // The neighbouring re-thread this one was modeled on, pinned so the two cannot diverge.
    expect(rebuilt[0]?.autonomous).toBe(true);
  });

  it('leaves an ordinary flat run without a dispatch — the field stays absent, not empty', async () => {
    const rebuilt = captureRebuiltInput();
    const { id } = store.createRun({
      title: 'plain',
      workflow: 'quick-task',
      task: 'do it',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(id, { workflowDef: WORKFLOW_DEF });

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    expect(store.getRun(id)?.dispatch).toBeUndefined();
    expect(rebuilt[0]?.dispatch).toBeUndefined();
  });

  /**
   * The other half of a restart, and the one with no `dropActive` under it: a child parked
   * `waiting` when cezar exited is SETTLED by `recover()` — a terminal transition reached through
   * none of this process's registries. Its parent has to learn about it anyway (spec
   * 2026-09-10-dispatch), and the only channel that survives a restart is the pending
   * report on the parent's own record.
   */
  it('reports a waiting child settled by recovery to its parent', async () => {
    const flag = process.env.CEZ_DISPATCH;
    process.env.CEZ_DISPATCH = '1';
    try {
      const parent = store.createRun({ title: 'commander', workflow: 'quick-task', task: 'hold', steps: [] });
      store.updateRun(parent.id, { status: 'waiting', dispatch: { rootRunId: parent.id } });
      const child = store.createRun({
        title: 'flank left',
        workflow: 'quick-task',
        task: 'take the left flank',
        steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      });
      store.updateRun(child.id, {
        status: 'waiting',
        workflowDef: WORKFLOW_DEF,
        dispatch: { rootRunId: parent.id, parentRunId: parent.id },
      });

      await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

      expect(store.getRun(child.id)?.status).toBe('done');
      expect(store.getRun(child.id)?.dispatch?.parentRunId).toBe(parent.id); // the dispatch survives the settle
      const pending = store.getRun(parent.id)?.dispatch?.pendingReports ?? [];
      expect(pending).toHaveLength(1);
      expect(pending[0]?.fromRunId).toBe(child.id);
      // No CEZ:REPORT was ever emitted, so the report is synthesised from what the run left.
      expect(pending[0]?.report.status).toBe('done');
    } finally {
      if (flag === undefined) delete process.env.CEZ_DISPATCH;
      else process.env.CEZ_DISPATCH = flag;
    }
  });

  /**
   * The Guard across a restart (audit R9): a child parked on its own `CEZ:ASK` is force-settled
   * like any other `waiting` run — but what reaches its commander must say BLOCKED, naming the
   * question, never a clean `done` nobody answered. The sibling above pins the other half: a
   * `waiting` child with no open question still reports `done` exactly as before.
   */
  it('reports a child force-settled on an unanswered question as blocked, not done', async () => {
    const flag = process.env.CEZ_DISPATCH;
    process.env.CEZ_DISPATCH = '1';
    try {
      const parent = store.createRun({ title: 'commander', workflow: 'quick-task', task: 'hold', steps: [] });
      store.updateRun(parent.id, { status: 'waiting', dispatch: { rootRunId: parent.id } });
      const child = store.createRun({
        title: 'guard duty',
        workflow: 'quick-task',
        task: 'ask before deleting',
        steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      });
      store.updateRun(child.id, {
        status: 'waiting',
        workflowDef: WORKFLOW_DEF,
        dispatch: {
          rootRunId: parent.id,
          parentRunId: parent.id,
          pendingAsk: { questions: ['Delete the old migration?'], askedAt: new Date().toISOString() },
        },
      });

      await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

      expect(store.getRun(child.id)?.status).toBe('done'); // cezar's own settle is unchanged
      // The question stays on the terminal record as the honest trace of what went unanswered.
      expect(store.getRun(child.id)?.dispatch?.pendingAsk?.questions).toEqual(['Delete the old migration?']);
      const pending = store.getRun(parent.id)?.dispatch?.pendingReports ?? [];
      expect(pending).toHaveLength(1);
      expect(pending[0]?.report.status).toBe('blocked');
      expect(pending[0]?.report.result).toContain('Delete the old migration?');
    } finally {
      if (flag === undefined) delete process.env.CEZ_DISPATCH;
      else process.env.CEZ_DISPATCH = flag;
    }
  });

  it('survives the record being written and read back off disk', () => {
    const { id, dispatch } = queuedDispatchedRun();
    store.flush();
    // A second store over the same dataDir parses `runs.json` from scratch, which is what a
    // restart really does — the persistence twin of `unitSchema` has to accept its own output.
    expect(RunStore.open(join(repoRoot, '.ai/cezar')).getRun(id)?.dispatch).toEqual(dispatch);
  });
});
