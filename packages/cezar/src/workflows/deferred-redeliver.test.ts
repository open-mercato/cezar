import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

// Same harness as session-gap-message.test.ts: the review gate's diff is held open, which is the
// settle tail where a message gets deferred (telemetry 1408d7cb). `diff` picks review vs done.
const gate = vi.hoisted(() => ({
  specs: [] as AgentRunSpec[],
  sent: [] as unknown[],
  hold: false,
  diff: '',
  release: undefined as (() => void) | undefined,
  onStart: undefined as ((spec: AgentRunSpec, n: number) => void) | undefined,
}));

vi.mock('../git-worktree.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git-worktree.ts')>()),
  autosaveCommit: vi.fn(async () => 'nothing-to-do'),
  worktreeDiff: vi.fn(async () => {
    if (gate.hold) await new Promise<void>((resolve) => { gate.release = resolve; });
    return gate.diff;
  }),
}));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec) => {
      gate.specs.push(spec);
      gate.onStart?.(spec, gate.specs.length);
      const second = gate.onStart !== undefined && gate.specs.length === 2;
      return {
        result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }),
        sendMessage: (blocks: unknown) => {
          if (!second) return false;
          gate.sent.push(blocks);
          return true;
        },
        end: () => {},
        interrupt: () => {},
        open: second,
      };
    },
    interrupt: async () => {},
  }),
}));

type Internals = {
  active: Map<string, { graphFinish?: () => void; finishRequested?: boolean; acceptReviewOnDrop?: boolean; continueOnDrop?: unknown }>;
  memoryPausing: Set<string>;
  armAutoResume: (runId: string, deadline: number) => void;
  scheduleAutoResumeIfLimited: (runId: string) => void;
};

