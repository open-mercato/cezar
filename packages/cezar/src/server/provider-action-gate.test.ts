import { describe, expect, it, vi } from 'vitest';
import type { ProviderStatus, ProviderStatusResponse } from '../core/provider-auth.ts';
import type { RunRecord } from '../runs/store.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { defaultAgentAccountStore, type AgentAccountStore } from '../workspace/agent-accounts.ts';
import {
  providerForActiveRun,
  providerForExistingRun,
  providersRequiredByWorkflow,
  recordedProfileFor,
  unavailableProviderMessage,
  signedOutAccountMessage,
  withSelectedAccounts,
} from './provider-action-gate.ts';

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-1',
  title: 'Task',
  workflow: 'quick-task',
  task: 'Task',
  status: 'done',
  createdAt: '2026-07-24T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...overrides,
});

describe('provider action gate', () => {
  it('collects each agent step backend and ignores checks', () => {
    const workflow: WorkflowDef = {
      name: 'mixed',
      source: 'built-in',
      steps: [
        { id: 'a', prompt: 'a', runner: 'codex' },
        { id: 'check', command: 'npm test' },
        { id: 'b', prompt: 'b' },
        { id: 'c', prompt: 'c', runner: 'opencode' },
      ],
    };

    expect(providersRequiredByWorkflow(workflow, 'claude')).toEqual(['claude', 'codex', 'opencode']);
  });

  it('reports disabled before missing credentials', () => {
    expect(unavailableProviderMessage(['codex'], {
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: false },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      { provider: 'cursor', status: 'not-installed', enabled: true },
      ],
    })).toBe('Codex is disabled. Enable it in Settings → Agents → Providers.');
  });

  it.each(['disconnected', 'unknown'] as const)(
    'reports unavailable credentials for a %s provider',
    (status) => {
      expect(unavailableProviderMessage(['codex'], {
        providers: [{ provider: 'codex', status, enabled: true }],
      })).toBe('Codex credentials are unavailable. Authorize it in Settings → Agents → Providers.');
    },
  );

  it('reports unavailable credentials when the provider status row is missing', () => {
    expect(unavailableProviderMessage(['opencode'], { providers: [] }))
      .toBe('OpenCode credentials are unavailable. Authorize it in Settings → Agents → Providers.');
  });

  it('uses an explicit override before the latest step backend', () => {
    expect(providerForExistingRun(run({
      runner: 'claude',
      steps: [
        { id: 'first', name: 'First', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'claude' },
        { id: 'last', name: 'Last', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'codex' },
      ],
    }), 'opencode')).toBe('opencode');
  });

  it('uses the run runner before any historical step backend for a continuation', () => {
    expect(providerForExistingRun(run({
      runner: 'claude',
      steps: [
        { id: 'first', name: 'First', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'claude' },
        { id: 'last', name: 'Last', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'codex' },
      ],
    }))).toBe('claude');
  });

  it('uses the run runner, then Claude, when no step backend exists', () => {
    expect(providerForExistingRun(run({ runner: 'opencode' }))).toBe('opencode');
    expect(providerForExistingRun(run())).toBe('claude');
  });

  it('uses the current active step backend for a live message', () => {
    expect(providerForActiveRun(run({
      runner: 'claude',
      currentStepId: 'retry',
      steps: [
        { id: 'retry', name: 'Retry', kind: 'agent', status: 'running', iterations: 2, tokensUsed: 0, backend: 'claude' },
        { id: 'later', name: 'Later', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'codex' },
      ],
    }))).toBe('claude');
  });

  it('falls back from an un-attributed active step to the run runner, historical backend, then Claude', () => {
    expect(providerForActiveRun(run({
      runner: 'opencode',
      currentStepId: 'active',
      steps: [{ id: 'active', name: 'Active', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0 }],
    }))).toBe('opencode');
    expect(providerForActiveRun(run({
      steps: [{ id: 'previous', name: 'Previous', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'codex' }],
    }))).toBe('codex');
    expect(providerForActiveRun(run())).toBe('claude');
  });
});

