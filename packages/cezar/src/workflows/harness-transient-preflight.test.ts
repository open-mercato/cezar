import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRANSIENT_RETRIES } from '../core/agent-failure-class.ts';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { ledgerPath, loadLedger } from '../harness/ledger.ts';
import { createModelProber } from '../harness/probe.ts';
import * as probeTransports from '../harness/probe-transports.ts';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE } from '../harness/workflows.ts';
import { reportAgentError } from '../runs/agent-error-telemetry.ts';
import { RunStore } from '../runs/store.ts';
import * as profiles from '../workspace/agent-profiles.ts';
import { RunManager } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

const OVERLOAD = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const model = vi.hoisted(() => ({ phases: [] as string[] }));
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    startSession: (spec: AgentRunSpec, emit: (event: AgentEvent) => void) => {
      let open = true;
      let finish: () => void = () => {};
      const result = new Promise<AgentRunResult>((resolve) => {
        finish = () => { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
        setTimeout(() => {
          const resultPath = spec.env?.CEZ_HARNESS_RESULT_FILE;
          if (!resultPath) {
            emit({ type: 'error', message: OVERLOAD });
          } else {
            const phase = basename(dirname(resultPath)).replace(/^phase-/, '').replace(/-r\d+$/, '');
            model.phases.push(phase);
            emit({ type: 'session', sessionId: `phase-${model.phases.length}` });
            let value: unknown;
            if (phase === 'qualify') value = { outcome: 'work_needed', evidence: 'reproduced' };
            else if (phase === 'diagnose') value = { summary: 'bug', files: ['a.txt'] };
            else if (phase === 'implement') {
              writeFileSync(join(spec.cwd, 'a.txt'), 'fixed\n');
              value = { changedPaths: ['a.txt'], suggestedCommit: 'fix: bug' };
            } else value = { verdict: 'approve', findings: [] };
            writeFileSync(resultPath, JSON.stringify(value));
          }
          emit({ type: 'turn-end' });
          finish();
        }, 0);
      });
      return { result, get open() { return open; }, sendMessage: () => true, end: finish, interrupt: finish };
    },
  }),
}));
vi.mock('../runs/agent-error-telemetry.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reportAgentError: vi.fn(),
}));

