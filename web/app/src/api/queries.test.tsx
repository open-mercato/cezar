import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from './client'
import { createQueryClient } from './query-client'
import { setApiScope } from './project-scope'
import {
  queryKeys,
  useProviderStatus,
  useRefreshProviderStatus,
  useRetryProviderAuth,
  useHealth,
  useRunnerModels,
  usePatchRun,
  usePutAgentConfigFile,
  useRun,
  useRunChanges,
  useRuns,
  useSkills,
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
}

describe('useRunnerModels', () => {
  it('loads the workspace Codex catalog', async () => {
    fetchMock.mockResolvedValue(json({ runner: 'codex', models: [{ id: 'gpt-future', label: 'Future', description: '' }], source: 'live', stale: false }))
    const { result } = renderHook(() => useRunnerModels(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.models[0]?.id).toBe('gpt-future')
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/models?runner=codex')
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
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/providers/status')
    expect(workspaceQueryKeys.providerStatus).toEqual(['workspace', 'providers', 'status'])
    expect(client.getQueryData(['workspace', 'providers', 'status'])).toEqual(PROVIDERS)

    setApiScope('proj-b')
    expect(workspaceQueryKeys.providerStatus).toEqual(['workspace', 'providers', 'status'])
  })

  it('polls exactly every 30 seconds', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(json(PROVIDERS))
    const { result } = renderHook(() => useProviderStatus(), { wrapper: wrapper() })

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.isSuccess).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(() => vi.advanceTimersByTimeAsync(29_999))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refetches on window focus', async () => {
    fetchMock.mockResolvedValue(json(PROVIDERS))
    const client = createQueryClient()
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, staleTime: 0 },
    })
    const { result } = renderHook(() => useProviderStatus(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/providers/status?refresh=1')
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
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/claude/retry', expect.objectContaining({
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
      if (String(input) === '/api/skills') {
        return json([{ name: 'local', source: 'ai', body: '', path: '/repo/local.md' }])
      }
      if (String(input) === '/api/skills?wait=1') {
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
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/skills', '/api/skills?wait=1'])
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
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/health')
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

  // #369: a `git checkout` in a foreground, connected tab fires none of reconnect/visibility/
  // pageshow, so the branch chip needs its own poll rather than relying solely on those.
  it('polls, so a branch switched outside the cockpit is caught without a reconnect', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValue(json(HEALTH))
      const { result } = renderHook(() => useHealth(), { wrapper: wrapper() })

      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(result.current.isSuccess).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await act(() => vi.advanceTimersByTimeAsync(5000))
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
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
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/p/proj-a/agent-config/claude.project.settings')

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
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/runs')
  })
})

describe('useRun', () => {
  it('does not fetch until it has an id', async () => {
    fetchMock.mockResolvedValue(json({ id: 'run-1' }))
    const { result, rerender } = renderHook(({ id }: { id?: string }) => useRun(id), {
      wrapper: wrapper(),
      initialProps: {},
    })

    // A route param that has not resolved yet must not become `GET /api/runs/undefined`.
    expect(result.current.fetchStatus).toBe('idle')
    expect(fetchMock).not.toHaveBeenCalled()

    rerender({ id: 'run-1' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/runs/run-1')
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
    expect(path).toBe('/api/runs/run-1')
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
