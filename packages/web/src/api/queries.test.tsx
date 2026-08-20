import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from './client'
import { createQueryClient } from './query-client'
import { setApiScope } from '@open-mercato/cezar-api-client'
import { ProjectScopeContext } from './project-scope-context'
import type { GithubRefStatusData } from '@open-mercato/cezar-api-client'
import {
  refStatusRecheckAfter,
  useReferenceProjectId,
  useProjectRepoBase,
  queryKeys,
  useProviderStatus,
  useRefreshProviderStatus,
  useRetryProviderAuth,
  useHealth,
  useHealthSubscription,
  useRunnerModels,
  useMarkRunSeen,
  useMarkRunUnseen,
  usePatchRun,
  usePutAgentConfigFile,
  useRun,
  useRunChanges,
  useRuns,
  useSkills,
  useSkillsUpdate,
  workspaceQueryKeys,
} from './queries'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

/** A client per test: a shared cache would let one test's data satisfy the next test's query,
 *  and "loading → data" would pass without a fetch ever happening. */
function wrapper() {
  const client = createQueryClient()
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

const HEALTH = {
  version: '0.1.3',
  repoRoot: '/home/me/cezar',
  repo: { root: '/home/me/cezar', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  capabilities: { localHandoff: true, followups: false, singleProject: false, automations: false },
}

/** Just enough WebSocket for useHealth's topic subscription (api/ws.ts): records the frames the
 *  client sends, lets the test drive `open` and deliver server frames by hand. */
class FakeHealthSocket {
  static instances: FakeHealthSocket[] = []

  readyState = 0 // CONNECTING
  sent: string[] = []
  private handlers = new Map<string, Set<(event: unknown) => void>>()

  constructor(_url: string) {
    FakeHealthSocket.instances.push(this)
  }

  addEventListener(name: string, handler: (event: unknown) => void): void {
    let set = this.handlers.get(name)
    if (!set) {
      set = new Set()
      this.handlers.set(name, set)
    }
    set.add(handler)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.fire('close', {})
  }

  open(): void {
    this.readyState = 1
    this.fire('open', {})
  }

  message(frame: unknown): void {
    this.fire('message', { data: JSON.stringify(frame) })
  }

  private fire(name: string, event: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(event)
  }
}

describe('useRunnerModels', () => {
  it('loads the workspace Codex catalog', async () => {
    fetchMock.mockResolvedValue(json({ runner: 'codex', models: [{ id: 'gpt-future', label: 'Future', description: '' }], source: 'live', stale: false }))
    const { result } = renderHook(() => useRunnerModels('codex'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.models[0]?.id).toBe('gpt-future')
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/v1/models?runner=codex')
  })

  it('loads the OpenCode catalog from its own cache entry (#794)', async () => {
    fetchMock.mockResolvedValue(json({ runner: 'opencode', models: [{ id: 'openai/gpt-5.4', label: 'openai/gpt-5.4', description: 'via openai' }], source: 'live', stale: false }))
    const { result } = renderHook(() => useRunnerModels('opencode'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.models[0]?.id).toBe('openai/gpt-5.4')
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/v1/models?runner=opencode')
  })

  it('never asks the server about claude, which has no host catalog', async () => {
    const { result } = renderHook(() => useRunnerModels('claude'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(result.current.data).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('provider status workspace query', () => {
  const PROVIDERS = {
    providers: [
      { provider: 'claude', status: 'connected', enabled: true },
      { provider: 'codex', status: 'disconnected', enabled: true, hint: 'Run codex login.' },
      { provider: 'opencode', status: 'not-installed', enabled: true },
    ],
  }

  afterEach(() => {
    setApiScope(null)
    vi.useRealTimers()
  })

  it('loads the workspace endpoint under any active project with one stable key', async () => {
    setApiScope('proj-a')
    fetchMock.mockResolvedValue(json(PROVIDERS))
    const client = createQueryClient()
    const { result } = renderHook(() => useProviderStatus(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/v1/providers/status')
    expect(workspaceQueryKeys.providerStatus).toEqual(['workspace', 'providers', 'status'])
    expect(client.getQueryData(['workspace', 'providers', 'status'])).toEqual(PROVIDERS)

    setApiScope('proj-b')
    expect(workspaceQueryKeys.providerStatus).toEqual(['workspace', 'providers', 'status'])
  })

  it('loads once without interval polling and becomes focus-refreshable after five minutes', async () => {
    fetchMock.mockResolvedValue(json(PROVIDERS))
    const client = createQueryClient()
    const { result } = renderHook(() => useProviderStatus(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const query = client.getQueryCache().find({ queryKey: workspaceQueryKeys.providerStatus })
    expect(query?.observers[0]?.options.refetchInterval).toBe(false)
    expect(query?.observers[0]?.options.staleTime).toBe(5 * 60_000)
  })

  it('refetches on window focus', async () => {
    fetchMock.mockResolvedValue(json(PROVIDERS))
    const client = createQueryClient()
    const { result } = renderHook(() => useProviderStatus(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const query = client.getQueryCache().find({ queryKey: workspaceQueryKeys.providerStatus })
    if (!query) throw new Error('provider status query was not created')
    query.setState({ ...query.state, dataUpdatedAt: Date.now() - 5 * 60_000 - 1 })
    window.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('surfaces an ApiError instead of synthesizing disconnected providers', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'provider probe failed' }), {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    )
    const { result } = renderHook(() => useProviderStatus(), { wrapper: wrapper() })

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 })
    expect(result.current.data).toBeUndefined()
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).message).toBe('provider probe failed')
  })

  it('enters the query error state for a malformed successful response', async () => {
    fetchMock.mockImplementation(async () =>
      json({ providers: [null], raw: 'do-not-render-this' }),
    )
    const client = createQueryClient()
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, retry: false },
    })
    const { result } = renderHook(() => useProviderStatus(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 })
    expect(result.current.data).toBeUndefined()
    expect(result.current.error?.message).toBe('Invalid provider status response')
  })

  it('refreshes explicitly and replaces the workspace cache', async () => {
    const refreshed = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    }
    fetchMock.mockResolvedValue(json(refreshed))
    const client = createQueryClient()
    const { result } = renderHook(() => useRefreshProviderStatus(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    act(() => result.current.mutate())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/v1/providers/status?refresh=1')
    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toEqual(refreshed)
  })

  it('does not let a deferred polling response clear an SSE runtime incident', async () => {
    const deferred = deferredResponse()
    fetchMock.mockReturnValue(deferred.promise)
    const client = createQueryClient()
    renderHook(() => useProviderStatus(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    client.setQueryData(workspaceQueryKeys.providerStatus, {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'sse-1', hint: 'Reconnect.' },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    })

    await act(async () => deferred.resolve(json(PROVIDERS)))

    expect(client.getQueryData<typeof PROVIDERS>(workspaceQueryKeys.providerStatus)?.providers[0]).toMatchObject({
      status: 'disconnected',
      authFailureId: 'sse-1',
    })
  })

  it('does not let a deferred refresh response clear an SSE runtime incident', async () => {
    const deferred = deferredResponse()
    fetchMock.mockReturnValue(deferred.promise)
    const client = createQueryClient()
    const { result } = renderHook(() => useRefreshProviderStatus(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    act(() => result.current.mutate())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    client.setQueryData(workspaceQueryKeys.providerStatus, {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'sse-1', hint: 'Reconnect.' },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    })

    await act(async () => deferred.resolve(json(PROVIDERS)))

    expect(client.getQueryData<typeof PROVIDERS>(workspaceQueryKeys.providerStatus)?.providers[0]).toMatchObject({
      status: 'disconnected',
      authFailureId: 'sse-1',
    })
  })

  it('retries a matching provider incident and replaces the confirmed workspace cache', async () => {
    const confirmed = {
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: false },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    }
    fetchMock.mockResolvedValue(json(confirmed))
    const client = createQueryClient()
    const { result } = renderHook(() => useRetryProviderAuth(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    act(() => result.current.mutate({ provider: 'claude', authFailureId: 'incident-1' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/providers/claude/retry', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ authFailureId: 'incident-1' }),
    }))
    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toEqual(confirmed)
  })

  it('does not let a deferred retry clear a newer SSE runtime incident', async () => {
    const deferred = deferredResponse()
    fetchMock.mockReturnValue(deferred.promise)
    const client = createQueryClient()
    client.setQueryData(workspaceQueryKeys.providerStatus, {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'retry-1', hint: 'Reconnect.' },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    })
    const { result } = renderHook(() => useRetryProviderAuth(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    act(() => result.current.mutate({ provider: 'claude', authFailureId: 'retry-1' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    client.setQueryData(workspaceQueryKeys.providerStatus, {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'sse-2', hint: 'Reconnect again.' },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    })

    await act(async () => deferred.resolve(json(PROVIDERS)))

    expect(client.getQueryData<typeof PROVIDERS>(workspaceQueryKeys.providerStatus)?.providers[0]).toMatchObject({
      status: 'disconnected',
      authFailureId: 'sse-2',
    })
  })

  it('keeps the last confirmed provider cache when retry fails', async () => {
    const prior = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'incident-1' },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    }
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'stale incident' }), { status: 409 }))
    const client = createQueryClient()
    client.setQueryData(workspaceQueryKeys.providerStatus, prior)
    const { result } = renderHook(() => useRetryProviderAuth(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    act(() => result.current.mutate({ provider: 'claude', authFailureId: 'incident-1' }))
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toEqual(prior)
  })
})

describe('queryKeys', () => {
  // Step 3.2 invalidates by these. Keeping them stable and hierarchical is the whole contract:
  // the runs root has to be a prefix of both the list and every detail key, or one invalidate
  // call cannot reach them. Since step 3.1 every key leads with the project scope — the
  // `'default'` sentinel unscoped — so caches never bleed across projects.
  it('nests every run key under the list root', () => {
    expect(queryKeys.runs.all).toEqual(['default', 'runs'])
    expect(queryKeys.runs.list()).toEqual(['default', 'runs', 'list'])
    expect(queryKeys.runs.detail('a')).toEqual(['default', 'runs', 'detail', 'a'])
    expect(queryKeys.runs.diff('a')).toEqual(['default', 'runs', 'diff', 'a'])
    for (const key of [queryKeys.runs.list(), queryKeys.runs.detail('a'), queryKeys.runs.diff('a')]) {
      expect(key.slice(0, 2)).toEqual([...queryKeys.runs.all])
    }
  })

  it('keys github by limit so two page sizes are two caches', () => {
    expect(queryKeys.github()).toEqual(['default', 'github', null])
    expect(queryKeys.github({ limit: 5 })).not.toEqual(queryKeys.github({ limit: 50 }))
  })

  it('keys github checks by the sorted PR set so the same window is one cache (#664)', () => {
    // Order must not matter — a re-sorted visible window would otherwise refetch needlessly.
    expect(queryKeys.githubChecks([12, 7])).toEqual(queryKeys.githubChecks([7, 12]))
    expect(queryKeys.githubChecks([7, 12])).toEqual(['default', 'github', 'checks', '7,12'])
    // Different windows are different caches.
    expect(queryKeys.githubChecks([7])).not.toEqual(queryKeys.githubChecks([7, 12]))
  })

  it('is stable across calls — an unstable key refetches forever', () => {
    expect(queryKeys.runs.detail('a')).toEqual(queryKeys.runs.detail('a'))
  })

  it('leads every key with the active project scope, so two projects are two caches', () => {
    setApiScope('proj-a')
    try {
      expect(queryKeys.runs.list()).toEqual(['proj-a', 'runs', 'list'])
      expect(queryKeys.health).toEqual(['proj-a', 'health'])
      expect(queryKeys.todos).toEqual(['proj-a', 'todos'])
      expect(queryKeys.skills).toEqual(['proj-a', 'skills'])
      expect(queryKeys.skillsReady).toEqual(['proj-a', 'skills', 'ready'])
      expect(queryKeys.agentConfig).toEqual(['proj-a', 'agent-config'])
      expect(queryKeys.agentConfigFile('claude.project.settings')).toEqual([
        'proj-a',
        'agent-config',
        'file',
        'claude.project.settings',
      ])
      expect(queryKeys.github({ limit: 5 })).toEqual(['proj-a', 'github', 5])
      const scoped = queryKeys.runs.detail('a')
      setApiScope('proj-b')
      // The same call under another scope is a DIFFERENT cache entry — the whole point.
      expect(queryKeys.runs.detail('a')).not.toEqual(scoped)
    } finally {
      setApiScope(null)
    }
  })
})

describe('useSkills', () => {
  it('renders the fast catalog, then converges when the cold team cache is ready', async () => {
    let resolveReady!: (response: Response) => void
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/api/v1/skills') {
        return json([{ name: 'local', source: 'ai', body: '', path: '/repo/local.md' }])
      }
      if (String(input) === '/api/v1/skills?wait=1') {
        return new Promise<Response>((resolve) => {
          resolveReady = resolve
        })
      }
      return new Response(null, { status: 404 })
    })

    const { result } = renderHook(() => useSkills(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data?.map((skill) => skill.name)).toEqual(['local']))
    await waitFor(() => expect(resolveReady).toBeTypeOf('function'))

    resolveReady(
      json([
        { name: 'local', source: 'ai', body: '', path: '/repo/local.md' },
        { name: 'om-fix', source: 'team', body: '', path: 'skills/om-fix/SKILL.md' },
      ]),
    )

    await waitFor(() =>
      expect(result.current.data?.map((skill) => skill.name)).toEqual(['local', 'om-fix']),
    )
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/v1/skills', '/api/v1/skills?wait=1'])
  })
})

describe('useSkillsUpdate', () => {
  it('retries a transient snapshot conservatively until the background server check converges', async () => {
    fetchMock.mockResolvedValue(json({
      status: 'idle',
      available: false,
      autoUpdateEnabled: false,
      inherited: false,
      checkedAt: null,
      updatedAt: null,
      scopes: [],
      needsUpgradeNotes: false,
    }))
    const client = createQueryClient()
    const key = workspaceQueryKeys.skillsUpdate('boot')
    const { result } = renderHook(() => useSkillsUpdate('boot'), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    await waitFor(() => expect(result.current.data?.status).toBe('idle'))

    const query = client.getQueryCache().find({ queryKey: key })
    const interval = query?.observers[0]?.options.refetchInterval
    expect(typeof interval).toBe('function')
    expect((interval as (current: typeof query) => number | false)(query)).toBe(60_000)

    client.setQueryData(key, { ...result.current.data!, status: 'current' })
    expect((interval as (current: typeof query) => number | false)(query)).toBe(false)

    client.setQueryData(key, { ...result.current.data!, status: 'available' })
    expect((interval as (current: typeof query) => number | false)(query)).toBe(false)
  })
})

describe('useHealth', () => {
  it('goes loading → data', async () => {
    fetchMock.mockResolvedValue(json(HEALTH))
    const { result } = renderHook(() => useHealth(), { wrapper: wrapper() })

    expect(result.current.isPending).toBe(true)
    expect(result.current.data).toBeUndefined()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.version).toBe('0.1.3')
    expect(result.current.data?.repo?.branch).toBe('main')
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/v1/health')
  })

  it('surfaces an ApiError rather than pretending it has data', async () => {
    // A fresh Response per call: a 5xx is retried once, and a Response body can only be read
    // once — a single shared instance would fail the retry with a Body-is-unusable TypeError.
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'boom' }), { status: 500, statusText: 'Internal Server Error' }),
    )
    const { result } = renderHook(() => useHealth(), { wrapper: wrapper() })

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 })
    expect(result.current.data).toBeUndefined()
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).message).toBe('boom')
  })

  it('does not touch the socket on its own — it is a pure read', () => {
    vi.stubGlobal('WebSocket', FakeHealthSocket)
    fetchMock.mockResolvedValue(json(HEALTH))
    renderHook(() => useHealth(), { wrapper: wrapper() })
    // The subscription lives once at the root (useHealthSubscription), NOT per useHealth reader,
    // so mounting a reader must open no socket and flap no subscribe/unsubscribe frame.
    expect(FakeHealthSocket.instances).toHaveLength(0)
  })

  // #369 moved server-side: the branch-switched-in-a-terminal case is now the `health` topic on
  // /api/v1/ws (ws.ts) pushing a changed snapshot, not a per-tab refetchInterval. The ONE root-level
  // useHealthSubscription folds those pushes into the same cache useHealth reads; the poll is gone.
  it('useHealthSubscription folds pushed frames into the cache instead of polling', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('WebSocket', FakeHealthSocket)
      fetchMock.mockResolvedValue(json(HEALTH))
      // The root wiring (subscription) and a reader together, sharing one query client.
      const client = createQueryClient()
      const scopedWrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      )
      const { result } = renderHook(
        () => {
          useHealthSubscription()
          return useHealth()
        },
        { wrapper: scopedWrapper },
      )

      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(result.current.isSuccess).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      // Read `.data` BEFORE the push: v5 result props are tracked on access, and an observer
      // that never had `data` read would not re-render when only `data` changes.
      expect(result.current.data?.repo?.branch).toBe('main')

      const ws = FakeHealthSocket.instances.at(-1)
      if (!ws) throw new Error('useHealthSubscription never opened the topic socket')
      act(() => ws.open())
      expect(ws.sent.map((raw) => JSON.parse(raw))).toContainEqual({ type: 'subscribe', topic: 'health' })

      act(() =>
        ws.message({
          type: 'event',
          topic: 'health',
          data: { ...HEALTH, repo: { ...HEALTH.repo, branch: 'feature' } },
        }),
      )
      // Flush react-query's batched notify (scheduled, so fake timers hold it) before reading.
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(result.current.data?.repo?.branch).toBe('feature')

      // The old refetchInterval cadence passes with no further request — pushed, not polled.
      await act(() => vi.advanceTimersByTimeAsync(5000))
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses authenticated HTTP only in remote mode and never starts the WebSocket reconnect loop', async () => {
    FakeHealthSocket.instances = []
    vi.stubGlobal('WebSocket', FakeHealthSocket)
    fetchMock.mockResolvedValue(json({
      ...HEALTH,
      capabilities: { ...HEALTH.capabilities, localHandoff: false },
    }))
    const client = createQueryClient()
    const scopedWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(
      () => {
        useHealthSubscription()
        return useHealth()
      },
      { wrapper: scopedWrapper },
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(FakeHealthSocket.instances).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/health', expect.objectContaining({
      credentials: 'include',
    }))
  })
})

