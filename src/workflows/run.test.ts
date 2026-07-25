import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.js';
import { RunStore, type RunRecord } from '../runs/store.js';
import { RunManager } from './run.js';
import type { WorkflowDef } from './types.js';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const TURN_TEXT =
  "I'll catch the AuthError in the login handler so wrong passwords answer 401.\n\nDetails follow.";

/**
 * Turn-end bookkeeping (#389, task auto-naming spec) against a REAL fixture
 * repo: `recordTurnEnd` is the exact method both agent-event paths fire on
 * `turn-end`, driven directly here because a live agent session is the only
 * other way to reach it. CEZ_AUTONAME=0 keeps the namer (an LLM call) out of
 * these fixtures — titles are ONLY ever namer-owned or user-owned now, never
 * derived from turn text.
 */
describe('RunManager.recordTurnEnd', () => {
  const savedAutoname = process.env.CEZ_AUTONAME;
  beforeAll(() => {
    process.env.CEZ_AUTONAME = '0';
  });
  afterAll(() => {
    if (savedAutoname === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoname;
  });
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-turnend-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\ntwo\nthree\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A run with a real worktree forked off main, holding an edit + a new file. */
  async function makeWorktreeRun(): Promise<RunRecord> {
    const record = store.createRun({ title: 'fix the login bug', workflow: 'quick-task', task: 'fix the login bug', steps: [] });
    const wt = await createWorktree(repoRoot, record.id, 'main');
    store.updateRun(record.id, { worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch });
    writeFileSync(join(wt.path, 'a.txt'), 'one\nTWO\nthree\n'); // 1 add, 1 del
    writeFileSync(join(wt.path, 'new.txt'), 'x\ny\n'); // 2 adds, untracked
    return store.getRun(record.id) as RunRecord;
  }

  it('computes a real diffStat and never derives a title from turn text', async () => {
    const record = await makeWorktreeRun();
    await manager.recordTurnEnd(record.id, TURN_TEXT);

    const after = store.getRun(record.id);
    // The agent's words are not a title source (they produced "Reading the
    // handoff…"-class titles) — naming is the namer's job, or the user's.
    expect(after?.titleSummary).toBeUndefined();
    expect(after?.diffStat).toEqual({ adds: 3, dels: 1, files: 2 });

    // Second turn: the diff stat keeps refreshing.
    writeFileSync(join(store.getRun(record.id)!.worktreePath!, 'more.txt'), 'z\n');
    await manager.recordTurnEnd(record.id, 'Now I rewrote everything from scratch with a different approach.');
    const later = store.getRun(record.id);
    expect(later?.titleSummary).toBeUndefined();
    expect(later?.diffStat).toEqual({ adds: 4, dels: 1, files: 3 });
  });

  it('never overwrites a user-edited title (PATCH sets titleSummary too)', async () => {
    const record = await makeWorktreeRun();
    // What PATCH /api/runs/:id does on a rename:
    store.updateRun(record.id, { title: 'My name', titleSummary: 'My name', titleOrigin: 'user' });
    await manager.recordTurnEnd(record.id, TURN_TEXT);
    expect(store.getRun(record.id)?.titleSummary).toBe('My name');
  });

  it('skips diffStat for a worktree-less run, and never throws', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'do the thing', steps: [] });
    await expect(manager.recordTurnEnd(record.id, TURN_TEXT)).resolves.toBeUndefined();
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBeUndefined();
    expect(after?.diffStat).toBeUndefined();
  });

  it('is a quiet no-op for an unknown run', async () => {
    await expect(manager.recordTurnEnd('nope', TURN_TEXT)).resolves.toBeUndefined();
  });

  it('applies in-band CEZ markers from the turn text (spec 2026-07-18-task-ref-markers)', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'implement comment threads', steps: [] });
    await manager.recordTurnEnd(
      record.id,
      'Progress so far.\nCEZ:PR=500\nCEZ:ISSUE=433\nCEZ:TITLE=implementing comment threads\nMore to come.',
    );
    const after = store.getRun(record.id);
    expect(after?.prNumber).toBe(500);
    expect(after?.issueNumber).toBe(433);
    expect(after?.markerRefs).toEqual({ pr: 500, issue: 433 });
    // The declared title lands number-prefixed, marker-owned.
    expect(after?.titleSummary).toBe('500: implementing comment threads');
    expect(after?.titleOrigin).toBe('marker');
  });

  it('a marker title never overwrites a user rename — but the numbers still land', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.updateRun(record.id, { title: 'My name', titleSummary: 'My name', titleOrigin: 'user' });
    await manager.recordTurnEnd(record.id, 'CEZ:PR=500\nCEZ:TITLE=implementing comment threads');
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBe('My name');
    expect(after?.titleOrigin).toBe('user');
    expect(after?.prNumber).toBe(500);
  });

  it('a junk CEZ:TITLE never blanks the title', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    await manager.recordTurnEnd(record.id, 'CEZ:PR=500\nCEZ:TITLE=...');
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBeUndefined();
    expect(after?.titleOrigin).toBeUndefined();
    expect(after?.prNumber).toBe(500); // the number still lands
  });

  it('prose that merely mentions a marker changes nothing', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    await manager.recordTurnEnd(record.id, 'I will emit CEZ:PR=442 once the PR exists.');
    const after = store.getRun(record.id);
    expect(after?.markerRefs).toBeUndefined();
    expect(after?.prNumber).toBeUndefined();
    expect(after?.titleSummary).toBeUndefined();
  });
});