const workflow = harnessWorkflowDefs().find((item) => item.name === HARNESS_FIX_ISSUE)!;
describe('harness transient preflight retry', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let probeFails: boolean;
  let probeAttempts: (number | undefined)[];
  const dataDir = () => join(root, '.ai/cezar');
  const internals = () => manager as unknown as {
    autoResumeTimers: Map<string, ReturnType<typeof setTimeout>>;
    fireAutoResume(id: string): void;
    scheduleAutoResumeIfLimited(id: string): void;
    semaphore: { autoResumeOnUsageLimit(): boolean };
  };
  const start = () => manager.startRun(workflow, {
    task: 'Fix issue #642', runner: 'claude',
    harness: { profile: 'standard', skillProfile: 'generic', issueId: '642' },
  });
  const settled = async (id: string) => {
    await expect.poll(() => !manager.isActive(id)
      && ['failed', 'review', 'done', 'cancelled'].includes(store.getRun(id)?.status ?? ''),
    { timeout: 20_000 }).toBe(true);
  };
  const fire = (id: string) => {
    clearTimeout(internals().autoResumeTimers.get(id));
    internals().fireAutoResume(id);
  };
  const messages = (id: string) => store.readEvents(id).map((event) => String(event.message ?? ''));
  const deferredReports = () => vi.mocked(reportAgentError).mock.calls
    .map((call) => call[2]).filter((opts) => opts !== undefined);
  const expectNoSession = (id: string) => {
    expect(store.getRun(id)?.steps.some((step) => step.sessionId)).toBe(false);
    expect(model.phases).toEqual([]);
  };

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.mocked(reportAgentError).mockClear();
    model.phases.length = 0;
    probeFails = true;
    probeAttempts = [];
    root = mkdtempSync(join(tmpdir(), 'cez-harness-preflight-'));
    mkdirSync(dataDir(), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), '.ai/cezar/\n');
    writeFileSync(join(root, 'a.txt'), 'base\n');
    writeFileSync(join(root, '.ai/agentic.config.json'), JSON.stringify({
      baseBranch: 'main', validation: { commands: ['node -e "process.exit(0)"'] },
      agentHarness: { version: 1, delivery: { mode: 'stage-only' } },
    }));
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
    writeFileSync(join(dataDir(), 'config.json'), JSON.stringify({
      multiModel: true, skillsRepos: [], branchNaming: { enabled: false },
    }));
    vi.spyOn(probeTransports, 'createProjectProber').mockImplementation(async () => {
      probeAttempts.push(store.listRuns().find((run) => run.harness)?.autoResumeAttempts);
      return createModelProber({ transport: async () => probeFails
        ? { status: 'failed', detail: OVERLOAD }
        : { status: 'ready', detail: 'test model' } });
    });
    vi.spyOn(profiles, 'resolveProfileEnvForRoot').mockImplementation(async (_, provider) => ({
      profile: profiles.defaultAgentProfile(provider), env: {},
    }));
    store = RunStore.open(dataDir());
    manager = new RunManager(store, root);
  });

  afterEach(async () => {
    for (const run of store.listRuns()) manager.cancel(run.id);
    await expect.poll(() => store.listRuns().some((run) => manager.isActive(run.id)), { timeout: 10_000 }).toBe(false);
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('retries a 529 before the first session, re-probes, and completes through the real runtime', async () => {
    const run = start();
    await settled(run.id);
    expectNoSession(run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', autoResumeReason: 'transient' });
    expect(store.getRun(run.id)?.error).toContain('unverified or unreachable host model');
    expect(store.getRun(run.id)?.error).toContain(OVERLOAD);
    expect(internals().autoResumeTimers.has(run.id)).toBe(true);
    expect(messages(run.id)).toContainEqual(expect.stringMatching(
      new RegExp(`temporary provider failure — retrying automatically at .*\\(1/${MAX_TRANSIENT_RETRIES}\\)$`),
    ));
    expect(loadLedger(dataDir(), run.id)?.phases.find((phase) => phase.id === 'preflight')?.status).toBe('failed');
    expect(deferredReports()).toEqual([]);

    probeFails = false;
    fire(run.id);
    await settled(run.id);

    expect(probeAttempts).toEqual([undefined, 1]);
    expect(model.phases).toEqual(['qualify', 'diagnose', 'implement', 'review']);
    expect(store.getRun(run.id)?.harness?.profile).toBe('standard');
    expect(store.getRun(run.id), messages(run.id).join('\n')).toMatchObject({ status: 'review', error: undefined, autoResumeAttempts: undefined });
    expect(store.getRun(run.id)?.autoResumeAt).toBeUndefined();
    expect(internals().autoResumeTimers.has(run.id)).toBe(false);
    expect(loadLedger(dataDir(), run.id)).toMatchObject({
      phases: expect.arrayContaining([expect.objectContaining({ id: 'preflight', status: 'done' })]),
      stage: { status: 'staged', stagedPaths: ['a.txt'] }, pendingMessages: [],
    });
    expect(deferredReports()).toEqual([]);
  }, 60_000);

  it('stops a permanently overloaded probe at the transient cap with its real cause', async () => {
    const run = start();
    await settled(run.id);
    for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      expect(store.getRun(run.id)?.autoResumeAt).toBeDefined();
      expect(internals().autoResumeTimers.has(run.id)).toBe(true);
      fire(run.id);
      await settled(run.id);
      expect(store.getRun(run.id)?.autoResumeAttempts).toBe(attempt);
    }

    expectNoSession(run.id);
    expect(probeAttempts).toEqual([undefined, ...Array.from({ length: MAX_TRANSIENT_RETRIES }, (_, i) => i + 1)]);
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', autoResumeAttempts: MAX_TRANSIENT_RETRIES });
    expect(store.getRun(run.id)?.error).toContain('unverified or unreachable host model');
    expect(store.getRun(run.id)?.error).toContain(OVERLOAD);
    expect(store.getRun(run.id)?.autoResumeAt).toBeUndefined();
    expect(internals().autoResumeTimers.has(run.id)).toBe(false);
    expect(messages(run.id)).toContain(
      `the provider is still failing after ${MAX_TRANSIENT_RETRIES} automatic retries — continue this task manually`,
    );
    expect(deferredReports()).toEqual([{ transientOutcome: 'retries_exhausted' }]);
  }, 60_000);

  it('restores a pre-session retry after restart and resumes from the same ledger', async () => {
    const run = start();
    await settled(run.id);
    expectNoSession(run.id);
    const deadline = store.getRun(run.id)?.autoResumeAt;
    expect(deadline).toBeDefined();
    const ledger = loadLedger(dataDir(), run.id)!;
    manager.dispose();
    store.flush({ throwOnError: true });
    store = RunStore.open(dataDir(), { keepLive: true });
    manager = new RunManager(store, root);
    await manager.recover();

    expect(store.getRun(run.id)?.autoResumeAt).toBe(deadline);
    expect(internals().autoResumeTimers.has(run.id)).toBe(true);
    expect(loadLedger(dataDir(), run.id)).toEqual(ledger);
    probeFails = false;
    fire(run.id);
    await settled(run.id);
    expect(probeAttempts).toEqual([undefined, 1]);
    expect(store.getRun(run.id), messages(run.id).join('\n')).toMatchObject({ status: 'review', error: undefined });
    expect(loadLedger(dataDir(), run.id)?.pendingMessages).toEqual([]);
  }, 60_000);

  it('guard: an ordinary multiModel-off runner failure retains its assigned session and retries', async () => {
    writeFileSync(join(dataDir(), 'config.json'), JSON.stringify({ multiModel: false, skillsRepos: [], branchNaming: { enabled: false } }));
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'ordinary task', runner: 'claude', worktree: false });
    await settled(run.id);
    expect(store.getRun(run.id)?.steps.find((step) => step.id === 'task')).toMatchObject({ sessionId: expect.any(String) });
    expect(model.phases).toEqual([]);
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', error: `step "task" failed: ${OVERLOAD}` });
    expect(store.getRun(run.id)?.harness).toBeUndefined();
    expect(store.getRun(run.id)?.autoResumeAt).toBeDefined();
    expect(internals().autoResumeTimers.has(run.id)).toBe(true);
    expect(deferredReports()).toEqual([]);
  }, 30_000);

  it('guard: an ordinary multiModel-off failure record without a session still reports not_retried', () => {
    writeFileSync(join(dataDir(), 'config.json'), JSON.stringify({ multiModel: false, skillsRepos: [] }));
    const run = store.createRun({
      title: 'ordinary task', workflow: QUICK_TASK_WORKFLOW.name, task: 'ordinary task', runner: 'claude',
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
    store.updateRun(run.id, { status: 'failed', error: OVERLOAD, workflowDef: QUICK_TASK_WORKFLOW });

    internals().scheduleAutoResumeIfLimited(run.id);

    expectNoSession(run.id);
    expect(store.getRun(run.id)?.harness).toBeUndefined();
    expect(store.getRun(run.id)?.autoResumeAt).toBeUndefined();
    expect(internals().autoResumeTimers.has(run.id)).toBe(false);
    expect(deferredReports()).toEqual([{ transientOutcome: 'not_retried' }]);
    expect(manager.continueRun(run.id)).toEqual({ ok: false, error: 'no agent session to resume' });
  });

  it('guard: a recovered pre-session timer reports resume_refused for a corrupt ledger', async () => {
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, {
      status: 'failed', error: OVERLOAD, workflowDef: workflow,
      harness: { profile: 'standard', workflow: workflow.name, issueId: '642' },
      autoResumeAt: new Date(Date.now() + 60_000).toISOString(), autoResumeReason: 'transient',
    });
    mkdirSync(dirname(ledgerPath(dataDir(), run.id)), { recursive: true });
    writeFileSync(ledgerPath(dataDir(), run.id), '{invalid');
    await manager.recover();
    expect(internals().autoResumeTimers.has(run.id)).toBe(true);

    fire(run.id);

    expectNoSession(run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', error: OVERLOAD });
    expect(store.getRun(run.id)?.autoResumeAt).toBeUndefined();
    expect(internals().autoResumeTimers.has(run.id)).toBe(false);
    expect(messages(run.id)).toContainEqual(expect.stringContaining('automatic resume could not start — harness ledger is corrupt:'));
    expect(deferredReports()).toEqual([{ transientOutcome: 'resume_refused' }]);
  });

  it.each(['archived', 'switch off'])('guard: a harness preflight failure is not retried with %s', async (refusal) => {
    if (refusal === 'switch off') vi.spyOn(internals().semaphore, 'autoResumeOnUsageLimit').mockReturnValue(false);
    const run = start();
    if (refusal === 'archived') store.updateRun(run.id, { archived: true });
    await settled(run.id);

    expectNoSession(run.id);
    expect(store.getRun(run.id)?.status).toBe('failed');
    expect(store.getRun(run.id)?.error).toContain(OVERLOAD);
    expect(store.getRun(run.id)?.autoResumeAt).toBeUndefined();
    expect(internals().autoResumeTimers.has(run.id)).toBe(false);
    // An archived run is resigned before failure classification (main's scheduleAutoResumeIfLimited).
    expect(deferredReports()).toEqual(refusal === 'archived' ? [] : [{ transientOutcome: 'not_retried' }]);
    expect(messages(run.id).some((message) => message.includes('retrying automatically'))).toBe(false);
  }, 30_000);
});
