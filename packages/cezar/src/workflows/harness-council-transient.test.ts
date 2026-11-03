import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, RunnerId } from '../core/agent-runner.ts';
import { MAX_TRANSIENT_RETRIES } from '../core/agent-failure-class.ts';
import { councilDecisionDetail, loadLedger, saveLedger } from '../harness/ledger.ts';
import { createModelProber } from '../harness/probe.ts';
import * as probeTransports from '../harness/probe-transports.ts';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE, HARNESS_IMPLEMENT_FEATURE } from '../harness/workflows.ts';
import { RunStore } from '../runs/store.ts';
import * as profiles from '../workspace/agent-profiles.ts';
import { RunManager } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

const model = vi.hoisted(() => ({
  calls: [] as Array<{ phase: string; runner: RunnerId; timeoutMs?: number }>,
  behavior: (_phase: string, _runner: RunnerId, _spec: AgentRunSpec): string | null | undefined => undefined,
}));
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (runner: RunnerId) => ({
    startSession: (spec: AgentRunSpec, emit: (event: AgentEvent) => void) => {
      let open = true;
      let finish: () => void = () => {};
      const result = new Promise<AgentRunResult>((resolve) => {
        finish = () => { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
        setTimeout(() => {
          const resultPath = spec.env?.CEZ_HARNESS_RESULT_FILE;
          if (!resultPath) {
            emit({ type: 'session', sessionId: 'ordinary-session' });
            emit({ type: 'text', text: 'CEZ:DONE' });
            emit({ type: 'turn-end' });
            finish();
            return;
          }
          const phase = basename(dirname(resultPath)).replace(/^phase-/, '').replace(/-r\d+$/, '');
          model.calls.push({ phase, runner, timeoutMs: spec.timeoutMs });
          emit({ type: 'session', sessionId: `test-${model.calls.length}` });
          const failure = model.behavior(phase, runner, spec);
          if (failure) {
            emit({ type: 'error', message: failure });
          } else if (failure === undefined) {
            let value: unknown;
            if (phase === 'qualify') value = { outcome: 'work_needed', evidence: 'reproduced' };
            else if (phase === 'diagnose') value = { summary: 'bug', files: ['a.txt'] };
            else if (phase === 'spec') {
              mkdirSync(join(spec.cwd, '.ai/specs'), { recursive: true });
              writeFileSync(join(spec.cwd, '.ai/specs/test.md'), '# Specification\n');
              value = { summary: 'spec', specPath: '.ai/specs/test.md', files: ['.ai/specs/test.md'] };
            } else if (phase === 'implement') {
              writeFileSync(join(spec.cwd, 'a.txt'), 'fixed\n');
              value = { changedPaths: ['a.txt'], suggestedCommit: 'fix: bug' };
            } else value = { verdict: 'approve', findings: [] };
            writeFileSync(resultPath!, JSON.stringify(value));
          }
          emit({ type: 'turn-end' });
          finish();
        }, 0);
      });
      return { result, get open() { return open; }, sendMessage: () => true, end: finish, interrupt: finish };
    },
  }),
}));

const TRANSIENT = 'stream disconnected before completion: upstream closed';
const LIMIT = 'Claude AI usage limit reached|1890000000';
const roles = {
  orchestrator: { runner: 'claude' as const, model: 'sonnet' },
  implementer: { runner: 'claude' as const, model: 'sonnet' },
  reviewers: [{ runner: 'claude' as const, model: 'opus' }, { runner: 'harness' as const, model: 'local-advisor', family: 'openai' }],
};
const councils = [
  { workflow: HARNESS_FIX_ISSUE, phase: 'review', kind: 'implementation' as const },
  { workflow: HARNESS_IMPLEMENT_FEATURE, phase: 'spec-review', kind: 'spec' as const },
];