describe('usePutAgentConfigFile', () => {
  it('updates the project cache where the save started when the active project changes in flight', async () => {
    let resolveFetch!: (response: Response) => void
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve
      }),
    )
    const client = createQueryClient()
    const scopedWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const file = {
      id: 'claude.project.settings',
      path: '/repo-a/.claude/settings.json',
      exists: true,
      content: '{"project":"a"}',
      version: 'next',
    }

    setApiScope('proj-a')
    const { result } = renderHook(() => usePutAgentConfigFile(file.id), { wrapper: scopedWrapper })
    act(() => result.current.mutate({ content: file.content, version: 'previous' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/p/proj-a/agent-config/claude.project.settings')

    setApiScope('proj-b')
    resolveFetch(json(file))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(client.getQueryData(['proj-a', 'agent-config', 'file', file.id])).toEqual(file)
    expect(client.getQueryData(['proj-b', 'agent-config', 'file', file.id])).toBeUndefined()
    setApiScope(null)
  })
})

describe('useRuns', () => {
  it('goes loading → data', async () => {
    fetchMock.mockResolvedValue(json([{ id: 'run-1', title: 'Fix it', status: 'running' }]))
    const { result } = renderHook(() => useRuns(), { wrapper: wrapper() })

    expect(result.current.isPending).toBe(true)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toHaveLength(1)
    expect(result.current.data?.[0]?.title).toBe('Fix it')
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/v1/runs')
  })
})