/**
 * Optional review gate (#489, spec 2026-07-18-optional-review-gate): the
 * terminal `settleSuccess` transition parks a changed run at `review` ONLY when
 * the gate is enabled (config toggle over `CEZ_REVIEW_GATE`, default off) and the
 * run is not autonomous. Driven directly through the private `settleSuccess`
 * (the same method `execute`, `runContinuation`, and `recover`'s waiting-run path
 * all call) against a real fixture worktree.
 */
describe('RunManager.settleSuccess — optional review gate', () => {
  const savedGate = process.env.CEZ_REVIEW_GATE;
  const savedAutoname = process.env.CEZ_AUTONAME;
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeAll(async () => {
    process.env.CEZ_AUTONAME = '0';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-reviewgate-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\ntwo\nthree\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedGate === undefined) delete process.env.CEZ_REVIEW_GATE;
    else process.env.CEZ_REVIEW_GATE = savedGate;
    if (savedAutoname === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoname;
  });

  afterEach(() => {
    delete process.env.CEZ_REVIEW_GATE;
    // Reset the config file each test so config.reviewGate never leaks across cases.
    rmSync(join(repoRoot, '.ai/cezar', 'config.json'), { force: true });
  });

  /** A fresh run + worktree holding a real diff (edit + new file) vs main. */
  async function changedRun(autonomous?: boolean): Promise<RunRecord> {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', autonomous, steps: [] });
    const wt = await createWorktree(repoRoot, record.id, 'main');
    store.updateRun(record.id, { worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch });
    writeFileSync(join(wt.path, 'a.txt'), 'one\nTWO\nthree\n');
    writeFileSync(join(wt.path, 'new.txt'), 'x\n');
    return store.getRun(record.id) as RunRecord;
  }

  /** A fresh run + worktree with no changes vs main (empty diff). */
  async function cleanRun(): Promise<RunRecord> {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    const wt = await createWorktree(repoRoot, record.id, 'main');
    store.updateRun(record.id, { worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch });
    return store.getRun(record.id) as RunRecord;
  }

  const settle = (id: string) => (manager as unknown as { settleSuccess(id: string): Promise<void> }).settleSuccess(id);

  it('gate off (default) + changes → done, diff left in the worktree', async () => {
    const record = await changedRun();
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
  });

  it('gate on (env) + non-autonomous + changes → review', async () => {
    process.env.CEZ_REVIEW_GATE = '1';
    const record = await changedRun();
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('review');
  });

  it('gate on + autonomous + changes → done (autonomous wins — the #489 fix)', async () => {
    process.env.CEZ_REVIEW_GATE = '1';
    const record = await changedRun(true);
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
  });

  it('gate on + no changes → done (the diff check stays first)', async () => {
    process.env.CEZ_REVIEW_GATE = '1';
    const record = await cleanRun();
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
  });
});

/**
 * Regression for #410: the GitHub tab's "Hand over" panel lets a user select
 * several skills at once, which become one agent step per skill (spec 008 —
 * `skillChainSteps` / `skillsToSteps`) in a single run. The reported bug was
 * that only the FIRST selected skill actually did anything — the run finished
 * right after it, with the second skill's step marked `done` despite never
 * doing real work. It wasn't dropped when the step list was built (both steps
 * are present and the engine's loop does iterate over both, proven below);
 * the root cause was that every step got the identical task text and shared
 * one run-level handoff journal, so the LAST step's fresh session — the only
 * one that honors `CEZ:DONE` as an early-completion signal — could read an
 * earlier step's own "done" report and conclude the whole run was already
 * finished, ending its first turn with the marker before doing its own
 * step's work. The fix (`chainStepNote`, `workflows/types.ts`) tells every
 * step of a chain which position it holds and that an earlier step's
 * completion isn't its own — this end-to-end run proves both effects: both
 * steps really execute (their mock sessions both leave a trace in the
 * worktree), and the note text actually reaches the second step's prompt.
 */
