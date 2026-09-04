import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ContentBlock } from '../core/agent-runner.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { createWorktree } from '../git-worktree.ts';
import { RunStore, type RunRecord, type StepState } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { parseTaskMarkers } from '../runs/task-markers.ts';
import { appendTurnText, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

type UsageAccountingHarness = {
  beginUsageInvocation(runId: string, state: Record<string, unknown>, stepId: string): void;
  handleRunnerUiEvent(
    runId: string,
    state: Record<string, unknown>,
    sink: { handle(event: UiEvent): void },
    event: UiEvent,
  ): void;
};

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const TURN_TEXT =
  "I'll catch the AuthError in the login handler so wrong passwords answer 401.\n\nDetails follow.";

describe('appendTurnText', () => {
  it.each(['initial execution', 'resumed execution'])(
    'preserves a marker boundary before later commentary during %s',
    () => {
      const turnText = appendTurnText(
        'Issue claimed.\n\nCEZ:PR=635\nCEZ:TITLE=linking per-project limits',
        'The verification gate confirms the defect.',
      );

      expect(turnText).toContain('CEZ:TITLE=linking per-project limits\nThe verification');
      expect(turnText).not.toContain('limitsThe');
      expect(parseTaskMarkers(turnText).title).toBe('linking per-project limits');
    },
  );

  it('matches runner result assembly for empty blocks and multiple complete text blocks', () => {
    expect(appendTurnText('', 'first')).toBe('first');
    expect(appendTurnText('first', '')).toBe('first');
    expect(appendTurnText(appendTurnText('', 'first'), 'second')).toBe('first\nsecond');
  });
});

describe('RunManager directional usage accounting', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let internal: UsageAccountingHarness;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-usage-accounting-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
    });
    internal = manager as unknown as UsageAccountingHarness;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function fixture() {
    const run = store.createRun({
      title: 'usage',
      workflow: 'quick-task',
      task: 'usage',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(run.id, 'work', { iterations: 1, status: 'running' });
    const state: Record<string, unknown> = { cancelled: false, interrupt: () => undefined, cwd: repoRoot };
    const sink = { handle: (_event: UiEvent) => undefined };
    return { run, state, sink };
  }

  it('deduplicates starts and completions while summing multiple turns in one invocation', () => {
    const { run, state, sink } = fixture();
    internal.beginUsageInvocation(run.id, state, 'work');
    const started: UiEvent = { type: 'turn.started', turnId: 'turn_1' };
    internal.handleRunnerUiEvent(run.id, state, sink, started);
    internal.handleRunnerUiEvent(run.id, state, sink, started);
    const completed: UiEvent = {
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { input: 10, output: 2, total: 12 },
    };
    internal.handleRunnerUiEvent(run.id, state, sink, completed);
    internal.handleRunnerUiEvent(run.id, state, sink, completed);
    internal.handleRunnerUiEvent(run.id, state, sink, { type: 'turn.started', turnId: 'turn_2' });
    internal.handleRunnerUiEvent(run.id, state, sink, {
      type: 'turn.completed',
      turnId: 'turn_2',
      stopReason: 'end_turn',
      usage: { input: 5, output: 1, total: 6 },
    });

    expect(store.getRun(run.id)?.steps[0]).toMatchObject({
      usageInvocationsStarted: 1,
      usageInvocationsObserved: 1,
      usageTurnsStarted: 2,
      usageTurnsRecorded: 2,
      inputTokens: 15,
      outputTokens: 3,
    });
    expect(store.getRun(run.id)).toMatchObject({ inputTokens: 15, outputTokens: 3 });
  });

  it('keeps the run aggregate absent after a pre-turn failure even when a later invocation is metered', () => {
    const { run, state, sink } = fixture();
    internal.beginUsageInvocation(run.id, state, 'work');
    // The first startSession attempt fails before emitting turn.started.
    internal.beginUsageInvocation(run.id, state, 'work');
    internal.handleRunnerUiEvent(run.id, state, sink, { type: 'turn.started', turnId: 'turn_1' });
    internal.handleRunnerUiEvent(run.id, state, sink, {
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { input: 8, output: 2, total: 10 },
    });

    expect(store.getRun(run.id)?.steps[0]).toMatchObject({
      usageInvocationsStarted: 2,
      usageInvocationsObserved: 1,
      usageTurnsStarted: 1,
      usageTurnsRecorded: 1,
      inputTokens: 8,
      outputTokens: 2,
    });
    expect(store.getRun(run.id)?.inputTokens).toBeUndefined();
    expect(store.getRun(run.id)?.outputTokens).toBeUndefined();
  });

  it('writes each completeness checkpoint before launching or forwarding its boundary event', () => {
    const { run, state } = fixture();
    store.flush();

    internal.beginUsageInvocation(run.id, state, 'work');
    expect(RunStore.open(join(repoRoot, '.ai/cezar')).getRun(run.id)?.steps[0]).toMatchObject({
      usageInvocationsStarted: 1,
    });

    const persistedAtSink: StepState[] = [];
    const sink = {
      handle: (_event: UiEvent) => {
        const persisted = RunStore.open(join(repoRoot, '.ai/cezar')).getRun(run.id)?.steps[0];
        if (persisted) persistedAtSink.push(persisted);
      },
    };
    internal.handleRunnerUiEvent(run.id, state, sink, { type: 'turn.started', turnId: 'turn_1' });
    internal.handleRunnerUiEvent(run.id, state, sink, {
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { input: 8, output: 2, total: 10 },
    });

    expect(persistedAtSink[0]).toMatchObject({
      usageInvocationsObserved: 1,
      usageTurnsStarted: 1,
    });
    expect(persistedAtSink[1]).toMatchObject({
      usageTurnsRecorded: 1,
      inputTokens: 8,
      outputTokens: 2,
    });
  });

  it('tracks an unmetered turn without recording it and ignores a completion that never started', () => {
    const { run, state, sink } = fixture();
    internal.beginUsageInvocation(run.id, state, 'work');
    internal.handleRunnerUiEvent(run.id, state, sink, {
      type: 'turn.completed',
      turnId: 'ghost',
      stopReason: 'end_turn',
      usage: { input: 99, output: 9, total: 108 },
    });
    internal.handleRunnerUiEvent(run.id, state, sink, { type: 'turn.started', turnId: 'turn_1' });
    internal.handleRunnerUiEvent(run.id, state, sink, {
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
    });
    expect(store.getRun(run.id)?.steps[0]).toMatchObject({
      usageInvocationsStarted: 1,
      usageInvocationsObserved: 1,
      usageTurnsStarted: 1,
    });
    expect(store.getRun(run.id)?.steps[0]?.usageTurnsRecorded).toBeUndefined();
    expect(store.getRun(run.id)?.inputTokens).toBeUndefined();
  });
});

