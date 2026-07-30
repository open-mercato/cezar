import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { Runner } from '@open-mercato/cezar-api-client'

import { engineBody, type ResolvedEngine, useResolvedEngine } from './engine-pills'

/**
 * `engineBody` (#401) is the one place the create-run body rules live for the Inbox and the
 * GitHub tab. The rules are small; the reason they are worth pinning is the third case below —
 * the composer's `runnerCount > 1` rule gets it wrong, and this is the difference.
 */

const resolved = (over: Partial<ResolvedEngine> = {}): ResolvedEngine => ({
  runner: 'claude',
  runnerExplicit: false,
  model: '',
  runners: ['claude'],
  defaultRunner: 'claude',
  canRun: true,
  providerPending: false,
  providerError: false,
  ...over,
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function stubResolverFetch({
  providers,
  providerStatus = 200,
  providerPending = false,
  bootDefault = 'claude',
  projectDefault = 'claude',
}: {
  providers: unknown
  providerStatus?: number
  providerPending?: boolean
  bootDefault?: Runner
  projectDefault?: Runner
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/providers/status') {
        if (providerPending) return new Promise<Response>(() => {})
        return jsonResponse(providers, providerStatus)
      }
      if (path === '/api/v1/health') {
        return jsonResponse({
          defaultRunner: bootDefault,
          checks: [{ name: 'claude', available: true }],
        })
      }
      if (path === '/api/v1/config') {
        return jsonResponse({ defaultRunner: projectDefault, defaultModels: {}, modelsLocked: false })
      }
      if (path === '/api/v1/models?runner=codex') {
        return jsonResponse({ runner: 'codex', models: [], source: 'live', stale: false })
      }
      return jsonResponse({})
    }),
  )
}

function renderResolved() {
  const client = createQueryClient()
  return renderHook(() => useResolvedEngine({ runner: null, model: null }), {
    wrapper: ({ children }) =>
      createElement(QueryClientProvider, { client }, children),
  })
}

describe('useResolvedEngine provider status', () => {
  it('derives runnable choices from connected providers, not installation health', async () => {
    stubResolverFetch({
      providers: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.canRun).toBe(true))

    expect(result.current.runners).toEqual(['codex'])
    expect(result.current.runner).toBe('codex')
    expect(result.current.providerPending).toBe(false)
    expect(result.current.providerError).toBe(false)
  })

  it('cannot run while provider status is pending', async () => {
    stubResolverFetch({ providers: {}, providerPending: true })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.providerPending).toBe(true))

    expect(result.current.canRun).toBe(false)
  })

  it('cannot run when provider status verification fails', async () => {
    stubResolverFetch({
      providers: { error: 'verification failed' },
      providerStatus: 404,
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.providerError).toBe(true))

    expect(result.current.canRun).toBe(false)
    expect(result.current.runners).toEqual([])
  })

  it('cannot run when provider status succeeds with no connected provider', async () => {
    stubResolverFetch({
      providers: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'unknown', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.providerPending).toBe(false))

    expect(result.current.canRun).toBe(false)
    expect(result.current.runners).toEqual([])
  })

  it('excludes a connected but disabled provider while retaining an enabled fallback', async () => {
    stubResolverFetch({
      providers: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: false },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.canRun).toBe(true))

    expect(result.current.runners).toEqual(['codex'])
    expect(result.current.runner).toBe('codex')
  })

  it('resolves an untouched pick from project config, never the boot health default', async () => {
    stubResolverFetch({
      bootDefault: 'codex',
      projectDefault: 'claude',
      providers: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.canRun).toBe(true))

    expect(result.current.runner).toBe('claude')
    expect(result.current.defaultRunner).toBe('claude')
  })
})

describe('engineBody', () => {
  it("auto ('') stays implicit rather than shipping an empty model", () => {
    expect(engineBody(resolved({ model: '' })).model).toBeUndefined()
  })

  it('a pinned model is sent', () => {
    expect(engineBody(resolved({ model: 'opus' })).model).toBe('opus')
  })

  it('omits a resolved native model when model selection is locked', () => {
    expect(engineBody(resolved({ model: 'opus', modelsLocked: true })).model).toBeUndefined()
  })

  it('omits the runner when it is already what the server would choose', () => {
    const body = engineBody(resolved({ runner: 'claude', defaultRunner: 'claude' }))
    expect(body.runner).toBeUndefined()
  })

  it('sends the runner when it differs from the default — a real pick', () => {
    const body = engineBody(
      resolved({ runner: 'codex', defaultRunner: 'claude', runners: ['claude', 'codex'] }),
    )
    expect(body.runner).toBe('codex')
  })

  it('always sends an explicit pick even when it equals the reported default', () => {
    const body = engineBody(
      resolved({ runner: 'codex', runnerExplicit: true, defaultRunner: 'codex' }),
    )
    expect(body.runner).toBe('codex')
  })

  /**
   * The case the composer's count rule gets wrong (#401 review). The host prefers codex, but
   * provider status says only claude is connected. `runnerCount` is 1, so the count rule would
   * omit the runner; the server would then resolve the omitted field straight back to codex.
   * Comparing against the authoritative project config default sends `claude` and settles it.
   */
  it('sends the runner when the host default is unavailable, even with one backend left', () => {
    const body = engineBody(
      resolved({ runner: 'claude', defaultRunner: 'codex', runners: ['claude'], model: 'opus' }),
    )
    expect(body.runner).toBe('claude')
    expect(body.model).toBe('opus')
  })

  it('collapses to the composer on a healthy single-backend host — nothing sent', () => {
    const body = engineBody(
      resolved({ runner: 'claude', defaultRunner: 'claude', runners: ['claude'], model: '' }),
    )
    expect(body).toEqual({ runner: undefined, model: undefined })
  })

  it.each<Runner>(['claude', 'codex', 'opencode'])(
    'is symmetric for %s as the host default',
    (runner) => {
      expect(engineBody(resolved({ runner, defaultRunner: runner })).runner).toBeUndefined()
    },
  )
})