describe('a message deferred while a run settles (telemetry 1408d7cb follow-up)', { timeout: 30_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const internals = () => manager as unknown as Internals;

  beforeEach(async () => {
    gate.specs.length = 0;
    gate.sent.length = 0;
    gate.hold = false;
    gate.diff = '';
    gate.release = undefined;
    gate.onStart = undefined;
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-deferred-redeliver-')));
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

  /** Continue the run and stop it in its settle tail, with `late` deferred there. */
  async function deferInSettleTail(late: string[] = ['late']): Promise<string> {
    const runId = await settledRun();
    gate.hold = true;
    expect(manager!.continueRun(runId, { text: 'first' })).toEqual({ ok: true });
    await expect.poll(() => gate.release !== undefined, { timeout: 15_000 }).toBe(true);
    for (const t of late) expect(manager!.deferMessage(runId, text(t))).toBe(true);
    return runId;
  }

  function releaseGate(): void {
    gate.hold = false;
    gate.release!();
  }

  const text = (t: string) => [{ type: 'text' as const, text: t }];
  const lifecycle = (runId: string) => store.readEvents(runId).filter((e) => e.type === 'lifecycle').map((e) => String(e.message));
  const undelivered = (runId: string, reason: string) =>
    expect.poll(() => lifecycle(runId).some((m) => m.includes(`could not be delivered — ${reason}`)), { timeout: 15_000 }).toBe(true);
  const settled = (runId: string) =>
    expect.poll(() => manager!.isActive(runId), { timeout: 15_000 }).toBe(false);

  it('a run whose review was ACCEPTED mid-gap is not continued', async () => {
    // The review gate is opt-in; with it on, a diff settles the turn at `review`.
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ reviewGate: true }));
    gate.diff = 'diff --git a/a.txt b/a.txt\n+two\n';
    const runId = await deferInSettleTail();
    internals().active.get(runId)!.acceptReviewOnDrop = true;
    releaseGate();
    await undelivered(runId, 'the review was accepted');
    await settled(runId);
    expect(store.getRun(runId)?.status).toBe('done');
    expect(gate.specs).toHaveLength(1);
  });

  it('a run FINISHED mid-gap is not continued', async () => {
    const runId = await deferInSettleTail();
    internals().active.get(runId)!.finishRequested = true;
    releaseGate();
    await undelivered(runId, 'the task was finished');
    await settled(runId);
    expect(gate.specs).toHaveLength(1);
    expect(store.getRun(runId)?.steps.some((s) => s.id === 'continue-2')).toBe(false);
  });

  it('a run FINISHED at a workflow wait mid-gap is not continued', async () => {
    const runId = await deferInSettleTail();
    const finished = vi.fn();
    internals().active.get(runId)!.graphFinish = finished;
    expect(manager!.finish(runId)).toBe(true);
    expect(finished).toHaveBeenCalledTimes(1);
    releaseGate();
    await undelivered(runId, 'the task was finished');
    await settled(runId);
    expect(gate.specs).toHaveLength(1);
  });

  it('a run MEMORY-PAUSED mid-gap is not continued', async () => {
    const runId = await deferInSettleTail();
    internals().memoryPausing.add(runId);
    releaseGate();
    await undelivered(runId, 'the task was paused for exceeding the memory limit');
    await settled(runId);
    expect(gate.specs).toHaveLength(1);
  });

  it('a run parked for a usage-limit auto-resume keeps its schedule and is not continued', async () => {
    const runId = await deferInSettleTail();
    const deadline = Date.now() + 60 * 60_000;
    vi.spyOn(internals(), 'scheduleAutoResumeIfLimited').mockImplementation((id: string) => internals().armAutoResume(id, deadline));
    releaseGate();
    await undelivered(runId, 'the task is waiting for its usage limit to reset');
    await settled(runId);
    expect(gate.specs).toHaveLength(1);
    expect(store.getRun(runId)?.autoResumeAt).toBe(new Date(deadline).toISOString());
  });

  it('stacks the message onto a run that was RE-QUEUED by a Continue taken in the same window', async () => {
    const runId = await deferInSettleTail(['stacked']);
    // A Continue deferred for capacity (restart recovery's shape) re-queues the run on drop.
    internals().active.get(runId)!.continueOnDrop = { opts: { text: 'again' }, deferForCapacity: true };
    releaseGate();
    await expect
      .poll(
        () =>
          (store.getRun(runId)?.queuedMessages ?? []).some((m) => m.text === 'stacked')
          || gate.specs.slice(1).some((s) => s.userPrompt.includes('stacked')),
        { timeout: 15_000 },
      )
      .toBe(true);
    expect(lifecycle(runId).some((m) => m.includes('could not be delivered'))).toBe(false);
  });

  it('applies the queued stack bounds to a re-queued redelivery', async () => {
    const runId = await deferInSettleTail(['one too many']);
    const full = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, text: `queued ${i}`, createdAt: new Date().toISOString() }));
    store.updateRun(runId, { queuedMessages: full });
    internals().active.get(runId)!.continueOnDrop = { opts: { text: 'again' }, deferForCapacity: true };
    releaseGate();
    await undelivered(runId, 'too many queued messages — 20 message limit');
    expect(store.getRun(runId)?.queuedMessages?.some((m) => m.text === 'one too many')).toBe(false);
  });

  it('applies the one-turn bound before resuming with several deferred messages', async () => {
    const runId = await deferInSettleTail(['a'.repeat(60_000), 'b'.repeat(60_000)]);
    releaseGate();
    await undelivered(runId, 'prompt too long — 100000 character limit for one turn');
    await settled(runId);
    expect(gate.specs).toHaveLength(1);
  });

  it('flushes a message deferred between two workflow steps into the next step', async () => {
    let runId = '';
    gate.onStart = (_spec, n) => {
      // Step b is launching: step a's session is gone and b's is not attached yet.
      if (n === 2) expect(manager!.deferMessage(runId, text('between steps'))).toBe(true);
    };
    const record = manager!.startRun(
      { name: 'two-steps', source: 'file', steps: [{ id: 'a', name: 'A', prompt: '{{task}}' }, { id: 'b', name: 'B', prompt: 'next' }] },
      { task: 'go', runner: 'claude' },
    );
    runId = record.id;
    await expect.poll(() => gate.sent.length, { timeout: 15_000 }).toBe(1);
    expect(JSON.stringify(gate.sent[0])).toContain('between steps');
    expect(lifecycle(runId).some((m) => m.includes('could not be delivered'))).toBe(false);
  });

  it('a restart notes a message the previous process was still holding', async () => {
    const runId = await deferInSettleTail(['held', 'also held']);
    const marker = join(repoRoot, '.ai/cezar/runs', `${runId}.deferred-messages`);
    expect(existsSync(marker)).toBe(true);
    // The process dies here: a fresh manager over the same data dir is the restart.
    manager!.dispose();
    mkdirSync(join(repoRoot, '.ai/cezar/runs'), { recursive: true });
    manager = new RunManager(store, repoRoot);
    await manager.recover();
    expect(lifecycle(runId).some((m) => m.includes('2 messages sent while the session was closing could not be delivered — cezar restarted'))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('removes the marker once the deferred message is delivered', async () => {
    const runId = await deferInSettleTail(['delivered later']);
    const marker = join(repoRoot, '.ai/cezar/runs', `${runId}.deferred-messages`);
    expect(existsSync(marker)).toBe(true);
    releaseGate();
    await expect.poll(() => gate.specs.length, { timeout: 15_000 }).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });
});
