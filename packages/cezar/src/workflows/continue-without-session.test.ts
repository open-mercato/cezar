import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const INTERRUPTED = 'interrupted — cezar process exited during the run';

/**
 * Continue on a run with NOTHING to resume (#no-session-continue).
 *
 * The reported shape: cezar was killed while a task queued for the repository working tree, so
 * the backend never minted a session id. Recovery answered "could not resume the interrupted
 * task (no agent session to resume)", the composer answered "Session closed — no session to
 * resume.", and the only remaining action on a task mid-flight was Delete.
 *
 * It continues in a FRESH session now, opened on a replay of the old one (`buildSessionRecap`).
 * These cases pin both halves: no `--resume` reaches the CLI, and the briefing does reach the
 * agent — plus the guard case, that a run which DOES have a session still resumes it untouched
 * and is told nothing about a previous session it is already in.
 */
describe('Continue with no session to resume opens a fresh, briefed session', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;
  let argsFile: string;
  let stdinFile: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-no-session-'));
    dataDir = join(repoRoot, '.ai/cezar');
    argsFile = join(repoRoot, 'mock-args.ndjson');
    stdinFile = join(repoRoot, 'mock-stdin.ndjson');
    for (const key of ['CEZ_DRY_RUN', 'CEZ_MOCK_ARGS_FILE', 'CEZ_MOCK_STDIN_FILE']) {
      savedEnv[key] = process.env[key];
    }
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ maxParallel: 1 }));
    writeFileSync(argsFile, '', 'utf8');
    writeFileSync(stdinFile, '', 'utf8');
    store = RunStore.open(dataDir);
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A run killed mid-turn, exactly as `recover()` leaves it: the step failed, and no session
   *  id was ever recorded because the crash beat the first spawn. */
  function interruptedRun(extra: Partial<RunRecord> = {}): RunRecord {
    const record = store.createRun({
      title: 'fix the login redirect',
      workflow: 'quick-task',
      task: 'Fix the login redirect that drops the session cookie',
      runner: 'claude',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      ...extra,
    });
    store.updateStep(record.id, 'work', { status: 'failed', iterations: 1 });
    store.updateRun(record.id, {
      status: 'failed',
      error: INTERRUPTED,
      finishedAt: new Date().toISOString(),
    });
    return record;
  }

  /** The record starts OUT `failed` (that is the state a continuation is offered from), so a plain
   *  "wait for a terminal status" would return before anything happened. This waits for the
   *  continuation's own turn to settle, and surfaces a refusal as the error rather than a timeout. */
  async function waitForContinuation(runId: string, timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = store.getRun(runId);
      if (record && ['waiting', 'done', 'review'].includes(record.status)) return record.status;
      if (record?.status === 'failed' && record.error !== INTERRUPTED) {
        throw new Error(`continuation failed: ${record.error}`);
      }
      if (Date.now() > deadline) throw new Error(`continuation did not settle in time (was ${record?.status})`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const stdinLines = (): Array<{ userText: string; imageCount: number }> =>
    readFileSync(stdinFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  const spawnArgs = (): string[][] =>
    readFileSync(argsFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  it('accepts the continuation, replays the task and conversation, and never passes --resume', async () => {
    const record = interruptedRun();
    store.appendEvent(record.id, { type: 'text', stepId: 'work', text: 'Reading src/middleware.ts.' });
    store.appendEvent(record.id, { type: 'user-message', stepId: 'work', text: 'check the cookie flags too' });

    expect(manager.continueRun(record.id, { text: 'keep going please' })).toEqual({ ok: true });
    await waitForContinuation(record.id);

    const opening = stdinLines()[0];
    expect(opening).toBeDefined();
    // The briefing, the original task, the replayed conversation…
    expect(opening?.userText).toContain('## Previous session (cezar)');
    expect(opening?.userText).toContain('Fix the login redirect that drops the session cookie');
    expect(opening?.userText).toContain('interrupted — cezar process exited during the run');
    expect(opening?.userText).toContain('[agent] Reading src/middleware.ts.');
    expect(opening?.userText).toContain('[user] check the cookie flags too');
    // …and the user's own prompt last, fenced off from the replayed history.
    expect(opening?.userText.trimEnd().endsWith('keep going please')).toBe(true);

    // There was nothing to reattach to, so nothing may claim otherwise on the wire.
    expect(spawnArgs().some((args) => args.includes('--resume'))).toBe(false);

    // The thread says which of the two Continues this was.
    const notes = store
      .readEvents(record.id)
      .filter((event) => event.type === 'note')
      .map((event) => String(event.message ?? ''));
    expect(notes.some((message) => message.includes('no session to resume — started a fresh session'))).toBe(true);
  }, 30_000);

  /** The prompt the user typed is what the TRANSCRIPT must show. The briefing is delivery-only:
   *  the thread already renders every line it replays, right above. */
  it('persists the user prompt alone, not the briefing wrapped around it', async () => {
    const record = interruptedRun();
    expect(manager.continueRun(record.id, { text: 'keep going please' })).toEqual({ ok: true });
    await waitForContinuation(record.id);

    const userMessages = store
      .readEvents(record.id)
      .filter((event) => event.type === 'user-message')
      .map((event) => String(event.text ?? ''));
    expect(userMessages).toContain('keep going please');
    expect(userMessages.some((text) => text.includes('## Previous session'))).toBe(false);
  }, 30_000);

  /** The guard case: unchanged behavior for the run that HAS a session. It resumes, and being
   *  already inside that conversation it must not be handed a summary of it. */
  it('a run with a recorded session still resumes it, with no briefing', async () => {
    const record = interruptedRun();
    store.updateStep(record.id, 'work', { sessionId: 'sess-1', backend: 'claude' });

    expect(manager.continueRun(record.id, { text: 'keep going please' })).toEqual({ ok: true });
    await waitForContinuation(record.id);

    expect(spawnArgs().some((args) => args.includes('--resume') && args.includes('sess-1'))).toBe(true);
    const opening = stdinLines()[0];
    expect(opening?.userText).not.toContain('## Previous session (cezar)');
    expect(opening?.userText).toBe('keep going please');

    const notes = store
      .readEvents(record.id)
      .filter((event) => event.type === 'note')
      .map((event) => String(event.message ?? ''));
    expect(notes.some((message) => message.includes('no session to resume'))).toBe(false);
  }, 30_000);

  /** Boot recovery is where the user met this: it is the caller that turns an interrupted run
   *  into a continuation, and it used to give up here and leave the task dead. */
  it('recover() continues an interrupted run that never recorded a session', async () => {
    const record = store.createRun({
      title: 'fix the login redirect',
      workflow: 'quick-task',
      task: 'Fix the login redirect that drops the session cookie',
      runner: 'claude',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(record.id, 'work', { status: 'running', iterations: 1 });
    store.updateRun(record.id, { status: 'running', currentStepId: 'work' });

    const recovering = new RunManager(store, repoRoot);
    try {
      await recovering.recover();
      const lifecycle = store
        .readEvents(record.id)
        .filter((event) => event.type === 'lifecycle')
        .map((event) => String(event.message ?? ''));
      expect(lifecycle.some((message) => message.includes('could not resume'))).toBe(false);
      expect(
        lifecycle.some((message) =>
          message.includes('no session to resume; continuing the interrupted task in a fresh session'),
        ),
      ).toBe(true);
      expect(store.getRun(record.id)?.steps.some((step) => step.id === 'continue-1')).toBe(true);
      await waitForContinuation(record.id);
    } finally {
      recovering.dispose();
    }
  }, 30_000);
});