describe('a chain of 2 selected skills runs BOTH steps, in order (#410)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-410-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('runs both skill steps to completion, and the second step\'s prompt carries the chain guard', async () => {
    // Exactly the shape `githubRunBody` / `skillChainSteps` build for 2
    // selected skills: one agent step per skill, every step's prompt just
    // `{{task}}` — no per-step differentiation from the GUI side.
    const workflow: WorkflowDef = {
      name: '(planned)',
      source: 'built-in',
      steps: [
        { id: 'om-auto-review-pr', name: 'om-auto-review-pr', skill: 'om-auto-review-pr', prompt: '{{task}}' },
        { id: 'om-auto-verify-pr-ui', name: 'om-auto-verify-pr-ui', skill: 'om-auto-verify-pr-ui', prompt: '{{task}}' },
      ],
    };
    // `mock:done` makes the mock's turn end with CEZ:DONE — needed so the
    // last (interactive) step closes itself and the run reaches a terminal
    // status instead of parking at `waiting` for a real reply.
    const record = manager.startRun(workflow, { task: 'mock:done fix the PR', worktree: false });

    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }

    const finished = store.getRun(record.id);
    // Neither step failed or was skipped — the reported bug looked exactly
    // like this from the RunRecord's point of view (both `done`) while the
    // second step's session had done nothing; the assertion below on
    // `notes.md` is what actually distinguishes a real run from a no-op one.
    expect(finished?.steps.map((s) => ({ id: s.id, status: s.status }))).toEqual([
      { id: 'om-auto-review-pr', status: 'done' },
      { id: 'om-auto-verify-pr-ui', status: 'done' },
    ]);

    // The mock leaves a `notes.md` trace on its first turn, once per spawned
    // session (`scripts/mock-claude.mjs`) — one line per step that actually
    // ran, in order, holding the head of that step's userText.
    //
    // Assert only on the note's opening sentence: it proves the guard reached
    // the right step's prompt with the right numbering, and stays inside the
    // mock's fixed userText slice however the wording grows later. The note's
    // full text is pinned in `test/unit/workflow-types.test.ts`.
    const notes = readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n');
    expect(notes.length).toBe(2);
    expect(notes[0]).toContain('you are running step 1 of 2');
    expect(notes[1]).toContain('you are running step 2 of 2');
  }, 30_000);
});

/**
 * The other half of #410's contract: the note exists to explain a step
 * boundary, so a workflow with only ONE agent step must not get it — its
 * prompt stays exactly what the author wrote. Check steps are shell commands,
 * not sessions, so they don't make a chain no matter how many surround the
 * agent step. This is the README's canonical `implement` + `verify` shape, the
 * one most user workflows are built from, and the note's first cut fired on
 * all of them (`steps.length` counted the check) — telling a lone step that
 * "an earlier step" may have reported its work done, when there was none.
 */
describe('a single agent step plus a check step gets NO chain note (#410)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-410-single-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("leaves the lone agent step's prompt untouched", async () => {
    // README.md's documented workflow, with a check that passes so the run
    // reaches a terminal state without looping back.
    const workflow: WorkflowDef = {
      name: 'implement-verify',
      source: 'file',
      steps: [
        { id: 'implement', skill: 'project-conventions', prompt: '{{task}}' },
        { id: 'verify', command: 'true', onFail: { retry: 'implement', max: 2 } },
      ],
    };
    const record = manager.startRun(workflow, { task: 'mock:done fix the login bug', worktree: false });

    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(store.getRun(record.id)?.steps.map((s) => ({ id: s.id, status: s.status }))).toEqual([
      { id: 'implement', status: 'done' },
      { id: 'verify', status: 'done' },
    ]);

    // One session ran, and its userText is the task text alone — no chain
    // note, no "an earlier step" premise, no skill named as the step's goal.
    const notes = readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n');
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('mock:done fix the login bug');
    expect(notes[0]).not.toContain('chain of');
    expect(notes[0]).not.toContain('earlier step');
    expect(notes[0]).not.toContain('project-conventions');
  }, 30_000);
});

/**
 * #490 — the `CEZ:MONITORING` marker parks a still-working turn-end as
 * `running`/`activity:'monitoring'` (a non-attention state) instead of
 * `waiting`, while a markerless turn-end still parks as `waiting`. Resuming
 * clears the activity. Driven dry through the mock (`mock:monitoring`).
 */
