import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cezarHomeDir } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import { managerFallbackPolicy, putAgentFallbackPolicy, setManagerTaskAccountsLookup, type AgentFallbackPolicy } from '../workspace/agent-fallback.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager, setFallbackProviderCheck } from './run.ts';
import { managerAccountLimit } from '../managers/account-limit.ts';
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
    setFallbackProviderCheck(undefined);
    setManagerTaskAccountsLookup(undefined);
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

  it('returns a fallback successor to the native effort instead of carrying the previous choice', async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(workflow, { task: 'fix the bug mock:limit', worktree: false });
    // The dry run only drives Claude's exhaustion, so the Codex selection is seeded on the record.
    store.updateRun(started.id, { reasoningEffort: 'high' });
    await until(() => (store.getRun(started.id)?.fallbackEpisode?.current !== undefined), 'fallback to reserve its successor');
    const record = store.getRun(started.id);
    expect(record?.reasoningEffort).toBeUndefined();
    expect(record?.steps.find((step) => step.id === record.fallbackEpisode?.current?.stepId)?.reasoningEffort).toBeUndefined();
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

  describe('a manager-started task falls back within the manager’s allowed accounts', () => {
    const startedByManager = { id: 'm1', name: 'Coding Manager' };

    it('moves to the next allowed account with capacity, with project fallback off, and records why', async () => {
      registerAccounts(['second']);
      manager = new RunManager(store, repoRoot);
      const started = manager.startRun(workflow, {
        task: 'fix the bug mock:limit', worktree: false, startedByManager,
        managerAgent: { note: 'Agent chosen by manager Coding Manager: claude · Default — default from manager settings', fallback: [{ provider: 'claude', profileId: 'second' }] },
      });
      expect(store.getRun(started.id)?.fallbackPolicy).toMatchObject({ enabled: true, source: 'manager' });
      await until(() => store.getRun(started.id)?.fallbackEpisode?.current !== undefined, 'manager fallback to reserve its successor');
      const record = store.getRun(started.id);
      expect(record?.agentProfile).toBe('second');
      expect(store.listRuns()).toHaveLength(1);
      expect(messages(started.id)).toContain('Agent chosen by manager Coding Manager: claude · Default — default from manager settings');
      expect(messages(started.id)).toContain('claude · Default reached its usage limit — claude · Second · auto model continues this task');
    }, 40_000);

    it('keeps the reset-time auto-resume when every other allowed account is out of limits', async () => {
      registerAccounts(['second']);
      manager = new RunManager(store, repoRoot);
      // `second` is already waiting out its own limit.
      const first = manager.startRun(workflow, { task: 'mock:limit', worktree: false, agentProfile: 'second' });
      await until(() => store.getRun(first.id)?.autoResumeAt !== undefined, 'second account held');
      expect(manager.accountHolds().deadline.has('claude:second')).toBe(true);
      const started = manager.startRun(workflow, {
        task: 'mock:limit', worktree: false, startedByManager,
        managerAgent: { note: 'chosen', fallback: [{ provider: 'claude', profileId: 'second' }] },
      });
      await until(() => store.getRun(started.id)?.autoResumeAt !== undefined, 'auto-resume to arm');
      expect(store.getRun(started.id)?.fallbackEpisode).toBeUndefined();
      expect(store.getRun(started.id)?.status).toBe('failed');
    }, 40_000);

    it('keeps the reset-time auto-resume when the only other allowed account is signed out', async () => {
      registerAccounts(['second']);
      setFallbackProviderCheck(async (_provider, profileId) => (profileId === 'second' ? 'not signed in' : null));
      manager = new RunManager(store, repoRoot);
      const started = manager.startRun(workflow, {
        task: 'mock:limit', worktree: false, startedByManager,
        managerAgent: { note: 'chosen', fallback: [{ provider: 'claude', profileId: 'second' }] },
      });
      await until(() => store.getRun(started.id)?.autoResumeAt !== undefined, 'auto-resume to arm');
      const record = store.getRun(started.id);
      expect(record?.status).toBe('failed');
      expect(record?.agentProfile).toBeUndefined();
      expect(messages(started.id)).toContain('fallback skipped claude · Second — not signed in');
      expect(messages(started.id).some((m) => m.startsWith('no fallback agent could continue'))).toBe(false);
      expect(messages(started.id).some((m) => m.startsWith('usage limit reached — resuming automatically'))).toBe(true);
    }, 40_000);

    it('reports the account limit under the key the queue holds, named and automatic accounts alike', async () => {
      registerAccounts(['second']);
      manager = new RunManager(store, repoRoot);
      const named = manager.startRun(workflow, { task: 'mock:limit', worktree: false, agentProfile: 'second' });
      const automatic = manager.startRun(workflow, { task: 'mock:limit', worktree: false });
      await until(() => Boolean(store.getRun(named.id)?.autoResumeAt && store.getRun(automatic.id)?.autoResumeAt), 'both accounts held');
      const holds = () => manager!.accountHolds();
      const second = await managerAccountLimit(holds, 'claude', 'second', repoRoot);
      expect(second).toMatchObject({ account: 'second', label: 'Second' });
      expect(second.until).toBe(holds().deadlines?.get('claude:second'));
      expect(second.until).toBeGreaterThan(Date.now());
      const discovered = await managerAccountLimit(holds, 'claude', undefined, repoRoot);
      expect(discovered).toMatchObject({ account: 'default', label: 'default account' });
      expect(discovered.until).toBeGreaterThan(Date.now());
      expect(await managerAccountLimit(holds, 'codex', undefined, repoRoot)).not.toHaveProperty('until');
    }, 40_000);

    const managerTask = (fallback: Array<{ provider: 'claude' | 'opencode'; profileId: string; model?: string }>, task = 'mock:limit') => manager!.startRun(workflow, {
      task, worktree: false, startedByManager, managerAgent: { note: 'chosen', fallback },
    });
    const resumesAtReset = async (id: string) => {
      await until(() => store.getRun(id)?.autoResumeAt !== undefined, 'auto-resume to arm');
      expect(store.getRun(id)?.status).toBe('failed');
      expect(store.getRun(id)?.agentProfile).toBeUndefined();
      expect(messages(id).some((m) => m.startsWith('no fallback agent could continue'))).toBe(false);
    };

    it('keeps the reset-time auto-resume when the only other allowed account was deleted', async () => {
      registerAccounts([]);
      manager = new RunManager(store, repoRoot);
      const started = managerTask([{ provider: 'claude', profileId: 'default' }, { provider: 'claude', profileId: 'removed' }]);
      await resumesAtReset(started.id);
      // The removed account was never started on: no continuation, and the run still names no account.
      const record = store.getRun(started.id)!;
      expect(record.steps.some((step) => step.id.startsWith('continue-'))).toBe(false);
      expect(record.fallbackEpisode?.current).toBeUndefined();
      expect(messages(started.id).some((m) => m.includes('· removed') && m.includes('continues this task'))).toBe(false);
    }, 40_000);

    it('a list holding only the task’s own account waits for the reset, never claims a fallback', async () => {
      manager = new RunManager(store, repoRoot);
      const started = managerTask([{ provider: 'claude', profileId: 'default' }]);
      await resumesAtReset(started.id);
      expect(store.getRun(started.id)?.fallbackEpisode).toBeUndefined();
    }, 40_000);

    it('keeps the reset-time auto-resume when the only other allowed account is on a disabled provider', async () => {
      writeFileSync(join(cezarHomeDir(), 'config.json'), JSON.stringify({ disabledProviders: ['opencode'] }));
      try {
        manager = new RunManager(store, repoRoot);
        const started = managerTask([{ provider: 'opencode', profileId: 'default' }]);
        await resumesAtReset(started.id);
        expect(messages(started.id)).toContain('fallback skipped opencode · Default — provider is disabled in Settings');
      } finally {
        rmSync(join(cezarHomeDir(), 'config.json'), { force: true });
      }
    }, 40_000);

    it('a same-runner fallback keeps the model the manager asked for', async () => {
      registerAccounts(['second']);
      manager = new RunManager(store, repoRoot);
      const started = managerTask([{ provider: 'claude', profileId: 'second', model: 'opus' }], 'fix the bug mock:limit');
      await until(() => store.getRun(started.id)?.fallbackEpisode?.current !== undefined, 'successor reserved');
      expect(store.getRun(started.id)).toMatchObject({ agentProfile: 'second', model: 'opus' });
      expect(messages(started.id)).toContain('claude · Default reached its usage limit — claude · Second · opus continues this task');
    }, 40_000);

    it('is withdrawn when the manager is deleted after the task started', async () => {
      registerAccounts(['second']);
      setManagerTaskAccountsLookup(() => null);
      manager = new RunManager(store, repoRoot);
      await resumesAtReset(managerTask([{ provider: 'claude', profileId: 'second' }]).id);
    }, 40_000);

    it('skips an account the manager removed from its list after the task started', async () => {
      registerAccounts(['second']);
      setManagerTaskAccountsLookup((id) => (id === 'm1' ? [{ runner: 'claude', agentProfile: 'default' }] : null));
      manager = new RunManager(store, repoRoot);
      const started = managerTask([{ provider: 'claude', profileId: 'second' }]);
      await resumesAtReset(started.id);
      // The pre-check already sees the current list, so fallback never claims the failure.
      expect(store.getRun(started.id)?.fallbackEpisode).toBeUndefined();
    }, 40_000);

    it('a bare { runner } left in the list is the default account only, so a removed named account is not a target', async () => {
      registerAccounts(['second']);
      setManagerTaskAccountsLookup(() => [{ runner: 'claude' }]);
      manager = new RunManager(store, repoRoot);
      const started = managerTask([{ provider: 'claude', profileId: 'second' }]);
      await resumesAtReset(started.id);
      expect(store.getRun(started.id)?.fallbackEpisode).toBeUndefined();
    }, 40_000);

    it('still falls back while the account is in the manager’s current list', async () => {
      registerAccounts(['second']);
      setManagerTaskAccountsLookup(() => [{ runner: 'claude', agentProfile: 'default' }, { runner: 'claude', agentProfile: 'second' }]);
      manager = new RunManager(store, repoRoot);
      const started = managerTask([{ provider: 'claude', profileId: 'second' }]);
      await until(() => store.getRun(started.id)?.fallbackEpisode?.current !== undefined, 'successor reserved');
      expect(store.getRun(started.id)?.agentProfile).toBe('second');
    }, 40_000);

    it('a dispatched child keeps the manager policy, never the project one', async () => {
      registerAccounts(['second']);
      await enable([{ provider: 'claude', profileId: 'second' }]);
      manager = new RunManager(store, repoRoot);
      for (const fallback of [[{ provider: 'claude' as const, profileId: 'second' }], []]) {
        const parent = manager.startRun(workflow, { task: 'mock:monitoring waiting on my tasks', startedByManager, managerAgent: { note: 'chosen', fallback } });
        store.updateRun(parent.id, { dispatch: { rootRunId: parent.id } });
        await until(() => store.getRun(parent.id)?.activity === 'monitoring', 'parent parked');
        const child = manager.dispatch(parent.id, { objective: 'mock:done child' });
        if ('refused' in child) throw new Error(child.refused);
        const policy = store.getRun(child.id)?.fallbackPolicy;
        expect(policy).toEqual(store.getRun(parent.id)?.fallbackPolicy);
        expect(policy).toMatchObject({ source: 'manager', managerId: 'm1', enabled: fallback.length > 0 });
      }
    }, 40_000);

    it('a dispatched child with its own model keeps it on a same-runner fallback, not the parent’s', async () => {
      registerAccounts(['second']);
      manager = new RunManager(store, repoRoot);
      const parent = manager.startRun(workflow, {
        task: 'mock:monitoring waiting on my tasks', model: 'opus', startedByManager,
        managerAgent: { note: 'chosen', fallback: [{ provider: 'claude', profileId: 'second', model: 'opus' }] },
      });
      store.updateRun(parent.id, { dispatch: { rootRunId: parent.id } });
      await until(() => store.getRun(parent.id)?.activity === 'monitoring', 'parent parked');
      const own = manager.dispatch(parent.id, { objective: 'mock:done child', model: 'sonnet' });
      if ('refused' in own) throw new Error(own.refused);
      expect(store.getRun(own.id)?.fallbackPolicy?.candidates).toEqual([{ provider: 'claude', profileId: 'second', model: 'sonnet' }]);
      // A child that names no model inherits the parent's on the same runner, and its fallback with it.
      const inherited = manager.dispatch(parent.id, { objective: 'mock:done child two' });
      if ('refused' in inherited) throw new Error(inherited.refused);
      expect(store.getRun(inherited.id)?.model).toBe('opus');
      expect(store.getRun(inherited.id)?.fallbackPolicy?.candidates).toEqual([{ provider: 'claude', profileId: 'second', model: 'opus' }]);
    }, 40_000);

    it('a child on another listed account falls back to the parent’s account, never to itself', async () => {
      registerAccounts(['second']);
      manager = new RunManager(store, repoRoot);
      const parent = manager.startRun(workflow, {
        task: 'mock:monitoring waiting on my tasks', startedByManager,
        managerAgent: { note: 'chosen', fallback: [{ provider: 'claude', profileId: 'default' }, { provider: 'claude', profileId: 'second' }] },
      });
      store.updateRun(parent.id, { dispatch: { rootRunId: parent.id } });
      await until(() => store.getRun(parent.id)?.activity === 'monitoring', 'parent parked');
      const child = manager.dispatch(parent.id, { objective: 'fix the bug mock:limit', account: 'second' });
      if ('refused' in child) throw new Error(child.refused);
      await until(() => store.getRun(child.id)?.fallbackEpisode?.current !== undefined, 'child successor reserved');
      expect(store.getRun(child.id)?.agentProfile).toBe('default');
      expect(store.getRun(child.id)?.fallbackEpisode?.attempted).toEqual(['claude:second', 'claude:default']);
      expect(messages(child.id)).toContain('claude · Second reached its usage limit — claude · Default · auto model continues this task');
      // The manager list holds the child's own account; skipping it is expected, so no note says so.
      expect(messages(child.id).some((m) => m.includes('it is the agent that just reached its limit'))).toBe(false);
    }, 40_000);

    it('a child’s copy: its own model on its runner, the engine-checked model on another runner', async () => {
      manager = new RunManager(store, repoRoot);
      const parent = manager.startRun(workflow, {
        task: 'mock:monitoring waiting on my tasks', model: 'opus', startedByManager,
        managerAgent: { note: 'chosen', fallback: [
          { provider: 'claude', profileId: 'default', model: 'opus' },
          { provider: 'codex', profileId: 'default', model: 'gpt-5.1-codex' },
          { provider: 'opencode', profileId: 'default' },
        ] },
      });
      store.updateRun(parent.id, { dispatch: { rootRunId: parent.id } });
      await until(() => store.getRun(parent.id)?.activity === 'monitoring', 'parent parked');
      const child = manager.dispatch(parent.id, { objective: 'mock:done child', model: 'sonnet' });
      if ('refused' in child) throw new Error(child.refused);
      expect(store.getRun(child.id)?.fallbackPolicy?.candidates).toEqual([
        { provider: 'claude', profileId: 'default', model: 'sonnet' },
        { provider: 'codex', profileId: 'default', model: 'gpt-5.1-codex' },
        { provider: 'opencode', profileId: 'default' },
      ]);
    }, 40_000);

    it('a child on another runner than its parent: the parent’s model stays on parent-runner entries, the child’s on its own', async () => {
      manager = new RunManager(store, repoRoot);
      const parent = manager.startRun(workflow, {
        task: 'mock:monitoring waiting on my tasks', model: 'opus', startedByManager,
        managerAgent: { note: 'chosen', fallback: [
          { provider: 'claude', profileId: 'default', model: 'opus' },
          { provider: 'codex', profileId: 'default' },
          { provider: 'codex', profileId: 'team', model: 'gpt-5.1-codex' },
        ] },
      });
      store.updateRun(parent.id, { dispatch: { rootRunId: parent.id } });
      await until(() => store.getRun(parent.id)?.activity === 'monitoring', 'parent parked');
      const child = manager.dispatch(parent.id, { objective: 'mock:done child', runner: 'codex', model: 'gpt-5.1-codex-mini' });
      if ('refused' in child) throw new Error(child.refused);
      expect(store.getRun(child.id)).toMatchObject({ runner: 'codex', model: 'gpt-5.1-codex-mini' });
      expect(store.getRun(child.id)?.fallbackPolicy?.candidates).toEqual([
        { provider: 'claude', profileId: 'default', model: 'opus' },
        { provider: 'codex', profileId: 'default', model: 'gpt-5.1-codex-mini' },
        { provider: 'codex', profileId: 'team', model: 'gpt-5.1-codex-mini' },
      ]);
    }, 40_000);

    it('the limit a manager sees is the semaphore’s merged deadline under the queue’s own key', async () => {
      registerAccounts(['second']);
      const semaphore = new WorkspaceSemaphore();
      manager = new RunManager(store, repoRoot, { semaphore });
      const named = manager.startRun(workflow, { task: 'mock:limit', worktree: false, agentProfile: 'second' });
      await until(() => store.getRun(named.id)?.autoResumeAt !== undefined, 'second held');
      const own = manager.accountHolds().deadlines!.get('claude:second')!;
      expect((await managerAccountLimit(() => semaphore.accountHolds(), 'claude', 'second', repoRoot)).until).toBe(own);
      // Another project holding the same account resets sooner: the earliest reset wins.
      const sooner = Date.now() + 60_000;
      const off = semaphore.register({
        busy: () => 0, pump: async () => undefined, oldestQueuedAt: () => null,
        accountHolds: () => ({ deadline: new Set(['claude:second']), inFlight: new Set(), deadlines: new Map([['claude:second', sooner]]) }),
      } as unknown as Parameters<WorkspaceSemaphore['register']>[0]);
      expect((await managerAccountLimit(() => semaphore.accountHolds(), 'claude', 'second', repoRoot)).until).toBe(sooner);
      off();
      expect((await managerAccountLimit(() => semaphore.accountHolds(), 'claude', 'second', repoRoot)).until).toBe(own);
    }, 40_000);

    it('an empty allowed remainder never falls back outside the list, even with project fallback on', async () => {
      registerAccounts(['second']);
      await enable([{ provider: 'claude', profileId: 'second' }]);
      manager = new RunManager(store, repoRoot);
      const started = manager.startRun(workflow, { task: 'mock:limit', worktree: false, startedByManager, managerAgent: { note: 'chosen', fallback: [] } });
      expect(store.getRun(started.id)?.fallbackPolicy).toMatchObject({ enabled: false, source: 'manager', managerId: 'm1' });
      await until(() => store.getRun(started.id)?.autoResumeAt !== undefined, 'auto-resume to arm');
      expect(store.getRun(started.id)?.agentProfile).toBeUndefined();
    }, 40_000);
  });

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

  it('a successor whose login is rejected stays with fallback instead of parking for a reconnect', async () => {
    registerAccounts(['second', 'third']);
    await enable([{ provider: 'claude', profileId: 'second' }, { provider: 'claude', profileId: 'third' }]);
    manager = new RunManager(store, repoRoot);
    const id = await failedRun({ status: 'running', error: undefined });
    store.addStep(id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    store.updateStep(id, 'continue-1', { status: 'failed', sessionId: 'pinned-up-front', backend: 'claude', profileId: 'second' });
    store.updateRun(id, {
      runner: 'claude', agentProfile: 'second',
      fallbackEpisode: { attempted: ['claude:default', 'claude:second'], current: { key: 'claude:second', stepId: 'continue-1' } },
    });
    const parked = (manager as unknown as { publishRunFailure(id: string, patch: object): boolean }).publishRunFailure(id, {
      status: 'failed', error: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    });
    expect(parked).toBe(false);
    expect(store.getRun(id)).toMatchObject({ status: 'queued', fallbackEpisode: { pending: true } });
    expect(store.getRun(id)?.parked).toBeUndefined();
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
    expect(manager.accountHolds().deadlines?.get('claude:default')).toBe(untilAt);
    store.deleteRun(id);
    expect(manager.accountHolds().deadline.has('claude:default')).toBe(true);
    expect(manager.accountHolds().deadlines?.get('claude:default')).toBe(untilAt);
    manager.dispose();
    manager = new RunManager(store, repoRoot);
    expect(manager.accountHolds().deadline.has('claude:default')).toBe(true);
    expect(manager.accountHolds().deadlines?.get('claude:default')).toBe(untilAt);
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

  it('hands a task to the explicitly selected agent when its manager fallback is still being admitted', async () => {
    registerAccounts(['second']);
    const policy = managerFallbackPolicy([{ provider: 'claude', profileId: 'second', model: 'opus' }], 'manager');
    setManagerTaskAccountsLookup(() => [
      { runner: 'claude', agentProfile: 'second' },
      { runner: 'codex', agentProfile: 'default' },
    ]);
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    // Keep the admitted successor in the queue so this assertion stops at the handoff.
    semaphore.register({ busySlots: () => 1, oldestQueuedAt: () => null, pump: () => {} });
    manager = new RunManager(store, repoRoot, { semaphore });
    let release!: (value: string | null) => void;
    const gate = new Promise<string | null>((resolve) => { release = resolve; });
    const check = vi.spyOn(manager as unknown as { fallbackProviderRefusal(): Promise<string | null> }, 'fallbackProviderRefusal').mockReturnValue(gate);
    const id = await failedRun({
      worktree: false, model: 'opus', fallbackPolicy: policy, startedByManager: { id: 'manager', name: 'Release Manager' },
    });
    decide(id);
    await until(() => check.mock.calls.length > 0, 'provider check starts');
    expect(manager.switchAgent(id, { runner: 'codex', agentProfile: 'default', changedBy: 'Release Manager' })).toHaveProperty('summary');
    release(null);
    await until(() => !(manager as unknown as { fallbackPending: Set<string> }).fallbackPending.has(id), 'selection settles');
    expect(store.getRun(id)).toMatchObject({ status: 'queued', runner: 'codex', agentProfile: 'default', fallbackPolicy: policy });
    expect(store.getRun(id)?.fallbackEpisode).toBeUndefined();
    expect(store.getRun(id)?.model).toBeUndefined();
    expect(store.getRun(id)?.steps.map((step) => step.id)).toEqual(['work', 'continue-1']);
  }, 40_000);

  it('finishes an admission a restart interrupted, without reusing an agent it had already tried', async () => {
    registerAccounts(['second', 'third']);
    await enable([{ provider: 'claude', profileId: 'second' }, { provider: 'claude', profileId: 'third' }]);
    const id = await failedRun({ fallbackEpisode: { attempted: ['claude:default', 'claude:second'] } });
    manager = new RunManager(store, repoRoot);
    await manager.recover();
    await until(() => store.getRun(id)?.agentProfile === 'third', 'third account takes over after restart');
  }, 40_000);
});
