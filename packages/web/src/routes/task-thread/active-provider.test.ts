import { describe, expect, it } from 'vitest'

import type { ApiRun, ProviderStatusResponse } from '@open-mercato/cezar-api-client'

import {
  activeProviderAvailability,
  existingProviderAvailability,
  providerForActiveRun,
  providerForExistingRun,
} from './active-provider'

const run = (overrides: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'Task',
  workflow: 'quick-task',
  task: 'Task',
  status: 'waiting',
  createdAt: '2026-07-24T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...overrides,
})

const providers = (overrides: Partial<ProviderStatusResponse> = {}): ProviderStatusResponse => ({
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'connected', enabled: true },
  ],
  ...overrides,
})

describe('active task provider availability', () => {
  it('uses the current step backend before a disabled run runner', () => {
    const active = run({
      runner: 'claude',
      currentStepId: 'retry',
      steps: [{ id: 'retry', name: 'Retry', kind: 'agent', status: 'waiting', iterations: 1, tokensUsed: 0, backend: 'codex' }],
    })
    const status = providers({
      providers: [
        { provider: 'claude', status: 'connected', enabled: false },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    })

    expect(providerForActiveRun(active)).toBe('codex')
    expect(activeProviderAvailability(active, status)).toEqual({ provider: 'codex', usable: true })
  })

  it.each([
    ['disabled', { provider: 'claude', status: 'connected', enabled: false }, 'Claude Code is disabled. Enable it in Settings → Agents → Providers.'],
    ['disconnected', { provider: 'claude', status: 'disconnected', enabled: true }, 'Claude Code credentials are unavailable. Authorize it in Settings → Agents → Providers.'],
  ] as const)('reports the fixed server-safe reason for a %s active provider', (_case, row, reason) => {
    const status = providers({ providers: [row, ...providers().providers.slice(1)] })

    expect(activeProviderAvailability(run({ runner: 'claude' }), status)).toEqual({
      provider: 'claude',
      usable: false,
      reason,
    })
  })

  it('gates an override-free continuation on the run provider, not a connected fallback', () => {
    const closed = run({
      status: 'done',
      runner: 'claude',
      steps: [{
        id: 'continue-1',
        name: 'Continue',
        kind: 'agent',
        status: 'done',
        iterations: 1,
        tokensUsed: 0,
        backend: 'codex',
        sessionId: 'session-1',
      }],
    })
    const status = providers({
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    })

    expect(providerForExistingRun(closed)).toBe('claude')
    expect(existingProviderAvailability(closed, status)).toEqual({
      provider: 'claude',
      usable: false,
      reason: 'Claude Code credentials are unavailable. Authorize it in Settings → Agents → Providers.',
    })
  })
})
