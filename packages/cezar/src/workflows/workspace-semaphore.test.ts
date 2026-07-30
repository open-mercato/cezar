import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The workspace-wide parallel cap (spec 2026-07-20-multi-project-workspace,
 * step 2.5): ONE `WorkspaceSemaphore` shared by every project's RunManager
 * caps concurrent runs at the global `resources.maxParallel`, replacing the
 * old per-repo count. Three contracts, each against real managers on real
 * fixture repos (run.test.ts conventions — check-step slot holders, and the
 * CEZ_DRY_RUN mock agent where a live session is needed):
 *
 *  1. two managers, cap 2 → a third run queues ACROSS projects;
 *  2. the #347 exemption survives the move: a `waiting` run holds no slot,
 *     and a message into it resumes it immediately even when OTHER projects
 *     saturate the cap — the resume must never hang on the workspace queue;
 *  3. `refresh()` (the cache hook boot and PUT /api/v1/workspace/config call)
 *     applies a config change without a restart: raising the cap starts a
 *     queued run right away.
 */

/** Real git fixture repo — worktree-isolated runs genuinely succeed. */
function fixtureRepo(prefix: string, roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  return root;
}

async function waitFor(predicate: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settled = ['done', 'failed', 'cancelled', 'review'];

/** Holds a workspace slot (status `running`, never `waiting`) long enough to
 *  observe scheduling — a check step, so no agent process is involved. */
const SLOW: WorkflowDef = {
  name: 'slow',
  source: 'built-in',
  steps: [{ id: 'hold', command: 'node -e "setTimeout(()=>{},3000)"' }],
};
const INSTANT: WorkflowDef = {
  name: 'instant',
  source: 'built-in',
  steps: [{ id: 'noop', command: 'node -e ""' }],
};
/** One interactive agent step — the mock parks at `waiting` after its turn. */
const AGENT: WorkflowDef = {
  name: 'quick-task',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};

describe('workspace semaphore across RunManagers (step 2.5)', () => {
  const roots: string[] = [];
  const managers: RunManager[] = [];
  const stores: RunStore[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  /** A project: fixture repo + store + manager on the SHARED semaphore. */
  function project(
    prefix: string,
    semaphore: WorkspaceSemaphore,
  ): { store: RunStore; manager: RunManager; root: string } {
    const root = fixtureRepo(prefix, roots);
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root, { semaphore });
    stores.push(store);
    managers.push(manager);
    return { store, manager, root };
  }

  beforeEach(() => {
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
  });

  it('exempts only the configured number of durable monitoring sessions', () => {
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2, maxMonitoringSessions: 2 } });
    const projectA = project('cez-monitor-cap-', semaphore);
    const internals = projectA.manager as unknown as {
      active: Map<string, object>;
      waiting: Set<string>;
      monitoring: Set<string>;
      busySlots(): number;
    };
    for (const id of ['ordinary', 'm1', 'm2', 'm3']) internals.active.set(id, {});
    for (const id of ['ordinary', 'm1', 'm2', 'm3']) internals.waiting.add(id);
    for (const id of ['m1', 'm2', 'm3']) internals.monitoring.add(id);
    // ordinary wait is exempt; two monitors are exempt; monitor #3 back-pressures the active pool.
    expect(internals.busySlots()).toBe(1);
    expect(semaphore.busy()).toBe(1);
  });

  afterEach(async () => {
    // Settle everything before tearing the fixtures down: cancel whatever is
    // still live and wait for terminal statuses, so no check-step child or
    // mock session outlives its repo directory.
    for (const store of stores) {
      for (const run of store.listRuns()) {
        const m = managers[stores.indexOf(store)];
        if (!settled.includes(store.getRun(run.id)?.status ?? '')) m?.cancel(run.id);
      }
    }
    for (const store of stores) {
      await waitFor(
        () => store.listRuns().every((r) => settled.includes(r.status)),
        'all runs to settle before teardown',
      ).catch(() => undefined);
      store.flush();
    }
    for (const manager of managers.splice(0)) manager.dispose();
    stores.length = 0;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (savedEnv.CEZ_DRY_RUN === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedEnv.CEZ_DRY_RUN;
  });

  it('caps concurrent runs across two projects: with cap 2, the third run queues', async () => {
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 } });
    const a = project('cez-wsem-a-', semaphore);
    const b = project('cez-wsem-b-', semaphore);

    const slowA = a.manager.startRun(SLOW, { task: 'hold a slot (A)' });
    const slowB = b.manager.startRun(SLOW, { task: 'hold a slot (B)' });
    await waitFor(
      () =>
        a.store.getRun(slowA.id)?.status === 'running' &&
        b.store.getRun(slowB.id)?.status === 'running',
      'both slot holders to run',
    );

    // Third run, third project slot — but the WORKSPACE cap is 2, so it must
    // queue even though manager A alone only holds one slot.
    const third = a.manager.startRun(INSTANT, { task: 'third — must queue' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(a.store.getRun(third.id)?.status).toBe('queued');

    // Capacity returns as the holders settle — the queued run then completes.
    await waitFor(
      () => settled.includes(a.store.getRun(third.id)?.status ?? ''),
      'the queued run to complete once a slot frees',
      30_000,
    );
    expect(a.store.getRun(third.id)?.status).toBe('done');
  }, 45_000);

  it('a slot freed in one project starts the run queued in ANOTHER project', async () => {
    // The starvation regression: `RunManager` only ever pumps ITSELF, so a
    // freed slot used to reach exactly one queue. With both slots held by A,
    // B's queued run sat at `queued` while A's runs finished one after
    // another — it only ever started if B happened to start or finish a run of
    // its own. The fix routes every slot-freeing transition through
    // `WorkspaceSemaphore.release()`, which pumps every manager.
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 } });
    const a = project('cez-wsem-cross-a-', semaphore);
    const b = project('cez-wsem-cross-b-', semaphore);

    const slow1 = a.manager.startRun(SLOW, { task: 'saturate 1' });
    const slow2 = a.manager.startRun(SLOW, { task: 'saturate 2' });
    await waitFor(
      () =>
        a.store.getRun(slow1.id)?.status === 'running' &&
        a.store.getRun(slow2.id)?.status === 'running',
      'A to saturate the workspace cap',
    );

    const queued = b.manager.startRun(INSTANT, { task: 'queued in the OTHER project' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(b.store.getRun(queued.id)?.status).toBe('queued');

    // Nothing else happens in B — the only event is A's runs settling.
    await waitFor(
      () => settled.includes(b.store.getRun(queued.id)?.status ?? ''),
      "B's queued run to start once A frees a slot",
      30_000,
    );
    expect(b.store.getRun(queued.id)?.status).toBe('done');
  }, 45_000);

  it('a freed slot goes to the longest-waiting run across projects', async () => {
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    const a = project('cez-wsem-fair-a-', semaphore);
    const b = project('cez-wsem-fair-b-', semaphore);

    const holder = a.manager.startRun(SLOW, { task: 'hold the only slot' });
    await waitFor(() => a.store.getRun(holder.id)?.status === 'running', 'the holder to run');
    // B queues first, then A — the freed slot must go to B despite the slot
    // being freed by (and the pump originating in) A.
    const older = b.manager.startRun(INSTANT, { task: 'queued first, other project' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const newer = a.manager.startRun(SLOW, { task: 'queued second, same project' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(b.store.getRun(older.id)?.status).toBe('queued');
    expect(a.store.getRun(newer.id)?.status).toBe('queued');

    await waitFor(
      () => settled.includes(b.store.getRun(older.id)?.status ?? ''),
      "B's older queued run to take the freed slot",
      30_000,
    );
    expect(b.store.getRun(older.id)?.status).toBe('done');
  }, 45_000);

  it('#347 across projects: a waiting run resumes immediately even when other projects saturate the cap', async () => {
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 } });
    const a = project('cez-wsem-347a-', semaphore);
    const b = project('cez-wsem-347b-', semaphore);

    // B's agent run parks at `waiting` (markerless mock turn-end) — and by the
    // #347 rule gives its slot back while parked.
    const waitingRun = b.manager.startRun(AGENT, { task: 'park and wait', worktree: false });
    await waitFor(
      () => b.store.getRun(waitingRun.id)?.status === 'waiting',
      "B's run to park at waiting",
    );

    // Project A saturates the workspace cap: 2 running holders, busy == cap.
    const slow1 = a.manager.startRun(SLOW, { task: 'saturate 1' });
    const slow2 = a.manager.startRun(SLOW, { task: 'saturate 2' });
    await waitFor(
      () =>
        a.store.getRun(slow1.id)?.status === 'running' &&
        a.store.getRun(slow2.id)?.status === 'running',
      'A to saturate the cap',
    );

    // The #347 exemption: the message goes straight into the open session —
    // no slot acquire, no queue — even though that momentarily exceeds the
    // cap. Before #347 (and if a resume ever acquired a workspace slot) this
    // would hang until A's runs finished.
    expect(
      b.manager.sendMessage(waitingRun.id, [{ type: 'text', text: 'carry on please' }]),
    ).toBe(true);
    const resumed = b.store.getRun(waitingRun.id);
    expect(resumed?.status).toBe('running'); // resumed instantly, cap exceeded by design
    // ...while A's saturating runs are genuinely still holding both slots.
    expect(a.store.getRun(slow1.id)?.status).toBe('running');
    expect(a.store.getRun(slow2.id)?.status).toBe('running');

    // The resumed turn completes and re-parks — the exemption is a moment of
    // over-cap, not a leak.
    await waitFor(
      () => b.store.getRun(waitingRun.id)?.status === 'waiting',
      "B's run to re-park after the resumed turn",
    );
  }, 45_000);

  it('per-project cap: project A limited to 1 runs one at a time while B fills the workspace cap', async () => {
    // Shared snapshot the load hook copies on each refresh — mutating the map
    // and calling refresh() mirrors a settings write to a project's maxParallel.
    const projectLimits = new Map<string, number>();
    const semaphore = new WorkspaceSemaphore({
      load: () =>
        Promise.resolve({ maxParallel: 4, memoryLimitMb: null, projectLimits: new Map(projectLimits) }),
      initial: { maxParallel: 4 },
    });
    const a = project('cez-wsem-ppA-', semaphore);
    const rootA = a.root;
    const b = project('cez-wsem-ppB-', semaphore);

    // Pin project A to a single concurrent run; refresh so the snapshot carries it.
    projectLimits.set(realpathSync(rootA), 1);
    await semaphore.refresh();

    // A starts two runs. The workspace has room (cap 4), but A's own ceiling is
    // 1 — so the second A run must queue on the per-project gate.
    const a1 = a.manager.startRun(SLOW, { task: 'A slot 1' });
    const a2 = a.manager.startRun(SLOW, { task: 'A slot 2 — must queue on A per-project cap' });
    await waitFor(() => a.store.getRun(a1.id)?.status === 'running', 'A first run to run');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(a.store.getRun(a2.id)?.status).toBe('queued'); // blocked by A's own cap, not the workspace

    // B inherits the workspace cap (no override) — it runs two concurrently.
    const b1 = b.manager.startRun(SLOW, { task: 'B slot 1' });
    const b2 = b.manager.startRun(SLOW, { task: 'B slot 2' });
    await waitFor(
      () =>
        b.store.getRun(b1.id)?.status === 'running' && b.store.getRun(b2.id)?.status === 'running',
      'B to run two concurrently under the workspace cap',
    );

    // A still runs only one; the workspace total (1 A + 2 B) never exceeds 4.
    expect(a.store.getRun(a1.id)?.status).toBe('running');
    expect(a.store.getRun(a2.id)?.status).toBe('queued');
    expect(semaphore.busy()).toBeLessThanOrEqual(4);

    // Once A's holder settles, A's second run starts — the cap gates, never strands.
    await waitFor(
      () => settled.includes(a.store.getRun(a2.id)?.status ?? ''),
      "A's queued run to start and finish after its slot frees",
      30_000,
    );
    expect(a.store.getRun(a2.id)?.status).toBe('done');
  }, 60_000);

  it('restart recovery queues interrupted continuations behind the per-project cap', async () => {
    const root = fixtureRepo('cez-wsem-recover-cap-', roots);
    const projectLimits = new Map([[realpathSync(root), 1]]);
    const semaphore = new WorkspaceSemaphore({
      load: () =>
        Promise.resolve({ maxParallel: 3, memoryLimitMb: null, projectLimits }),
      initial: { maxParallel: 3 },
    });
    await semaphore.refresh();
    const store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    const firstManager = new RunManager(store, root, { semaphore });
    stores.push(store);

    for (const suffix of ['one', 'two', 'three']) {
      const record = store.createRun({
        title: suffix,
        workflow: 'quick-task',
        task: `interrupted ${suffix}`,
        runner: 'claude',
        steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
      });
      store.updateStep(record.id, 'task', {
        status: 'running',
        iterations: 1,
        sessionId: `session-${suffix}`,
        backend: 'claude',
      });
      store.updateRun(record.id, { status: 'running', currentStepId: 'task' });
    }

    // Hold the first admitted continuation open. This isolates scheduler
    // admission from backend timing and makes the cap observable.
    const never = new Promise<void>(() => undefined);
    const holdContinuation = (manager: RunManager) => {
      (
        manager as unknown as {
          runContinuation(runId: string, stepId: string): Promise<void>;
        }
      ).runContinuation = async (runId: string, stepId: string) => {
        store.updateStep(runId, stepId, { status: 'running' });
        store.updateRun(runId, { status: 'running', currentStepId: stepId });
        await never;
      };
    };
    holdContinuation(firstManager);

    await firstManager.recover();
    await waitFor(
      () => store.listRuns().filter((run) => run.status === 'running').length === 1,
      'one recovered continuation to take the project slot',
    );
    expect(store.listRuns().filter((run) => run.status === 'running')).toHaveLength(1);
    expect(store.listRuns().filter((run) => run.status === 'queued')).toHaveLength(2);
    expect(semaphore.busy()).toBe(1);

    const queuedStepCounts = new Map(
      store
        .listRuns()
        .filter((run) => run.status === 'queued')
        .map((run) => [run.id, run.steps.filter((step) => step.id.startsWith('continue-')).length]),
    );
    firstManager.dispose();

    // Simulate another process start before the queued continuations receive a
    // slot. They must reconstruct those same Continue jobs, not revive the
    // original quick-task workflow or append duplicate continuation steps.
    const secondManager = new RunManager(store, root, { semaphore });
    managers.push(secondManager);
    holdContinuation(secondManager);
    await secondManager.recover();
    await waitFor(
      () => store.listRuns().filter((run) => run.status === 'running').length === 1,
      'one continuation to take the project slot after the second restart',
    );
    for (const [runId, stepCount] of queuedStepCounts) {
      expect(store.getRun(runId)?.steps.filter((step) => step.id.startsWith('continue-'))).toHaveLength(
        stepCount,
      );
      expect(
        store
          .readEvents(runId)
          .some(
            (event) =>
              event.type === 'lifecycle' &&
              event.message === 'cezar restarted — interrupted continuation re-queued',
          ),
      ).toBe(true);
    }
    expect(store.listRuns().filter((run) => run.status === 'running')).toHaveLength(1);
    expect(store.listRuns().filter((run) => run.status === 'queued')).toHaveLength(2);
    expect(semaphore.busy()).toBe(1);

    // Keep fixture teardown independent of the deliberately unresolved stub.
    for (const run of store.listRuns()) {
      store.updateRun(run.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    }
  });

  it('restart continuation releases its starting slot after becoming active', async () => {
    const root = fixtureRepo('cez-wsem-recover-starting-', roots);
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    const store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    const manager = new RunManager(store, root, { semaphore });
    stores.push(store);
    managers.push(manager);

    const record = store.createRun({
      title: 'interrupted continuation',
      workflow: 'quick-task',
      task: 'resume after restart',
      runner: 'claude',
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    store.updateStep(record.id, 'task', {
      status: 'running',
      iterations: 1,
      sessionId: 'session-interrupted',
      backend: 'claude',
    });
    store.updateRun(record.id, { status: 'running', currentStepId: 'task' });

    await manager.recover();
    await waitFor(
      () => store.getRun(record.id)?.status === 'waiting',
      'the recovered continuation to finish its mock turn',
    );

    expect(semaphore.busy()).toBe(0);
    expect(
      (manager as unknown as { starting: Set<string> }).starting.has(record.id),
    ).toBe(false);
  });

  it('#347 with a per-project cap: a waiting run on the capped project still resumes immediately', async () => {
    const projectLimits = new Map<string, number>();
    const semaphore = new WorkspaceSemaphore({
      load: () =>
        Promise.resolve({ maxParallel: 4, memoryLimitMb: null, projectLimits: new Map(projectLimits) }),
      initial: { maxParallel: 4 },
    });
    const a = project('cez-wsem-pp347-', semaphore);
    const rootA = a.root;
    projectLimits.set(realpathSync(rootA), 1);
    await semaphore.refresh();

    // Park an agent run at `waiting` (holds no slot per #347), then saturate A's
    // per-project cap of 1 with a running holder.
    const waitingRun = a.manager.startRun(AGENT, { task: 'park and wait', worktree: false });
    await waitFor(() => a.store.getRun(waitingRun.id)?.status === 'waiting', 'the agent run to park');
    const holder = a.manager.startRun(SLOW, { task: 'occupy the single per-project slot' });
    await waitFor(() => a.store.getRun(holder.id)?.status === 'running', "the holder to take A's only slot");

    // Even at A's per-project cap, the resume bypasses pump() — straight into the
    // open session, no slot acquire — so the ceiling can never strand it.
    expect(a.manager.sendMessage(waitingRun.id, [{ type: 'text', text: 'carry on' }])).toBe(true);
    expect(a.store.getRun(waitingRun.id)?.status).toBe('running');
    expect(a.store.getRun(holder.id)?.status).toBe('running'); // holder keeps the single slot
    await waitFor(
      () => a.store.getRun(waitingRun.id)?.status === 'waiting',
      'the resumed run to re-park after its turn',
    );
  }, 45_000);

  it('refresh() applies a raised cap without a restart: the queued run starts', async () => {
    let limits = { maxParallel: 1, memoryLimitMb: null as number | null };
    const semaphore = new WorkspaceSemaphore({
      load: () => Promise.resolve({ ...limits }),
      initial: { maxParallel: 1 },
    });
    const a = project('cez-wsem-refresh-', semaphore);

    const holder = a.manager.startRun(SLOW, { task: 'hold the only slot' });
    const queued = a.manager.startRun(INSTANT, { task: 'wait for capacity' });
    await waitFor(() => a.store.getRun(holder.id)?.status === 'running', 'the holder to run');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(a.store.getRun(queued.id)?.status).toBe('queued');

    // The workspace cache hook (boot / PUT /api/v1/workspace/config, step 2.7):
    // bump the config, refresh — the pump fires and the queued run proceeds
    // while the holder is still running. No process restart involved.
    limits = { maxParallel: 2, memoryLimitMb: null };
    await semaphore.refresh();
    await waitFor(
      () => settled.includes(a.store.getRun(queued.id)?.status ?? ''),
      'the queued run to start and finish after the cap was raised',
    );
    expect(a.store.getRun(queued.id)?.status).toBe('done');
    expect(a.store.getRun(holder.id)?.status).toBe('running'); // still holding — proves no restart/wait
  }, 45_000);
});