it('parallel variants ignore a worktree opt-out and retain isolated mode', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-variant-isolation-'));
  const store = RunStore.open(join(repoRoot, '.ai/cezar'));
  try {
    const manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
    });
    const records = manager.startVariants(
      {
        name: 'quick-task',
        description: 'x',
        source: 'built-in',
        steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
      },
      { task: 'compare approaches', worktree: false },
      2,
    );

    expect(records.map((record) => record.worktree)).toEqual([undefined, undefined]);
  } finally {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

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

  /**
   * #751: `recordTurnEnd` is the ONE place `RunRecord.diffStat` is written, so it
   * is also the one place `run.branch` has to reach `worktreeShortstat` — without
   * it, a review/QA run that checked another branch out into its worktree stores
   * that branch's whole diff as this task's work.
   */
  it('stores only the uncommitted diff when the agent repointed the worktree HEAD', async () => {
    const record = await makeWorktreeRun();
    const wt = record.worktreePath as string;

    // A branch with real commits on it, checked out into the task's worktree —
    // exactly what a `review/pr-NNN` or QA run does.
    await run('git', ['checkout', '-q', '-b', 'someone-elses-branch'], { cwd: wt });
    writeFileSync(join(wt, 'theirs.txt'), 'a\nb\nc\nd\ne\nf\n'); // 6 lines that are NOT this task's
    await run('git', ['add', '-A'], { cwd: wt });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'their work'], { cwd: wt });
    writeFileSync(join(wt, 'mine.txt'), 'z\n'); // the 1 line this task produced

    await manager.recordTurnEnd(record.id, TURN_TEXT);

    // 1 uncommitted line, flagged — not the 6 committed ones the foreign branch carries
    // (which, with `a.txt`'s edit and `new.txt`, would have read `+10 −1 / 4 files`).
    expect(store.getRun(record.id)?.diffStat).toEqual({
      adds: 1,
      dels: 0,
      files: 1,
      repointed: true,
    });
  });

  it('drops the repointed flag again once HEAD returns to the task branch', async () => {
    const record = await makeWorktreeRun();
    const wt = record.worktreePath as string;
    await run('git', ['checkout', '-q', '-b', 'a-detour'], { cwd: wt });
    await manager.recordTurnEnd(record.id, TURN_TEXT);
    expect(store.getRun(record.id)?.diffStat?.repointed).toBe(true);

    // `updateRun` replaces `diffStat` wholesale, so a stale `repointed: true` can
    // never outlive the repoint that caused it.
    await run('git', ['checkout', '-q', record.branch as string], { cwd: wt });
    await manager.recordTurnEnd(record.id, TURN_TEXT);
    const after = store.getRun(record.id);
    expect(after?.diffStat).toEqual({ adds: 3, dels: 1, files: 2 });
    expect(after?.diffStat).not.toHaveProperty('repointed');
  });

  it('never overwrites a user-edited title (PATCH sets titleSummary too)', async () => {
    const record = await makeWorktreeRun();
    // What PATCH /api/v1/runs/:id does on a rename:
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
 * `continueRun` runner/model override (#401): the follow-up composer can pick which backend and
 * model reopen the session. The override is persisted as the run's current backend BEFORE the
 * continuation is scheduled (so `runContinuation` reads it off the record); omitted fields
 * preserve the run's current choice. We stub the private continuation so no live session
 * starts — the assertion is only the synchronous record persistence.
 */
describe('RunManager.continueRun override', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-continue-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    // No live agent — we only assert the synchronous persistence continueRun does before it
    // hands off to the (stubbed) continuation.
    (manager as unknown as { runContinuation: () => Promise<void> }).runContinuation = async () => {};
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A finished run with a resumable session on the `claude`/`sonnet` backend. */
  function resumableRun(): string {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 't',
      runner: 'claude',
      model: 'sonnet',
      steps: [{ id: 's1', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    return record.id;
  }

  it('persists a runner + model override as the run current backend', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { runner: 'codex', model: 'gpt-5.1-codex' })).toEqual({ ok: true });
    const after = store.getRun(id);
    expect(after?.runner).toBe('codex');
    expect(after?.model).toBe('gpt-5.1-codex');
  });

  it('starts fresh when Continue switches to a backend that does not own the session', () => {
    const id = resumableRun();
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { runner: 'codex' })).toEqual({ ok: true });
    expect(calls[0]?.[2]).toBeUndefined();
    expect(calls[0]?.[3]).toBe('codex');
  });

  it('resumes when Continue stays on the backend that owns the session', () => {
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude' });
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { runner: 'claude' })).toEqual({ ok: true });
    expect(calls[0]?.[2]).toBe('sess-1');
    expect(calls[0]?.[3]).toBe('claude');
  });

  it('an omitted override preserves the run current backend/model (backward compat)', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    const after = store.getRun(id);
    expect(after?.runner).toBe('claude');
    expect(after?.model).toBe('sonnet');
  });

  it("an empty model clears the pin so the runner picks the model (auto)", () => {
    const id = resumableRun();
    manager.continueRun(id, { model: '' });
    expect(store.getRun(id)?.model).toBeUndefined();
    // Runner untouched → the run keeps its backend.
    expect(store.getRun(id)?.runner).toBe('claude');
  });

  it("rejects a model that is recognizably another runner's preset (no corruption persisted)", () => {
    const id = resumableRun();
    // The review's corruption case (#401): a codex preset landing on a claude continuation.
    const result = manager.continueRun(id, { model: 'gpt-5.1-codex' });
    expect(result).toEqual({ ok: false, error: "model 'gpt-5.1-codex' is not a claude model" });
    expect(store.getRun(id)?.model).toBe('sonnet');
    expect(store.getRun(id)?.runner).toBe('claude');
  });

  it('a runner-only switch clears the previous backend model pin instead of carrying it over', () => {
    const id = resumableRun(); // claude/sonnet
    // The composer sends only `runner` when the user switches backend without touching the
    // model pill (it displays `auto` at that point). The inherited `sonnet` pin belongs to
    // claude and must not reach the codex runner via `runContinuation`'s `model: record.model`.
    expect(manager.continueRun(id, { runner: 'codex' })).toEqual({ ok: true });
    const after = store.getRun(id);
    expect(after?.runner).toBe('codex');
    expect(after?.model).toBeUndefined();
  });

  it('a runner-only switch keeps a free-form model id — only known foreign presets are cleared', () => {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 't',
      runner: 'claude',
      model: 'my-org/custom-tune',
      steps: [{ id: 's1', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    expect(manager.continueRun(record.id, { runner: 'codex' })).toEqual({ ok: true });
    expect(store.getRun(record.id)?.model).toBe('my-org/custom-tune');
  });

  it('a runner-only continue on the SAME backend keeps the pin (no spurious clear)', () => {
    const id = resumableRun(); // claude/sonnet
    expect(manager.continueRun(id, { runner: 'claude' })).toEqual({ ok: true });
    expect(store.getRun(id)?.model).toBe('sonnet');
  });

  it('guards legacy records too — no persisted runner resolves to claude, like runContinuation', () => {
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [{ id: 's1', name: 'Work', kind: 'agent' }] });
    store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    const result = manager.continueRun(record.id, { model: 'gpt-5.1-codex' });
    expect(result.ok).toBe(false);
    expect(store.getRun(record.id)?.model).toBeUndefined();
  });

  it('keeps free-form model ids working — only cross-runner presets are rejected', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { model: 'my-custom-alias' })).toEqual({ ok: true });
    expect(store.getRun(id)?.model).toBe('my-custom-alias');
  });

  /* Agent accounts (spec 2026-07-29-agent-profiles): a follow-up may switch login as well as
     backend — and a session id only resolves inside the config dir that created it. */

  it('persists the picked account as the run current one', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { agentProfile: 'klaudiusz' })).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('klaudiusz');
    // Nothing else moves: the account is its own axis.
    expect(store.getRun(id)?.runner).toBe('claude');
    expect(store.getRun(id)?.model).toBe('sonnet');
  });

  it('starts fresh when Continue switches to another login of the same agent', () => {
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude', profileId: 'default' });
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { agentProfile: 'klaudiusz' })).toEqual({ ok: true });
    // `claude --resume <id>` under another login would find nothing and silently open a fresh
    // conversation, so the session id is deliberately not passed.
    expect(calls[0]?.[2]).toBeUndefined();
    expect(calls[0]?.[3]).toBe('claude');
  });

  it('resumes when the picked account is the one that owns the session', () => {
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude', profileId: 'klaudiusz' });
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { agentProfile: 'klaudiusz' })).toEqual({ ok: true });
    expect(calls[0]?.[2]).toBe('sess-1');
  });

  it('treats a step that recorded no account as the discovered one', () => {
    // Pre-accounts sessions ran under whatever `agentHomePaths()` finds, so re-picking `default`
    // is not a switch and must still resume.
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude' });
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { agentProfile: 'default' })).toEqual({ ok: true });
    expect(calls[0]?.[2]).toBe('sess-1');
  });

  it('an omitted account preserves the one the run is on (backward compat)', () => {
    const id = resumableRun();
    store.updateRun(id, { agentProfile: 'klaudiusz' });
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('klaudiusz');
  });

  it('a runner switch drops the previous agent account instead of carrying it over', () => {
    // An account belongs to ONE agent: a claude login says nothing about which codex account
    // should run, and leaving it on the record would re-apply it if a later Continue switched back.
    const id = resumableRun();
    store.updateRun(id, { agentProfile: 'klaudiusz' });
    expect(manager.continueRun(id, { runner: 'codex' })).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBeUndefined();
  });

  it('keeps the account when the continuation stays on the same agent', () => {
    const id = resumableRun();
    store.updateRun(id, { agentProfile: 'klaudiusz' });
    expect(manager.continueRun(id, { runner: 'claude' })).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('klaudiusz');
  });

  it('refuses to continue a run with no resumable session (no override persisted)', () => {
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'claude', steps: [] });
    store.updateRun(record.id, { status: 'done' });
    const result = manager.continueRun(record.id, { runner: 'codex' });
    expect(result.ok).toBe(false);
    expect(store.getRun(record.id)?.runner).toBe('claude');
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
    expect(finished?.worktree).toBe(false);
    expect(finished?.worktreePath).toBeUndefined();
    expect(finished?.baseBranch).toMatch(/^[0-9a-f]{40}$/);
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
    const state = (manager as unknown as { active: Map<string, { idleTimer?: NodeJS.Timeout }> }).active.get(record.id);
    expect(state?.idleTimer).toBeUndefined(); // durable monitors do not inherit the 15-minute user-wait timer
  }, 30_000);

  /**
   * #810 — the regression the two 0.9.2 reports describe. #661 removed the 15-minute
   * idle timer from the monitoring branch and replaced it with a wake timer that
   * defaulted OFF, so a zero-config parked monitor had NO timer at all and cezar has no
   * other resume path (no process-exit callback, no CI webhook, no sub-agent-completion
   * event). It sat in `monitoring` until a human typed something. A default manager must
   * therefore publish a wake deadline: the run has to be able to resume itself.
   */
  it('a parked monitor schedules its own re-check under the zero-config default (#810)', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:monitoring keep going', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.activity === 'monitoring');
    await waitFor(record.id, (r) => Boolean(r?.monitoringWakeAt));
    const parked = store.getRun(record.id);
    const deadline = Date.parse(String(parked?.monitoringWakeAt));
    expect(Number.isNaN(deadline)).toBe(false);
    expect(deadline).toBeGreaterThan(Date.now()); // a real future re-check, not a stale stamp
    const state = (manager as unknown as {
      active: Map<string, { idleTimer?: NodeJS.Timeout; monitoringWakeTimer?: NodeJS.Timeout }>;
    }).active.get(record.id);
    expect(state?.monitoringWakeTimer).toBeDefined();
    expect(state?.idleTimer).toBeUndefined(); // still no user-wait timeout — #661's fix stands
  }, 30_000);

  it('park mode remains reachable as an explicit operator choice (#810)', async () => {
    manager.dispose();
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: null } }),
    });
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:monitoring keep going', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.activity === 'monitoring');
    expect(store.getRun(record.id)?.monitoringWakeAt).toBeUndefined();
    const state = (manager as unknown as {
      active: Map<string, { monitoringWakeTimer?: NodeJS.Timeout }>;
    }).active.get(record.id);
    expect(state?.monitoringWakeTimer).toBeUndefined();
  }, 30_000);

  it('optionally wakes a parked monitor without fabricating a user message', async () => {
    manager.dispose();
    const semaphore = new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: 0.001 } });
    manager = new RunManager(store, repoRoot, { semaphore });
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:monitoring keep going', worktree: false });
    currentId = record.id;
    await waitFor(record.id, () => {
      const path = join(repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`);
      if (!existsSync(path)) return false;
      const ndjson = readFileSync(path, 'utf8');
      return ndjson.includes('automatic monitoring wake-up (1/40)');
    });
    const events = readFileSync(join(repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as { type: string; message?: string });
    expect(events.some((event) => event.type === 'note' && event.message?.includes('(1/40)'))).toBe(true);
    expect(events.some((event) => event.type === 'user-message')).toBe(false);
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

  it('normalizes a near-valid presentation-only marker into exactly one ask card', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:ask-near choose', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    const events = readEvents(record.id);
    const asks = events.filter((event) => event.type === 'ask.requested');
    expect(asks).toHaveLength(1);
    const questions = asks[0]!.questions as Array<{
      header: string;
      options: Array<{ label: string; description?: string }>;
    }>;
    expect(questions[0]!.header).toBe('Implementati');
    expect(questions[0]!.options[0]).toEqual({ label: 'Minimal', description: 'd'.repeat(280) });
    expect(events.filter((event) => event.type === 'text').some((event) => String(event.text).includes('CEZ:ASK'))).toBe(false);
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
    const events = readEvents(record.id);
    expect(events.some((e) => e.type === 'ask.requested')).toBe(false);
    expect(events.filter((e) => e.type === 'note' && String(e.message).includes('not valid JSON'))).toHaveLength(1);
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
    expect(events.filter((e) => e.type === 'note' && String(e.message).includes('failed validation'))).toHaveLength(1);
    const assistantText = events.filter((e) => e.type === 'text');
    expect(assistantText.some((e) => String(e.text).includes('CEZ:ASK {"questions":[]}'))).toBe(true);
  }, 30_000);
});

/**
 * #472 — `persistAttachment` must work with no `ActiveRun`, because a queued run has
 * none. The counter moved to `RunManager.queuedImageSeq`, seeded from the highest
 * numeric suffix on disk rather than the file count.
 */
describe('RunManager.persistAttachment without a session (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const PNG = Buffer.from('fake-png-bytes').toString('base64');

  type PersistFn = (
    runId: string,
    mediaType: string,
    data: string,
    namePrefix?: string,
  ) => { name: string; url: string; path: string } | null;
  const persist = (id: string, prefix?: string) =>
    (manager as unknown as { persistAttachment: PersistFn }).persistAttachment(id, 'image/png', PNG, prefix);
  const imagesDir = (id: string) => join(repoRoot, '.ai/cezar', 'runs', `${id}-images`);

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-persist-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('persists two attachments with no ActiveRun and gives them distinct names', () => {
    const first = persist('run-a', 'pasted');
    const second = persist('run-a', 'pasted');
    expect(first?.name).toBe('pasted-1.png');
    expect(second?.name).toBe('pasted-2.png');
    expect(first?.url).toBe('/api/v1/runs/run-a/images/pasted-1.png');
  });

  /** The count-based bug this replaces: one file on disk named `pasted-3.png` is a
   *  count of 1, so a counting seed would issue `pasted-2.png` — a number BELOW a
   *  live one. Seeding from the highest suffix yields 4. */
  it('seeds from the highest existing suffix, not the file count', () => {
    mkdirSync(imagesDir('run-b'), { recursive: true });
    writeFileSync(join(imagesDir('run-b'), 'pasted-3.png'), 'x');
    expect(persist('run-b', 'pasted')?.name).toBe('pasted-4.png');
  });

  /** `screenshot-*` and `pasted-*` share one numbering space. */
  it('shares one numbering space across screenshot- and pasted- prefixes', () => {
    mkdirSync(imagesDir('run-c'), { recursive: true });
    writeFileSync(join(imagesDir('run-c'), 'screenshot-7.png'), 'x');
    expect(persist('run-c', 'pasted')?.name).toBe('pasted-8.png');
  });

  /** A stale seed (in-memory map ahead of/behind disk) must never overwrite: the
   *  exclusive-create flag makes it retry onto the next free suffix. */
  it('retries past a pre-existing file rather than overwriting it', () => {
    mkdirSync(imagesDir('run-d'), { recursive: true });
    // Force a stale counter: the map says 0, but pasted-1 already exists.
    writeFileSync(join(imagesDir('run-d'), 'pasted-1.png'), 'original');
    (manager as unknown as { queuedImageSeq: Map<string, number> }).queuedImageSeq.set('run-d', 0);

    const saved = persist('run-d', 'pasted');
    expect(saved?.name).toBe('pasted-2.png');
    expect(readFileSync(join(imagesDir('run-d'), 'pasted-1.png'), 'utf8')).toBe('original');
  });
});

/**
 * #472 — the queued-stack mutators. Driven against a directly-seeded
 * `pendingJobs` so the mutators are tested independently of scheduling; the real
 * dequeue path is covered end-to-end by the `hydrateQueuedInput` suite.
 */
describe('RunManager queued-stack mutators (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const PNG = Buffer.from('png').toString('base64');

  const WORKFLOW: WorkflowDef = {
    name: '(planned)',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  };

  const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
  const image = (): ContentBlock => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG },
  });

  /** Seed a run that the engine still holds as queued. */
  const seedQueued = (task = 'ship it') => {
    const record = store.createRun({ title: 't', workflow: 'w', task, steps: [] });
    (
      manager as unknown as {
        pendingJobs: Map<string, { workflow: WorkflowDef; input: { task: string } }>;
      }
    ).pendingJobs.set(record.id, { workflow: WORKFLOW, input: { task } });
    return record;
  };
  const dequeue = (id: string) =>
    (manager as unknown as { pendingJobs: Map<string, unknown> }).pendingJobs.delete(id);
  const imagesDir = (id: string) => join(repoRoot, '.ai/cezar', 'runs', `${id}-images`);

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-stack-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('appends messages in order while queued', () => {
    const r = seedQueued();
    const first = manager.enqueueMessage(r.id, text('also update the changelog'));
    const second = manager.enqueueMessage(r.id, text('and bump the version'));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(store.getRun(r.id)?.queuedMessages?.map((m) => m.text)).toEqual([
      'also update the changelog',
      'and bump the version',
    ]);
  });

  it('persists attached images and records their URLs', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, [image(), { type: 'text', text: 'like this' }]);
    expect(msg?.images).toEqual([`/api/v1/runs/${r.id}/images/pasted-1.png`]);
    expect(existsSync(join(imagesDir(r.id), 'pasted-1.png'))).toBe(true);
  });

  it('hydrates edits and stacked messages into a queued restart continuation', async () => {
    const r = store.createRun({
      title: 'interrupted task',
      workflow: 'quick-task',
      task: 'original recovery goal',
      steps: [],
    });
    store.updateRun(r.id, { status: 'queued' });

    type PendingContinuation = {
      stepId: string;
      sessionId: string | undefined;
      backend: 'claude';
      prompt: string;
      images: ContentBlock[];
    };
    const internals = manager as unknown as {
      pendingContinuations: Map<string, PendingContinuation>;
      queue: string[];
      pump(): Promise<void>;
      runContinuation(
        runId: string,
        stepId: string,
        sessionId: string | undefined,
        backend: 'claude',
        prompt: string,
        images: ContentBlock[],
        persistedImages: ContentBlock[],
        persistedAttachments: Array<{ name: string; url: string; path: string }>,
      ): Promise<void>;
    };
    internals.pendingContinuations.set(r.id, {
      stepId: 'continue-1',
      sessionId: 'session-interrupted',
      backend: 'claude',
      prompt: 'restart recovery',
      images: [],
    });
    internals.queue.push(r.id);

    expect(manager.editTask(r.id, 'amended recovery goal')).toBe(true);
    expect(
      manager.enqueueMessage(r.id, [image(), { type: 'text', text: 'also verify the queue' }]),
    ).not.toBeNull();

    let delivered:
      | {
          prompt: string;
          images: ContentBlock[];
          persistedImages: ContentBlock[];
          persistedAttachments: Array<{ name: string; url: string; path: string }>;
        }
      | undefined;
    internals.runContinuation = async (
      _runId,
      _stepId,
      _sessionId,
      _backend,
      prompt,
      images,
      persistedImages,
      persistedAttachments,
    ) => {
      delivered = { prompt, images, persistedImages, persistedAttachments };
    };
    await internals.pump();

    expect(delivered?.prompt).toBe(
      'restart recovery\n\nCurrent task and queued updates:\n\n' +
        'amended recovery goal\n\nalso verify the queue',
    );
    expect(delivered?.images).toEqual([]);
    expect(delivered?.persistedImages).toEqual([image()]);
    expect(delivered?.persistedAttachments).toEqual([
      {
        name: 'pasted-1.png',
        url: `/api/v1/runs/${r.id}/images/pasted-1.png`,
        path: join(imagesDir(r.id), 'pasted-1.png'),
      },
    ]);
    expect(readdirSync(imagesDir(r.id))).toEqual(['pasted-1.png']);
    expect(internals.pendingContinuations.has(r.id)).toBe(false);
    expect(manager.editTask(r.id, 'too late')).toBe(false);
  });

  it('refuses every mutation once the run has been dequeued', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, text('while queued'))!;
    dequeue(r.id);

    expect(manager.enqueueMessage(r.id, text('too late'))).toBeNull();
    expect(manager.editQueuedMessage(r.id, msg.id, { text: 'too late' })).toBeNull();
    expect(manager.removeQueuedMessage(r.id, msg.id)).toBe(false);
    expect(manager.editTask(r.id, 'too late')).toBe(false);
    // …and the stack is untouched by the refused calls.
    expect(store.getRun(r.id)?.queuedMessages?.map((m) => m.text)).toEqual(['while queued']);
  });

  it('edits a message in place, keeping its id and createdAt', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, text('typo here'))!;
    const edited = manager.editQueuedMessage(r.id, msg.id, { text: 'fixed now' })!;
    expect(edited.id).toBe(msg.id);
    expect(edited.createdAt).toBe(msg.createdAt);
    expect(store.getRun(r.id)?.queuedMessages).toEqual([edited]);
  });

  it('keeps existing attachments when an edit only changes the text', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, [image(), { type: 'text', text: 'typo' }])!;
    const file = join(imagesDir(r.id), 'pasted-1.png');

    const edited = manager.editQueuedMessage(r.id, msg.id, { text: 'fixed' })!;

    expect(edited.images).toEqual(msg.images);
    expect(existsSync(file)).toBe(true);
  });

  it('returns null when the message id is unknown', () => {
    const r = seedQueued();
    expect(manager.editQueuedMessage(r.id, 'nope', { text: 'x' })).toBeNull();
    expect(manager.removeQueuedMessage(r.id, 'nope')).toBe(false);
  });

  it('removes a message and unlinks its orphaned images', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, [image()])!;
    const file = join(imagesDir(r.id), 'pasted-1.png');
    expect(existsSync(file)).toBe(true);

    expect(manager.removeQueuedMessage(r.id, msg.id)).toBe(true);
    expect(store.getRun(r.id)?.queuedMessages).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  /** Never delete a file another entry still points at. */
  it('keeps an image that a surviving message still references', () => {
    const r = seedQueued();
    const first = manager.enqueueMessage(r.id, [image()])!;
    const shared = first.images![0]!;
    // A second entry deliberately pointing at the same file.
    const second = manager.enqueueMessage(r.id, text('see above'))!;
    store.updateRun(r.id, {
      queuedMessages: store
        .getRun(r.id)!
        .queuedMessages!.map((m) => (m.id === second.id ? { ...m, images: [shared] } : m)),
    });

    manager.removeQueuedMessage(r.id, first.id);
    expect(existsSync(join(imagesDir(r.id), 'pasted-1.png'))).toBe(true);
  });

  /** Same rule against the initial prompt's own attachments. */
  it('keeps an image still referenced by taskImages', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, [image()])!;
    store.updateRun(r.id, { taskImages: [msg.images![0]!] });

    manager.removeQueuedMessage(r.id, msg.id);
    expect(existsSync(join(imagesDir(r.id), 'pasted-1.png'))).toBe(true);
  });

  it('edits the task and re-derives the heuristic title and refs', () => {
    const r = seedQueued('fix the thing');
    expect(manager.editTask(r.id, 'fix the login bug in issue #123')).toBe(true);
    const updated = store.getRun(r.id)!;
    expect(updated.task).toBe('fix the login bug in issue #123');
    expect(updated.title).not.toBe('t');
    expect(updated.issueNumber).toBe(123);
  });

  /** Hand-edited titles always win (#389). */
  it('leaves a user-owned title alone when the task is edited', () => {
    const r = seedQueued('fix the thing');
    store.updateRun(r.id, { titleSummary: 'My own title', titleOrigin: 'user' });
    manager.editTask(r.id, 'completely different task now');
    expect(store.getRun(r.id)?.titleSummary).toBe('My own title');
    expect(store.getRun(r.id)?.title).toBe('t');
  });

  it('defers a message only while the run is starting up', () => {
    const r = seedQueued();
    const starting = (manager as unknown as { starting: Set<string> }).starting;

    // Not starting yet → the ladder falls through to 409.
    expect(manager.deferMessage(r.id, text('nope'))).toBe(false);

    starting.add(r.id);
    expect(manager.deferMessage(r.id, text('buffer me'))).toBe(true);
    expect(
      (manager as unknown as { deferredMessages: Map<string, ContentBlock[][]> }).deferredMessages.get(
        r.id,
      ),
    ).toHaveLength(1);
  });

  /**
   * The sub-window that `starting` alone misses: `execute()` drops the run from
   * `starting` as soon as it builds the ActiveRun, seconds before the backend is
   * spawned. A message arriving there must still buffer, not 409.
   */
  it('still defers after `starting` is cleared but before the session opens', () => {
    const r = seedQueued();
    (manager as unknown as { active: Map<string, unknown> }).active.set(r.id, {
      cancelled: false,
      sessionEverOpened: undefined,
    });
    expect(manager.deferMessage(r.id, text('mid-spawn'))).toBe(true);
  });

  /**
   * Review fix: `flushDeferred` used to drop its buffer before sending, so a message the
   * session refused was silently lost — precisely the failure `deferMessage` exists to
   * prevent. Anything unsent must stay buffered for the next session that opens.
   */
  it('re-buffers a deferred message the session refuses, instead of dropping it', () => {
    const r = seedQueued();
    const starting = (manager as unknown as { starting: Set<string> }).starting;
    const buffer = (manager as unknown as { deferredMessages: Map<string, ContentBlock[][]> })
      .deferredMessages;

    starting.add(r.id);
    manager.deferMessage(r.id, text('buffer me'));
    expect(buffer.get(r.id)).toHaveLength(1);

    // Flush with no open session — `sendMessage` refuses.
    ;(manager as unknown as { flushDeferred(id: string): void }).flushDeferred(r.id);
    expect(buffer.get(r.id)).toHaveLength(1);

    // Now a session that accepts it: the buffer drains.
    const delivered: ContentBlock[][] = [];
    (manager as unknown as { sendMessage(id: string, c: ContentBlock[]): boolean }).sendMessage = (
      _id,
      content,
    ) => {
      delivered.push(content);
      return true;
    };
    ;(manager as unknown as { flushDeferred(id: string): void }).flushDeferred(r.id);
    expect(delivered).toHaveLength(1);
    expect(buffer.has(r.id)).toBe(false);
  });

  it('stops deferring once a session has opened (a closed session is a real 409)', () => {
    const r = seedQueued();
    (manager as unknown as { active: Map<string, unknown> }).active.set(r.id, {
      cancelled: false,
      sessionEverOpened: true,
    });
    expect(manager.deferMessage(r.id, text('too late'))).toBe(false);
  });
});

/**
 * #472 — `hydrateQueuedInput`. The seam that makes the RECORD the single source
 * of truth for a queued run's prompt, and the guards that keep it from
 * compounding on restart.
 */
describe('RunManager.hydrateQueuedInput (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  type Hydrate = (runId: string, input: { task: string }) => {
    task: string;
    images?: ContentBlock[];
    stackedImages?: ContentBlock[];
  };
  const hydrate = (id: string, task: string) =>
    (manager as unknown as { hydrateQueuedInput: Hydrate }).hydrateQueuedInput(id, { task });

  const stack = (id: string, ...messages: Array<{ text: string; images?: string[] }>) =>
    store.updateRun(id, {
      queuedMessages: messages.map((m, i) => ({
        id: `m${i}`,
        text: m.text,
        ...(m.images ? { images: m.images } : {}),
        createdAt: `2026-07-21T10:0${i}:00.000Z`,
      })),
    });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-hydrate-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('folds the task and every stacked message, in order, blank-line joined', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'build the thing', steps: [] });
    stack(r.id, { text: 'also update the changelog' }, { text: 'and bump the version' });

    expect(hydrate(r.id, r.task).task).toBe(
      'build the thing\n\nalso update the changelog\n\nand bump the version',
    );
  });

  it('leaves the input untouched when nothing is stacked', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'build the thing', steps: [] });
    expect(hydrate(r.id, r.task).task).toBe('build the thing');
  });

  /**
   * The compounding guard. Hydration composes from `run.task` + the stack and
   * never writes the folded string back, so a restart cannot re-append. Without
   * this rule every recovery would grow the prompt without bound.
   */
  it('never writes the folded prompt back to the record, and is idempotent', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'build the thing', steps: [] });
    stack(r.id, { text: 'also update the changelog' });

    const once = hydrate(r.id, r.task).task;
    const twice = hydrate(r.id, r.task).task;
    const thrice = hydrate(r.id, hydrate(r.id, r.task).task).task;

    expect(twice).toBe(once);
    // Even feeding an already-folded string back in yields the same result —
    // the helper reads `run.task`, not whatever `input.task` happens to hold.
    expect(thrice).toBe(once);
    // …and the record itself is byte-identical to what the user typed.
    expect(store.getRun(r.id)?.task).toBe('build the thing');
    expect(store.getRun(r.id)?.queuedMessages).toHaveLength(1);
  });

  it('re-encodes stacked attachments from disk into stackedImages', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'look at this', steps: [] });
    const dir = join(repoRoot, '.ai/cezar', 'runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pasted-1.png'), 'the-bytes');
    stack(r.id, { text: 'see the mock', images: [`/api/v1/runs/${r.id}/images/pasted-1.png`] });

    const images = hydrate(r.id, r.task).stackedImages;
    expect(images).toHaveLength(1);
    expect(images?.[0]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/png', data: Buffer.from('the-bytes').toString('base64') },
    });
  });

  it('re-encodes initial task images from disk after a queued-run restart (#612)', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'look at this', steps: [] });
    const dir = join(repoRoot, '.ai/cezar', 'runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pasted-1.png'), 'the-task-bytes');
    store.updateRun(r.id, { taskImages: [`/api/v1/runs/${r.id}/images/pasted-1.png`] });

    expect(hydrate(r.id, r.task).images).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('the-task-bytes').toString('base64'),
        },
      },
    ]);
  });

  /**
   * #950 — the re-read branches on the NAME, not on the list. A `.pdf` sitting in the same
   * `images` list as a screenshot must come back as a path only: re-encoding it into a base64
   * image block would compose a message no backend can accept, and would put the whole document
   * into the prompt on the one path (restart) where nobody is watching.
   */
  it('never re-encodes a non-image attachment into an image block on restart', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'read the brief', steps: [] });
    const dir = join(repoRoot, '.ai/cezar', 'runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pasted-1.png'), 'the-task-bytes');
    writeFileSync(join(dir, 'pasted-2.pdf'), '%PDF-1.4 the-document-bytes');
    store.updateRun(r.id, {
      taskImages: [
        `/api/v1/runs/${r.id}/images/pasted-1.png`,
        `/api/v1/runs/${r.id}/images/pasted-2.pdf`,
      ],
    });

    const images = hydrate(r.id, r.task).images;
    expect(images).toHaveLength(1);
    expect(images?.[0]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
    expect(JSON.stringify(images)).not.toContain(Buffer.from('%PDF-1.4 the-document-bytes').toString('base64'));
  });

  /** Degrade, never fail the boot (AGENTS.md). */
  it('skips an unreadable attachment, notes it, and still starts', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'look at this', steps: [] });
    stack(r.id, { text: 'see the mock', images: [`/api/v1/runs/${r.id}/images/gone-1.png`] });

    const hydrated = hydrate(r.id, r.task);
    expect(hydrated.task).toBe('look at this\n\nsee the mock');
    expect(hydrated.stackedImages).toBeUndefined();
    expect(store.readEvents(r.id).some((e) => e.type === 'note' && String(e.message).includes('gone-1.png'))).toBe(true);
  });

  /** A file has no bytes to fail on — it is only ever `stat`ed — so it needs its own case: a
   *  deleted `.md` must be dropped and noted, not handed to the agent as a path to nothing. */
  it('notes a non-image attachment whose file is gone instead of naming a dead path', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'read the brief', steps: [] });
    stack(r.id, { text: 'see the brief', images: [`/api/v1/runs/${r.id}/images/pasted-7.md`] });

    const hydrated = hydrate(r.id, r.task);
    expect(hydrated.stackedImages).toBeUndefined();
    expect(store.readEvents(r.id).some((e) => e.type === 'note' && String(e.message).includes('pasted-7.md'))).toBe(true);
  });
});

/**
 * #472 end-to-end: the amended prompt must actually reach the backend. This is
 * the regression the whole feature turns on — an edit that "works" in the UI but
 * never reaches the agent. `maxParallel: 1` holds the second run in the queue
 * long enough to stack onto it.
 */
describe('queued stacking reaches the backend (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  const WORKFLOW: WorkflowDef = {
    name: '(planned)',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  };

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-472-e2e-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    // One slot, so the second run demonstrably waits in the queue.
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify({ maxParallel: 1 }));
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

  it('delivers the task plus every stacked message, with the edit applied', async () => {
    const first = manager.startRun(WORKFLOW, { task: 'mock:done occupy the slot', worktree: false });
    const second = manager.startRun(WORKFLOW, { task: 'mock:done original prompt', worktree: false });

    // The second run is holding in the queue — amend it there.
    expect(store.getRun(second.id)?.status).toBe('queued');
    const typo = manager.enqueueMessage(second.id, [{ type: 'text', text: 'STACKEDONE with a typo' }]);
    expect(typo).not.toBeNull();
    manager.enqueueMessage(second.id, [{ type: 'text', text: 'STACKEDTWO' }]);
    // …and fix the first one before it starts.
    manager.editQueuedMessage(second.id, typo!.id, { text: 'STACKEDONE corrected' });

    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 40_000;
    while (!terminal.has(store.getRun(second.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('queued run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }

    // The mock records the head of each session's userText, one line per spawned
    // session. The second run's line must carry the folded prompt.
    const notes = readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n');
    const line = notes.find((n) => n.includes('original prompt'));
    expect(line).toBeDefined();
    expect(line).toContain('STACKEDONE corrected');
    expect(line).toContain('STACKEDTWO');
    // The typo never reached the backend.
    expect(line).not.toContain('with a typo');
    // Order is preserved: task, then the stack.
    expect(line!.indexOf('original prompt')).toBeLessThan(line!.indexOf('STACKEDONE corrected'));
    expect(line!.indexOf('STACKEDONE corrected')).toBeLessThan(line!.indexOf('STACKEDTWO'));

    // And the record still holds the two parts separately — never the folded string.
    expect(store.getRun(second.id)?.task).toBe('mock:done original prompt');
    expect(store.getRun(second.id)?.queuedMessages).toHaveLength(2);
  }, 60_000);
});

/**
 * #472 — the restart path. `recover()` rebuilds a queued run's input through the
 * same helper `pump()` uses, so the stack survives a restart; and because
 * hydration always composes from `run.task`, it lands exactly once no matter how
 * many times the process restarts.
 */
describe('recover() carries the queued stack exactly once (#472)', () => {
  let repoRoot: string;
  let store: RunStore;

  const WORKFLOW = {
    name: '(planned)',
    source: 'built-in' as const,
    steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('folds once across repeated recoveries', async () => {
    const r = store.createRun({ title: 't', workflow: '(planned)', task: 'the original task', steps: [] });
    store.updateRun(r.id, {
      status: 'queued',
      workflowDef: WORKFLOW,
      queuedMessages: [
        { id: 'm1', text: 'the stacked bit', createdAt: '2026-07-21T10:00:00.000Z' },
      ],
    });

    const expected = 'the original task\n\nthe stacked bit';
    const jobsOf = (m: RunManager) =>
      (m as unknown as { pendingJobs: Map<string, { input: { task: string } }> }).pendingJobs;

    // Two successive restarts, each re-adopting the same record.
    for (let restart = 0; restart < 2; restart += 1) {
      const manager = new RunManager(store, repoRoot);
      // Keep the run parked in the queue: recover() pushes and pumps, but with the
      // job still pending we can read exactly what it rebuilt.
      await manager.recover();
      expect(jobsOf(manager).get(r.id)?.input.task).toBe(expected);
      // The record is never rewritten — that is what stops the compounding.
      expect(store.getRun(r.id)?.task).toBe('the original task');
    }
  });
});

describe('native Codex requestUserInput parks and resumes the run (#565)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedCodexBin = process.env.CEZ_CODEX_BIN;
  const workflow: WorkflowDef = {
    name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-565-'));
    delete process.env.CEZ_DRY_RUN;
    // Resolved from this file, not the cwd: the fixture is a sibling of the source under test,
    // so the path holds wherever vitest is invoked from and survives the tree moving.
    process.env.CEZ_CODEX_BIN = join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs');
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    if (runId) manager.cancel(runId);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN; else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedCodexBin === undefined) delete process.env.CEZ_CODEX_BIN; else process.env.CEZ_CODEX_BIN = savedCodexBin;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (predicate: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it('persists the ask, parks immediately, then routes the answer to the pending RPC', async () => {
    const record = manager.startRun(workflow, {
      task: 'mock:native-codex-ask choose a library', runner: 'codex', worktree: false,
    });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    const eventsPath = join(repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`);
    expect(readFileSync(eventsPath, 'utf8')).toContain('"type":"ask.requested"');
    expect(manager.sendMessage(record.id, [{ type: 'text', text: 'Library: Vitest' }])).toBe(true);
    await waitFor(() => readFileSync(eventsPath, 'utf8').includes('"type":"turn-end"'));
    expect(store.getRun(record.id)?.status).toBe('waiting');
  }, 30_000);
});

