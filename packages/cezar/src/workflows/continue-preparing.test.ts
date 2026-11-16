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

const gate = vi.hoisted(() => ({ specs: [] as AgentRunSpec[], release: undefined as (() => void) | undefined }));

// A deliberately slow worktree restore: the window #2216 is about.
vi.mock('../runs/retention.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runs/retention.ts')>()),
  rematerializeReclaimedWorktree: vi.fn(async () => {
    await new Promise<void>((resolve) => { gate.release = resolve; });
    return true;
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
        sendMessage: () => false, end: () => {}, interrupt: () => {}, open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

describe('Continue while a reclaimed worktree is restored (#2216)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    gate.specs.length = 0; gate.release = undefined;
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-continue-prep-')));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    gate.release?.();
    manager?.dispose(); manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function reclaimedRun(): string {
    const record = store.createRun({
      title: 't', workflow: 'legacy', task: 'do it', runner: 'claude',
      steps: [{ id: 'work', name: 'work', kind: 'agent' as const }],
    });
    store.updateRun(record.id, {
      status: 'done', finishedAt: new Date().toISOString(),
      worktreePath: join(repoRoot, '.ai/cezar/worktrees/gone'), branch: 'cez/gone', worktreeReclaimedAt: new Date().toISOString(),
    });
    store.updateStep(record.id, 'work', { status: 'done', sessionId: 'sess-1', backend: 'claude' });
    return record.id;
  }

  it('leaves the closed status as soon as Continue is accepted, and cancel wins over a late restore', async () => {
    const runId = reclaimedRun();
    expect(manager!.continueRun(runId, { text: 'go' })).toEqual({ ok: true });
    await expect.poll(() => gate.release !== undefined).toBe(true);
    // Preparation is still pending: the durable record must not still read as finished.
    const mid = store.getRun(runId)!;
    expect(mid.status).toBe('queued');
    expect(mid.finishedAt).toBeUndefined();
    expect(manager!.continueRun(runId, { text: 'again' }).ok).toBe(false);
    expect(store.getRun(runId)!.steps.filter((s) => s.id.startsWith('continue-'))).toHaveLength(1);

    expect(manager!.cancel(runId)).toBe(true);
    gate.release!();
    await expect.poll(() => manager!.isActive(runId)).toBe(false);
    expect(store.getRun(runId)!.status).toBe('cancelled');
    expect(gate.specs).toHaveLength(0);
  });
});