describe('useRun', () => {
  it('does not fetch until it has an id', async () => {
    fetchMock.mockResolvedValue(json({ id: 'run-1' }))
    const { result, rerender } = renderHook(({ id }: { id?: string }) => useRun(id), {
      wrapper: wrapper(),
      initialProps: {},
    })

    // A route param that has not resolved yet must not become `GET /api/v1/runs/undefined`.
    expect(result.current.fetchStatus).toBe('idle')
    expect(fetchMock).not.toHaveBeenCalled()

    rerender({ id: 'run-1' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/v1/runs/run-1')
  })
})

describe('useMarkRunSeen', () => {
  const RUN = {
    id: 'run-1',
    title: 'mock:limit ship it',
    workflow: 'quick-task',
    task: 'mock:limit ship it',
    status: 'failed',
    createdAt: '2026-08-03T19:23:00.000Z',
    finishedAt: '2026-08-03T19:23:13.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
  }

  it('takes only the receipt from the answer, keeping fields the stream advanced meanwhile', async () => {
    // The read receipt fires the instant a run finishes — the busiest moment on the run stream.
    // Its answer is a snapshot from BEFORE anything that happened while it was in flight, so
    // writing it wholesale reverts those fields for good (nothing refetches afterwards).
    //
    // Measured case (spec 2026-08-03-auto-resume-after-usage-limit): a run fails on a usage
    // limit and, a beat later, publishes when it will resume itself. The receipt raced that beat
    // and the thread's resume hint vanished on every live schedule while a reload always showed
    // it — the exact "works on refresh, never live" shape.
    const deferred = deferredResponse()
    fetchMock.mockReturnValue(deferred.promise)
    const client = createQueryClient()
    client.setQueryData(queryKeys.runs.detail('run-1'), RUN)
    client.setQueryData(queryKeys.runs.list(), [RUN])
    const { result } = renderHook(() => useMarkRunSeen(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    act(() => result.current.mutate('run-1'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    // …the run stream lands the newer record while the POST is still in flight.
    const armed = { ...RUN, autoResumeAt: '2026-08-03T19:33:53.000Z', seenAt: undefined as string | undefined }
    client.setQueryData(queryKeys.runs.detail('run-1'), armed)
    client.setQueryData(queryKeys.runs.list(), [armed])

    // The answer is the pre-arm snapshot the server had when it stamped the receipt.
    await act(async () => deferred.resolve(json({ ...RUN, seenAt: '2026-08-03T19:23:14.000Z' })))

    const detail = client.getQueryData<typeof armed>(queryKeys.runs.detail('run-1'))
    expect(detail?.autoResumeAt).toBe('2026-08-03T19:33:53.000Z')
    expect(detail?.seenAt).toBe('2026-08-03T19:23:14.000Z')
    const list = client.getQueryData<Array<typeof armed>>(queryKeys.runs.list())
    expect(list?.[0]?.autoResumeAt).toBe('2026-08-03T19:33:53.000Z')
    expect(list?.[0]?.seenAt).toBe('2026-08-03T19:23:14.000Z')
  })

  it('marks the workspace run index stale, so the global Tasks page stops showing it unread', async () => {
    // The bug this pins: the receipt patches the project-scoped list and detail, and the global
    // page renders from a THIRD cache with a 30s staleTime. Opening an unread task from /tasks
    // and coming straight back showed it still unread until a refresh.
    fetchMock.mockResolvedValue(json({ ...RUN, seenAt: '2026-08-03T19:23:14.000Z' }))
    const client = createQueryClient()
    client.setQueryData(workspaceQueryKeys.runsIndex, {
      runs: [{ projectId: 'api', id: 'run-1', title: 'x', status: 'done', createdAt: RUN.createdAt, archived: false, workflow: 'quick-task' }],
      perProjectLimit: 200,
      truncated: [],
    })
    expect(client.getQueryState(workspaceQueryKeys.runsIndex)?.isInvalidated).toBe(false)

    const { result } = renderHook(() => useMarkRunSeen(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    act(() => result.current.mutate('run-1'))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // Stale, not refetched: nothing is observing the index from a task thread, so this costs no
    // request — the global page's next mount reads the truth.
    expect(client.getQueryState(workspaceQueryKeys.runsIndex)?.isInvalidated).toBe(true)
  })

  it('still stamps a detail cache that arrived only with the answer', async () => {
    fetchMock.mockResolvedValue(json({ ...RUN, seenAt: '2026-08-03T19:23:14.000Z' }))
    const client = createQueryClient()
    const { result } = renderHook(() => useMarkRunSeen(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    act(() => result.current.mutate('run-1'))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(client.getQueryData<typeof RUN & { seenAt: string }>(queryKeys.runs.detail('run-1'))?.seenAt)
      .toBe('2026-08-03T19:23:14.000Z')
  })
})

describe('useMarkRunUnseen', () => {
  const RUN = {
    id: 'run-1',
    title: 'mock:limit ship it',
    workflow: 'quick-task',
    task: 'mock:limit ship it',
    status: 'done',
    createdAt: '2026-08-03T19:23:00.000Z',
    finishedAt: '2026-08-03T19:23:13.000Z',
    seenAt: '2026-08-03T19:23:14.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
  }

  it('clears only the receipt, keeping fields the stream advanced meanwhile', async () => {
    // The same trap as the read twin above, and the reason this hook cannot simply write its
    // answer into the cache: `POST /runs/:id/unread` replies with the snapshot the server held
    // while the request was in flight, so writing it wholesale reverts anything the run stream
    // landed in that window — permanently, because nothing refetches afterwards. A finished run
    // is quieter than a just-finished one but not silent: here the janitor discovers the task's
    // PR link a beat after the click.
    const deferred = deferredResponse()
    fetchMock.mockReturnValue(deferred.promise)
    const client = createQueryClient()
    client.setQueryData(queryKeys.runs.detail('run-1'), RUN)
    client.setQueryData(queryKeys.runs.list(), [RUN])
    const { result } = renderHook(() => useMarkRunUnseen(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    act(() => result.current.mutate('run-1'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const linked = { ...RUN, pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/776' }
    client.setQueryData(queryKeys.runs.detail('run-1'), linked)
    client.setQueryData(queryKeys.runs.list(), [linked])

    // The answer is the pre-link snapshot the server had when it cleared the receipt.
    await act(async () => deferred.resolve(json({ ...RUN, seenAt: undefined })))

    const detail = client.getQueryData<typeof linked>(queryKeys.runs.detail('run-1'))
    expect(detail?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/776')
    // Absent, not blanked — `isUnread` keys on the field being missing.
    expect(detail && 'seenAt' in detail).toBe(false)
    const list = client.getQueryData<Array<typeof linked>>(queryKeys.runs.list())
    expect(list?.[0]?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/776')
    expect(list?.[0] && 'seenAt' in list[0]).toBe(false)
  })

  it('still falls back to the answer for a detail cache that arrived only with it', async () => {
    fetchMock.mockResolvedValue(json({ ...RUN, seenAt: undefined }))
    const client = createQueryClient()
    const { result } = renderHook(() => useMarkRunUnseen(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    act(() => result.current.mutate('run-1'))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const detail = client.getQueryData<typeof RUN>(queryKeys.runs.detail('run-1'))
    expect(detail?.id).toBe('run-1')
    expect(detail?.seenAt).toBeUndefined()
  })
})

describe('usePatchRun', () => {
  it('PATCHes the title and invalidates every runs query on success', async () => {
    fetchMock.mockResolvedValue(json({ id: 'run-1', title: 'New name', titleSummary: 'New name' }))
    const client = createQueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { result } = renderHook(() => usePatchRun('run-1'), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    result.current.mutate({ title: 'New name' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const [path, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
    expect(path).toBe('/api/v1/runs/run-1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ title: 'New name' })
    // `runs.all` is a prefix of the list, detail and diff keys — one call reaches them all.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.all })
  })

  it('does not invalidate anything on failure', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'not found' }), { status: 404, statusText: 'Not Found' }),
    )
    const client = createQueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { result } = renderHook(() => usePatchRun('nope'), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    result.current.mutate({ title: 'x' })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('useRunChanges', () => {
  it('opts out of the no-poll defaults so a finished run’s tab refetches on focus (#488)', async () => {
    fetchMock.mockResolvedValue(json({ files: [], stat: { adds: 0, dels: 0, files: 0 } }))
    const client = createQueryClient()
    // live=false: the run is not active, so polling is off — exactly when the global defaults would
    // otherwise leave a stale, possibly-empty snapshot on screen until the 5-min staleTime lapses.
    const { result } = renderHook(() => useRunChanges('run-1', false), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // Read the resolved options off the live observer: this query overrides the client-wide
    // refetchOnWindowFocus:false / long staleTime (asserted in 'query defaults'), scoped to itself.
    const options = client.getQueryCache().find({ queryKey: queryKeys.runs.changes('run-1') })?.observers[0]
      ?.options
    expect(options?.refetchOnWindowFocus).toBe(true)
    expect(options?.staleTime).toBe(0)
    // …but an inactive run still must not poll.
    expect(options?.refetchInterval).toBe(false)
  })
})

describe('query defaults', () => {
  it('never retries a 4xx — it is the server\'s considered answer', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'not found' }), { status: 404, statusText: 'Not Found' }),
    )
    const { result } = renderHook(() => useRun('nope'), { wrapper: wrapper() })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not poll — SSE drives freshness', () => {
    const client = createQueryClient()
    const defaults = client.getDefaultOptions().queries
    expect(defaults?.refetchInterval).toBe(false)
    expect(defaults?.refetchOnWindowFocus).toBe(false)
    expect(defaults?.staleTime).toBeGreaterThanOrEqual(60_000)
  })
})

/**
 * The refresh policy for reference statuses — and specifically, that the cockpit no longer HAS
 * one.
 *
 * Reference statuses are the one query family here that polls: everything else is told what
 * changed by the run stream, and GitHub is outside that stream, so a chip reading "checks running"
 * has no other way to ever stop saying it. But *when* to ask is forge semantics — a merged pull
 * request can never change, a closed one can be reopened, a running check finishes in minutes —
 * and those live server-side, next to the cache that decides whether asking would even reach
 * GitHub. The cockpit obeys `recheckAfterMs` and holds no table of its own; a second copy here
 * would be two sets of constants that must agree with nothing enforcing it.
 */
/**
 * One project, one name.
 *
 * The bug this pins: the global Tasks page keys every chip by its run's real `projectId`, because
 * its rows span the registry — while an unscoped surface (the sidebar, the run header, the
 * per-project table) used the `'default'` alias the routes accept. The same pull request was then
 * remembered under two names: a status learned on one surface never reached the other, and both
 * fetched it separately. Reported as "the ref updated in All tasks but the sidebar still holds
 * the old status".
 */
describe('useReferenceProjectId', () => {
  /** `useProjectScope` reads React context — the module-level `setApiScope` is a different seam. */
  const mounted = (scope: string | null, health?: unknown) => {
    const client = createQueryClient()
    if (health !== undefined) client.setQueryData(queryKeys.health, health)
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={client}>
          <ProjectScopeContext.Provider value={{ projectId: scope, apiBase: '/api/v1' }}>
            {children}
          </ProjectScopeContext.Provider>
        </QueryClientProvider>
      )
    }
  }

  it('uses the mounted scope when there is one', () => {
    const { result } = renderHook(() => useReferenceProjectId(), {
      wrapper: mounted('proj-a', { ...HEALTH, bootProject: 'boot-id' }),
    })
    expect(result.current).toBe('proj-a')
  })

  it('names the BOOT project when unscoped — never the `default` alias', () => {
    // `default` would key the same reference differently from every cross-project surface.
    const { result } = renderHook(() => useReferenceProjectId(), {
      wrapper: mounted(null, { ...HEALTH, bootProject: 'boot-id' }),
    })
    expect(result.current).toBe('boot-id')
  })

  it('answers undefined until health says which project that is', () => {
    // Better a neutral chip for a moment than an entry written under a name nothing else uses.
    const { result } = renderHook(() => useReferenceProjectId(), { wrapper: mounted(null) })
    expect(result.current).toBeUndefined()
  })
})

describe('useProjectRepoBase', () => {
  const mounted = (scope: string | null, health?: unknown, projects?: unknown) => {
    const client = createQueryClient()
    if (health !== undefined) client.setQueryData(queryKeys.health, health)
    if (projects !== undefined) client.setQueryData(workspaceQueryKeys.projects, { projects })
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={client}>
          <ProjectScopeContext.Provider value={{ projectId: scope, apiBase: '/api/v1' }}>
            {children}
          </ProjectScopeContext.Provider>
        </QueryClientProvider>
      )
    }
  }

  const REGISTRY = [
    { id: 'boot-id', name: 'boot', root: '/home/me/cezar', repoUrl: 'https://github.com/o/boot' },
    { id: 'proj-a', name: 'a', root: '/home/me/a', repoUrl: 'https://github.com/o/a' },
    { id: 'proj-b', name: 'b', root: '/home/me/b' },
  ]

  // The defect this was found through: the SAME task showed a linked chip on All tasks (which
  // reads the registry) and inert text on its own page (which read health, and health only names
  // the boot project's repo).
  it('answers a NON-boot project from the registry, where All tasks reads it', () => {
    const { result } = renderHook(() => useProjectRepoBase(), {
      wrapper: mounted('proj-a', { ...HEALTH, bootProject: 'boot-id', repo: { remote: 'git@github.com:o/boot.git' } }, REGISTRY),
    })
    expect(result.current).toBe('https://github.com/o/a')
  })

  it('never hands a project the boot repo — #526', () => {
    // `proj-b` has no forge remote of its own; health's is the boot project's and would be a link
    // into a completely different repository.
    const { result } = renderHook(() => useProjectRepoBase(), {
      wrapper: mounted('proj-b', { ...HEALTH, bootProject: 'boot-id', repo: { remote: 'git@github.com:o/boot.git' } }, REGISTRY),
    })
    expect(result.current).toBeUndefined()
  })

  it('falls back to health for the boot project — an unregistered boot folder still links', () => {
    const { result } = renderHook(() => useProjectRepoBase(), {
      wrapper: mounted(null, { ...HEALTH, bootProject: 'boot-id', repo: { remote: 'git@github.com:o/boot.git' } }, []),
    })
    expect(result.current).toBe('https://github.com/o/boot')
  })
})

describe('refStatusRecheckAfter', () => {
  const answered = (recheckAfterMs: number | null): GithubRefStatusData =>
    ({ available: true, prs: {}, issues: {}, recheckAfterMs }) as GithubRefStatusData

  it('takes the cadence from the answer, whatever it says', () => {
    expect(refStatusRecheckAfter(answered(60_000))).toBe(60_000)
    expect(refStatusRecheckAfter(answered(24 * 60 * 60_000))).toBe(24 * 60 * 60_000)
  })

  it('passes null through — nothing here can change, so nothing is scheduled', () => {
    // Becomes `refetchInterval: false` and an infinite staleTime, so a table of merged pull
    // requests costs nothing on a loop and ignores window focus too.
    expect(refStatusRecheckAfter(answered(null))).toBeNull()
  })

  it('obeys an unavailable answer as readily as a successful one', () => {
    expect(
      refStatusRecheckAfter({ available: false, reason: 'gh CLI not found', recheckAfterMs: 300_000 } as GithubRefStatusData),
    ).toBe(300_000)
  })

  it('falls back only where there is no answer to obey', () => {
    // Still loading, or errored out — `retry` owns the immediate attempt; this is the backstop
    // that keeps the query from going silent forever.
    expect(refStatusRecheckAfter(undefined)).toBeGreaterThan(0)
  })
})