describe('council transient retries', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  const dataDir = () => join(root, '.ai/cezar');
  const ledger = (id: string) => loadLedger(dataDir(), id)!;
  const advisorFailure = (message: string | null | undefined) => writeFileSync(join(dataDir(), 'model-mode'), message === null ? 'invalid-json' : message ?? '');
  const counts = (phase: string) => [
    model.calls.filter((call) => call.phase === phase && call.runner === 'claude').length,
    readFileSync(join(dataDir(), 'model-calls'), 'utf8').split('\n').filter((entry) => entry === phase).length,
  ];
  const settled = async (id: string) => {
    await expect.poll(() => !manager.isActive(id) && ['failed', 'review', 'done', 'cancelled'].includes(store.getRun(id)?.status ?? ''),
      { timeout: 20_000 }).toBe(true);
  };
  const fire = (id: string) => {
    const scheduler = manager as unknown as {
      autoResumeTimers: Map<string, ReturnType<typeof setTimeout>>;
      fireAutoResume(id: string): void;
    };
    clearTimeout(scheduler.autoResumeTimers.get(id));
    scheduler.fireAutoResume(id);
  };
  const start = (workflow: string, withCouncil = true) => manager.startRun(
    harnessWorkflowDefs().find((item) => item.name === workflow)!,
    { task: 'Fix issue #642', runner: 'claude', harness: {
      profile: 'standard', skillProfile: 'generic', issueId: '642', ...(withCouncil ? { roles } : {}),
    } },
  );
  const decide = (id: string, kind: 'council.proceed' | 'council.retry') => {
    const saved = ledger(id);
    const pending = saved.outcome.pendingDecision;
    expect(pending?.kind).toBe('council');
    if (pending?.kind !== 'council') throw new Error('missing council decision');
    saved.decisions.push({ at: new Date().toISOString(), kind, by: 'user', detail: councilDecisionDetail(pending) });
    saveLedger(dataDir(), id, saved);
  };

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    model.calls.length = 0;
    model.behavior = () => undefined;
    root = mkdtempSync(join(tmpdir(), 'cez-council-transient-'));
    mkdirSync(dataDir(), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), '.ai/cezar/\n');
    writeFileSync(join(root, 'a.txt'), 'base\n');
    writeFileSync(join(dataDir(), 'model-calls'), '');
    advisorFailure(undefined);
    const advisorScript = join(dataDir(), 'model.mjs');
    writeFileSync(advisorScript, `
      import { appendFileSync, readFileSync } from 'node:fs';
      const control = process.argv[2];
      let prompt = '';
      process.stdin.on('data', (chunk) => { prompt += chunk; });
      process.stdin.on('end', () => {
        appendFileSync(control + '/model-calls', (prompt.includes('SPECIFICATION') ? 'spec-review' : 'review') + '\\n');
        const failure = readFileSync(control + '/model-mode', 'utf8');
        if (failure === 'invalid-json') console.log('invalid result');
        else if (failure) { console.error(failure); process.exitCode = 1; }
        else console.log(JSON.stringify({ verdict: 'approve', findings: [], notes: [] }));
      });
    `);
    writeFileSync(join(root, '.ai/agentic.config.json'), JSON.stringify({
      baseBranch: 'main', validation: { commands: ['node -e "process.exit(0)"'] },
      agentHarness: { version: 1, delivery: { mode: 'stage-only' }, models: {
        'local-advisor': { adapter: 'command', family: 'openai', model: 'test-advisor', roles: ['reviewer'],
          commands: { review: [process.execPath, advisorScript, dataDir()] } },
      } },
    }));
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
    writeFileSync(join(dataDir(), 'config.json'), JSON.stringify({ multiModel: true, skillsRepos: [], branchNaming: { enabled: false } }));
    vi.spyOn(probeTransports, 'createProjectProber').mockImplementation(async () =>
      createModelProber({ transport: async () => ({ status: 'ready', detail: 'test model' }) }));
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

  it('guard: harness phase timeout options retain their existing inactivity windows', async () => {
    const run = start(HARNESS_FIX_ISSUE, false);
    await settled(run.id);
    expect(model.calls.map(({ phase, timeoutMs }) => [phase, timeoutMs])).toEqual([
      ['qualify', 20 * 60_000], ['diagnose', 45 * 60_000], ['implement', 3 * 60 * 60_000], ['review', 30 * 60_000],
    ]);
    expect(store.getRun(run.id)?.status, store.getRun(run.id)?.error).toBe('review');
  }, 40_000);

  it.each(councils)('$kind: the automatic retry actually runs both reviewers and continues', async ({ workflow, phase }) => {
    let failing = true;
    model.behavior = (id) => id === phase && failing ? TRANSIENT : undefined;
    advisorFailure(TRANSIENT);
    const run = start(workflow);
    await settled(run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', autoResumeReason: 'transient', error: expect.stringContaining(TRANSIENT) });
    expect(counts(phase)).toEqual([2, 2]);
    const firstReviewer = { ...ledger(run.id).invocations.find((entry) => entry.id.startsWith('reviewer:'))! };
    failing = false;
    advisorFailure(undefined);
    fire(run.id);
    await settled(run.id);
    expect(counts(phase)).toEqual([3, 3]);
    expect(firstReviewer).toMatchObject({ status: 'interrupted', attempt: 1, error: TRANSIENT });
    expect(store.getRun(run.id)?.status, store.getRun(run.id)?.error).toBe('review');
    expect(ledger(run.id).outcome.status).toBe('ready');
  }, 40_000);

  it.each(councils)('$kind: exhausted attempts retain the prior failure in the run and pending decision', async ({ workflow, phase }) => {
    model.behavior = (id) => id === phase ? 'review result rejected by contract' : undefined;
    advisorFailure('review result rejected by contract');
    const run = start(workflow);
    await settled(run.id);
    const saved = ledger(run.id);
    saved.invocations.find((entry) => entry.id.startsWith('advisor:'))!.error = 'permanent advisor failure';
    saveLedger(dataDir(), run.id, saved);
    manager.continueRun(run.id, {});
    await settled(run.id);
    expect(counts(phase)).toEqual([2, 2]);
    expect(store.getRun(run.id)?.error).toContain('review result rejected by contract');
    expect(ledger(run.id).outcome.pendingDecision).toMatchObject({
      failed: [{ label: 'claude/opus', reason: 'review result rejected by contract' }, { label: 'harness/local-advisor', reason: 'permanent advisor failure' }],
    });
  }, 40_000);

  it.each(councils)('$kind: transient forever stops at the automatic retry cap with the real cause', async ({ workflow, phase }) => {
    model.behavior = (id) => id === phase ? TRANSIENT : undefined;
    advisorFailure(TRANSIENT);
    const run = start(workflow);
    await settled(run.id);
    for (let retry = 0; retry < MAX_TRANSIENT_RETRIES; retry += 1) {
      expect(store.getRun(run.id)?.autoResumeAt).toBeDefined();
      fire(run.id);
      await settled(run.id);
    }
    expect(counts(phase)).toEqual([6, 6]);
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', autoResumeAttempts: MAX_TRANSIENT_RETRIES, error: expect.stringContaining(TRANSIENT) });
    expect(store.getRun(run.id)?.autoResumeAt).toBeUndefined();
    expect(ledger(run.id).outcome.pendingDecision).toMatchObject({ failed: [expect.objectContaining({ reason: expect.stringContaining(TRANSIENT) }), expect.objectContaining({ reason: expect.stringContaining(TRANSIENT) })] });
    expect(store.readEvents(run.id).map((event) => event.message)).toContain(
      'the provider is still failing after 2 automatic retries — continue this task manually');
  }, 40_000);

  it.each(councils)('guard: $kind contract failures stay charged until an explicit retry', async ({ workflow, phase }) => {
    model.behavior = (id) => id === phase ? null : undefined;
    advisorFailure(null);
    const run = start(workflow);
    await settled(run.id);
    expect(counts(phase)).toEqual([2, 2]);
    manager.continueRun(run.id, {});
    await settled(run.id);
    expect(counts(phase)).toEqual([2, 2]);
    expect(ledger(run.id).invocations.filter((entry) => entry.role === 'reviewer')).toEqual([
      expect.objectContaining({ status: 'failed', attempt: 2 }), expect.objectContaining({ status: 'failed', attempt: 2 }),
    ]);
    decide(run.id, 'council.retry');
    model.behavior = () => undefined;
    advisorFailure(undefined);
    manager.continueRun(run.id, {});
    await settled(run.id);
    expect(counts(phase)).toEqual([3, 3]);
    expect(store.getRun(run.id)?.status, store.getRun(run.id)?.error).toBe('review');
  }, 40_000);

  it.each(councils)('guard: $kind usage limits spend no attempt and resume after the window', async ({ workflow, phase }) => {
    model.behavior = (id) => id === phase ? LIMIT : undefined;
    advisorFailure(LIMIT);
    const run = start(workflow);
    await settled(run.id);
    expect(counts(phase)).toEqual([1, 1]);
    expect(ledger(run.id).invocations.filter((entry) => entry.role === 'reviewer').every((entry) => entry.status === 'interrupted' && entry.attempt === 1)).toBe(true);
    model.behavior = () => undefined;
    advisorFailure(undefined);
    manager.continueRun(run.id, {});
    await settled(run.id);
    expect(counts(phase)).toEqual([2, 2]);
    expect(store.getRun(run.id)?.status, store.getRun(run.id)?.error).toBe('review');
  }, 40_000);

  it.each(councils)('guard: $kind proceed with survivors never buys the transient reviewer another attempt', async ({ workflow, phase }) => {
    model.behavior = (id, runner) => id === phase && runner === 'claude' ? TRANSIENT : undefined;
    const run = start(workflow);
    await settled(run.id);
    expect(counts(phase)).toEqual([2, 1]);
    decide(run.id, 'council.proceed');
    manager.continueRun(run.id, {});
    await settled(run.id);
    expect(counts(phase)).toEqual([2, 1]);
    expect(store.getRun(run.id)?.status, store.getRun(run.id)?.error).toBe('review');
  }, 40_000);

  it.each(councils)('$kind: manager recovery reloads the persisted transient council', async ({ workflow, phase }) => {
    model.behavior = (id) => id === phase ? TRANSIENT : undefined;
    advisorFailure(TRANSIENT);
    const run = start(workflow);
    await settled(run.id);
    manager.dispose();
    manager = new RunManager(store, root);
    await manager.recover();
    model.behavior = () => undefined;
    advisorFailure(undefined);
    fire(run.id);
    await settled(run.id);
    expect(counts(phase)).toEqual([3, 3]);
    expect(store.getRun(run.id)?.status, store.getRun(run.id)?.error).toBe('review');
  }, 40_000);

  it.each(councils)('$kind: both transports retry transient failures persisted as failed by older drivers', async ({ workflow, phase }) => {
    model.behavior = (id) => id === phase ? 'contract rejection' : undefined;
    advisorFailure('contract rejection');
    const run = start(workflow);
    await settled(run.id);
    const saved = ledger(run.id);
    for (const invocation of saved.invocations.filter((entry) => entry.role === 'reviewer')) {
      invocation.error = TRANSIENT;
      expect(invocation).toMatchObject({ status: 'failed', attempt: 2 });
    }
    saveLedger(dataDir(), run.id, saved);
    model.behavior = () => undefined;
    advisorFailure(undefined);
    manager.continueRun(run.id, {});
    await settled(run.id);
    expect(counts(phase)).toEqual([3, 3]);
    expect(store.getRun(run.id)?.status, store.getRun(run.id)?.error).toBe('review');
  }, 40_000);

  it.each(councils)('guard: $kind recovery interrupts live invocations and reuses the unspent attempt', async ({ workflow, phase }) => {
    model.behavior = (id) => id === phase ? 'contract rejection' : undefined;
    advisorFailure('contract rejection');
    const run = start(workflow);
    await settled(run.id);
    const saved = ledger(run.id);
    for (const invocation of saved.invocations.filter((entry) => entry.role === 'reviewer')) {
      invocation.status = 'running';
      invocation.endedAt = undefined;
    }
    saveLedger(dataDir(), run.id, saved);
    model.behavior = () => undefined;
    advisorFailure(undefined);
    manager.continueRun(run.id, {});
    await settled(run.id);
    expect(counts(phase)).toEqual([3, 3]);
    expect(store.readEvents(run.id).some((event) => event.type === 'harness.invocation.updated' &&
      (event.invocation as { error?: string } | undefined)?.error?.startsWith('recovered after the prior Cezar process'))).toBe(true);
    expect(store.getRun(run.id)?.status, store.getRun(run.id)?.error).toBe('review');
  }, 40_000);

  it.each(councils)('guard: $kind a mutation failure stays charged on a no-decision Continue', async ({ workflow, phase }) => {
    model.behavior = (id) => id === phase ? 'contract rejection' : undefined;
    advisorFailure('contract rejection');
    const run = start(workflow);
    await settled(run.id);
    const saved = ledger(run.id);
    for (const invocation of saved.invocations.filter((entry) => entry.role === 'reviewer')) {
      invocation.error = 'reviewer mutated the worktree or index';
    }
    saveLedger(dataDir(), run.id, saved);
    manager.continueRun(run.id, {});
    await settled(run.id);
    expect(counts(phase)).toEqual([2, 2]);
    expect(ledger(run.id).invocations.filter((entry) => entry.role === 'reviewer').every((entry) => entry.status === 'failed' && entry.attempt === 2)).toBe(true);
  }, 40_000);

  it.each(councils)('guard: $kind a demoted completed artifact still spends its attempts', async ({ workflow, phase }) => {
    model.behavior = (id) => id === phase ? 'contract rejection' : undefined;
    advisorFailure('contract rejection');
    const run = start(workflow);
    await settled(run.id);
    const saved = ledger(run.id);
    for (const invocation of saved.invocations.filter((entry) => entry.role === 'reviewer')) {
      invocation.status = 'interrupted';
      invocation.artifactSha256 = 'hash-from-the-completed-attempt';
      invocation.error = TRANSIENT;
    }
    saveLedger(dataDir(), run.id, saved);
    manager.continueRun(run.id, {});
    await settled(run.id);
    expect(counts(phase)).toEqual([2, 2]);
  }, 40_000);

  it('guard: an ordinary run with multiModel off never enters the harness', async () => {
    writeFileSync(join(dataDir(), 'config.json'), JSON.stringify({ multiModel: false, skillsRepos: [] }));
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'Finish the task', runner: 'claude', worktree: false });
    await settled(run.id);
    expect(store.getRun(run.id)?.status).toMatch(/^(done|review)$/);
    expect(store.getRun(run.id)?.harness).toBeUndefined();
    expect(loadLedger(dataDir(), run.id)).toBeNull();
    expect(model.calls).toEqual([]);
  }, 40_000);

  it('guard: a sequential phase still interrupts a provider failure without spending a contract attempt', async () => {
    model.behavior = (phase) => phase === 'diagnose' ? TRANSIENT : undefined;
    const run = start(HARNESS_FIX_ISSUE, false);
    await settled(run.id);
    expect(ledger(run.id).invocations.find((entry) => entry.phaseId === 'diagnose')).toMatchObject({ role: 'host', status: 'interrupted', attempt: 1, error: TRANSIENT });
    model.behavior = () => undefined;
    advisorFailure(undefined);
    fire(run.id);
    await settled(run.id);
    expect(model.calls.filter((call) => call.phase === 'diagnose')).toHaveLength(2);
    expect(store.getRun(run.id)?.status, store.getRun(run.id)?.error).toBe('review');
  }, 40_000);
});
