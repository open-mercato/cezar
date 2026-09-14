import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { AUTONOMOUS_NUDGE, MAX_AUTO_CONTINUES, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Autonomous mode (#autonomous) must never park a run at `waiting`: at every turn end cezar
 * sends `AUTONOMOUS_NUDGE` into the open session, bounded by `MAX_AUTO_CONTINUES`.
 *
 * The nudge was unreachable on BOTH turn-end handlers, in two different ways — the shape
 * AGENTS.md names under "find every construction site of a shared in-memory object":
 *  - `runContinuation` had the branch but built its `ActiveRun` without `autonomous`, so the
 *    condition was always false;
 *  - `runAgentStep` (the run's FIRST session) never had the branch at all.
 * The existing coverage (`recover-autonomous.test.ts`, run.test.ts's "gate on + autonomous +
 * changes → done") only pins the settle/review-gate reading of the flag, which is why a flag that
 * did nothing at turn end still looked tested.
 *
 * Driven dry through `scripts/mock-claude.mjs`: `mock:autonomous` ends the first turn plainly and
 * answers the nudge with `CEZ:DONE`, so a nudged run can actually finish inside a test.
 */
describe('autonomous mode nudges at turn end instead of parking (#autonomous)', () => {
  // Fresh repo + manager per test, like the #490 suite: these runs park (or hold the exclusive
  // repo-root lock while working), so a shared manager would starve the next test.
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-autonudge-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
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
    if (currentId) manager.cancel(currentId); // release the session + repo lock
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

  const readEvents = (id: string): Array<{ type: string; message?: string; stepId?: string }> => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; message?: string; stepId?: string });
  };

  const notesMatching = (id: string, needle: string) =>
    readEvents(id).filter((e) => e.type === 'note' && String(e.message).includes(needle));

  const nudgeNotes = (id: string): string[] =>
    notesMatching(id, 'autonomous — continuing').map((e) => String(e.message));

  /** Every status the record ever passed through — a park can be brief, so polling the record
   *  could miss it. The store is the SSE bus and emits one `run` event per update. */
  const trackStatuses = (): string[] => {
    const seen: string[] = [];
    store.on('run', (record: RunRecord) => {
      if (seen[seen.length - 1] !== record.status) seen.push(record.status);
    });
    return seen;
  };

  it('nudges an autonomous run at its FIRST turn end and never parks it at waiting', async () => {
    const statuses = trackStatuses();
    const record = manager.startRun(SINGLE_STEP, {
      task: 'mock:autonomous implement the thing',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;

    // The nudge fires on the first session's turn end — the site that had no branch at all.
    await waitFor(record.id, () => nudgeNotes(record.id).length > 0);
    expect(nudgeNotes(record.id)[0]).toContain(
      `autonomous — continuing without pausing (1/${MAX_AUTO_CONTINUES})`,
    );

    // And the nudged turn ends with CEZ:DONE, so the run settles instead of sitting on a slot.
    await waitFor(record.id, (r) => r?.status === 'done');
    expect(statuses).not.toContain('waiting');
    expect(store.getRun(record.id)?.steps.every((s) => s.status !== 'waiting')).toBe(true);
  }, 40_000);

  it('a NON-autonomous run whose turn ends plainly still parks at waiting (unchanged)', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'just do the thing', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(store.getRun(record.id)?.activity).toBeUndefined();
    expect(nudgeNotes(record.id)).toEqual([]);
  }, 40_000);

  it('nudges a CONTINUATION of an autonomous run instead of parking it at waiting', async () => {
    // A finished autonomous run: `mock:done` closes the first session on its own turn (DONE wins
    // over the nudge), so nothing here depends on the first-step site.
    const record = manager.startRun(SINGLE_STEP, {
      task: 'mock:done first pass',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'done');
    expect(nudgeNotes(record.id)).toEqual([]);
    expect(store.getRun(record.id)?.autonomous).toBe(true);

    const statuses = trackStatuses();
    expect(manager.continueRun(record.id, { text: 'mock:autonomous keep going' })).toEqual({ ok: true });

    // `runContinuation` builds its OWN ActiveRun; it must read `autonomous` off the record.
    await waitFor(record.id, () => nudgeNotes(record.id).length > 0);
    expect(nudgeNotes(record.id)[0]).toContain(
      `autonomous — continuing without pausing (1/${MAX_AUTO_CONTINUES})`,
    );
    // Same helper, same event SHAPE: every other event this handler writes is attributed to the
    // continuation's own step, and the cockpit keys transcript items by `stepId`. A nudge note
    // from a continuation must not be the one anonymous event in the file.
    expect(notesMatching(record.id, 'autonomous — continuing')[0]?.stepId).toBe(
      store.getRun(record.id)?.currentStepId,
    );
    expect(notesMatching(record.id, 'autonomous — continuing')[0]?.stepId).toMatch(/^continue-/);
    await waitFor(record.id, (r) => r?.status === 'done');
    expect(statuses).not.toContain('waiting');
  }, 40_000);

  it('a NON-autonomous continuation still parks at waiting (unchanged)', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done first pass', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review');
    expect(manager.continueRun(record.id, { text: 'plain follow-up' })).toEqual({ ok: true });
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(nudgeNotes(record.id)).toEqual([]);
  }, 40_000);

  it('stops at MAX_AUTO_CONTINUES and parks the run, so the loop is bounded', async () => {
    // No `mock:autonomous` arming: the mock answers every nudge plainly and never emits
    // CEZ:DONE, which is the stuck-agent case the cap exists for.
    const record = manager.startRun(SINGLE_STEP, {
      task: 'never finishes on its own',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting', 120_000);
    const notes = nudgeNotes(record.id);
    expect(notes).toHaveLength(MAX_AUTO_CONTINUES);
    expect(notes[0]).toContain(`(1/${MAX_AUTO_CONTINUES})`);
    expect(notes[MAX_AUTO_CONTINUES - 1]).toContain(
      `(${MAX_AUTO_CONTINUES}/${MAX_AUTO_CONTINUES})`,
    );
    // The cap hands the run back exactly as a non-autonomous turn end does.
    expect(store.getRun(record.id)?.activity).toBeUndefined();
  }, 180_000);

  it('parks on a question the agent repeats after a nudge instead of nudging it to the cap', async () => {
    // The live-session failure this pins: the agent asked how to proceed around a refused
    // `cez task create`, the nudge overrode it forty times, and the agent improvised at full
    // cost. The first override stands (the #967 rule); the same question asked again parks.
    const record = manager.startRun(SINGLE_STEP, {
      task: 'mock:ask-repeat pick a date library',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting', 60_000);
    expect(nudgeNotes(record.id)).toHaveLength(1);
    expect(notesMatching(record.id, 'question overridden by the auto-continue nudge')).toHaveLength(1);
    const parked = notesMatching(record.id, 'the same question was asked again after a nudge');
    expect(parked).toHaveLength(1);
    expect(String(parked[0]?.message)).toContain('Which date library should I standardize on?');
    // The repeated question reaches the operator as a real ask card, not a silent park.
    expect(readEvents(record.id).some((e) => e.type === 'ask.requested')).toBe(true);
  }, 90_000);

  it('records the CEZ:ASK it overrides, so an overridden question is not lost', async () => {
    // The nudge deliberately outranks `CEZ:ASK` while budget remains — but `stripAskMarker`
    // removes the marker from the visible text and no ask card is emitted, so without an
    // explicit note the question would leave NO trace in the transcript at all.
    const record = manager.startRun(SINGLE_STEP, {
      task: 'mock:autonomous mock:ask pick a date library',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;

    await waitFor(record.id, () => nudgeNotes(record.id).length > 0);
    const overrides = notesMatching(record.id, 'question overridden by the auto-continue nudge');
    expect(overrides).toHaveLength(1);
    expect(String(overrides[0]?.message)).toContain(
      'Which date library should I standardize on?',
    );
    expect(overrides[0]?.stepId).toBe('task');

    // The run keeps going rather than parking on the question it just overrode.
    await waitFor(record.id, (r) => r?.status === 'done');
  }, 40_000);

  it('keeps the nudge text the dry-run mock recognises', () => {
    // `scripts/mock-claude.mjs` ends a nudged turn with CEZ:DONE by matching the OPENING WORDS
    // of the nudge (it carries no `mock:` marker of its own). Rewording the nudge without
    // updating the mock does not fail at the seam: the nudge still fires, the mock just never
    // finishes, and the autonomous tests above die on their waitFor deadline with "condition
    // not met in time" — pointing at neither side. Pin the coupling where it is readable.
    const mock = readFileSync(
      fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url)),
      'utf8',
    );
    const prefix = /AUTONOMOUS_NUDGE_PREFIX = '([^']+)'/.exec(mock)?.[1];
    expect(prefix, 'mock-claude.mjs no longer declares AUTONOMOUS_NUDGE_PREFIX').toBeTruthy();
    expect(AUTONOMOUS_NUDGE.startsWith(String(prefix))).toBe(true);
  });
});
