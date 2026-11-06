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

describe('Continue posted while a settled continuation unwinds, with an older step left open', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    gate.specs.length = 0;
    gate.release = undefined;
    vi.mocked(autosaveCommit).mockClear();
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-stale-unwinding-')));
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

  it('queues the Continue behind the autosave instead of releasing the healthy registration', async () => {
    const runId = await terminalWorktreeRun();
    store.updateStep(runId, 'work', { status: 'running' });
    expect(manager!.continueRun(runId, { text: 'first' })).toEqual({ ok: true });
    await unwinding();
    expect(['done', 'review']).toContain(store.getRun(runId)?.status);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(manager!.continueRun(runId, { text: 'second' })).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 500));
    const released = store.readEvents(runId).some((e) => String((e as { message?: unknown }).message ?? '').includes('stale session registration'));
    expect(released).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(gate.specs).toHaveLength(1);
    gate.release!();
    await expect.poll(() => gate.specs.length, { timeout: 15_000 }).toBe(2);
  });
});
