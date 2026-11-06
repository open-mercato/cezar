import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktree } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const skillsGate = vi.hoisted(() => ({
  /** When set, the next `discoverSkills` call parks until this resolves; later calls pass through. */
  hold: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
}));

vi.mock('../skills.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skills.ts')>();
  return {
    ...actual,
    discoverSkills: async (...args: Parameters<typeof actual.discoverSkills>) => {
      const hold = skillsGate.hold;
      if (hold) {
        skillsGate.hold = undefined;
        skillsGate.entered?.();
        await hold;
      }
      return actual.discoverSkills(...args);
    },
  };
});

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** A `claude` that opens a session and then never settles on its own: it ignores stdin EOF and
 *  only exits when signalled. That is the field shape behind #798 — a continuation parked on
 *  `await session.result` while the record has already moved on. */
const HANGING_CLAUDE = fileURLToPath(
  new URL('../core/__fixtures__/claude/stub-ignores-eof-exits-143.mjs', import.meta.url),
);

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the expected state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * #798 — "Getting 'run is still active' when trying to Continue session".
 *
 * The cockpit offers Continue off the RECORD (`done`/`failed`/`cancelled`/`review`), while the
 * engine refused off the in-memory registry. A session that stalls in teardown leaves the two
 * disagreeing, and nothing ever reconciled them: Continue was refused permanently, and a restart
 * re-entered the same continuation path rather than clearing it.
 */
