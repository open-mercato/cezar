import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * An in-place run (worktree off) owns the exclusive working-tree lease. Before `parkRepoRoot`
 * it kept that lease for as long as it was PARKED — on a question, or as a monitor waiting for
 * its dispatched children — and every other in-place task queued behind a session that was not
 * touching the tree, with the slots visibly free (the first live dispatch tree, 2026-09-11).
 * Now a park gives the lease back and `deliverMessage` takes it again before the session resumes.
 *
 * Scoped to runs IN a dispatch tree (spec 2026-09-10-dispatch A10), and the last test is the
 * counterweight: handing the tree to another task mid-park means a live session's view of the
 * files can go stale, so only the case with no alternative pays that price — a commander parked
 * for as long as its children take. An ordinary in-place run parking on a question keeps its
 * lease, exactly as it always has.
 *
 * Driven dry through `scripts/mock-claude.mjs`: `mock:monitoring` parks the first run as a
 * monitor, `mock:done` lets the second finish on its own.
 */
describe('a parked in-place run releases the working-tree lease', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-lease-park-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    for (const record of store.listRuns()) manager.cancel(record.id);
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const notes = (id: string): string[] => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .filter((e) => e.type === 'note')
      .map((e) => String(e.message));
  };

  /** An in-place run that became the ROOT of a dispatch tree — what `dispatch()` writes on a
   *  parent's first `cez task create`, and the only in-place run that parks for its children.
   *  Set the way `dispatch-engine.test.ts` does it; `mock:pause` keeps the turn open long enough
   *  that the record carries the tree before the turn ends. */
  const inPlaceRoot = (task: string): RunRecord => {
    const record = manager.startRun(SINGLE_STEP, { task, worktree: false });
    store.updateRun(record.id, { dispatch: { rootRunId: record.id } });
    return record;
  };

  it('lets another in-place task run while the first is parked, and waits for the tree before resuming', async () => {
    const parked = inPlaceRoot('mock:pause mock:monitoring watch my children');
    await waitFor(parked.id, (r) => r?.activity === 'monitoring');
    expect(notes(parked.id).some((m) => m.startsWith('parked — released the repository working tree'))).toBe(true);

    // Before the fix this run waited on the lease for as long as the first stayed parked. It holds
    // the tree for ~2 s (`mock:pause`) so the wake-up below has something to wait for.
    const second = manager.startRun(SINGLE_STEP, { task: 'mock:pause mock:done quick in-place fix', worktree: false });
    await waitFor(second.id, (r) => r?.status === 'running' && r.steps[0]?.status === 'running');
    expect(store.getRun(parked.id)?.activity).toBe('monitoring');

    // The wake-up is accepted at once, but reaches the session only once the tree is ours again.
    expect(manager.sendMessage(parked.id, [{ type: 'text', text: 'your child reported' }])).toBe(true);
    expect(store.getRun(parked.id)?.activity).toBe('monitoring');
    expect(notes(parked.id)).toContain('resuming — waiting for exclusive access to the repository working tree');
    await waitFor(second.id, (r) => r?.status === 'done');
    await waitFor(parked.id, (r) => r?.activity === undefined);
    // The resumed turn parks again (the mock answers plainly) and gives the lease back again.
    await waitFor(parked.id, (r) => r?.status === 'waiting');
    expect(notes(parked.id).filter((m) => m.startsWith('parked — released')).length).toBe(2);
    // Somebody else held the tree meanwhile, so the session is told its view of it may be stale
    // rather than left to clobber the other task's work.
    expect(readFileSync(join(repoRoot, '.ai/cezar/runs', `${parked.id}.ndjson`), 'utf8'))
      .toContain('another task held this repository working tree');
  }, 40_000);

  it('resumes synchronously when nobody holds the tree — the #347 guarantee is kept', async () => {
    const parked = manager.startRun(SINGLE_STEP, { task: 'park on a question', worktree: false });
    await waitFor(parked.id, (r) => r?.status === 'waiting');
    expect(manager.sendMessage(parked.id, [{ type: 'text', text: 'carry on' }])).toBe(true);
    expect(store.getRun(parked.id)?.status).toBe('running');
    expect(notes(parked.id)).not.toContain('resuming — waiting for exclusive access to the repository working tree');
    await waitFor(parked.id, (r) => r?.status === 'waiting');
  }, 30_000);

  it('does not touch a worktree run — it never held the lease', async () => {
    const isolated = manager.startRun(SINGLE_STEP, { task: 'mock:monitoring in a worktree' });
    await waitFor(isolated.id, (r) => r?.activity === 'monitoring');
    expect(notes(isolated.id).some((m) => m.startsWith('parked — released'))).toBe(false);
  }, 30_000);

  // The counterweight (A10): an in-place run with no dispatch keeps the lease across a park,
  // exactly as before this feature existed. Weakening #438 for every in-place run — a live
  // session's files changing under it — is a price only a dispatch tree has to pay.
  it('keeps the lease for an in-place run that is not in a dispatch tree', async () => {
    const parked = manager.startRun(SINGLE_STEP, { task: 'mock:monitoring plain in-place work', worktree: false });
    await waitFor(parked.id, (r) => r?.activity === 'monitoring');
    expect(notes(parked.id).some((m) => m.startsWith('parked — released'))).toBe(false);
  }, 30_000);
});
