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
    expect(gate.specs).toHaveLength(1);

    gate.release!();
    await expect.poll(() => stepStatus(runId, 'continue-2'), { timeout: 15_000 }).toBe('done');
    expect(gate.specs).toHaveLength(2);
    expect(gate.specs[1]?.userPrompt).toContain('second');
    expect(store.getRun(runId)?.steps.some((s) => s.id === 'continue-3')).toBe(false);
  });

  it('folds a follow-up posted while a Continue is already queued into that continuation', async () => {
    const runId = await terminalWorktreeRun();
    expect(manager!.continueRun(runId, { text: 'first' })).toEqual({ ok: true });
    await unwinding();
    expect(manager!.continueRun(runId, { text: 'second' })).toEqual({ ok: true });
    // The record still reads settled, so the cockpit posts the next message to /continue too.
    expect(manager!.continueRun(runId, { text: 'third' })).toEqual({ ok: true });
    // A repeated one-click Continue has nothing to add.
    expect(manager!.continueRun(runId, {})).toEqual({ ok: true });
    // An engine switch cannot ride a continuation that already chose its engine.
    expect(manager!.continueRun(runId, { text: 'x', runner: 'codex' })).toEqual({ ok: false, error: 'run is still active' });
    expect(gate.specs).toHaveLength(1);

    gate.release!();
    await expect.poll(() => gate.specs.some((spec) => spec.userPrompt?.includes('third')), { timeout: 15_000 }).toBe(true);
    expect(gate.specs[1]?.userPrompt).toContain('second');
    expect(gate.specs.filter((spec) => spec.userPrompt?.includes('third'))).toHaveLength(1);
    expect(gate.specs.some((spec) => spec.userPrompt?.includes('x'))).toBe(false);
  });

  it('takes a Continue posted after Cancel while the cancelled owner is still letting go', async () => {
    const runId = await terminalWorktreeRun();
    expect(manager!.continueRun(runId, { text: 'first' })).toEqual({ ok: true });
    await unwinding();
    expect(manager!.cancel(runId)).toBe(true);
    expect(store.getRun(runId)?.status).toBe('cancelled');
    expect(manager!.isActive(runId)).toBe(true);
    expect(manager!.continueRun(runId, { text: 'do Y instead' })).toEqual({ ok: true });

    gate.release!();
    await expect.poll(() => stepStatus(runId, 'continue-2'), { timeout: 15_000 }).toBe('done');
    expect(gate.specs[1]?.userPrompt).toContain('do Y instead');
  });

  it('a second Cancel drops the Continue posted after the first', async () => {
    const runId = await terminalWorktreeRun();
    expect(manager!.continueRun(runId, { text: 'first' })).toEqual({ ok: true });
    await unwinding();
    manager!.cancel(runId);
    expect(manager!.continueRun(runId, { text: 'do Y instead' })).toEqual({ ok: true });
    manager!.cancel(runId);

    gate.release!();
    await expect.poll(() => manager!.isActive(runId), { timeout: 15_000 }).toBe(false);
    expect(store.getRun(runId)?.status).toBe('cancelled');
    expect(gate.specs).toHaveLength(1);
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
