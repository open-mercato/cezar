import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const SETTLED = ['done', 'failed', 'cancelled', 'review'];

/** Ceiling on how long a lease holder keeps the tree when nothing releases it.
 *  A passing test never reaches it — the test's own `release()` ends the step —
 *  so it is purely the escape hatch for a failed assertion that skipped the
 *  release: the suite fails on that assertion instead of wedging. */
const HOLD_SAFETY_MS = 20_000;

/** These tests drive real Git and real child processes across three runs, so
 *  they need more than Vitest's 5 s default. Racing that budget under a loaded
 *  full-suite run is half of what made this file flaky (#797). */
const TEST_TIMEOUT_MS = 30_000;

/** POSIX single-quote escaping. A check step is a command string handed to
 *  `bash -lc`, so the fixture's temp path has to reach node verbatim whatever
 *  `TMPDIR` happens to contain — double quotes would still expand `$`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A root workflow whose single step blocks until `gate` appears on disk.
 *
 * The holder used to sleep for a fixed 1.5 s, which made every assertion below
 * a bet that the rest of the suite reached it before that timer expired — a bet
 * a loaded full-suite run lost (#797). Now the holder is still `running`
 * because the test has not released it yet, which no amount of machine load
 * can change.
 */
function leaseHolder(gate: string): WorkflowDef {
  // Double quotes only — the script itself is single-quoted for the shell.
  const hold = [
    'const fs = require("fs");',
    'const gate = process.argv[1];',
    `const deadline = Date.now() + ${HOLD_SAFETY_MS};`,
    'const poll = () => { if (fs.existsSync(gate) || Date.now() > deadline) return; setTimeout(poll, 10); };',
    'poll();',
  ].join(' ');
  return {
    name: 'held-root',
    source: 'built-in',
    steps: [{ id: 'hold', command: `node -e '${hold}' ${shellQuote(gate)}` }],
  };
}

const INSTANT: WorkflowDef = {
  name: 'instant',
  source: 'built-in',
  steps: [{ id: 'noop', command: 'node -e ""' }],
};

interface Fixture {
  root: string;
  store: RunStore;
  manager: RunManager;
  /** Occupies the repo-root lease until `release()` is called. */
  holdsLease: WorkflowDef;
  /** Let the holder's step exit, handing the lease to the next waiter. */
  release: () => void;
  /** `manager.startRun`, recording the run so teardown can wait for it. */
  start: (
    workflow: WorkflowDef,
    input: Parameters<RunManager['startRun']>[1],
  ) => ReturnType<RunManager['startRun']>;
  started: string[];
}

const fixtures: Fixture[] = [];

/** Real Git fixture — unlike `run-isolation.test.ts`, worktree creation is not
 *  mocked here, so isolated runs genuinely succeed and can be observed
 *  overtaking root runs that are queued behind the lease. */
function fixtureRepo(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'cez-root-lease-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root);
  // Under `.ai/cezar` on purpose: nothing treats that directory as repository
  // content, so the gate can never turn up in a worktree diff or the review gate.
  const gate = join(root, '.ai/cezar', 'lease-gate');
  const started: string[] = [];
  const fixture: Fixture = {
    root,
    store,
    manager,
    holdsLease: leaseHolder(gate),
    release: () => writeFileSync(gate, ''),
    start: (workflow, input) => {
      const run = manager.startRun(workflow, input);
      started.push(run.id);
      return run;
    },
    started,
  };
  fixtures.push(fixture);
  return fixture;
}

/**
 * Block until the holder is demonstrably *inside* its hold step, and therefore
 * demonstrably owns the repo-root lease.
 *
 * Starting the holder first does not make it the first waiter: both runs reach
 * `acquireRepoRoot` through their own async prologue, so the lease can just as
 * easily go to whichever run gets there first. When it went to the short run,
 * that run finished on its own instead of parking on the lease — and the test
 * below "passed" without ever exercising the slot hand-back it exists to prove.
 */
