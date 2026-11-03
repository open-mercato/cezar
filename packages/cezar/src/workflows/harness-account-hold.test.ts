import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE } from '../harness/workflows.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const LIMIT = 'Codex usage limit reached. Try again in 3 hours.';

// a usage-limit hold was keyed to the composer's account, so a Codex implementer's
// limit held every new Claude task while new Codex tasks walked into the closed window.
describe('a usage-limit hold belongs to the account that hit the limit', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-account-hold-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'a\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  const failedRun = (harness: boolean) => {
    const run = store.createRun({
      title: 't',
      workflow: harness ? 'harness-fix-issue' : 'one-step',
      task: 'x',
      steps: [{ id: 'implement', name: 'Implement', kind: 'agent' as const }],
    });
    store.updateStep(run.id, 'implement', { status: 'failed', backend: 'codex', profileId: 'work', error: LIMIT });
    store.updateRun(run.id, {
      status: 'failed',
      runner: 'claude',
      error: `phase "implement" failed: ${LIMIT}`,
      autoResumeAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      ...(harness ? { autoResumeAccount: 'codex:default', harness: { profile: 'standard', workflow: 'harness-fix-issue', issueId: '1' } } : {}),
    });
  };

  it('guard: holds the harness phase account, not the composer account', () => {
    failedRun(true);
    const holds = manager.accountHolds();
    expect(holds.deadline.has('codex:default')).toBe(true);
    expect(holds.deadline.has('claude:default')).toBe(false);
  });

  // the resume resets the limited step, so the in-flight hold fell back to the
  // composer's account — holding every Claude task while Codex tasks walked into the closed window.
  it('keeps the limited account through an automatic resume until that account proves its window', () => {
    const workflow = harnessWorkflowDefs().find((item) => item.name === HARNESS_FIX_ISSUE)!;
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ multiModel: true, skillsRepos: [] }));
    manager.dispose();
    // No free slot: the resumed run stays queued, its resume in flight.
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #1', steps: [{ id: 'implement', name: 'Implement', kind: 'agent' as const }] });
    store.updateStep(run.id, 'implement', { status: 'failed', backend: 'codex', profileId: 'work', sessionId: 's-1', error: LIMIT });
    store.updateRun(run.id, {
      status: 'failed',
      runner: 'claude',
      workflowDef: workflow,
      error: `phase "implement" failed: ${LIMIT}`,
      harness: { profile: 'standard', workflow: workflow.name, issueId: '1' },
    });
    const internals = manager as unknown as {
      scheduleAutoResumeIfLimited(runId: string, account?: string): void;
      fireAutoResume(runId: string): void;
      noteWindowProven(runId: string, account?: string): void;
    };

    internals.scheduleAutoResumeIfLimited(run.id, 'codex:default');
    internals.fireAutoResume(run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: 'queued', autoResumeAttempts: 1 });
    expect(manager.accountHolds().inFlight).toEqual(new Set(['codex:default']));

    internals.noteWindowProven(run.id, 'claude:default');
    expect(manager.accountHolds().inFlight).toEqual(new Set(['codex:default']));
    internals.noteWindowProven(run.id, 'codex:default');
    expect(manager.accountHolds().inFlight.size).toBe(0);
  });

  it.each([false, true])('auto-resumes an advisor-only limit without holding an account (session=%s)', (hasSession) => {
    failedRun(true);
    const run = store.listRuns()[0]!;
    const workflow = harnessWorkflowDefs().find((item) => item.name === HARNESS_FIX_ISSUE)!;
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ multiModel: true, skillsRepos: [] }));
    manager.dispose();
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    store.updateRun(run.id, { workflowDef: workflow, autoResumeAt: undefined, autoResumeAccount: undefined });
    if (hasSession) store.updateStep(run.id, 'implement', { sessionId: 's-1' });
    const internal = manager as unknown as {
      scheduleAutoResumeIfLimited: (id: string) => void;
      fireAutoResume: (id: string) => void;
    };
    internal.scheduleAutoResumeIfLimited(run.id);
    expect(store.getRun(run.id)?.autoResumeAt).toBeDefined();
    expect(store.getRun(run.id)?.autoResumeAccount).toBeUndefined();
    expect(manager.accountHolds().deadline.size).toBe(0);
    internal.fireAutoResume(run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: 'queued', autoResumeAttempts: 1 });
    expect(store.getRun(run.id)?.autoResumeAccount).toBeUndefined();
    expect(manager.accountHolds().inFlight.size).toBe(0);
  });

  // A transient retry (#1690) says nothing about an account's window: a capture left from an
  // earlier limit must not ride along and hold that account while the retry is in flight.
  it('carries no account through a transient retry of a harness run', () => {
    failedRun(true);
    const run = store.listRuns()[0]!;
    const workflow = harnessWorkflowDefs().find((item) => item.name === HARNESS_FIX_ISSUE)!;
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ multiModel: true, skillsRepos: [] }));
    manager.dispose();
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    store.updateStep(run.id, 'implement', { sessionId: 's-1', error: 'API Error: 529 overloaded' });
    store.updateRun(run.id, {
      workflowDef: workflow,
      error: 'phase "implement" failed: API Error: 529 overloaded',
      autoResumeAt: undefined,
    });
    const internal = manager as unknown as {
      scheduleAutoResumeIfLimited: (id: string) => void;
      fireAutoResume: (id: string) => void;
    };

    internal.scheduleAutoResumeIfLimited(run.id);
    expect(store.getRun(run.id)?.autoResumeReason).toBe('transient');
    internal.fireAutoResume(run.id);

    expect(store.getRun(run.id)).toMatchObject({ status: 'queued', autoResumeAttempts: 1, autoResumeReason: 'transient' });
    expect(store.getRun(run.id)?.autoResumeAccount).toBeUndefined();
    expect(manager.accountHolds().inFlight.size).toBe(0);
  });

  it('schedules from persisted limited-account attribution without an active state', () => {
    failedRun(true);
    const run = store.listRuns()[0]!;
    store.updateRun(run.id, { autoResumeAt: undefined });
    store.updateStep(run.id, 'implement', { sessionId: 's-1' });
    const internal = manager as unknown as {
      active: Map<string, unknown>;
      scheduleAutoResumeIfLimited: (id: string) => void;
    };
    expect(internal.active.has(run.id)).toBe(false);
    internal.scheduleAutoResumeIfLimited(run.id);
    expect(store.getRun(run.id)?.autoResumeAt).toBeDefined();
    expect(store.getRun(run.id)?.autoResumeAccount).toBe('codex:default');
    expect(manager.accountHolds().deadline).toEqual(new Set(['codex:default']));
  });

  it('guard: keeps the run account for an ordinary run', () => {
    failedRun(false);
    expect(manager.accountHolds().deadline.has('claude:default')).toBe(true);
  });
});
