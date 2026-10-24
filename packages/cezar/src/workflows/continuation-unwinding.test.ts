import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { autosaveCommit } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

// The turn-end autosave is the slow tail (a git commit — seconds on Windows); hold it open.
const gate = vi.hoisted(() => ({ specs: [] as AgentRunSpec[], release: undefined as (() => void) | undefined }));

vi.mock('../git-worktree.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git-worktree.ts')>()),
  autosaveCommit: vi.fn(async (_cwd: string, reason: string) => {
    if (reason === 'turn end' && !gate.release) await new Promise<void>((resolve) => { gate.release = resolve; });
    return 'nothing-to-do';
  }),
}));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec) => {
      gate.specs.push(spec);
      return {
        result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

describe('Continue posted while a settled continuation is still unwinding (telemetry 77117b95)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    gate.specs.length = 0;
    gate.release = undefined;
    vi.mocked(autosaveCommit).mockClear();
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-unwinding-')));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    gate.release?.();
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function terminalWorktreeRun(): Promise<string> {
    const worktreePath = join(repoRoot, '.ai/cezar/worktrees/wt');
    await run('git', ['worktree', 'add', '-q', '-b', 'cez/wt', worktreePath], { cwd: repoRoot });
    const record = store.createRun({
      title: 't',
      workflow: 'legacy',
      task: 'do it',
      runner: 'claude',
      steps: [{ id: 'work', name: 'work', kind: 'agent' as const }],
    });
    store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString(), worktreePath, branch: 'cez/wt' });
    store.updateStep(record.id, 'work', { status: 'done', sessionId: 'sess-1', backend: 'claude' });
    return record.id;
  }

  const unwinding = () => expect.poll(() => gate.release !== undefined, { timeout: 15_000 }).toBe(true);
  const stepStatus = (runId: string, stepId: string) => store.getRun(runId)?.steps.find((s) => s.id === stepId)?.status;

  it('accepts the Continue and starts it once the turn-end autosave lets go', async () => {
    const runId = await terminalWorktreeRun();
    expect(manager!.continueRun(runId, { text: 'first' })).toEqual({ ok: true });
    await unwinding();
    // The record already says settled, so every client offers Continue — and it must not 409.
    expect(['done', 'review']).toContain(store.getRun(runId)?.status);
    expect(manager!.isActive(runId)).toBe(true);

    expect(manager!.continueRun(runId, { text: 'second' })).toEqual({ ok: true });
    // A second one in the same window is a duplicate, refused as before.
    expect(manager!.continueRun(runId, { text: 'third' })).toEqual({ ok: false, error: 'run is still active' });
    expect(gate.specs).toHaveLength(1);

    // Durable before it answered ok (a restart in this window must not lose it)…
    expect(store.getRun(runId)?.pendingContinue).toEqual({ text: 'second' });

    gate.release!();
    await expect.poll(() => stepStatus(runId, 'continue-2'), { timeout: 15_000 }).toBe('done');
    expect(gate.specs).toHaveLength(2);
    expect(gate.specs[1]?.userPrompt).toContain('second');
    expect(store.getRun(runId)?.steps.some((s) => s.id === 'continue-3')).toBe(false);
    // …and spent once the drop handed it to the ordinary Continue path.
    expect(store.getRun(runId)?.pendingContinue).toBeUndefined();
  });

  it('a Continue accepted during teardown survives a restart inside that window', async () => {
    const runId = await terminalWorktreeRun();
    expect(manager!.continueRun(runId, { text: 'first' })).toEqual({ ok: true });
    await unwinding();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    expect(manager!.continueRun(runId, {
      text: 'after the restart',
      runner: 'claude',
      images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
    })).toEqual({ ok: true });
    const pending = store.getRun(runId)?.pendingContinue;
    expect(pending?.images).toHaveLength(1);

    // The process dies before the turn-end autosave lets go: only the disk survives.
    store.flush();
    const old = manager!;
    manager = undefined;
    old.dispose();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    expect(store.getRun(runId)?.pendingContinue).toEqual(pending);
    manager = new RunManager(store, repoRoot);
    await manager.recover();

    await expect.poll(() => stepStatus(runId, 'continue-2'), { timeout: 15_000 }).toBe('done');
    expect(gate.specs.at(-1)?.userPrompt).toContain('after the restart');
    const opening = store.readEvents(runId).find((e) => e.type === 'user-message' && e.stepId === 'continue-2');
    expect(opening?.images).toEqual(pending?.images);
    expect(store.getRun(runId)?.pendingContinue).toBeUndefined();
    expect(store.getRun(runId)?.steps.some((s) => s.id === 'continue-3')).toBe(false);
  });

  it('a recovered pending Continue on a run that is no longer continuable is dropped, not started', async () => {
    const runId = await terminalWorktreeRun();
    store.updateRun(runId, { status: 'queued', pendingContinue: { text: 'stale' } });
    store.flush();
    manager!.dispose();
    manager = new RunManager(store, repoRoot);
    // `queued` without a work item is revived as a fresh run; the stale Continue must not stack on it.
    await manager.recover();
    expect(store.getRun(runId)?.pendingContinue).toBeUndefined();
    expect(store.getRun(runId)?.steps.some((s) => s.id.startsWith('continue-'))).toBe(false);
  });

  it('a Continue sent back during teardown supersedes a Finish accept from the same window', async () => {
    vi.stubEnv('CEZ_REVIEW_GATE', '1');
    const runId = await terminalWorktreeRun();
    const worktreePath = store.getRun(runId)!.worktreePath!;
    writeFileSync(join(worktreePath, 'a.txt'), 'two\n');
    store.updateRun(runId, { status: 'review', baseBranch: 'main' });
    expect(manager!.continueRun(runId, { text: 'first' })).toEqual({ ok: true });
    await unwinding();
    expect(store.getRun(runId)?.status).toBe('review');
    expect(manager!.finish(runId)).toBe(true);
    expect(manager!.continueRun(runId, { text: 'corrections' })).toEqual({ ok: true });
    gate.release!();
    await expect.poll(() => stepStatus(runId, 'continue-2'), { timeout: 15_000 }).toBe('done');
    const messages = store.readEvents(runId).filter((e) => e.type === 'lifecycle').map((e) => String(e.message));
    expect(messages).not.toContain('review accepted — finished without a PR');
  });

  it('still refuses a Continue while the session is live', async () => {
    const runId = await terminalWorktreeRun();
    const active = (manager as unknown as { active: Map<string, object> }).active;
    store.updateRun(runId, { status: 'running' });
    active.set(runId, { cancelled: false, sessionEverOpened: true });
    try {
      expect(manager!.continueRun(runId, { text: 'x' })).toEqual({ ok: false, error: 'run is still active' });
      // A settled record on an owner whose turn has NOT ended (a continuation still preparing).
      store.updateRun(runId, { status: 'done' });
      expect(manager!.continueRun(runId, { text: 'x' })).toEqual({ ok: false, error: 'run is still active' });
    } finally {
      active.delete(runId);
    }
  });
});