/**
 * #811 — registry `/skill` expansion on the CONTINUATION path.
 *
 * `expandRegistrySlashSkill` (#676) reads `state.skills`, which only `execute` ever
 * populated. `runContinuation` builds its OWN `ActiveRun`, so a Reply into a finished
 * run — and every restart recovery, which routes through `continueRun` — expanded
 * against an empty registry and handed the raw `/om-...` to the backend, which answered
 * "Unknown skill". Two seams have to hold: the continuation's opening prompt (the
 * session's `userPrompt`, which never passes through `deliverMessage`) and the
 * follow-ups delivered into that same session.
 *
 * The mock CLI echoes the prompt it received (`Okay — looking into: …`), so the
 * transcript is a faithful witness of what actually reached the backend.
 */
describe('registry /skill expansion survives a continuation (#811)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string | undefined;
  let savedDryRun: string | undefined;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-811-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar/skills'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.ai/cezar/skills/demo-review.md'),
      '---\nname: demo-review\ndescription: Review a diff.\n---\n\nRun the demo review playbook.\n',
    );
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    runId = undefined;
  });

  afterEach(() => {
    if (runId) manager.cancel(runId);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const eventsOf = (id: string) =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string; stepId?: string });

  const waitFor = async (predicate: () => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  /** A finished run, ready for the cockpit's Reply composer. The dry-run mock ends its
   *  turn with no marker, so the run parks at `waiting` with the session open — closing
   *  it is what a user pressing Finish does, and `continueRun` only accepts a run that
   *  reached a terminal status. */
  const finishedRun = async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(manager.finish(record.id)).toBe(true);
    await waitFor(() => ['done', 'review'].includes(store.getRun(record.id)?.status ?? ''));
    return record.id;
  };

  it("expands the continuation's OPENING prompt before it becomes the session userPrompt", async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: '/demo-review look at the diff' })).toEqual({ ok: true });
    await waitFor(() =>
      eventsOf(id).some((e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into')),
    );

    const echoed = eventsOf(id).find(
      (e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into'),
    );
    // The backend saw the expanded skill prompt, NOT a bare slash command it would
    // reject as an unknown skill.
    expect(echoed?.text).toContain('Selected skill: /demo-review');
    expect(echoed?.text).not.toContain('/demo-review look at the diff');

    // Delivery-only: the transcript still shows what the user actually typed.
    const typed = eventsOf(id).find((e) => e.type === 'user-message' && e.stepId === 'continue-1');
    expect(typed?.text).toBe('/demo-review look at the diff');
  }, 40_000);

  it('expands a FOLLOW-UP delivered into the reopened continuation session', async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await waitFor(() => store.getRun(id)?.status === 'waiting');

    expect(manager.sendMessage(id, [{ type: 'text', text: '/demo-review now review it' }])).toBe(true);
    await waitFor(() =>
      eventsOf(id).filter((e) => e.type === 'text' && e.text?.includes('Selected skill: /demo-review')).length > 0,
    );
    expect(
      eventsOf(id).some((e) => e.type === 'text' && e.text?.includes('Selected skill: /demo-review')),
    ).toBe(true);
  }, 40_000);

  it('leaves an unknown slash command untouched so backend-native commands still work', async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: '/compact please' })).toEqual({ ok: true });
    await waitFor(() =>
      eventsOf(id).some((e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into')),
    );
    const echoed = eventsOf(id).find(
      (e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into'),
    );
    expect(echoed?.text).toContain('/compact please');
  }, 40_000);
});

