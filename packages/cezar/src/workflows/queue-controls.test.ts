import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const SETTLED = ['done', 'failed', 'cancelled', 'review'];

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
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Finishes immediately — enough to prove a run LEFT the queue. */
const INSTANT: WorkflowDef = {
  name: 'instant',
  source: 'built-in',
  steps: [{ id: 'noop', command: 'node -e ""' }],
};

/** Occupies a slot until `gate` appears, so a test can hold capacity open deliberately. */
function blocker(gate: string): WorkflowDef {
  const script = [
    'const fs = require("fs");',
    'const gate = process.argv[1];',
    'const deadline = Date.now() + 20000;',
    'const poll = () => { if (fs.existsSync(gate) || Date.now() > deadline) return; setTimeout(poll, 10); };',
    'poll();',
  ].join(' ');
  return {
    name: 'blocker',
    source: 'built-in',
    steps: [{ id: 'hold', command: `node -e '${script}' '${gate.replaceAll("'", `'\\''`)}'` }],
  };
}

/**
 * The Tasks header's three queue controls, at the engine level: the PAUSE hold on `pump()`, the
 * Start sweep that lifts it, and the bulk delete.
 *
 * The behaviour these lock down is the reason the header's buttons are honest:
 *
 *  1. a hold stops ADMISSION and nothing else — a task already running finishes, and no new one
 *     starts until the hold is lifted;
 *  2. the hold is not a dead end: lifting it drains the queue under the ordinary `maxParallel`
 *     cap, and the reported count is what actually left rather than what was waiting;
 *  3. bulk delete empties the project, worktrees and all, and does not leave the queue held.
 *
 * Real git, real child processes and the `CEZ_DRY_RUN` mock agent, on run.test.ts conventions.
 */
describe('the queue controls — pause, start, delete-all', () => {
  const roots: string[] = [];
  const stores: RunStore[] = [];
  const managers: RunManager[] = [];
  const gates: string[] = [];
  let savedDryRun: string | undefined;

  function project(prefix: string, semaphore: WorkspaceSemaphore): { store: RunStore; manager: RunManager; root: string } {
    const root = fixtureRepo(prefix, roots);
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root, { semaphore });
    stores.push(store);
    managers.push(manager);
    return { store, manager, root };
  }

  function gatePath(): string {
    const gate = join(mkdtempSync(join(tmpdir(), 'cez-gate-')), 'open');
    gates.push(gate);
    return gate;
  }

  beforeEach(() => {
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) manager.dispose();
    for (const store of stores.splice(0)) store.flush();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    for (const gate of gates.splice(0)) rmSync(gate, { force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  it('runs queued tasks strictly in creation order under a cap of one', async () => {
    // FIFO is a property of the QUEUE, so it is asserted at `maxParallel: 1` — where sequencing is
    // actually guaranteed. Under a higher cap the two run CONCURRENTLY and finish order is a race,
    // so an ordering assertion there would be testing the scheduler's good luck, not its order.
    const a = project('cez-queue-start-', new WorkspaceSemaphore({ initial: { maxParallel: 1 } }));
    const first = a.manager.startRun(INSTANT, { task: 'first' });
    const second = a.manager.startRun(INSTANT, { task: 'second' });

    await waitFor(
      () => SETTLED.includes(a.store.getRun(first.id)?.status ?? '') && SETTLED.includes(a.store.getRun(second.id)?.status ?? ''),
      'both tasks to finish',
    );
    // The stronger claim, and the one the Start button makes: the second task did not merely
    // finish second, it did not BEGIN until the first had finished.
    expect(Date.parse(a.store.getRun(second.id)!.startedAt!)).toBeGreaterThanOrEqual(
      Date.parse(a.store.getRun(first.id)!.finishedAt!),
    );
    expect(a.manager.queueState()).toEqual({ paused: false, queued: 0 });
  }, 45_000);

  it('a pause holds admission: running work finishes and nothing new starts', async () => {
    const a = project('cez-queue-hold-', new WorkspaceSemaphore({ initial: { maxParallel: 1 } }));
    const gate = gatePath();

    // Fill the only slot, so the next task has to queue.
    const holder = a.manager.startRun(blocker(gate), { task: 'holds the single slot' });
    await waitFor(() => a.store.getRun(holder.id)?.status === 'running', 'the holder to take the slot');

    const queued = a.manager.startRun(INSTANT, { task: 'waits behind the hold' });
    await waitFor(() => a.manager.queueState().queued === 1, 'the second task to queue');

    // Pause while it waits. Nothing about the running holder may change.
    expect(a.manager.setQueuePaused(true)).toEqual({ paused: true, queued: 1 });

    // Let the holder finish. Its slot frees — and the paused task must NOT take it.
    execFileSync('touch', [gate]);
    await waitFor(() => SETTLED.includes(a.store.getRun(holder.id)?.status ?? ''), 'the holder to finish');
    // A real window, not an instant: give the freed slot every chance to be taken.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(a.store.getRun(queued.id)?.status).toBe('queued');
    expect(a.manager.isActive(queued.id)).toBe(true);
    expect(a.manager.queueState()).toEqual({ paused: true, queued: 1 });
  }, 45_000);

  it('a task created while the queue is held waits, and starts on resume', async () => {
    const a = project('cez-queue-late-', new WorkspaceSemaphore({ initial: { maxParallel: 2 } }));
    a.manager.setQueuePaused(true);

    // Created AFTER the hold — the case a gate placed anywhere but `startable()` would miss.
    const late = a.manager.startRun(INSTANT, { task: 'created while held' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(a.store.getRun(late.id)?.status).toBe('queued');
    expect(a.manager.queueState()).toEqual({ paused: true, queued: 1 });

    // Lift the hold the way the Start button does.
    const released = await a.manager.startQueued();
    expect(released.released).toBe(1);
    await waitFor(
      () => SETTLED.includes(a.store.getRun(late.id)?.status ?? ''),
      'the held task to run once the hold is lifted',
    );
    expect(a.manager.queueState().paused).toBe(false);
  }, 45_000);

  it('Start releases only what maxParallel allows, and reports that count', async () => {
    const a = project('cez-queue-cap-', new WorkspaceSemaphore({ initial: { maxParallel: 1 } }));
    const gate = gatePath();

    const holder = a.manager.startRun(blocker(gate), { task: 'holds the only slot' });
    await waitFor(() => a.store.getRun(holder.id)?.status === 'running', 'the holder to take the slot');

    // Three tasks behind a cap of one.
    const waiting = ['w1', 'w2', 'w3'].map((task) => a.manager.startRun(INSTANT, { task }));
    await waitFor(() => a.manager.queueState().queued === 3, 'all three to queue');
    a.manager.setQueuePaused(true);

    // Held, so nothing can start even though the holder is about to free the slot.
    execFileSync('touch', [gate]);
    await waitFor(() => SETTLED.includes(a.store.getRun(holder.id)?.status ?? ''), 'the holder to finish');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(a.manager.queueState()).toEqual({ paused: true, queued: 3 });

    // "Start tasks". The cap is 1, so at most ONE can leave the queue right now.
    const result = await a.manager.startQueued();
    expect(result.released).toBe(1);
    // …and the other two are still queued, not lost and not silently started.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(a.manager.queueState().paused).toBe(false);
    expect(a.manager.queueState().queued).toBeLessThanOrEqual(2);

    for (const run of waiting) {
      await waitFor(
        () => SETTLED.includes(a.store.getRun(run.id)?.status ?? ''),
        `queued task ${run.id} to finish`,
      );
    }
  }, 60_000);

  it('Start is a no-op on an empty queue rather than an error', async () => {
    const a = project('cez-queue-empty-', new WorkspaceSemaphore({ initial: { maxParallel: 2 } }));
    expect(await a.manager.startQueued()).toEqual({ released: 0 });
  }, 20_000);

  it('deletes every task including archived, and does not leave the queue held', async () => {
    const a = project('cez-queue-del-', new WorkspaceSemaphore({ initial: { maxParallel: 2 } }));

    const finished = a.manager.startRun(INSTANT, { task: 'finishes' });
    await waitFor(() => SETTLED.includes(a.store.getRun(finished.id)?.status ?? ''), 'a task to finish');
    // Archive one, so the sweep has to cross the archived boundary to empty the project.
    a.store.setArchived(finished.id, true);

    const gate = gatePath();
    const live = a.manager.startRun(blocker(gate), { task: 'still running' });
    await waitFor(() => a.store.getRun(live.id)?.status === 'running', 'the live task to start');
    const queued = a.manager.startRun(INSTANT, { task: 'queued behind it' });
    await waitFor(() => a.manager.queueState().queued === 1, 'a task to queue');
    execFileSync('touch', [gate]);

    const result = await a.manager.deleteAllRuns();

    expect(result.deleted).toBe(3);
    expect(result.cancelled).toBeGreaterThan(0);
    // The honest failure channel: every holder settled inside the bounded wait.
    expect(result.unsettled).toBe(0);
    // Archived included — the point of "delete ALL".
    expect(a.store.getRun(finished.id)).toBeUndefined();
    expect(a.store.listRuns()).toHaveLength(0);
    // The worktree of the task that really ran went with it.
    expect(existsSync(join(a.root, '.ai/cezar/worktrees', finished.id))).toBe(false);
    // And the hold is not left behind: a wedged queue on an emptied project is the worst outcome
    // of this route, so it is asserted rather than assumed.
    expect(a.manager.queueState().paused).toBe(false);
    void queued;
  }, 60_000);

  it('cancels a run caught mid-spawn, which one pass cannot reach', async () => {
    // The `starting` window: `pump()` has dequeued the run and handed it to `execute()`, but it has
    // not registered in `active` yet — so `cancelOne` finds neither a queue entry nor a state and
    // returns false. A single cancel pass would let it register a moment later and run to COMPLETION
    // inside the sweep, with its record deleted underneath it. This is what forces the re-cancel
    // loop rather than a single pass.
    const a = project('cez-queue-spawn-', new WorkspaceSemaphore({ initial: { maxParallel: 4 } }));
    const gate = gatePath();
    const held = a.manager.startRun(blocker(gate), { task: 'saturate the cap' });
    await waitFor(() => a.store.getRun(held.id)?.status === 'running', 'a slot holder to start');

    const internals = a.manager as unknown as { starting: Set<string>; active: Map<string, unknown> };
    const staged = a.store.createRun({ title: 'mid-spawn', workflow: 'w', task: 't', steps: [] });
    a.store.updateRun(staged.id, { status: 'queued' });
    internals.starting.add(staged.id);
    expect(internals.active.has(staged.id)).toBe(false);

    // Stand in for `execute` reaching `this.active.set(...)`, which is what makes the run
    // reachable: a real spawn takes milliseconds, and the sweep's first pass is over by then.
    const registering = setTimeout(() => {
      internals.starting.delete(staged.id);
      internals.active.set(staged.id, { cancelled: false, interrupt: () => undefined });
    }, 60);
    registering.unref?.();

    execFileSync('touch', [gate]);
    const result = await a.manager.deleteAllRuns();

    // The second pass reached it: nothing is left holding it, and the record is gone with the rest.
    expect(result.unsettled).toBe(0);
    expect(result.deleted).toBe(2);
    expect(a.store.listRuns()).toHaveLength(0);
    expect(internals.starting.has(staged.id)).toBe(false);
    expect(internals.active.has(staged.id)).toBe(false);
  }, 60_000);

  it('reports a run it could not stop rather than claiming a clean sweep', async () => {
    // The honest-failure channel, and the reason `unsettled` is in the answer at all: a holder the
    // bounded wait could not clear means a process may outlive the record that just went away, and
    // an operator told "deleted N" with no caveat would have no way to know.
    const a = project('cez-queue-stranded-', new WorkspaceSemaphore({ initial: { maxParallel: 2 } }));
    const internals = a.manager as unknown as { starting: Set<string> };
    const stranded = a.store.createRun({ title: 'never registers', workflow: 'w', task: 't', steps: [] });
    a.store.updateRun(stranded.id, { status: 'queued' });
    // Nothing will ever move this one out of `starting` — the wedged shape, held deliberately.
    internals.starting.add(stranded.id);

    const result = await a.manager.deleteAllRuns();
    expect(result.unsettled).toBe(1);
    // …and the records still go, because refusing to clean up would leave the operator worse off.
    expect(result.deleted).toBe(1);
    expect(a.store.listRuns()).toHaveLength(0);
    // The sweep terminates rather than spinning on the wedged entry.
    internals.starting.delete(stranded.id);
  }, 60_000);

  it('a task created after a delete still runs — the sweep did not wedge the engine', async () => {
    const a = project('cez-queue-after-del-', new WorkspaceSemaphore({ initial: { maxParallel: 2 } }));
    const first = a.manager.startRun(INSTANT, { task: 'before' });
    await waitFor(() => SETTLED.includes(a.store.getRun(first.id)?.status ?? ''), 'a task to finish');

    await a.manager.deleteAllRuns();

    const after = a.manager.startRun(INSTANT, { task: 'after' });
    await waitFor(
      () => SETTLED.includes(a.store.getRun(after.id)?.status ?? ''),
      'a task created after the delete to finish',
    );
    expect(a.store.getRun(after.id)?.status).toBe('done');
  }, 60_000);

  it('the hold is process-local: a fresh manager over the same store is not paused', async () => {
    // The anti-dead-end guard. A hold that survived a restart would re-apply itself on every boot,
    // with nobody there to lift it — the queue would sit idle behind a button on an unopened page.
    const a = project('cez-queue-volatile-', new WorkspaceSemaphore({ initial: { maxParallel: 2 } }));
    a.manager.setQueuePaused(true);
    expect(a.manager.queueState().paused).toBe(true);

    const revived = new RunManager(a.store, a.root, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }),
    });
    managers.push(revived);
    expect(revived.queueState().paused).toBe(false);
  }, 20_000);
});
