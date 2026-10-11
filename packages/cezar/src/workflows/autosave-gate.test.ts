import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { autosaveCommit, commitAll, createWorktree } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { AUTOSAVE_INTERVAL_MS, periodicAutosaveEnabled, RunManager } from './run.ts';

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
  armAutosave(runId: string, state: TimerState): void;
  clearAutosaveTimer(state: TimerState): void;
  active: Map<string, unknown>;
  checkArtifactSnapshots: Map<string, Map<string, string>>;
  autosaveCheckpointBlockedRuns: Set<string>;
  releaseCheckState(runId: string): void;
  releaseArchivedCheckState(): void;
  dispose(): void;
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
  let runId: string;
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
    runId = record.id;
    worktreePath = (await createWorktree(repoRoot, runId, 'main')).path;
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
    manager.armAutosave(runId, state);
    expect(state.autosaveTimer).toBeUndefined();
  });

  it('arms the timer when CEZ_AUTOSAVE=1, but never for a repo-root run', () => {
    process.env.CEZ_AUTOSAVE = '1';
    const state: TimerState = { cancelled: false, interrupt: () => undefined, cwd: worktreePath };
    manager.active.set(runId, state);
    manager.armAutosave(runId, state);
    expect(state.autosaveTimer).toBeDefined();
    manager.armAutosave(runId, state); // idempotent — the second call must not double-arm
    manager.clearAutosaveTimer(state);
    expect(state.autosaveTimer).toBeUndefined();

    const rootState: TimerState = { cancelled: false, interrupt: () => undefined, cwd: repoRoot };
    manager.armAutosave(runId, rootState);
    manager.active.delete(runId);
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

  it('can checkpoint agent work without committing excluded check artifacts', async () => {
    writeFileSync(join(worktreePath, 'work.txt'), 'agent progress\n');
    writeFileSync(join(worktreePath, 'check-output.txt'), 'verification residue\n');

    expect(await autosaveCommit(worktreePath, 'turn end', ['check-output.txt'])).toBe('committed');
    const { stdout: files } = await run('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: worktreePath });
    expect(files.trim().split('\n')).toEqual(['work.txt']);
    expect(readFileSync(join(worktreePath, 'check-output.txt'), 'utf8')).toBe('verification residue\n');
    const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: worktreePath });
    expect(status.trim()).toBe('?? check-output.txt');
  });

  it('keeps unchanged check artifacts out of an explicit graph commit', async () => {
    writeFileSync(join(worktreePath, 'work.txt'), 'agent progress for explicit commit\n');
    writeFileSync(join(worktreePath, 'check-output.txt'), 'verification residue\n');

    expect(await commitAll(worktreePath, 'explicit commit', ['check-output.txt'])).toMatchObject({ result: 'committed' });
    const { stdout: files } = await run('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: worktreePath });
    expect(files.trim().split('\n')).toEqual(['work.txt']);
    expect(readFileSync(join(worktreePath, 'check-output.txt'), 'utf8')).toBe('verification residue\n');
    const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: worktreePath });
    expect(status.trim()).toBe('?? check-output.txt');
  });

  it('preserves tracked and untracked check residue, then reclaims a path after agent edits', async () => {
    for (const path of ['check-output.txt', 'untracked-check.txt', 'tracked-check.txt', 'agent-edit.txt']) {
      rmSync(join(worktreePath, path), { force: true });
    }
    await run('git', ['restore', '--', 'tracked-check.txt'], { cwd: worktreePath }).catch(() => undefined);
    writeFileSync(join(worktreePath, 'tracked-check.txt'), 'check baseline\n');
    await run('git', ['add', 'tracked-check.txt'], { cwd: worktreePath });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'check baseline'], { cwd: worktreePath });
    writeFileSync(join(worktreePath, 'tracked-check.txt'), 'check residue\n');
    writeFileSync(join(worktreePath, 'untracked-check.txt'), 'check residue\n');
    writeFileSync(join(worktreePath, 'agent-edit.txt'), 'agent work\n');

    expect(await commitAll(worktreePath, 'explicit check commit', ['tracked-check.txt', 'untracked-check.txt'])).toMatchObject({ result: 'committed' });
    const { stdout: files } = await run('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: worktreePath });
    expect(files.trim().split('\n')).toEqual(['agent-edit.txt']);
    const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: worktreePath });
    expect(status).toContain(' M tracked-check.txt');
    expect(status).toContain('?? untracked-check.txt');

    writeFileSync(join(worktreePath, 'tracked-check.txt'), 'agent reclaimed this path\n');
    expect(await commitAll(worktreePath, 'commit reclaimed edit', ['untracked-check.txt'])).toMatchObject({ result: 'committed' });
    const { stdout: reclaimed } = await run('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: worktreePath });
    expect(reclaimed.trim().split('\n')).toEqual(['tracked-check.txt']);
  });

  it('refuses a checkpoint when an excluded path cannot be reset, without losing work', async () => {
    for (const path of ['check-output.txt', 'untracked-check.txt', 'tracked-check.txt', 'agent-edit.txt']) {
      rmSync(join(worktreePath, path), { force: true });
    }
    await run('git', ['restore', '--', 'agent-edit.txt', 'tracked-check.txt'], { cwd: worktreePath }).catch(() => undefined);
    writeFileSync(join(worktreePath, 'unsafe-work.txt'), 'keep this dirty\n');

    expect(await autosaveCommit(worktreePath, 'turn end', ['../outside-worktree.txt'])).toBe('failed');
    expect(readFileSync(join(worktreePath, 'unsafe-work.txt'), 'utf8')).toBe('keep this dirty\n');
    const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: worktreePath });
    expect(status.trim()).toBe('?? unsafe-work.txt');

    writeFileSync(join(worktreePath, 'unsafe-explicit.txt'), 'keep this too\n');
    expect(await commitAll(worktreePath, 'explicit unsafe', ['../outside-worktree.txt'])).toMatchObject({ result: 'failed' });
    expect(readFileSync(join(worktreePath, 'unsafe-explicit.txt'), 'utf8')).toBe('keep this too\n');
  });

  it('retains continuation state until archive/delete makes it disposable', () => {
    const seam = manager;
    seam.checkArtifactSnapshots.set(runId, new Map([['check-output.txt', 'snapshot']]));
    seam.autosaveCheckpointBlockedRuns.add(runId);
    const record = store.getRun(runId)!;
    record.steps.push({
      id: 'agent', name: 'agent', kind: 'agent', status: 'done', iterations: 1,
      tokensUsed: 0, sessionId: 'session-1',
    });
    seam.releaseArchivedCheckState();
    expect(seam.checkArtifactSnapshots.has(runId)).toBe(true);
    expect(seam.autosaveCheckpointBlockedRuns.has(runId)).toBe(true);
    store.setArchived(runId, true);
    seam.releaseArchivedCheckState();
    expect(seam.checkArtifactSnapshots.has(runId)).toBe(false);
    expect(seam.autosaveCheckpointBlockedRuns.has(runId)).toBe(false);

    const deleted = store.createRun({ title: 'deleted', workflow: 'quick-task', task: 'deleted', steps: [] });
    seam.checkArtifactSnapshots.set(deleted.id, new Map([['check-output.txt', 'snapshot']]));
    seam.autosaveCheckpointBlockedRuns.add(deleted.id);
    expect(store.deleteRun(deleted.id)).toBe(true);
    seam.releaseCheckState(deleted.id);
    expect(seam.checkArtifactSnapshots.has(deleted.id)).toBe(false);
    expect(seam.autosaveCheckpointBlockedRuns.has(deleted.id)).toBe(false);
  });
});
