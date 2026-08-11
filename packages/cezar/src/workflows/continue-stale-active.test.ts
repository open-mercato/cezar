import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

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
    // Signal whatever session is still parked, then let its teardown run before the tree goes.
    for (const record of store.listRuns()) manager.cancel(record.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    manager.dispose();
    if (savedBin === undefined) delete process.env.CEZ_CLAUDE_BIN;
    else process.env.CEZ_CLAUDE_BIN = savedBin;
    if (savedLock === undefined) delete process.env.CEZ_DISABLE_REPO_LOCK;
    else process.env.CEZ_DISABLE_REPO_LOCK = savedLock;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

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
    await waitFor(() => store.getRun(runId)?.status === 'running');
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
    await waitFor(() => store.getRun(runId)?.status === 'running');
    store.updateRun(runId, {
      status: 'failed',
      error: 'interrupted — cezar process exited during the run',
      finishedAt: new Date().toISOString(),
    });
    expect(manager.continueRun(runId, { text: 'carry on' })).toEqual({ ok: true });

    // The released session is signalled on the way out and settles shortly afterwards. Its own
    // step is closed, but the run record belongs to the continuation that took over.
    await waitFor(() =>
      store
        .readEvents(runId)
        .some((event) => event.type === 'note' && String(event.message).includes('had been released')),
    );
    const record = store.getRun(runId);
    expect(record?.status).toBe('running');
    expect(record?.steps.find((step) => step.id === 'continue-1')?.status).not.toBe('running');
    expect(manager.isActive(runId)).toBe(true);
  }, 30_000);
});
