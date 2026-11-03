import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHarnessDriver } from '../harness/driver.ts';
import { createLedger, loadLedger, saveLedger } from '../harness/ledger.ts';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE } from '../harness/workflows.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { loadWorkflows } from './load.ts';
import { RunManager } from './run.ts';

// Exercise the real manager/worktree/settlement paths without paying for model phases.
vi.mock('../harness/driver.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/driver.ts')>()),
  runHarnessDriver: vi.fn(async () => null),
}));

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const workflow = harnessWorkflowDefs().find((item) => item.name === HARNESS_FIX_ISSUE)!;

describe('harness lifecycle boundaries', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;

  const config = (value: Record<string, unknown>) => {
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify(value));
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    root = mkdtempSync(join(tmpdir(), 'cez-harness-lifecycle-'));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, '.gitignore'), '.ai/cezar/\n');
    git('add', '.gitignore');
    git(...GIT_ID, 'commit', '-q', '-m', 'base');
    config({ multiModel: true, skillsRepos: [], branchNaming: { enabled: false } });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
    vi.mocked(runHarnessDriver).mockReset();
    vi.mocked(runHarnessDriver).mockResolvedValue(null);
  });

  afterEach(async () => {
    for (const run of store.listRuns()) manager.cancel(run.id);
    await vi.waitFor(() => expect(store.listRuns().some((run) => manager.isActive(run.id))).toBe(false));
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  // the harness Continue path re-queued without retiring a pending
  // usage-limit resume, so a later failure re-armed it without the user.
  it('retires a pending usage-limit resume when a harness run is continued', () => {
    manager.dispose();
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, {
      status: 'failed',
      workflowDef: workflow,
      harness: { profile: 'standard', workflow: workflow.name, issueId: '642' },
      autoResumeAt: new Date(Date.now() + 3_600_000).toISOString(),
      autoResumeAttempts: 1,
    });

    expect(manager.continueRun(run.id)).toEqual({ ok: true });

    expect(store.getRun(run.id)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(run.id)?.autoResumeAttempts).toBeUndefined();
  });

  // the usage-limit resume path armed periodic autosave without
  // the stage-only flag, so a resumed harness run committed mid-run.
  it('never arms periodic autosave for a harness run, from any call site', () => {
    vi.stubEnv('CEZ_AUTOSAVE', '1');
    const arm = (manager as unknown as {
      armAutosave(runId: string, state: { cwd: string; autosaveTimer?: ReturnType<typeof setInterval>; includeHarnessSkills: boolean }): void;
    }).armAutosave.bind(manager);
    const harnessRun = store.createRun({ title: 't', workflow: workflow.name, task: 'x', steps: [] });
    store.updateRun(harnessRun.id, { harness: { profile: 'standard', workflow: workflow.name } });
    const harnessState = { cwd: join(root, 'wt'), includeHarnessSkills: false } as { cwd: string; autosaveTimer?: ReturnType<typeof setInterval>; includeHarnessSkills: boolean };
    arm(harnessRun.id, harnessState);
    expect(harnessState.autosaveTimer).toBeUndefined();

    const plainRun = store.createRun({ title: 't', workflow: 'quick-task', task: 'x', steps: [] });
    const plainState = { cwd: join(root, 'wt2'), includeHarnessSkills: false } as typeof harnessState;
    arm(plainRun.id, plainState);
    expect(plainState.autosaveTimer).toBeDefined();
    clearInterval(plainState.autosaveTimer);
  });

  // named agentHarness profiles were removed. A run recorded under one has no
  // lineup to resume, and deriving its profile afresh would run it as Claude solo.
  it('refuses to resume a run recorded under a named profile without a lineup', async () => {
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, { status: 'failed', workflowDef: workflow, harness: { profile: 'multi', workflow: workflow.name } } as never);
    saveLedger(join(root, '.ai/cezar'), run.id, createLedger({ workflow: workflow.name, requestedProfile: 'multi', subject: { kind: 'issue', id: '642', text: 'Fix issue #642' } }));

    expect(manager.continueRun(run.id)).toEqual({ ok: true });

    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('failed'), { timeout: 10_000 });
    expect(store.getRun(run.id)?.error).toMatch(/needs a role lineup/);
    expect(runHarnessDriver).not.toHaveBeenCalled();
  });

  // the usage-limit auto-resume sent its prompt as a Continue
  // message, which a harness run treats as operator feedback.
  it('auto-resumes a usage-limited harness run from its ledger, sending no feedback', async () => {
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, {
      status: 'failed',
      error: 'phase "fix-2" failed: rate limit exceeded — try again in 42 minutes',
      workflowDef: workflow,
      autoResumeAt: new Date(Date.now() - 1_000).toISOString(),
      harness: { profile: 'standard', workflow: workflow.name },
      steps: [{
        id: 'fix-2',
        name: 'Fix',
        kind: 'agent',
        status: 'failed',
        sessionId: 'session-1',
        error: 'rate limit exceeded — try again in 42 minutes',
      }],
    } as never);
    const ledger = createLedger({ workflow: workflow.name, requestedProfile: 'standard', subject: { kind: 'issue', id: '642', text: 'Fix issue #642' } });
    ledger.phases.push({ id: 'implement', name: 'Implement', kind: 'agent', status: 'done', attempts: 1, artifacts: {} });
    saveLedger(join(root, '.ai/cezar'), run.id, ledger);

    (manager as unknown as { fireAutoResume(runId: string): void }).fireAutoResume(run.id);

    await vi.waitFor(() => expect(runHarnessDriver).toHaveBeenCalled(), { timeout: 10_000 });
    expect(loadLedger(join(root, '.ai/cezar'), run.id)?.pendingMessages).toEqual([]);
    expect(store.getRun(run.id)?.autoResumeAt).toBeUndefined();
  });

  it('keeps harness changes isolated and staged in an auto-landing trunk project', async () => {
    config({ multiModel: true, taskWorkspace: 'in-place', landing: 'auto', skillsRepos: [] });
    vi.mocked(runHarnessDriver).mockImplementation(async (host) => {
      writeFileSync(join(host.cwd, 'feature.txt'), 'ready for review\n');
      execFileSync('git', ['add', 'feature.txt'], { cwd: host.cwd });
      return null;
    });
    const before = git('rev-parse', 'HEAD');
    const run = manager.startRun(workflow, { task: 'Fix issue #642', autonomous: true });
    await vi.waitFor(() => expect(['review', 'failed', 'done']).toContain(store.getRun(run.id)?.status), { timeout: 10_000 });
    const result = store.getRun(run.id)!;
    expect(result.status, result.error).toBe('review');
    expect(result.worktree).not.toBe(false);
    expect(result.worktreePath).toBeTruthy();
    expect(result.landing).toBeUndefined();
    expect(result.systemPrompt ?? '').not.toContain('AUTO-LAND');
    expect(git('rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(join(root, 'feature.txt'))).toBe(false);
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: result.worktreePath, encoding: 'utf8' }).trim()).toBe('feature.txt');
  }, 15_000);

  // the auth latch read a driver note quoting an advisor's 401 as the run's own.
  it('marks the notes its driver writes as the driver\'s', async () => {
    config({ multiModel: true, skillsRepos: [] });
    vi.mocked(runHarnessDriver).mockImplementation(async (host) => {
      host.emit({ type: 'note', message: 'advisor council produced no result (401 Unauthorized)' });
      return null;
    });
    const run = manager.startRun(workflow, { task: 'Fix issue #642' });
    await vi.waitFor(() => expect(['review', 'failed', 'done']).toContain(store.getRun(run.id)?.status), { timeout: 10_000 });
    const quoted = store.readEvents(run.id).find((event) => event.type === 'note' && String(event.message).includes('advisor council'));
    expect(quoted?.origin).toBe('driver');
  }, 15_000);

  it('never gives a recorded harness run permission to land in the checkout', async () => {
    config({ multiModel: true, taskWorkspace: 'in-place', landing: 'auto' });
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, {
      worktree: false, status: 'review',
      harness: { profile: 'standard', workflow: workflow.name, issueId: '642' },
    });
    writeFileSync(join(root, 'unreviewed.txt'), 'must remain uncommitted\n');
    const before = git('rev-parse', 'HEAD');
    expect(await manager.land(run.id)).toMatchObject({ outcome: 'unavailable' });
    expect(git('rev-parse', 'HEAD')).toBe(before);
    expect(store.getRun(run.id)?.status).toBe('review');
  });

  it('fails before the driver can write when no isolated worktree can exist', async () => {
    rmSync(join(root, '.git'), { recursive: true, force: true });
    const run = manager.startRun(workflow, { task: 'Fix issue #642' });
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('failed'));
    expect(store.getRun(run.id)?.error).toContain('isolated git worktree');
    expect(runHarnessDriver).not.toHaveBeenCalled();
  });

  it('refuses a multi-model start when native model settings are locked', () => {
    config({ multiModel: true, modelsLocked: true });
    expect(() => manager.startRun(workflow, { task: 'Fix issue #642' })).toThrow(/model selection.*unlocked/i);
    expect(store.listRuns()).toEqual([]);
  });

  it('refuses a multi-model resume when native model settings are locked', async () => {
    config({ multiModel: true, modelsLocked: true });
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, { status: 'failed', workflowDef: workflow, harness: { profile: 'standard', workflow: workflow.name, issueId: '642' } });
    expect(manager.continueRun(run.id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(store.getRun(run.id)?.error).toMatch(/model selection.*unlocked/i), { timeout: 15_000 });
    expect(runHarnessDriver).not.toHaveBeenCalled();
  });

  it('rejects read-only harness starts before creating a run', () => {
    expect(() => manager.startRun(workflow, { task: 'Fix issue #642', readOnly: true })).toThrow(/isolated git worktree|read-only/);
    expect(store.listRuns()).toEqual([]);
    expect(runHarnessDriver).not.toHaveBeenCalled();
  });

  it.each([{}, { multiModel: false }, { multiModel: 'true' }])('blocks new harness starts unless explicitly enabled (%j)', (value) => {
    config(value);
    expect(() => manager.startRun(workflow, { task: 'Fix issue #642' })).toThrow(/multiModel/);
    expect(store.listRuns()).toEqual([]);
  });

  // harness identity is the built-in, so a user's file under its name stays theirs.
  it('keeps a user workflow file under a harness name as an ordinary workflow when disabled', async () => {
    config({ multiModel: false });
    mkdirSync(join(root, '.ai/cezar/workflows'), { recursive: true });
    writeFileSync(join(root, '.ai/cezar/workflows/custom.yaml'), `name: ${HARNESS_FIX_ISSUE}\nsteps:\n  - id: run\n    prompt: '{{task}}'\n`);
    const catalog = await loadWorkflows(root);
    expect(catalog.workflows.find((item) => item.name === HARNESS_FIX_ISSUE)).toMatchObject({ source: 'file', steps: [{ id: 'run' }] });
  });

  it('recovers a disabled harness with its private runtime and required companion skills', async () => {
    config({ multiModel: false, skillsRepos: [] });
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, { status: 'failed', workflowDef: workflow, harness: { profile: 'standard', workflow: workflow.name, issueId: '642' } });
    let installed = false;
    vi.mocked(runHarnessDriver).mockImplementation(async (host) => {
      installed = await host.ensureSkill('cez-setup-harness');
      expect(existsSync(join(host.cwd, '.claude/skills/cez-setup-harness/SKILL.md'))).toBe(true);
      expect(existsSync(join(host.cwd, '.claude/skills/cez-harness/scripts/harness.mjs'))).toBe(true);
      return null;
    });

    expect(manager.continueRun(run.id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('done'), { timeout: 10_000 });
    expect(installed).toBe(true);
    expect(runHarnessDriver).toHaveBeenCalledOnce();
  }, 15_000);

  it('reconsiders a no-action outcome when Continue brings new evidence', () => {
    manager.dispose();
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, { status: 'done', workflowDef: workflow, harness: { profile: 'standard', workflow: workflow.name } });
    const ledger = createLedger({ workflow: workflow.name, requestedProfile: 'standard', subject: { kind: 'issue', id: '642', text: 'Fix issue #642' } });
    ledger.outcome = { status: 'no-action', blockingReasons: [] };
    saveLedger(join(root, '.ai/cezar'), run.id, ledger);

    expect(manager.continueRun(run.id, { text: 'New evidence reproduces the defect.' })).toEqual({ ok: true });

    expect(store.getRun(run.id)?.status).toBe('queued');
    expect(loadLedger(join(root, '.ai/cezar'), run.id)?.pendingMessages).toEqual([
      expect.objectContaining({ text: 'New evidence reproduces the defect.' }),
    ]);
    expect(store.getRun(run.id)?.steps).toEqual([]);
  });

  it.each(['failed', 'cancelled', 'review', 'done'] as const)('resumes a %s harness through its ledger while disabled', (status) => {
    manager.dispose();
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    config({ multiModel: false });
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [{ id: 'implement', kind: 'agent', name: 'Implement' }] });
    store.updateRun(run.id, { status, workflowDef: workflow, harness: { profile: 'standard', workflow: workflow.name, issueId: '642' } });
    store.updateStep(run.id, 'implement', { status: status === 'review' ? 'done' : status, sessionId: 'must-not-resume-model' });
    expect(manager.continueRun(run.id, { text: 'Complete the verified handoff.' })).toEqual({ ok: true });
    expect(store.getRun(run.id)?.status).toBe('queued');
    expect(store.getRun(run.id)?.steps.find((step) => step.id === 'implement')?.status).toBe(status === 'failed' || status === 'cancelled' ? 'pending' : 'done');
    expect(store.getRun(run.id)?.steps.some((step) => step.id.startsWith('continue-'))).toBe(false);
  });
});