describe('withSelectedAccounts (telemetry ac53a6ef)', () => {
  const work = { id: 'work', provider: 'claude' as const, configDir: '/accounts/work', label: 'Work', addedAt: '' };
  const store = (overrides: Partial<AgentAccountStore> = {}): AgentAccountStore => ({
    ...defaultAgentAccountStore(),
    accounts: [work],
    ...overrides,
  });
  const defaultLoggedOut: ProviderStatusResponse = {
    providers: [{ provider: 'claude', status: 'disconnected', enabled: true, hint: 'Run claude auth login.' }],
  };
  const auth = (status: ProviderStatus['status']) => {
    const profileStatus = vi.fn(async (provider: ProviderStatus['provider'], profile: { id: string }) =>
      ({ provider, status, profileId: profile.id }));
    const forgetProfileStatus = vi.fn();
    return { profileStatus, forgetProfileStatus };
  };

  it('judges the workspace default account instead of the logged-out discovered login', async () => {
    const service = auth('connected');
    const judged = await withSelectedAccounts(defaultLoggedOut, ['claude'], { repoRoot: '/repo' }, service, {
      loadStore: async () => store({ defaults: { claude: 'work' } }),
    });

    expect(unavailableProviderMessage(['claude'], judged)).toBeNull();
    expect(judged.providers[0]).toEqual({ provider: 'claude', status: 'connected', enabled: true, profileId: 'work' });
    expect(service.profileStatus).toHaveBeenCalledWith('claude', { id: 'work', configDir: '/accounts/work' });
  });

  it('judges an explicit account and refuses when that account is the logged-out one', async () => {
    const service = auth('disconnected');
    const connectedDefault: ProviderStatusResponse = {
      providers: [{ provider: 'claude', status: 'connected', enabled: true }],
    };
    const judged = await withSelectedAccounts(connectedDefault, ['claude'], { profileFor: () => 'work' }, service, {
      refresh: true,
      loadStore: async () => store(),
    });

    // Names the account: "credentials are unavailable" sent users to a Providers card showing the
    // default login connected — a dead end they retried and restarted the server on (0.15.2).
    expect(unavailableProviderMessage(['claude'], judged)).toBe(
      'Claude Code account "Work" is not signed in. Sign it in under Settings → Agent accounts, or choose another account for this task.',
    );
    expect(service.forgetProfileStatus).toHaveBeenCalledWith('claude', 'work');
  });

  it('keeps the account label quotable, so the cockpit scrubber masks all of it', () => {
    expect(signedOutAccountMessage('claude', 'My "work" login')).toMatch(/^Claude Code account "My work login" is/);
  });

  it('keeps the provider message for the discovered login, which Providers does describe', () => {
    expect(unavailableProviderMessage(['claude'], defaultLoggedOut)).toBe(
      'Claude Code credentials are unavailable. Authorize it in Settings → Agents → Providers.',
    );
  });

  it('keeps the default row when no named account is selected', async () => {
    const service = auth('connected');
    const judged = await withSelectedAccounts(defaultLoggedOut, ['claude'], { repoRoot: '/repo' }, service, {
      loadStore: async () => store(),
    });

    expect(judged).toEqual(defaultLoggedOut);
    expect(service.profileStatus).not.toHaveBeenCalled();
  });

  it('never re-answers a disabled provider or a latched runtime failure', async () => {
    const service = auth('connected');
    const response: ProviderStatusResponse = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'incident' },
        { provider: 'codex', status: 'connected', enabled: false },
      ],
    };
    const judged = await withSelectedAccounts(response, ['claude', 'codex'], { profileFor: () => 'work' }, service, {
      loadStore: async () => store(),
    });

    expect(judged.providers).toEqual(response.providers);
    expect(service.profileStatus).not.toHaveBeenCalled();
  });

  it('falls back to the discovered login when the account store cannot be read', async () => {
    const service = auth('connected');
    const judged = await withSelectedAccounts(defaultLoggedOut, ['claude'], { profileFor: () => 'work' }, service, {
      loadStore: async () => { throw new Error('EACCES'); },
    });

    expect(judged).toBe(defaultLoggedOut);
  });
});

describe('recordedProfileFor', () => {
  const step = (backend: 'claude' | 'codex', profileId?: string) => ({
    id: `${backend}-${profileId ?? 'none'}`, name: 'Step', kind: 'agent' as const, status: 'done' as const,
    iterations: 1, tokensUsed: 0, backend, ...(profileId ? { profileId } : {}),
  });

  it('prefers the latest recorded account for that provider, then the run override for its runner', () => {
    const record = run({ runner: 'claude', agentProfile: 'override', steps: [step('claude', 'work'), step('codex', 'ci')] });
    expect(recordedProfileFor(record, 'claude')).toBe('work');
    expect(recordedProfileFor(record, 'codex')).toBe('ci');
    expect(recordedProfileFor(run({ runner: 'claude', agentProfile: 'override' }), 'claude')).toBe('override');
    expect(recordedProfileFor(run({ runner: 'claude', agentProfile: 'override' }), 'codex')).toBeUndefined();
  });
});