describe('CEZ:MONITORING parks as running/monitoring, not waiting (#490)', () => {
  // Fresh repo + manager per test: these runs PARK (they never reach a terminal
  // status), and a `worktree:false` parked run holds the exclusive repo-root
  // lock — so a shared manager would starve the next test. Isolation avoids that.
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-490-'));
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
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('a CEZ:MONITORING turn-end parks the run as running/monitoring', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:monitoring keep going', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.activity === 'monitoring');
    const parked = store.getRun(record.id);
    expect(parked?.status).toBe('running'); // a sub-state of running, NOT waiting
    expect(parked?.activity).toBe('monitoring');
  }, 30_000);

  it('a markerless turn-end still parks as waiting with no activity', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'just do the thing', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(store.getRun(record.id)?.activity).toBeUndefined();
  }, 30_000);

  it('strips the CEZ:MONITORING marker from server-emitted v1 text events', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:monitoring keep going', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.activity === 'monitoring');
    // v1 `text` events are stripped server-side (like CEZ:DONE); v2 message items carry
    // the raw text and the thread reducer strips it on display (thread-state.test.ts).
    const ndjson = readFileSync(join(repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8');
    const v1Text = ndjson
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'text');
    expect(v1Text.length).toBeGreaterThan(0);
    expect(v1Text.some((e) => String(e.text).includes('CEZ:MONITORING'))).toBe(false);
  }, 30_000);

  it('resuming a monitoring run clears the activity', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:monitoring keep going', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.activity === 'monitoring');
    // A user reply (no marker) resumes the run: the follow-up turn re-parks as
    // plain `waiting`, and the monitoring activity is gone.
    expect(manager.sendMessage(record.id, [{ type: 'text', text: 'thanks, carry on' }])).toBe(true);
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(store.getRun(record.id)?.activity).toBeUndefined();
  }, 30_000);
});

/**
 * #473 — the `CEZ:ASK` marker parks a turn-end as `waiting` (attention, NOT
 * monitoring) AND emits an `ask.requested` v2 event so the cockpit renders a
 * structured question as clickable chips. The marker is stripped from the v1
 * text; a markerless turn raises no ask. Driven dry through the mock
 * (`mock:ask`).
 */
describe('CEZ:ASK parks as waiting and emits ask.requested (#473)', () => {
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-473-'));
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
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const readEvents = (id: string): Array<Record<string, unknown>> =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('a CEZ:ASK turn-end parks the run as waiting (attention) and emits ask.requested', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:ask which library?', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    const parked = store.getRun(record.id);
    expect(parked?.status).toBe('waiting'); // attention — NOT running/monitoring
    expect(parked?.activity).toBeUndefined();
    const asks = readEvents(record.id).filter((e) => e.type === 'ask.requested');
    expect(asks).toHaveLength(1);
    expect(typeof asks[0]!.requestId).toBe('string');
    const questions = asks[0]!.questions as Array<{ header: string; options: unknown[] }>;
    expect(questions[0]!.header).toBe('Library');
    expect(questions[0]!.options).toHaveLength(2);
  }, 30_000);

  it('strips the CEZ:ASK marker from server-emitted v1 text events', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:ask pick one', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    const v1Text = readEvents(record.id).filter((e) => e.type === 'text');
    expect(v1Text.length).toBeGreaterThan(0);
    expect(v1Text.some((e) => String(e.text).includes('CEZ:ASK'))).toBe(false);
  }, 30_000);

  it('a markerless turn-end raises no ask.requested', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'just do the thing', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(readEvents(record.id).some((e) => e.type === 'ask.requested')).toBe(false);
  }, 30_000);

  it('a malformed CEZ:ASK degrades gracefully: parks waiting, no ask card', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:ask-bad choose', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    const parked = store.getRun(record.id);
    expect(parked?.status).toBe('waiting'); // still parks — never worse than the prose fallback
    expect(parked?.activity).toBeUndefined();
    expect(readEvents(record.id).some((e) => e.type === 'ask.requested')).toBe(false);
  }, 30_000);

  // Regression (blank-question bug): valid JSON that fails the ask schema used
  // to be STRIPPED from the v1 text while emitting no ask.requested — the
  // question vanished from the transcript entirely, leaving the user nothing
  // to answer. An invalid marker must survive as raw text (degraded but
  // answerable) and still park the run `waiting`.
  it('a schema-invalid CEZ:ASK stays visible in v1 text — no card will ever render it', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:ask-invalid choose', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    const events = readEvents(record.id);
    expect(events.some((e) => e.type === 'ask.requested')).toBe(false);
    const assistantText = events.filter((e) => e.type === 'text');
    expect(assistantText.some((e) => String(e.text).includes('CEZ:ASK {"questions":[]}'))).toBe(true);
  }, 30_000);
});
