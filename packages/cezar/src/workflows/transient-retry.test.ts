import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRANSIENT_RETRIES } from '../core/agent-failure-class.ts';
import { reportAgentError } from '../runs/agent-error-telemetry.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

vi.mock('../runs/agent-error-telemetry.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reportAgentError: vi.fn(),
}));

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

type Scheduler = {
  autoResumeTimers: Map<string, ReturnType<typeof setTimeout>>;
  fireAutoResume(runId: string): void;
};

/** Transient agent failures retry through the usage-limit auto-resume machinery; account-state
 *  failures explain themselves instead (core/agent-failure-class.ts). Driven by the bundled mock. */
describe('a run stopped by a transient provider failure retries itself', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  async function settle(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 20_000 })
      .toMatch(/^(done|review|failed|cancelled)$/);
  }
  function fireNow(runId: string): void {
    const scheduler = manager as unknown as Scheduler;
    clearTimeout(scheduler.autoResumeTimers.get(runId));
    scheduler.fireAutoResume(runId);
  }
  /** The deferred reports run.ts makes — the store's event-time calls are filtered inside the real one. */
  function deferredReports(): unknown[] {
    return vi.mocked(reportAgentError).mock.calls.map((call) => call[2]).filter((opts) => opts !== undefined);
  }
  function messages(runId: string): string[] {
    return store.readEvents(runId).map((event) => String(event.message ?? ''));
  }

  beforeEach(async () => {
    vi.mocked(reportAgentError).mockClear();
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-transient-retry-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(async () => {
    if (manager) {
      for (const { id } of store.listRuns()) manager.cancel(id);
      await expect.poll(() => store.listRuns().some(({ id }) => manager?.isActive(id)), { timeout: 10_000 }).toBe(false);
      manager.dispose();
      manager = undefined;
    }
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('books a 30 s retry that holds no account, and the retry resumes the same session', async () => {
    manager = new RunManager(store, repoRoot);
    const before = Date.now();
    const record = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:overloaded ship it', worktree: false });
    await settle(record.id);

    const failed = store.getRun(record.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.autoResumeReason).toBe('transient');
    const wait = Date.parse(failed.autoResumeAt ?? '') - before;
    expect(wait).toBeGreaterThanOrEqual(30_000);
    expect(wait).toBeLessThan(60_000);
    expect(messages(record.id).some((m) => m.startsWith('temporary provider failure — retrying automatically at'))).toBe(true);
    // A 529 says nothing about the account's window: other work on it must not queue behind it.
    const holds = manager.accountHolds();
    expect(holds.deadline.size + holds.inFlight.size).toBe(0);
    // Deferred until cezar knows whether the retry worked.
    expect(deferredReports()).toEqual([]);

    const session = failed.steps.find((step) => step.sessionId)?.sessionId;
    store.updateRun(record.id, { task: 'mock:done ship it' });
    fireNow(record.id);
    await expect.poll(() => store.getRun(record.id)?.status, { timeout: 20_000 }).toMatch(/^(done|review)$/);
    const resumed = store.getRun(record.id)!;
    expect(resumed.steps.some((step) => step.sessionId === session && step.status === 'done')).toBe(true);
    expect(resumed.autoResumeAt).toBeUndefined();
    expect(resumed.autoResumeAttempts).toBeUndefined();
    expect(messages(record.id)).toContain(`retrying after a temporary provider failure (1/${MAX_TRANSIENT_RETRIES})`);
    expect(deferredReports()).toEqual([]);
  }, 60_000);

  it(`gives up after ${MAX_TRANSIENT_RETRIES} retries, fails as before, and reports the error then`, async () => {
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:overloaded ship it', worktree: false });
    await settle(record.id);
    for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();
      fireNow(record.id);
      await expect.poll(() => store.getRun(record.id)?.autoResumeAttempts, { timeout: 5_000 }).toBe(attempt);
      await expect
        .poll(() => store.getRun(record.id)?.status === 'failed' && !manager!.isActive(record.id), { timeout: 20_000 })
        .toBe(true);
    }
    const spent = store.getRun(record.id)!;
    expect(spent.autoResumeAt).toBeUndefined();
    expect(messages(record.id)).toContain(
      `the provider is still failing after ${MAX_TRANSIENT_RETRIES} automatic retries — continue this task manually`,
    );
    expect(deferredReports()).toEqual([{ transientOutcome: 'retries_exhausted' }]);
  }, 90_000);

  it('Cancel on the failed run retires the booked retry', async () => {
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:overloaded ship it', worktree: false });
    await settle(record.id);
    expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();
    expect(manager.cancel(record.id)).toBe(true);
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    expect((manager as unknown as Scheduler).autoResumeTimers.has(record.id)).toBe(false);
    expect(store.getRun(record.id)?.status).toBe('failed');
  }, 30_000);

  it('a user Continue supersedes the booked retry', async () => {
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:overloaded ship it', worktree: false });
    await settle(record.id);
    expect(manager.continueRun(record.id, { text: 'mock:done carry on' }).ok).toBe(true);
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    expect((manager as unknown as Scheduler).autoResumeTimers.has(record.id)).toBe(false);
    await expect.poll(() => store.getRun(record.id)?.status, { timeout: 20_000 }).toMatch(/^(done|review)$/);
  }, 40_000);

  it('the switch that turns auto-resume off also turns the retry off — and the error is reported', async () => {
    manager = new RunManager(store, repoRoot);
    vi.spyOn((manager as unknown as { semaphore: { autoResumeOnUsageLimit(): boolean } }).semaphore, 'autoResumeOnUsageLimit')
      .mockReturnValue(false);
    const record = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:overloaded ship it', worktree: false });
    await settle(record.id);
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    expect(deferredReports()).toEqual([{ transientOutcome: 'not_retried' }]);
  }, 30_000);

  it('an account-state failure is explained, not retried', async () => {
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:credit ship it', worktree: false });
    await settle(record.id);
    const failed = store.getRun(record.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.autoResumeAt).toBeUndefined();
    expect(messages(record.id)).toContain(
      'the Claude Code account has run out of credit — top up its balance or switch this task to another account, then Continue',
    );
  }, 30_000);

  it('a full disk is explained with the reclaim hint, not retried (9cdcedc3)', async () => {
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:enospc ship it', worktree: false });
    await settle(record.id);
    const failed = store.getRun(record.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.autoResumeAt).toBeUndefined();
    expect(messages(record.id).some((m) => /the disk is full.*Reclaim now/.test(m))).toBe(true);
  }, 30_000);
});
