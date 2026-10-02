import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isProviderRefusal } from '../core/usage-limit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * A turn the PROVIDER refused is not a step forward (#rate-limit-refusal).
 *
 * The live failure, measured on a free-tier model across 28 runs: 444 `Rate limit exceeded`
 * errors, and `MAX_AUTO_CONTINUES` (40) nudges burned in 14 SECONDS — the nudge read the refusal
 * as "the agent finished a turn, keep going" and re-fired the identical request into a door that
 * was already shut. Only after the cap did the run park, and then it sat out the full
 * `IDLE_TIMEOUT_MS` (15m) waiting for a turn that could not arrive. 90% of total wall clock was
 * that waiting.
 *
 * The shape that lets it happen is a NON-FATAL `session.error` (v2): the turn ends, the session
 * survives it, so the turn-end handler sees a live session and the nudge is reachable. A v1
 * `error` cannot reproduce it — that one interrupts the session, so the nudge is never called.
 * That is why these run on the `pi` backend, whose mock can emit the v2 shape, and NOT on the
 * claude mock whose every error path is fatal.
 */
describe('a provider-refused turn parks an autonomous run instead of nudging into it again', () => {
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ratelimit-'));
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
    if (currentId) manager.cancel(currentId);
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const readEvents = (id: string): Array<{ type: string; message?: string; seq: number }> => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; message?: string; seq: number });
  };

  const nudgeNotes = (id: string): string[] =>
    readEvents(id)
      .filter((e) => e.type === 'note' && String(e.message).includes('autonomous — continuing'))
      .map((e) => String(e.message));

  const refusalNotes = (id: string): string[] =>
    readEvents(id)
      .filter((e) => e.type === 'note' && String(e.message).includes('the provider refused this turn'))
      .map((e) => String(e.message));

  /** The pi mock answers a normal prompt with plain prose and no `CEZ:DONE`, so a run that is
   *  left alone parks. A refusal is observable as the v2 `session.error` on the transcript. */
  const refusedTurns = (id: string): number =>
    readEvents(id).filter((e) => e.type === 'session.error' && /rate limit/i.test(String(e.message))).length;

  it('refuses to nudge a refused turn, and parks the run on the FIRST refusal', async () => {
    const record = manager.startRun(SINGLE_STEP, {
      task: 'mock:refused do the thing',
      worktree: false,
      autonomous: true,
      runner: 'pi',
    });
    currentId = record.id;

    // The refusal is on the transcript…
    await waitFor(record.id, () => refusedTurns(record.id) > 0);
    // …and the run parks on it, which is the whole point: zero nudges.
    await waitFor(record.id, (r) => r?.status === 'waiting');

    // The regression itself. Before the fix this was 40 nudges in ~14s.
    expect(nudgeNotes(record.id)).toEqual([]);
    expect(refusalNotes(record.id).length).toBeGreaterThan(0);
    // Exactly one refusal was spent reaching the park — the spin did not happen.
    expect(refusedTurns(record.id)).toBe(1);
    expect(store.getRun(record.id)?.activity).toBeUndefined();
  }, 60_000);

  it('says WHY it parked, and keeps the work so a Continue can resume it', async () => {
    const record = manager.startRun(SINGLE_STEP, {
      task: 'mock:refused-once do the thing',
      worktree: false,
      autonomous: true,
      runner: 'pi',
    });
    currentId = record.id;

    await waitFor(record.id, (r) => r?.status === 'waiting');
    const notes = refusalNotes(record.id);
    expect(notes[0]).toMatch(/rate limit or quota/);
    expect(notes[0]).toMatch(/keeps its work/);

    // Park, not fail: the session is still open and the run keeps its Continue button, because a
    // provider refusal is not the work's fault and must not read as one.
    const parked = store.getRun(record.id);
    expect(parked?.status).toBe('waiting');
    expect(parked?.error).toBeUndefined();
    expect(parked?.steps.every((s) => s.sessionId !== undefined)).toBe(true);
  }, 60_000);

  it('an autonomous run whose turn is NOT refused still nudges (the guard is narrow)', async () => {
    // Pinned in both directions: the flag must not become a blanket "never nudge", or autonomous
    // mode stops being autonomous for every backend. This is the behaviour that must not change.
    const record = manager.startRun(SINGLE_STEP, {
      task: 'mock:autonomous implement the thing',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;

    await waitFor(record.id, () => nudgeNotes(record.id).length > 0);
    expect(nudgeNotes(record.id)[0]).toContain('autonomous — continuing without pausing');
    expect(refusalNotes(record.id)).toEqual([]);
  }, 60_000);
});

describe('isProviderRefusal', () => {
  it('recognises the refusals a free-tier provider actually sends', () => {
    expect(isProviderRefusal('Rate limit exceeded. Please try again later.')).toBe(true);
    expect(isProviderRefusal('Error from provider (Console): Rate limit exceeded.')).toBe(true);
    expect(isProviderRefusal('429 rate_limit_error')).toBe(true);
    expect(isProviderRefusal('You are out of credits')).toBe(true);
    expect(isProviderRefusal('Weekly limit reached')).toBe(true);
  });

  it('does not fire on ordinary failures — a bug in the work is still progress to be nudged past', () => {
    expect(isProviderRefusal('ENOENT: no such file or directory')).toBe(false);
    expect(isProviderRefusal('the test failed: expected 3, got 4')).toBe(false);
    expect(isProviderRefusal(undefined)).toBe(false);
    expect(isProviderRefusal('')).toBe(false);
  });

  it('shares its notion of "a limit" with parseUsageLimit, so the two cannot disagree', () => {
    // The invariant that keeps this honest: whatever this accepts as a refusal, the sibling
    // scheduler recognises as a limit too — it is the SAME regex, so a divergence here would mean
    // the two had drifted apart, which is exactly what must not happen silently.
    for (const message of ['Rate limit exceeded.', 'You are out of credits', 'quota reached']) {
      expect(isProviderRefusal(message)).toBe(true);
    }
  });
});