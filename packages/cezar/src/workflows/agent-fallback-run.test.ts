import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cezarHomeDir } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import { putAgentFallbackPolicy, type AgentFallbackPolicy } from '../workspace/agent-fallback.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Automatic agent fallback through the real engine (spec 2026-10-20-agent-usage-limit-fallback).
 * The trigger is the bundled mock's `mock:limit` reply — Claude Code's own exhaustion envelope.
 * The successor is a second Claude ACCOUNT, because that is a distinct budget the dry run can drive.
 */
describe('automatic agent fallback', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  const workflow: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }] };

  async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const settled = (id: string) => ['done', 'review', 'failed', 'cancelled'].includes(store.getRun(id)?.status ?? '');
  const messages = (id: string) => store.readEvents(id).map((event) => String(event.message ?? ''));

  function registerAccounts(ids: string[]): void {
    const home = cezarHomeDir();
    mkdirSync(home, { recursive: true });
    const accounts = ids.map((id) => {
      const configDir = join(home, `claude-${id}`);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, '.claude.json'), '{}');
      return { id, provider: 'claude', configDir, label: id === 'second' ? 'Second' : id, addedAt: '2026-10-21T00:00:00.000Z' };
    });
    writeFileSync(join(home, 'agent-accounts.json'), JSON.stringify({ version: 1, accounts, selections: {}, defaults: {} }));
  }

  async function enable(candidates: AgentFallbackPolicy['candidates']): Promise<AgentFallbackPolicy> {
    const saved = await putAgentFallbackPolicy(repoRoot, { expectedRevision: 0, expectedIncarnation: null, enabled: true, candidates });
    if ('conflict' in saved) throw new Error('conflict');
    return saved;
  }

  beforeEach(async () => {
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_LIMIT_RESET_SECONDS = process.env.CEZ_MOCK_LIMIT_RESET_SECONDS;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-fallback-run-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    rmSync(join(cezarHomeDir(), 'agent-fallback.json'), { force: true });
    rmSync(join(cezarHomeDir(), 'agent-usage-holds'), { recursive: true, force: true });
    rmSync(join(cezarHomeDir(), 'agent-accounts.json'), { force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (manager) {
      for (const { id } of store.listRuns()) manager.cancel(id);
      await until(() => store.listRuns().every(({ id }) => !manager?.isActive(id)), 'runs to stop');
      manager.dispose();
      manager = undefined;
    }
    await store.flush?.();
    rmSync(join(cezarHomeDir(), 'agent-usage-holds'), { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('hands an exhausted task to the next configured account, in the same run, and holds the exhausted account', async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    manager = new RunManager(store, repoRoot);
    const states: Array<{ status: string; pending?: boolean }> = [];
    store.on('run', (record) => states.push({ status: record.status, pending: record.fallbackEpisode?.pending }));
    const started = manager.startRun(workflow, { task: 'fix the bug mock:limit', worktree: false });
    await until(() => (store.getRun(started.id)?.fallbackEpisode?.current !== undefined), 'fallback to reserve its successor');
    const record = store.getRun(started.id);
    expect(record?.agentProfile).toBe('second');
    expect(states.some((state) => state.status === 'failed')).toBe(false);
    expect(states).toContainEqual({ status: 'queued', pending: true });
    expect(record?.fallbackEpisode?.attempted).toEqual(['claude:default', 'claude:second']);
    expect(record?.usageLimitHolds?.map((hold) => hold.account)).toEqual(['claude:default']);
    expect(record?.autoResumeAt).toBeUndefined();
    expect(messages(started.id)).toContain('claude · Default reached its usage limit — claude · Second · auto model continues this task');
    expect(manager.accountHolds().deadline.has('claude:default')).toBe(true);
    expect(store.listRuns()).toHaveLength(1);
  }, 40_000);

  it('uses the project checkout default and retains it across fallback after the trunk-based merge', async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ taskWorkspace: 'in-place', landing: 'manual' }));
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(workflow, { task: 'mock:limit' });
    await until(() => store.getRun(started.id)?.fallbackEpisode?.current !== undefined, 'checkout fallback reserved');
    const record = store.getRun(started.id)!;
    expect(record.worktree).toBe(false);
    expect(record.worktreePath).toBeUndefined();
    expect(record.agentProfile).toBe('second');
    expect(record.steps.some((step) => step.id === record.fallbackEpisode?.current?.stepId)).toBe(true);
    expect(record.landing).toBeUndefined();
    expect(store.listRuns()).toHaveLength(1);
    expect((await run('git', ['branch', '--show-current'], { cwd: repoRoot })).stdout.trim()).toBe('main');
  }, 40_000);

  it('stops with one clear reason when no configured agent can continue, and never returns to the starting agent', async () => {
    registerAccounts([]);
    // Listing the starting agent itself and a removed account: both must be skipped, not used.
    await enable([{ provider: 'claude', profileId: 'default' }, { provider: 'claude', profileId: 'removed' }]);
    manager = new RunManager(store, repoRoot);
    const states: string[] = [];
    store.on('run', (record) => states.push(record.status));
    const started = manager.startRun(workflow, { task: 'mock:limit', worktree: false });
    await until(() => messages(started.id).some((m) => m.startsWith('no fallback agent could continue')), 'exhaustion summary');
    const record = store.getRun(started.id);
    expect(record?.status).toBe('failed');
    expect(states.filter((status) => status === 'failed')).toHaveLength(1);
    expect(record?.autoResumeAt).toBeUndefined();
    expect(record?.steps.some((step) => step.id.startsWith('continue-'))).toBe(false);
    expect(messages(started.id)).toContain("fallback skipped claude · removed — account no longer exists");
    const summary = store.readEvents(started.id).find((e) => String(e.message ?? '').startsWith('no fallback agent could continue'));
    expect(summary?.tone).toBe('danger');
  }, 40_000);

  it('leaves the zero-config path untouched: no policy means the reset-time auto-resume, exactly as before', async () => {
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(workflow, { task: 'mock:limit', worktree: false });
    await until(() => settled(started.id), 'run to fail');
    await until(() => store.getRun(started.id)?.autoResumeAt !== undefined, 'auto-resume to arm');
    expect(store.getRun(started.id)?.fallbackEpisode).toBeUndefined();
    expect(store.getRun(started.id)?.fallbackPolicy).toBeUndefined();
  }, 40_000);

  it('keeps graph workflows on the reset-time auto-resume even with fallback enabled', async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    manager = new RunManager(store, repoRoot);
    const { getAgentFallbackPolicy } = await import('../workspace/agent-fallback.ts');
    const graphRun = store.createRun({ title: 'g', workflow: 'graph', task: 't', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    store.updateRun(graphRun.id, {
      status: 'failed',
      error: 'Claude AI usage limit reached|' + String(Math.floor(Date.now() / 1000) + 3600),
      fallbackPolicy: await getAgentFallbackPolicy(repoRoot),
      workflowDef: { name: 'graph', source: 'built-in', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }], graph: { start: 'work', nodes: { work: { step: 'work' } } } } as unknown as WorkflowDef,
    });
    store.updateStep(graphRun.id, 'work', { status: 'failed', sessionId: 'sess-1' });
    (manager as unknown as { scheduleAutoResumeIfLimited(id: string): void }).scheduleAutoResumeIfLimited(graphRun.id);
    expect(store.getRun(graphRun.id)?.fallbackEpisode).toBeUndefined();
    expect(store.getRun(graphRun.id)?.autoResumeAt).toBeDefined();
  }, 40_000);

  it('does not switch providers on a transient rate limit', async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    manager = new RunManager(store, repoRoot);
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    const snapshot = await import('../workspace/agent-fallback.ts').then((m) => m.getAgentFallbackPolicy(repoRoot));
    store.updateRun(record.id, { status: 'failed', error: 'rate_limit_error: exceeded your per-minute rate limit', fallbackPolicy: snapshot, workflowDef: workflow });
    store.updateStep(record.id, 'work', { status: 'failed', sessionId: 'sess-1' });
    (manager as unknown as { scheduleAutoResumeIfLimited(id: string): void }).scheduleAutoResumeIfLimited(record.id);
    expect(store.getRun(record.id)?.fallbackEpisode).toBeUndefined();
    expect(store.getRun(record.id)?.runner).toBe('claude');
  });

  it('a run created before the policy existed never picks it up later', async () => {
    manager = new RunManager(store, repoRoot);
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    store.updateRun(record.id, { status: 'failed', error: 'Claude AI usage limit reached|' + String(Math.floor(Date.now() / 1000) + 3600), workflowDef: workflow });
    store.updateStep(record.id, 'work', { status: 'failed', sessionId: 'sess-1' });
    (manager as unknown as { scheduleAutoResumeIfLimited(id: string): void }).scheduleAutoResumeIfLimited(record.id);
    expect(store.getRun(record.id)?.fallbackEpisode).toBeUndefined();
    expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();
  });

  it('re-queues a reserved sessionless successor after a restart instead of restarting the workflow', async () => {
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    store.addStep(record.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    store.updateStep(record.id, 'work', { status: 'failed' });
    store.updateRun(record.id, {
      status: 'queued',
      workflowDef: workflow,
      fallbackEpisode: { attempted: ['codex:default', 'claude:default'], current: { key: 'claude:default', stepId: 'continue-1' } },
    });
    manager = new RunManager(store, repoRoot);
    await manager.recover();
    expect(messages(record.id).some((m) => m.endsWith('interrupted continuation re-queued'))).toBe(true);
    expect(store.getRun(record.id)?.steps.map((step) => step.id)).toEqual(['work', 'continue-1']);
  }, 40_000);

  const LIMIT = () => 'Claude AI usage limit reached|' + String(Math.floor(Date.now() / 1000) + 3600);
  const decide = (id: string) =>
    (manager as unknown as { scheduleAutoResumeIfLimited(id: string): void }).scheduleAutoResumeIfLimited(id);
  async function failedRun(patch: Record<string, unknown>, step: Record<string, unknown> = {}) {
    const { getAgentFallbackPolicy } = await import('../workspace/agent-fallback.ts');
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    store.updateRun(record.id, { status: 'failed', error: LIMIT(), workflowDef: workflow, fallbackPolicy: await getAgentFallbackPolicy(repoRoot), ...patch });
    store.updateStep(record.id, 'work', { status: 'failed', sessionId: 'sess-1', ...step });
    return record.id;
  }

  it("switches on Claude's everyday session-limit message", async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    manager = new RunManager(store, repoRoot);
    const id = await failedRun({ error: "You've hit your session limit · resets 3:10pm (UTC)" });
    decide(id);
    await until(() => store.getRun(id)?.fallbackEpisode?.current !== undefined, 'successor reserved');
    expect(store.getRun(id)?.agentProfile).toBe('second');
  }, 40_000);

  it('moves to the next agent when a successor fails before doing anything, even with its session id pinned', async () => {
    registerAccounts(['second', 'third']);
    await enable([{ provider: 'claude', profileId: 'second' }, { provider: 'claude', profileId: 'third' }]);
    manager = new RunManager(store, repoRoot);
    const id = await failedRun({ error: 'Claude account "Second" is not signed in.' });
    store.addStep(id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    store.updateStep(id, 'continue-1', { status: 'failed', sessionId: 'pinned-up-front', backend: 'claude', profileId: 'second' });
    store.updateRun(id, {
      runner: 'claude', agentProfile: 'second',
      fallbackEpisode: { attempted: ['claude:default', 'claude:second'], current: { key: 'claude:second', stepId: 'continue-1' } },
    });
    decide(id);
    await until(() => store.getRun(id)?.agentProfile === 'third', 'third account takes over');
    expect(messages(id).some((m) => m.startsWith('claude · Second could not start'))).toBe(true);
  }, 40_000);

  it('skips a provider the user disabled in Settings instead of sending it the task', async () => {
    writeFileSync(join(cezarHomeDir(), 'config.json'), JSON.stringify({ disabledProviders: ['opencode'] }));
    await enable([{ provider: 'opencode', profileId: 'default' }]);
    manager = new RunManager(store, repoRoot);
    const id = await failedRun({});
    decide(id);
    await until(() => messages(id).some((m) => m.startsWith('no fallback agent could continue')), 'exhaustion');
    expect(messages(id)).toContain('fallback skipped opencode · Default — provider is disabled in Settings');
    expect(store.getRun(id)?.runner).toBe('claude');
    rmSync(join(cezarHomeDir(), 'config.json'), { force: true });
  }, 40_000);

  it('identifies the starting agent by the account that actually ran, not the run-level override', async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }, { provider: 'claude', profileId: 'default' }]);
    manager = new RunManager(store, repoRoot);
    // The project selected `second`; the run itself records no override.
    const id = await failedRun({}, { backend: 'claude', profileId: 'second' });
    decide(id);
    await until(() => store.getRun(id)?.fallbackEpisode?.current !== undefined, 'successor reserved');
    expect(store.getRun(id)?.fallbackEpisode?.attempted).toEqual(['claude:second', 'claude:default']);
    expect(store.getRun(id)?.usageLimitHolds?.map((hold) => hold.account)).toEqual(['claude:second']);
    expect(messages(id)).toContain('fallback skipped claude · Second — it is the agent that just reached its limit');
  }, 40_000);

  it('does not launch a successor after the manager is disposed during admission', async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    manager = new RunManager(store, repoRoot);
    const id = await failedRun({});
    decide(id);
    manager.dispose();
    await until(() => !(manager as unknown as { fallbackPending: Set<string> }).fallbackPending.has(id), 'admission exits');
    expect(store.getRun(id)?.status).toBe('queued');
    expect(store.getRun(id)?.fallbackEpisode?.pending).toBe(true);
    expect(store.getRun(id)?.steps).toHaveLength(1);
  });

  it('does not treat a successor failure after tool use as a failure to start', async () => {
    registerAccounts(['second', 'third']);
    await enable([{ provider: 'claude', profileId: 'third' }]);
    manager = new RunManager(store, repoRoot);
    const id = await failedRun({ error: 'command failed' });
    store.addStep(id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    store.updateStep(id, 'continue-1', { status: 'failed', sessionId: 's', backend: 'claude', profileId: 'second' });
    store.updateRun(id, { fallbackEpisode: { attempted: ['claude:default', 'claude:second'], current: { key: 'claude:second', stepId: 'continue-1' } } });
    store.appendEvent(id, { type: 'tool', stepId: 'continue-1', name: 'Bash' });
    decide(id);
    expect(store.getRun(id)?.steps).toHaveLength(2);
    expect((manager as unknown as { fallbackPending: Set<string> }).fallbackPending.has(id)).toBe(false);
  });

  it('skips a named account removed while its successor was queued, without using the default login', async () => {
    registerAccounts(['third']);
    await enable([{ provider: 'claude', profileId: 'second' }, { provider: 'claude', profileId: 'third' }]);
    const id = await failedRun({});
    store.addStep(id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    store.updateRun(id, {
      status: 'queued', agentProfile: 'second',
      fallbackEpisode: { attempted: ['claude:default', 'claude:second'], current: { key: 'claude:second', stepId: 'continue-1' } },
    });
    manager = new RunManager(store, repoRoot);
    await manager.recover();
    await until(() => store.getRun(id)?.agentProfile === 'third', 'removed account skipped at spawn');
    expect(store.getRun(id)?.steps.find((step) => step.id === 'continue-1')?.error).toBe('fallback account no longer exists');
    expect(messages(id).some((message) => message.includes('could not start'))).toBe(true);
  }, 40_000);

  it('keeps a revoked pending selection stopped across repeated recovery', async () => {
    registerAccounts(['second']);
    const policy = await enable([{ provider: 'claude', profileId: 'second' }]);
    const id = await failedRun({ status: 'queued', fallbackEpisode: { pending: true, attempted: ['claude:default'] } });
    await putAgentFallbackPolicy(repoRoot, { expectedRevision: policy.revision, expectedIncarnation: policy.incarnation, enabled: false, candidates: policy.candidates });
    manager = new RunManager(store, repoRoot);
    await manager.recover();
    expect(store.getRun(id)?.status).toBe('failed');
    expect(store.getRun(id)?.autoResumeAt).toBeUndefined();
    manager.dispose();
    manager = new RunManager(store, repoRoot);
    await manager.recover();
    expect(store.getRun(id)?.autoResumeAt).toBeUndefined();
  });

  it('preserves ordinary reset-time resume when consent was revoked before a later failure', async () => {
    registerAccounts(['second']);
    const policy = await enable([{ provider: 'claude', profileId: 'second' }]);
    const id = await failedRun({});
    await putAgentFallbackPolicy(repoRoot, { expectedRevision: policy.revision, expectedIncarnation: policy.incarnation, enabled: false, candidates: policy.candidates });
    manager = new RunManager(store, repoRoot);
    decide(id);
    expect(store.getRun(id)?.autoResumeAt).toBeDefined();
    expect(store.getRun(id)?.fallbackEpisode).toBeUndefined();
  });

  it('retains exhausted-account holds after deleting the completed task and restarting', async () => {
    const untilAt = Date.now() + 3600000;
    const id = await failedRun({ status: 'done', runner: 'codex', error: undefined, usageLimitHolds: [{ account: 'claude:default', until: new Date(untilAt).toISOString() }] });
    manager = new RunManager(store, repoRoot);
    expect(manager.accountHolds().deadline.has('claude:default')).toBe(true);
    store.deleteRun(id);
    expect(manager.accountHolds().deadline.has('claude:default')).toBe(true);
    manager.dispose();
    manager = new RunManager(store, repoRoot);
    expect(manager.accountHolds().deadline.has('claude:default')).toBe(true);
    expect(manager.accountHolds(untilAt + 1).deadline.has('claude:default')).toBe(false);
  });

  it('restores the expiry wakeup after the source task was deleted', async () => {
    const id = await failedRun({ status: 'done', error: undefined, usageLimitHolds: [{ account: 'claude:default', until: new Date(Date.now() + 10000).toISOString() }] });
    manager = new RunManager(store, repoRoot);
    store.deleteRun(id);
    manager.dispose();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      manager = new RunManager(store, repoRoot);
      const pump = vi.spyOn(manager as unknown as { pump(): Promise<void> }, 'pump').mockResolvedValue(undefined);
      vi.advanceTimersByTime(12000);
      expect(pump).toHaveBeenCalledTimes(1);
      expect(manager.accountHolds().deadline.has('claude:default')).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it.each(['revoke', 'dispose'] as const)('refuses fallback launch after %s during environment preparation', async (action) => {
    registerAccounts(['second']);
    const policy = await enable([{ provider: 'claude', profileId: 'second' }]);
    manager = new RunManager(store, repoRoot);
    let captured: { sessionEverOpened?: boolean } | undefined;
    let completed = false;
    const internal = manager as any;
    const originalContinuation = internal.runContinuation.bind(manager);
    vi.spyOn(internal, 'runContinuation').mockImplementation(async (...args) => {
      try { return await originalContinuation(...args); }
      finally { completed = true; }
    });
    const originalEnv = internal.agentEnvForStep.bind(manager);
    let id: string;
    vi.spyOn(internal, 'agentEnvForStep').mockImplementation(async (...args) => {
      const result = await originalEnv(...args);
      captured = internal.active.get(id);
      if (action === 'dispose') manager!.dispose();
      else await putAgentFallbackPolicy(repoRoot, {
        expectedRevision: policy.revision, expectedIncarnation: policy.incarnation,
        enabled: false, candidates: policy.candidates,
      });
      return result;
    });
    id = await failedRun({});
    decide(id);
    await until(() => completed || captured?.sessionEverOpened === true, 'continuation preparation settled');
    expect(captured).toBeDefined();
    expect(captured!.sessionEverOpened ?? false).toBe(false);
    if (action === 'revoke') {
      expect(store.getRun(id)?.status).toBe('failed');
      expect(store.getRun(id)?.error).toContain('switched off');
      expect(store.getRun(id)?.autoResumeAt).toBeUndefined();
    }
  }, 40_000);

  it('recovers a queued selection without restarting the original workflow', async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    const id = await failedRun({ status: 'queued', fallbackEpisode: { pending: true, attempted: ['claude:default'] } });
    manager = new RunManager(store, repoRoot);
    await manager.recover();
    await until(() => store.getRun(id)?.agentProfile === 'second', 'queued selection recovers');
    expect(store.getRun(id)?.steps.map((step) => step.id)).toEqual(['work', 'continue-1']);
    expect(store.getRun(id)?.steps[0]?.status).toBe('failed');
    expect(store.getRun(id)?.fallbackEpisode?.pending).toBeUndefined();
  });

  it.each(['cancel', 'disable'] as const)('honours %s while the provider check is pending', async (action) => {
    registerAccounts(['second']);
    const policy = await enable([{ provider: 'claude', profileId: 'second' }]);
    manager = new RunManager(store, repoRoot);
    let release!: (value: string | null) => void;
    const gate = new Promise<string | null>((resolve) => { release = resolve; });
    const check = vi.spyOn(manager as unknown as { fallbackProviderRefusal(): Promise<string | null> }, 'fallbackProviderRefusal').mockReturnValue(gate);
    const id = await failedRun({});
    decide(id);
    await until(() => check.mock.calls.length > 0, 'provider check starts');
    expect(store.getRun(id)?.status).toBe('queued');
    expect(manager.isActive(id)).toBe(true);
    await manager.rescueStalledQueue();
    expect(store.getRun(id)?.steps).toHaveLength(1);
    expect(check).toHaveBeenCalledTimes(1);
    if (action === 'cancel') expect(manager.cancel(id)).toBe(true);
    else await putAgentFallbackPolicy(repoRoot, { expectedRevision: policy.revision, expectedIncarnation: policy.incarnation, enabled: false, candidates: policy.candidates });
    release(null);
    await until(() => !(manager as unknown as { fallbackPending: Set<string> }).fallbackPending.has(id), 'selection settles');
    expect(store.getRun(id)?.status).toBe(action === 'cancel' ? 'cancelled' : 'failed');
    expect(store.getRun(id)?.steps).toHaveLength(1);
    expect(store.getRun(id)?.fallbackEpisode?.pending).toBeUndefined();
  });

  it('settles an unexpected admission error instead of remaining queued', async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    manager = new RunManager(store, repoRoot);
    vi.spyOn(manager as unknown as { fallbackProviderRefusal(): Promise<string | null> }, 'fallbackProviderRefusal').mockRejectedValue(new Error('probe failed'));
    const id = await failedRun({});
    decide(id);
    await until(() => store.getRun(id)?.fallbackEpisode?.done === true, 'admission failure settles');
    expect(store.getRun(id)?.status).toBe('failed');
    expect(store.getRun(id)?.error).toBe('automatic fallback failed — probe failed');
    expect(store.getRun(id)?.fallbackEpisode?.pending).toBeUndefined();
  });

  it('finishes an admission a restart interrupted, without reusing an agent it had already tried', async () => {
    registerAccounts(['second', 'third']);
    await enable([{ provider: 'claude', profileId: 'second' }, { provider: 'claude', profileId: 'third' }]);
    const id = await failedRun({ fallbackEpisode: { attempted: ['claude:default', 'claude:second'] } });
    manager = new RunManager(store, repoRoot);
    await manager.recover();
    await until(() => store.getRun(id)?.agentProfile === 'third', 'third account takes over after restart');
  }, 40_000);
});
