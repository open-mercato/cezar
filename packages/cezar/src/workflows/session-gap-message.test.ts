import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

// The settle tail after a session's last turn (landing, the review gate's diff) runs while the
// record still says `running` and no session is open. Hold the review gate's diff open.
const gate = vi.hoisted(() => ({ specs: [] as AgentRunSpec[], hold: false, release: undefined as (() => void) | undefined }));

vi.mock('../git-worktree.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git-worktree.ts')>()),
  autosaveCommit: vi.fn(async () => 'nothing-to-do'),
  worktreeDiff: vi.fn(async () => {
    if (gate.hold) await new Promise<void>((resolve) => { gate.release = resolve; });
    return '';
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

describe('a message sent while a running task settles (telemetry 1408d7cb)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    gate.specs.length = 0;
    gate.hold = false;
    gate.release = undefined;
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-session-gap-')));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    gate.hold = false;
    gate.release?.();
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function settledRun(): Promise<string> {
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

  const text = (t: string) => [{ type: 'text' as const, text: t }];
  const stepStatus = (runId: string, stepId: string) => store.getRun(runId)?.steps.find((s) => s.id === stepId)?.status;

  it('accepts the message instead of refusing it, and resumes the task with it once settled', async () => {
    const runId = await settledRun();
    gate.hold = true;
    expect(manager!.continueRun(runId, { text: 'first' })).toEqual({ ok: true });
    await expect.poll(() => gate.release !== undefined, { timeout: 15_000 }).toBe(true);
    // The window the cockpit hits: the record says running, no session is open.
    expect(store.getRun(runId)?.status).toBe('running');
    expect(manager!.sendMessage(runId, text('one more thing'))).toBe(false);
    expect(manager!.deferMessage(runId, text('one more thing'))).toBe(true);

    gate.hold = false;
    gate.release!();
    await expect.poll(() => stepStatus(runId, 'continue-2'), { timeout: 15_000 }).toBe('done');
    expect(gate.specs).toHaveLength(2);
    expect(gate.specs[1]?.userPrompt).toContain('one more thing');
  });

  it('refuses a message while the run is parked at a wait, rather than holding it unseen', async () => {
    const runId = await settledRun();
    gate.hold = true;
    expect(manager!.continueRun(runId, { text: 'first' })).toEqual({ ok: true });
    await expect.poll(() => gate.release !== undefined, { timeout: 15_000 }).toBe(true);
    // A graph CI / children wait parks the run in `waiting` with no session — no step opens one soon.
    (manager as unknown as { waiting: Set<string> }).waiting.add(runId);
    expect(manager!.deferMessage(runId, text('stop, do X instead'))).toBe(false);
    (manager as unknown as { waiting: Set<string> }).waiting.delete(runId);
    expect(manager!.deferMessage(runId, text('stop, do X instead'))).toBe(true);
  });

  it('tells the thread when a deferred message cannot be delivered because the run was cancelled', async () => {
    const runId = await settledRun();
    gate.hold = true;
    expect(manager!.continueRun(runId, { text: 'first' })).toEqual({ ok: true });
    await expect.poll(() => gate.release !== undefined, { timeout: 15_000 }).toBe(true);
    expect(manager!.deferMessage(runId, text('late'))).toBe(true);
    manager!.cancel(runId);
    gate.hold = false;
    gate.release!();
    await expect
      .poll(() => store.readEvents(runId).some((e) => String(e.message).includes('could not be delivered — the run was cancelled')), { timeout: 15_000 })
      .toBe(true);
    expect(gate.specs).toHaveLength(1);
  });
});