/**
 * #278 — registry `/skill` expansion on a FRESH run's OPENING prompt.
 *
 * A task STARTED with `/om-...` as its first message is delivered straight to
 * `startSession` inside `execute`, never through `deliverMessage`, and #811 only
 * patched the continuation seam. So the opening prompt leaked the raw slash to the
 * backend, which answered "Unknown command" even though Cezar lists the skill.
 *
 * The mock CLI echoes the prompt it received (`Okay — looking into: …`), so the
 * transcript is a faithful witness of what actually reached the backend.
 */
describe("registry /skill expansion on a fresh run's opening prompt (#278)", () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string | undefined;
  let savedDryRun: string | undefined;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-278-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar/skills'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.ai/cezar/skills/demo-review.md'),
      '---\nname: demo-review\ndescription: Review a diff.\n---\n\nRun the demo review playbook.\n',
    );
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    runId = undefined;
  });

  afterEach(() => {
    if (runId) manager.cancel(runId);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // Tolerant of the pre-first-event window: the run's ndjson does not exist until
  // the engine writes its first event, and this describe polls events directly
  // (no store-status gate first), so a missing file is simply "no events yet".
  const eventsOf = (id: string) => {
    let raw: string;
    try {
      raw = readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8').trim();
    } catch {
      return [] as { type: string; text?: string; stepId?: string }[];
    }
    if (!raw) return [] as { type: string; text?: string; stepId?: string }[];
    return raw.split('\n').map((line) => JSON.parse(line) as { type: string; text?: string; stepId?: string });
  };

  const waitFor = async (predicate: () => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it('expands the opening prompt before it reaches the backend', async () => {
    const record = manager.startRun(SINGLE_STEP, {
      task: '/demo-review look at the diff',
      worktree: false,
    });
    runId = record.id;
    await waitFor(() =>
      eventsOf(record.id).some(
        (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('looking into'),
      ),
    );

    const echoed = eventsOf(record.id).find(
      (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('looking into'),
    );
    // The backend saw the expanded skill prompt, NOT the bare slash command it would
    // reject as an unknown command.
    expect(echoed?.text).toContain('Selected skill: /demo-review');
    expect(echoed?.text).not.toContain('/demo-review look at the diff');
  }, 40_000);

  it('leaves an unknown slash command untouched so backend-native commands still work', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: '/compact please', worktree: false });
    runId = record.id;
    await waitFor(() =>
      eventsOf(record.id).some(
        (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('looking into'),
      ),
    );
    const echoed = eventsOf(record.id).find(
      (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('looking into'),
    );
    expect(echoed?.text).toContain('/compact please');
  }, 40_000);
});
