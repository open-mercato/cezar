import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import { RunManager } from './run.js';
import type { WorkflowDef } from './types.js';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

/** Real Git fixture — unlike `run-isolation.test.ts`, worktree creation is not
 *  mocked here, so isolated runs genuinely succeed and can be observed
 *  overtaking root runs that are queued behind the lease. */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-root-lease-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  return root;
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settled = ['done', 'failed', 'cancelled', 'review'];

/** Occupies the repo-root lease long enough to observe what queues behind it. */
const SLOW_ROOT: WorkflowDef = {
  name: 'slow-root',
  source: 'built-in',
  steps: [{ id: 'hold', command: 'node -e "setTimeout(()=>{},1500)"' }],
};
const INSTANT: WorkflowDef = {
  name: 'instant',
  source: 'built-in',
  steps: [{ id: 'noop', command: 'node -e ""' }],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RunManager repository-root lease scheduling', () => {
  it('does not let a lease-blocked run consume a parallel slot', async () => {
    const root = fixtureRepo();
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);

    // maxParallel defaults to 2. `holder` takes the lease; `blocked` waits on
    // it while idle and must hand its slot back, or `isolated` — which needs
    // no lease at all — would be starved until the holder finishes (#438).
    const holder = manager.startRun(SLOW_ROOT, { task: 'holder', worktree: false });
    const blocked = manager.startRun(INSTANT, { task: 'blocked', worktree: false });
    const isolated = manager.startRun(INSTANT, { task: 'isolated' });

    await waitFor(
      () => settled.includes(store.getRun(isolated.id)?.status ?? ''),
      'the isolated worktree run to finish',
    );
    // The point of the assertion: it got through while the root lease holder
    // was still running, instead of queueing behind an idle lease waiter.
    expect(store.getRun(holder.id)?.status).toBe('running');

    await waitFor(
      () => [holder.id, blocked.id].every((id) => settled.includes(store.getRun(id)?.status ?? '')),
      'the root runs to finish',
    );
    expect(store.getRun(holder.id)?.status).toBe('done');
    expect(store.getRun(blocked.id)?.status).toBe('done');
  });

  it('cancels a run blocked on the lease without waiting for the holder', async () => {
    const root = fixtureRepo();
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);

    const holder = manager.startRun(SLOW_ROOT, { task: 'holder', worktree: false });
    const blocked = manager.startRun(INSTANT, { task: 'blocked', worktree: false });
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
    // released.
    expect(store.getRun(holder.id)?.status).toBe('running');

    // The lease chain survives the cancel: a later root run still gets it.
    const after = manager.startRun(INSTANT, { task: 'after', worktree: false });
    await waitFor(() => settled.includes(store.getRun(after.id)?.status ?? ''), 'the later run to finish');
    expect(store.getRun(after.id)?.status).toBe('done');
  });
});
