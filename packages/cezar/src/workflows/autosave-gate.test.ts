import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { autosaveCommit, createWorktree } from '../git-worktree.js';
import { RunStore } from '../runs/store.js';
import { AUTOSAVE_INTERVAL_MS, periodicAutosaveEnabled, RunManager } from './run.js';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** The slice of ActiveRun that armAutosave/clearAutosaveTimer read and write. */
interface TimerState {
  cancelled: boolean;
  interrupt: () => void;
  cwd: string;
  autosaveTimer?: NodeJS.Timeout;
}

interface TimerSeam {
  armAutosave(state: TimerState): void;
  clearAutosaveTimer(state: TimerState): void;
}

/**
 * The periodic autosave timer is opt-in via CEZ_AUTOSAVE=1 (#471). armAutosave is
 * driven directly (the recordTurnEnd precedent) because a live agent session is the
 * only other way to reach it. The turn-end/pre-PR flushes are a separate, ungated
 * call to autosaveCommit — proven env-independent below.
 */
describe('periodic autosave gate (#471)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: TimerSeam;
  let worktreePath: string;
  const savedEnv = process.env.CEZ_AUTOSAVE;

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-autosave-gate-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'base\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot) as unknown as TimerSeam;
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    worktreePath = (await createWorktree(repoRoot, record.id, 'main')).path;
  });

  afterAll(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CEZ_AUTOSAVE;
    else process.env.CEZ_AUTOSAVE = savedEnv;
  });

  it('is off by default, on only for the exact value "1"', () => {
    expect(periodicAutosaveEnabled({})).toBe(false);
    expect(periodicAutosaveEnabled({ CEZ_AUTOSAVE: '0' })).toBe(false);
    expect(periodicAutosaveEnabled({ CEZ_AUTOSAVE: 'true' })).toBe(false);
    expect(periodicAutosaveEnabled({ CEZ_AUTOSAVE: '1' })).toBe(true);
    delete process.env.CEZ_AUTOSAVE;
    expect(periodicAutosaveEnabled()).toBe(false); // defaults to process.env
  });

  it('does not arm the timer when the env is off (default)', () => {
    delete process.env.CEZ_AUTOSAVE;
    const state: TimerState = { cancelled: false, interrupt: () => undefined, cwd: worktreePath };
    manager.armAutosave(state);
    expect(state.autosaveTimer).toBeUndefined();
  });

  it('arms the timer when CEZ_AUTOSAVE=1, but never for a repo-root run', () => {
    process.env.CEZ_AUTOSAVE = '1';
    const state: TimerState = { cancelled: false, interrupt: () => undefined, cwd: worktreePath };
    manager.armAutosave(state);
    expect(state.autosaveTimer).toBeDefined();
    manager.armAutosave(state); // idempotent — the second call must not double-arm
    manager.clearAutosaveTimer(state);
    expect(state.autosaveTimer).toBeUndefined();

    const rootState: TimerState = { cancelled: false, interrupt: () => undefined, cwd: repoRoot };
    manager.armAutosave(rootState);
    expect(rootState.autosaveTimer).toBeUndefined();
  });

  it('AUTOSAVE_INTERVAL_MS stays the spec-006 90 s contract', () => {
    expect(AUTOSAVE_INTERVAL_MS).toBe(90_000);
  });

  it('the flush path (autosaveCommit) still commits with the env off', async () => {
    delete process.env.CEZ_AUTOSAVE;
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');
    expect(await autosaveCommit(worktreePath, 'turn end')).toBe('committed');
    const { stdout } = await run('git', ['log', '-1', '--format=%s'], { cwd: worktreePath });
    // Keeps the `cezar autosave` prefix so existing log greps still match, and
    // names the reason so an opted-out user can tell this flush apart from the
    // periodic timer they disabled (#471 follow-up).
    expect(stdout.trim()).toBe('cezar autosave (turn end)');
  });

  it('records the reason, so the gated timer is distinguishable in the log', async () => {
    delete process.env.CEZ_AUTOSAVE;
    for (const reason of ['periodic', 'turn end', 'run finalize', 'pre-PR'] as const) {
      writeFileSync(join(worktreePath, 'work.txt'), `progress ${reason}\n`);
      expect(await autosaveCommit(worktreePath, reason)).toBe('committed');
      const { stdout } = await run('git', ['log', '-1', '--format=%s'], { cwd: worktreePath });
      expect(stdout.trim()).toBe(`cezar autosave (${reason})`);
    }
  });
});
