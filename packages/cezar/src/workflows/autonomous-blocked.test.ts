import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** #1540: an autonomous agent that declares `CEZ:BLOCKED` parks without a nudge and stays parked. */
describe('autonomous external-blocked state (#1540)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  let savedDry: string | undefined;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-blocked-'));
    savedDry = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    currentId = undefined;
  });

  afterEach(() => {
    if (currentId) manager.cancel(currentId);
    manager.dispose();
    if (savedDry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDry;
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
  const events = (id: string): Array<{ type: string; message?: string; text?: string }> => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    return existsSync(path)
      ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  };
  const notes = (id: string, needle: string) =>
    events(id).filter((e) => e.type === 'note' && String(e.message).includes(needle));

  const expectParkedBlocked = async (id: string) => {
    await waitFor(id, (r) => r?.status === 'waiting');
    await new Promise((r) => setTimeout(r, 600)); // a nudge would have flipped it back to running
    const record = store.getRun(id);
    expect(record?.status).toBe('waiting');
    expect(record?.blocked).toMatchObject({ category: 'credential', resume: 'owner-local token is available' });
    expect(record?.askParked).toBe(true);
    expect(notes(id, 'autonomous — continuing')).toEqual([]);
    expect(notes(id, 'blocked (credential)')).toHaveLength(1);
    expect(events(id).some((e) => e.type === 'text' && String(e.text).includes('CEZ:BLOCKED'))).toBe(false);
  };

  it('parks the FIRST session without nudging, and an explicit message resumes it', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:blocked need the token', worktree: false, autonomous: true });
    currentId = record.id;
    await expectParkedBlocked(record.id);

    expect(manager.sendMessage(record.id, [{ type: 'text', text: 'mock:done token added, carry on' }])).toBe(true);
    await waitFor(record.id, (r) => r?.status === 'done');
    expect(store.getRun(record.id)?.blocked).toBeUndefined();
  }, 40_000);

  it('parks a CONTINUATION without nudging', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done first pass', worktree: false, autonomous: true });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'done');
    expect(manager.continueRun(record.id, { text: 'mock:blocked need the token' })).toEqual({ ok: true });
    await waitFor(record.id, (r) => r?.blocked !== undefined);
    await expectParkedBlocked(record.id);
  }, 40_000);

  it('a restart keeps the blocker and settles failed with Continue, never done', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:blocked need the token', worktree: false, autonomous: true });
    currentId = record.id;
    await expectParkedBlocked(record.id);
    store.flush();

    const reopened = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    const restarted = new RunManager(reopened, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
    });
    await restarted.recover();
    restarted.dispose();
    expect(reopened.getRun(record.id)?.status).toBe('failed');
    expect(reopened.getRun(record.id)?.blocked?.category).toBe('credential');
    expect(reopened.getRun(record.id)?.awaitingAnswerSince).toBeDefined();
  }, 40_000);

  it('a malformed marker is not a blocker: the run is still nudged', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:blocked-bad mock:autonomous go', worktree: false, autonomous: true });
    currentId = record.id;
    await waitFor(record.id, () => notes(record.id, 'autonomous — continuing').length > 0);
    expect(store.getRun(record.id)?.blocked).toBeUndefined();
  }, 40_000);

  it('an agent that never emits the marker stops being nudged once it repeats itself', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'cannot proceed without credentials', worktree: false, autonomous: true });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(notes(record.id, 'autonomous — continuing').length).toBeLessThanOrEqual(2);
    expect(notes(record.id, 'repeated its previous reply')).toHaveLength(1);
  }, 40_000);
  it('a repeated reply WITH tool calls each turn keeps being nudged to the cap (#1809)', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:tools-each-turn cannot proceed without credentials', worktree: false, autonomous: true });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(notes(record.id, 'repeated its previous reply')).toHaveLength(0);
    expect(notes(record.id, 'autonomous — continuing').length).toBeGreaterThan(2);
  }, 40_000);
});