async function holdsTheLease(fixture: Fixture, runId: string): Promise<void> {
  await waitFor(
    () =>
      fixture.store
        .readEvents(runId)
        .some((event) => event.type === 'step-start' && event.stepId === 'hold'),
    'the holder to take the repository-root lease',
  );
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Every run a fixture started has to be finished before its repository is
 * deleted. A run that is still settling writes its closing NDJSON event, and
 * against an already-removed fixture that surfaced as the teardown `ENOENT`
 * reported in #797 — the second test in particular returns the moment `after`
 * completes, while the holder it queued behind is still finalizing.
 */
async function drain(fixture: Fixture): Promise<void> {
  const unsettled = () =>
    fixture.started.filter((id) => !SETTLED.includes(fixture.store.getRun(id)?.status ?? ''));
  try {
    await waitFor(() => unsettled().length === 0, 'every started run to settle');
  } catch {
    // A run that will not finish on its own is a real problem, so cancel it and
    // let the second wait throw rather than deleting the fixture underneath it.
    for (const id of unsettled()) fixture.manager.cancel(id);
    await waitFor(() => unsettled().length === 0, 'the cancelled leftover runs to settle');
  }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    // Open the gate first. A failed assertion skips the test's own release, and
    // teardown must not sit out HOLD_SAFETY_MS waiting for the holder to give up.
    fixture.release();
    try {
      await drain(fixture);
    } finally {
      // Dispose either way: a manager left registered keeps its usage-sampler
      // subscription and its semaphore membership alive for the rest of the suite.
      fixture.manager.dispose();
    }
    // Reached only once nothing is still writing into the fixture. A failed
    // drain therefore leaks a temp directory, which is strictly better than
    // deleting one out from under a live run — the failure this file is fixing.
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);

describe('RunManager repository-root lease scheduling', () => {
  it(
    'does not let a lease-blocked run consume a parallel slot',
    async () => {
      const fixture = fixtureRepo();
      const { store, holdsLease, release, start } = fixture;

      // maxParallel defaults to 2. `holder` takes the lease; `blocked` waits on
      // it while idle and must hand its slot back, or `isolated` — which needs
      // no lease at all — would be starved until the holder finishes (#438).
      const holder = start(holdsLease, { task: 'holder', worktree: false });
      await holdsTheLease(fixture, holder.id);
      const blocked = start(INSTANT, { task: 'blocked', worktree: false });
      const isolated = start(INSTANT, { task: 'isolated' });

      await waitFor(
        () => SETTLED.includes(store.getRun(isolated.id)?.status ?? ''),
        'the isolated worktree run to finish',
      );
      // The point of the assertion: it got through while the root lease holder
      // was still running, instead of queueing behind an idle lease waiter.
      expect(store.getRun(holder.id)?.status).toBe('running');
      // And `blocked` was still parked on the lease at that moment, so the slot
      // `isolated` ran in is the one `blocked` handed back — not one it freed by
      // finishing. A lease waiter deliberately keeps the store status `running`,
      // so the GUI never shows it as awaiting user input.
      expect(store.getRun(blocked.id)?.status).toBe('running');

      release();
      await waitFor(
        () => [holder.id, blocked.id].every((id) => SETTLED.includes(store.getRun(id)?.status ?? '')),
        'the root runs to finish',
      );
      expect(store.getRun(holder.id)?.status).toBe('done');
      expect(store.getRun(blocked.id)?.status).toBe('done');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cancels a run blocked on the lease without waiting for the holder',
    async () => {
      const fixture = fixtureRepo();
      const { store, manager, holdsLease, release, start } = fixture;

      const holder = start(holdsLease, { task: 'holder', worktree: false });
      await holdsTheLease(fixture, holder.id);
      const blocked = start(INSTANT, { task: 'blocked', worktree: false });
      // The note is emitted immediately before the lease is awaited, so it — not
      // the `running` status, which lands well before — is what pins the run to
      // the blocked state this test is about.
      await waitFor(
        () =>
          store
            .readEvents(blocked.id)
            .some((event) => event.type === 'note' && String(event.message).includes('exclusive access')),
        'the blocked run to reach the lease',
      );

      expect(manager.cancel(blocked.id)).toBe(true);
      await waitFor(() => store.getRun(blocked.id)?.status === 'cancelled', 'the cancel to settle');
      // Settled while the holder still owns the tree — the lease wait aborted
      // rather than reporting success and sitting in `active` until the holder
      // released. Nothing has released the holder yet, so this is a fact about
      // the cancel path and not about how fast the assertion got here.
      expect(store.getRun(holder.id)?.status).toBe('running');

      // The lease chain survives the cancel: a later root run still gets the
      // tree once the holder hands it on.
      const after = start(INSTANT, { task: 'after', worktree: false });
      release();
      await waitFor(() => SETTLED.includes(store.getRun(after.id)?.status ?? ''), 'the later run to finish');
      expect(store.getRun(after.id)?.status).toBe('done');
    },
    TEST_TIMEOUT_MS,
  );
});