describe("Continue reconciles a stale 'active' registration (#798)", () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedBin = process.env.CEZ_CLAUDE_BIN;
  const savedLock = process.env.CEZ_DISABLE_REPO_LOCK;
  const savedAutosave = process.env.CEZ_AUTOSAVE;

  beforeEach(async () => {
    process.env.CEZ_CLAUDE_BIN = HANGING_CLAUDE;
    // The repo-root lease is orthogonal here; bypassing it keeps the test about the registry.
    process.env.CEZ_DISABLE_REPO_LOCK = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-stale-active-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    skillsGate.hold = undefined;
    skillsGate.entered = undefined;
    // Signal whatever session is still parked, then let its teardown run before the tree goes.
    for (const record of store.listRuns()) manager.cancel(record.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    manager.dispose();
    if (savedBin === undefined) delete process.env.CEZ_CLAUDE_BIN;
    else process.env.CEZ_CLAUDE_BIN = savedBin;
    if (savedLock === undefined) delete process.env.CEZ_DISABLE_REPO_LOCK;
    else process.env.CEZ_DISABLE_REPO_LOCK = savedLock;
    if (savedAutosave === undefined) delete process.env.CEZ_AUTOSAVE;
    else process.env.CEZ_AUTOSAVE = savedAutosave;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Past its run-up: the continuation's provider session has opened. `running` alone is not
   *  that — the record says it before the profile probe and the spawn. */
  function sessionOpened(runId: string): boolean {
    const internals = manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> };
    return internals.active.get(runId)?.sessionEverOpened === true;
  }

  /** A finished run with a session Continue can resume — the state the cockpit shows the button on. */
  function settledRunWithSession(error: string): string {
    const record = store.createRun({
      title: 'stuck',
      workflow: 'quick-task',
      task: 'carry the work on',
      runner: 'claude',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(record.id, 'work', {
      status: 'failed',
      sessionId: 'session-1',
      backend: 'claude',
      finishedAt: new Date().toISOString(),
    });
    store.updateRun(record.id, { status: 'failed', error, finishedAt: new Date().toISOString() });
    return record.id;
  }

  it('continues a run whose record settled while the engine still held it', async () => {
    const runId = settledRunWithSession('Claude AI usage limit reached|1');

    // The user's first Continue opens a session that will never settle on its own.
    expect(manager.continueRun(runId, { text: 'go' })).toEqual({ ok: true });
    await waitFor(() => sessionOpened(runId));
    expect(manager.isActive(runId)).toBe(true);

    // The reported desync: the record settles (its teardown stalled behind the hung session), so
    // the cockpit shows Continue again — while the registry still holds the run.
    store.updateRun(runId, {
      status: 'failed',
      error: 'interrupted — cezar process exited during the run',
      finishedAt: new Date().toISOString(),
    });

    // Before this fix the engine answered `run is still active` here, forever, and a restart
    // re-created the same state rather than clearing it.
    expect(manager.continueRun(runId, { text: 'carry on' })).toEqual({ ok: true });
    await waitFor(() => store.getRun(runId)?.steps.some((step) => step.id === 'continue-2') === true);

    const events = store.readEvents(runId);
    expect(
      events.some(
        (event) => event.type === 'lifecycle' && String(event.message).includes('stale session registration'),
      ),
    ).toBe(true);
  }, 30_000);

  it('still refuses a genuinely live run', async () => {
    const runId = settledRunWithSession('interrupted');

    expect(manager.continueRun(runId, { text: 'go' })).toEqual({ ok: true });
    await waitFor(() => store.getRun(runId)?.status === 'running');

    // Record and registry agree that the run is live — that refusal is the guard working.
    expect(manager.continueRun(runId, { text: 'again' })).toEqual({
      ok: false,
      error: 'run is still active',
    });
  }, 30_000);

  it('does not let the released session overwrite the record it no longer owns', async () => {
    const runId = settledRunWithSession('Claude AI usage limit reached|1');

    expect(manager.continueRun(runId, { text: 'go' })).toEqual({ ok: true });
    await waitFor(() => sessionOpened(runId));
    store.updateRun(runId, {
      status: 'failed',
      error: 'interrupted — cezar process exited during the run',
      finishedAt: new Date().toISOString(),
    });
    expect(manager.continueRun(runId, { text: 'carry on' })).toEqual({ ok: true });

    // The released session settles on its own terms and says so. It closes out its own step and
    // writes nothing to the run record, so the continuation that took over brings the run up to
    // `running` and nothing overwrites it.
    await waitFor(() =>
      store
        .readEvents(runId)
        .some((event) => event.type === 'note' && String(event.message).includes('had been released')),
    );
    await waitFor(() => store.getRun(runId)?.status === 'running');
    const record = store.getRun(runId);
    expect(record?.steps.find((step) => step.id === 'continue-1')?.status).not.toBe('running');
    expect(record?.steps.find((step) => step.id === 'continue-2')?.status).toBe('running');
    expect(manager.isActive(runId)).toBe(true);
  }, 30_000);

  /** A run with an open continuation session (`continue-1`). */
  async function liveContinuation(): Promise<string> {
    const runId = settledRunWithSession('Claude AI usage limit reached|1');
    expect(manager.continueRun(runId, { text: 'go' })).toEqual({ ok: true });
    await waitFor(() => sessionOpened(runId));
    return runId;
  }

  /** …whose record then settles under it, its turn still `running` — the shape `staleActive`
   *  recognises. */
  async function liveThenSettled(): Promise<string> {
    const runId = await liveContinuation();
    store.updateRun(runId, {
      status: 'failed',
      error: 'interrupted — cezar process exited during the run',
      finishedAt: new Date().toISOString(),
    });
    return runId;
  }

  /** Park the next continuation in skill discovery — after `active.set`, before `running`. */
  function holdSkillDiscovery(): { parked: Promise<void>; release: () => void } {
    let release!: () => void;
    skillsGate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parked = new Promise<void>((resolve) => {
      skillsGate.entered = resolve;
    });
    return { parked, release };
  }

  function releasedNotes(runId: string): number {
    return store
      .readEvents(runId)
      .filter((event) => event.type === 'note' && String(event.message).includes('had been released')).length;
  }

  it('refuses a second Continue during the run-up and leaves the first continuation untouched', async () => {
    const runId = settledRunWithSession('Claude AI usage limit reached|1');
    const internals = manager as unknown as Record<string, (...args: unknown[]) => unknown>;
    const settledReport = vi.spyOn(internals, 'reportSettledChildToParent');
    const autoResume = vi.spyOn(internals, 'scheduleAutoResumeIfLimited');
    const retention = vi.spyOn(internals, 'enforceRetention');
    const gate = holdSkillDiscovery();

    // Registered, record still `failed`: the continuation is on its way to `running`, not stale.
    expect(manager.continueRun(runId, { text: 'go' })).toEqual({ ok: true });
    await gate.parked;
    expect(store.getRun(runId)?.status).toBe('failed');

    expect(manager.continueRun(runId, { text: 'again' })).toEqual({ ok: false, error: 'run is still active' });
    expect(settledReport).not.toHaveBeenCalled();
    expect(autoResume).not.toHaveBeenCalled();
    expect(retention).not.toHaveBeenCalled();

    gate.release();
    await waitFor(() => store.getRun(runId)?.status === 'running');
    const record = store.getRun(runId);
    expect(record?.currentStepId).toBe('continue-1');
    expect(record?.steps.some((step) => step.id === 'continue-2')).toBe(false);
    expect(record?.steps.find((step) => step.id === 'continue-1')?.status).toBe('running');
    expect(manager.isActive(runId)).toBe(true);
  }, 30_000);

  it('treats the run-up as live even when the record still shows an earlier turn running', async () => {
    const runId = settledRunWithSession('interrupted — cezar process exited during the run');
    store.updateStep(runId, 'work', { status: 'running', finishedAt: undefined });
    const gate = holdSkillDiscovery();

    expect(manager.continueRun(runId, { text: 'go' })).toEqual({ ok: true });
    await gate.parked;

    // A settled record with a turn left open is the stale shape — but no session has opened on
    // this registration yet, so it is a continuation on its way up, not a leftover.
    expect(manager.continueRun(runId, { text: 'again' })).toEqual({ ok: false, error: 'run is still active' });
    gate.release();
    await waitFor(() => sessionOpened(runId));
    expect(store.getRun(runId)?.currentStepId).toBe('continue-1');
  }, 30_000);

  it('refuses Continue while a cancellation is still in its grace window', async () => {
    const runId = await liveContinuation();
    expect(manager.cancel(runId)).toBe(true);
    expect(store.getRun(runId)?.status).toBe('cancelled');

    // The session is still being reaped and holds its slot until it is — not a stalled leftover.
    expect(manager.continueRun(runId, { text: 'carry on' })).toEqual({ ok: false, error: 'run is still active' });
    expect(store.readEvents(runId).some((event) => String(event.message ?? '').includes('stale session'))).toBe(false);

    await waitFor(() => !manager.isActive(runId));
    expect(manager.continueRun(runId, { text: 'carry on' })).toEqual({ ok: true });
  }, 30_000);

  it('refuses while the previous session is closing out a turn it already settled', async () => {
    const runId = await liveThenSettled();
    store.updateStep(runId, 'continue-1', { status: 'done', finishedAt: new Date().toISOString() });
    store.updateRun(runId, { status: 'done', finishedAt: new Date().toISOString(), currentStepId: undefined });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(manager.continueRun(runId, { text: 'carry on' })).toEqual({ ok: false, error: 'run is still active' });

    expect(warn).not.toHaveBeenCalled();
    expect(store.getRun(runId)?.steps.some((step) => step.id === 'continue-2')).toBe(false);
    expect(manager.isActive(runId)).toBe(true);
  }, 30_000);

  it('hard-stops the released session so it cannot outlive the release', async () => {
    const runId = await liveThenSettled();
    const internals = manager as unknown as { active: Map<string, { session?: { hardStop?: () => void } }> };
    const session = internals.active.get(runId)?.session;
    expect(session?.hardStop).toBeTypeOf('function');
    const hardStop = vi.spyOn(session as { hardStop: () => void }, 'hardStop');

    expect(manager.continueRun(runId, { text: 'carry on' })).toEqual({ ok: true });

    expect(hardStop).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('runs every record-level refusal before releasing a stale registration', async () => {
    const runId = await liveThenSettled();

    expect(manager.continueRun(runId, { text: 'carry on', runner: 'claude', model: 'gpt-5' })).toEqual({
      ok: false,
      error: "model 'gpt-5' is not a claude model",
    });

    // The refused Continue left the stalled session registered; a valid one still reconciles.
    expect(manager.isActive(runId)).toBe(true);
    expect(store.readEvents(runId).some((event) => String(event.message ?? '').includes('stale session'))).toBe(false);
    expect(manager.continueRun(runId, { text: 'carry on' })).toEqual({ ok: true });
  }, 30_000);

  it("an escape from a cancelled continuation's run-up leaves the newcomer's record alone and posts nothing", async () => {
    const runId = settledRunWithSession('Claude AI usage limit reached|1');
    const internals = manager as unknown as { agentEnvForStep: (...args: unknown[]) => Promise<unknown> };
    const original = internals.agentEnvForStep.bind(manager);
    let crash!: () => void;
    const crashing = new Promise<void>((resolve) => {
      crash = resolve;
    });
    let calls = 0;
    vi.spyOn(internals, 'agentEnvForStep').mockImplementation(async (...args: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        await crashing;
        throw new Error('profile probe blew up');
      }
      return original(...args);
    });

    expect(manager.continueRun(runId, { text: 'go' })).toEqual({ ok: true });
    await waitFor(() => calls === 1);
    // Session-less, so the cancellation drops the registration at once and a newcomer can take over.
    expect(manager.cancel(runId)).toBe(true);
    expect(manager.continueRun(runId, { text: 'carry on' })).toEqual({ ok: true });
    await waitFor(() => store.getRun(runId)?.currentStepId === 'continue-2' && store.getRun(runId)?.status === 'running');

    crash();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const record = store.getRun(runId);
    expect(record?.status).toBe('running');
    expect(record?.error ?? '').not.toContain('continue crashed');
    expect(manager.isActive(runId)).toBe(true);
    expect(releasedNotes(runId)).toBe(0);
  }, 30_000);

  it('a continuation cancelled during its run-up stops its autosave timer and posts nothing', async () => {
    process.env.CEZ_AUTOSAVE = '1';
    const runId = settledRunWithSession('Claude AI usage limit reached|1');
    const worktree = await createWorktree(repoRoot, runId, 'main');
    store.updateRun(runId, { worktreePath: worktree.path });
    const internals = manager as unknown as { active: Map<string, { autosaveTimer?: NodeJS.Timeout }> };
    const gate = holdSkillDiscovery();

    expect(manager.continueRun(runId, { text: 'go' })).toEqual({ ok: true });
    await gate.parked;
    const displaced = internals.active.get(runId);
    const autosave = displaced?.autosaveTimer;
    expect(autosave).toBeDefined();
    const clearInterval = vi.spyOn(globalThis, 'clearInterval');

    expect(manager.cancel(runId)).toBe(true);
    gate.release();
    await waitFor(() => displaced?.autosaveTimer === undefined);

    expect(clearInterval).toHaveBeenCalledWith(autosave);
    expect(store.getRun(runId)?.status).toBe('cancelled');
    expect(releasedNotes(runId)).toBe(0);
  }, 30_000);
});

/**
 * A continuation parks on the repo-root lease BEFORE it writes `status: running`, so a
 * lease-blocked run sits in `active` with a terminal record. That is the run-up working as
 * designed, not a stall: Continue keeps refusing it, and the waiter keeps its place in line.
 */
describe('a continuation parked on the repo-root lease (#798)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedBin = process.env.CEZ_CLAUDE_BIN;
  const savedLock = process.env.CEZ_DISABLE_REPO_LOCK;

  beforeEach(async () => {
    process.env.CEZ_CLAUDE_BIN = HANGING_CLAUDE;
    // The lease IS the subject here, so it stays on.
    delete process.env.CEZ_DISABLE_REPO_LOCK;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-stale-lease-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const record of store.listRuns()) manager.cancel(record.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    manager.dispose();
    if (savedBin === undefined) delete process.env.CEZ_CLAUDE_BIN;
    else process.env.CEZ_CLAUDE_BIN = savedBin;
    if (savedLock !== undefined) process.env.CEZ_DISABLE_REPO_LOCK = savedLock;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function rootRunWithSession(): string {
    const record = store.createRun({
      title: 'root',
      workflow: 'quick-task',
      task: 'work in place',
      runner: 'claude',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(record.id, 'work', {
      status: 'failed',
      sessionId: `session-${record.id}`,
      backend: 'claude',
      finishedAt: new Date().toISOString(),
    });
    store.updateRun(record.id, {
      status: 'failed',
      error: 'Claude AI usage limit reached|1',
      finishedAt: new Date().toISOString(),
    });
    return record.id;
  }

  it('is live: Continue is refused and the waiter keeps its place', async () => {
    // The holder takes the lease and never lets go — its session ignores EOF.
    const holder = rootRunWithSession();
    expect(manager.continueRun(holder, { text: 'hold the tree' })).toEqual({ ok: true });
    await waitFor(() => store.getRun(holder)?.status === 'running');

    // The blocked run parks on the lease: registered as active, record still terminal.
    const blocked = rootRunWithSession();
    expect(manager.continueRun(blocked, { text: 'go' })).toEqual({ ok: true });
    await waitFor(() => manager.isActive(blocked));
    expect(store.getRun(blocked)?.status).toBe('failed');

    expect(manager.continueRun(blocked, { text: 'carry on' })).toEqual({ ok: false, error: 'run is still active' });

    // Once the holder lets go, the waiter it was blocking is the one that runs.
    expect(manager.cancel(holder)).toBe(true);
    await waitFor(() => store.getRun(blocked)?.status === 'running');
    expect(store.getRun(blocked)?.currentStepId).toBe('continue-1');
    expect(store.getRun(blocked)?.steps.some((step) => step.id === 'continue-2')).toBe(false);
  }, 30_000);
});
