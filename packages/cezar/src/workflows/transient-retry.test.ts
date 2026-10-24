import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import {
  MAX_TRANSIENT_RETRIES,
  RunManager,
  TRANSIENT_RETRY_DELAYS_MS,
  TRANSIENT_RETRY_MISSED_WINDOW_MS,
} from './run.ts';
import type { WorkflowDef } from './types.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

/**
 * Transient agent failures retry themselves through the usage-limit auto-resume machinery
 * (spec 2026-10-24-agent-cli-error-cooperation, Improvement 1), end to end through the real
 * engine and the bundled mock CLI (`mock:overloaded`, `CEZ_MOCK_ERROR_RESULT`).
 *
 * Exits from the retry-scheduled state (`failed` + `autoResumeAt` + reason `transient`), each
 * pinned below: the timer firing (retry runs), a human Continue (resets the shared counter),
 * Don't resume, archive, the setting switched off, a restart (re-arm, or expire when stale), and
 * Cancel/Finish — which refuse a failed run exactly as they do for a usage-limit wait.
 */
describe('a run stopped by a transient agent error retries itself', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  const workflow: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  async function settle(runId: string): Promise<void> {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const messages = (runId: string) => store.readEvents(runId).map((event) => String(event.message ?? ''));

  /** Start a run that fails on a 529 and wait for the retry to be booked. */
  async function overloadedRun(opts: { manager?: RunManager } = {}) {
    const owner = opts.manager ?? (manager ??= new RunManager(store, repoRoot));
    const record = owner.startRun(workflow, { task: 'mock:overloaded ship it', worktree: false });
    await settle(record.id);
    return record;
  }

  /** The timer's moment, without waiting it out: a restart with the deadline already passed —
   *  the same `fireAutoResume` the timer calls. */
  async function elapseAndRecover(runId: string): Promise<void> {
    manager?.dispose();
    store.updateRun(runId, { autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    manager = new RunManager(store, repoRoot);
    await manager.recover();
  }

  const stepStatus = (runId: string, stepId: string) =>
    store.getRun(runId)?.steps.find((step) => step.id === stepId)?.status;

  beforeEach(async () => {
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_ERROR_RESULT = process.env.CEZ_MOCK_ERROR_RESULT;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_MOCK_ERROR_RESULT;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-transient-retry-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await exec('git', ['add', '-A'], { cwd: repoRoot });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(async () => {
    if (manager) {
      for (const { id } of store.listRuns()) manager.cancel(id);
      const deadline = Date.now() + 10_000;
      while (store.listRuns().some(({ id }) => manager?.isActive(id)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      manager.dispose();
      manager = undefined;
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('books a retry two minutes out, says so, and holds no account', async () => {
    const before = Date.now();
    const record = await overloadedRun();

    const failed = store.getRun(record.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('529');
    expect(failed?.autoResumeReason).toBe('transient');
    const at = Date.parse(failed?.autoResumeAt ?? '');
    expect(at).toBeGreaterThanOrEqual(before + TRANSIENT_RETRY_DELAYS_MS[0]);
    expect(at).toBeLessThanOrEqual(Date.now() + TRANSIENT_RETRY_DELAYS_MS[0]);
    expect(messages(record.id).some((m) => m.startsWith('temporary agent error — retrying automatically at') && m.endsWith(`(1/${MAX_TRANSIENT_RETRIES})`))).toBe(true);
    // A 529 is about one request, not the account's window: other work on it must keep starting.
    const holds = manager!.accountHolds();
    expect(holds.deadline.size + holds.inFlight.size).toBe(0);
  }, 30_000);

  it('lets fresh work on the same account start while a retry waits', async () => {
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }),
    });
    const record = await overloadedRun();
    expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();
    const next = manager.startRun(workflow, { task: 'mock:done next', worktree: false });
    await settle(next.id);
    expect(store.getRun(next.id)?.status).toBe('done');
  }, 40_000);

  it.each([
    'Credit balance is too low',
    'Not logged in · Please run /login',
    'API Error: 400 Identity verification is required to continue.',
    'Your organization has disabled Claude subscription access for Claude Code',
    "You've hit your usage limit. Upgrade your plan to continue.",
    'exit code 1',
  ])('never retries a non-transient failure: %s', async (text) => {
    process.env.CEZ_MOCK_ERROR_RESULT = text;
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(workflow, { task: 'ship it', worktree: false });
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('failed');
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(record.id)?.autoResumeReason).toBeUndefined();
    expect(messages(record.id).some((m) => m.includes('retrying automatically'))).toBe(false);
  }, 30_000);

  it('is off with auto-resume — the same switch, no new knob', async () => {
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { autoResumeOnUsageLimit: false } }),
    });
    const record = await overloadedRun();
    expect(store.getRun(record.id)?.status).toBe('failed');
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
  }, 30_000);

  it('exit: the timer fires — the session is resumed with the retry prompt, and a completed turn resets the counter', async () => {
    const record = await overloadedRun();
    // The mock replays the task text on resume; swap it so the retried turn can succeed.
    store.updateRun(record.id, { task: 'mock:done ship it' });
    await elapseAndRecover(record.id);

    await expect.poll(() => stepStatus(record.id, 'continue-1'), { timeout: 20_000 }).toBe('done');
    expect(messages(record.id)).toContain(`retrying after a temporary agent error (1/${MAX_TRANSIENT_RETRIES})`);
    const after = store.getRun(record.id);
    expect(after?.autoResumeAt).toBeUndefined();
    expect(after?.autoResumeAttempts).toBeUndefined();
    expect(after?.autoResumeReason).toBeUndefined();
    // While it ran it held nothing either — the in-flight clause is for usage-limit resumes only.
    const holds = manager!.accountHolds();
    expect(holds.inFlight.size).toBe(0);
  }, 40_000);

  it('backs off 2 then 6 minutes, then stops at the cap and says why', async () => {
    process.env.CEZ_MOCK_ERROR_RESULT = OVERLOADED;
    const record = await overloadedRun();
    expect(store.getRun(record.id)?.autoResumeAttempts).toBeUndefined();

    const firstFire = Date.now();
    await elapseAndRecover(record.id);
    await expect.poll(() => stepStatus(record.id, 'continue-1'), { timeout: 20_000 }).toBe('failed');
    await expect.poll(() => store.getRun(record.id)?.autoResumeAt, { timeout: 5_000 }).toBeDefined();
    const second = store.getRun(record.id)!;
    expect(second.autoResumeAttempts).toBe(1);
    expect(second.autoResumeReason).toBe('transient');
    expect(Date.parse(second.autoResumeAt!)).toBeGreaterThanOrEqual(firstFire + TRANSIENT_RETRY_DELAYS_MS[1]);

    await elapseAndRecover(record.id);
    await expect.poll(() => stepStatus(record.id, 'continue-2'), { timeout: 20_000 }).toBe('failed');
    await expect
      .poll(() => messages(record.id).includes(`automatic retry cap reached (${MAX_TRANSIENT_RETRIES}) — continue this task manually`), { timeout: 5_000 })
      .toBe(true);
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(record.id)?.steps.some((step) => step.id === 'continue-3')).toBe(false);
  }, 60_000);

  it('shares one counter with the usage-limit resume, so the two cannot ping-pong', async () => {
    // transient → retry (1) → usage limit → resume (2) → transient: the cap is already spent.
    const record = await overloadedRun();
    process.env.CEZ_MOCK_ERROR_RESULT = `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`;
    await elapseAndRecover(record.id);
    await expect.poll(() => stepStatus(record.id, 'continue-1'), { timeout: 20_000 }).toBe('failed');
    await expect.poll(() => store.getRun(record.id)?.autoResumeAt, { timeout: 5_000 }).toBeDefined();
    // Now a usage-limit wait: it holds the account, and it counts on from the retry.
    expect(store.getRun(record.id)?.autoResumeReason).toBeUndefined();
    expect(store.getRun(record.id)?.autoResumeAttempts).toBe(1);
    expect([...manager!.accountHolds().deadline]).toContain('claude:default');

    process.env.CEZ_MOCK_ERROR_RESULT = OVERLOADED;
    await elapseAndRecover(record.id);
    await expect.poll(() => stepStatus(record.id, 'continue-2'), { timeout: 20_000 }).toBe('failed');
    await expect
      .poll(() => messages(record.id).some((m) => m.startsWith('automatic retry cap reached')), { timeout: 5_000 })
      .toBe(true);
    expect(store.getRun(record.id)?.autoResumeAttempts).toBe(2);
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
  }, 60_000);

  it('exit: a human Continue retires the retry and resets the shared counter', async () => {
    const record = await overloadedRun();
    store.updateRun(record.id, { autoResumeAttempts: 1 });
    expect(manager!.continueRun(record.id, { text: 'mock:done carry on' }).ok).toBe(true);
    const resumed = store.getRun(record.id);
    expect(resumed?.autoResumeAt).toBeUndefined();
    expect(resumed?.autoResumeAttempts).toBeUndefined();
    expect(resumed?.autoResumeReason).toBeUndefined();
    await expect.poll(() => stepStatus(record.id, 'continue-1'), { timeout: 20_000 }).toBe('done');
    // The retry timer is gone with it: no second continuation ever appears.
    expect(store.getRun(record.id)?.steps.some((step) => step.id === 'continue-2')).toBe(false);
  }, 40_000);

  it("exit: Don't resume retires it for this task, and says so", async () => {
    const record = await overloadedRun();
    expect(manager!.cancelAutoResume(record.id)).toBe(true);
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(record.id)?.autoResumeReason).toBeUndefined();
    expect(messages(record.id)).toContain('automatic resume cancelled for this task');
  }, 30_000);

  it('exit: archiving the task retires it', async () => {
    const record = await overloadedRun();
    store.setArchived(record.id, true);
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(record.id)?.autoResumeReason).toBeUndefined();
  }, 30_000);

  it('exit: switching auto-resume off cancels a pending retry', async () => {
    const semaphore = new WorkspaceSemaphore({ initial: { autoResumeOnUsageLimit: true } });
    manager = new RunManager(store, repoRoot, { semaphore });
    const record = await overloadedRun();
    expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();
    manager.dispose();
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { autoResumeOnUsageLimit: false } }),
    });
    await manager.recover();
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    expect(messages(record.id)).toContain('automatic resume cancelled — auto-resume is switched off');
  }, 30_000);

  it('exit: Cancel and Finish refuse a failed run, exactly as for a usage-limit wait — the retry stays booked', async () => {
    const record = await overloadedRun();
    expect(manager!.cancel(record.id)).toBe(false);
    expect(manager!.finish(record.id)).toBe(false);
    expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();
  }, 30_000);

  it('exit: a restart re-arms a pending retry from the record', async () => {
    const record = await overloadedRun();
    const at = store.getRun(record.id)?.autoResumeAt;
    manager!.dispose();
    manager = new RunManager(store, repoRoot);
    await manager.recover();
    expect(store.getRun(record.id)?.autoResumeAt).toBe(at);
    expect(store.getRun(record.id)?.autoResumeReason).toBe('transient');
  }, 30_000);

  it('exit: a restart retires a retry missed by more than an hour, instead of reviving it', async () => {
    const record = await overloadedRun();
    manager!.dispose();
    store.updateRun(record.id, {
      autoResumeAt: new Date(Date.now() - TRANSIENT_RETRY_MISSED_WINDOW_MS - 60_000).toISOString(),
    });
    manager = new RunManager(store, repoRoot);
    await manager.recover();
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    expect(messages(record.id).some((m) => m.startsWith('automatic retry expired'))).toBe(true);
    expect(store.getRun(record.id)?.steps.some((step) => step.id === 'continue-1')).toBe(false);
  }, 30_000);
});
