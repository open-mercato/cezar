import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createUsageStore, type UsageStore } from './events'
import { GlobalEventsProvider, useGlobalEvents, useRunUsage, useUsage } from './global-events'
import { setApiScope } from '@open-mercato/cezar-api-client'
import { createQueryClient } from './query-client'
import { queryKeys, useProviderStatus, workspaceQueryKeys } from './queries'
import type { ApiRun, ProviderStatusResponse, RunRecord } from '@open-mercato/cezar-api-client'

/**
 * jsdom ships no EventSource at all (it is not in its supported-API set), so there is nothing to
 * spy on — the stub *is* the test double. Same lesson as `matchMedia` in the theme tests: stub the
 * missing global with something controllable rather than skip the behavior that depends on it.
 *
 * It implements only what the hook touches, and adds the levers the hook cannot: emit a message,
 * complete the connection, drop it the two ways a real one drops.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  static get last(): FakeEventSource {
    const instance = FakeEventSource.instances.at(-1)
    if (!instance) throw new Error('no EventSource was constructed')
    return instance
  }

  /** CONNECTING, as a real one starts. */
  readyState = 0
  closeCount = 0
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(readonly url: string, readonly init?: EventSourceInit) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, fn: (event: Event) => void): void {
    const set = this.listeners.get(name) ?? new Set()
    set.add(fn)
    this.listeners.set(name, set)
  }

  removeEventListener(name: string, fn: (event: Event) => void): void {
    this.listeners.get(name)?.delete(fn)
  }

  close(): void {
    this.readyState = 2
    this.closeCount += 1
  }

  private dispatch(name: string, event: Event): void {
    // act() because a handler writes to the query cache, which re-renders subscribers.
    act(() => {
      for (const fn of this.listeners.get(name) ?? []) fn(event)
    })
  }

  // ---- levers -----------------------------------------------------------------------------

  /** The server accepted the stream. */
  open(): void {
    this.readyState = 1
    this.dispatch('open', new Event('open'))
  }

  /** One `event:`/`data:` frame. */
  emit(name: string, data: string): void {
    this.dispatch(name, new MessageEvent(name, { data }))
  }

  /** A dropped connection the browser will retry on its own. */
  drop(): void {
    this.readyState = 0
    this.dispatch('error', new Event('error'))
  }

  /** A connection the browser gave up on — what a non-2xx from a restarting server produces. */
  fail(): void {
    this.readyState = 2
    this.dispatch('error', new Event('error'))
  }
}

function runRecord(id: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    title: id,
    workflow: 'quick-task',
    task: 'do it',
    status: 'running',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

const SAMPLE = { cpuPct: 12, rssBytes: 1024, procCount: 3 }

/** The boot project's id, as `GET /api/v1/health` reports it (`bootProject`). Unscoped, the
 *  workspace stream's filter compares every stamp against it. */
const BOOT = 'boot'

const CONNECTED_PROVIDERS: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: false },
    { provider: 'opencode', status: 'connected', enabled: true },
  ],
}

/** A `run` frame as the workspace stream sends it (step 2.8): the record with a `project`
 *  stamp riding along, which the parser strips back off before the reducers see it. */
function stampedRun(record: RunRecord, project = BOOT): string {
  return JSON.stringify({ ...record, project })
}

let client: QueryClient
let usage: UsageStore

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/** Mount the stream and hand back the levers. */
function mount() {
  const view = renderHook(() => useGlobalEvents(usage), { wrapper })
  return { ...view, source: FakeEventSource.last }
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

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

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  // No fetch: every query here is seeded via setQueryData, and an invalidate of a query nothing
  // observes never fetches. A stub that threw would be noise; one that answered would let a
  // refetch, rather than the reducer under test, be what put data in the cache.
  vi.stubGlobal('fetch', vi.fn())
  client = createQueryClient()
  usage = createUsageStore()
  // What the app's first health fetch establishes: which project this unscoped cockpit IS.
  // Without it every stamped frame is dropped (see the scoping describe below).
  client.setQueryData(queryKeys.health, { bootProject: BOOT })
  setVisibility('visible')
})

afterEach(() => {
  cleanup()
  setApiScope(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useGlobalEvents — connection', () => {
  it('opens exactly one stream, at /api/v1/workspace/events', () => {
    mount()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.last.url).toBe('/api/v1/workspace/events')
    expect(FakeEventSource.last.init).toEqual({ withCredentials: true })
  })

  it('closes the stream on unmount', () => {
    const { unmount, source } = mount()
    expect(source.closeCount).toBe(0)

    unmount()

    // A dropped reference is a leaked socket *and* a leaked retry loop: EventSource reconnects on
    // its own forever, so nothing but close() ends it.
    expect(source.closeCount).toBe(1)
    expect(source.readyState).toBe(2)
  })

  it('does not construct an EventSource where there is none', () => {
    // Prerender, or any jsdom test that renders <App/> without this stub. The guard is the reason
    // those don't explode.
    vi.stubGlobal('EventSource', undefined)
    expect(() => renderHook(() => useGlobalEvents(usage), { wrapper })).not.toThrow()
    expect(FakeEventSource.instances).toHaveLength(0)
  })
})

describe('useGlobalEvents — back/forward cache', () => {
  // jsdom has no PageTransitionEvent; a plain Event with `persisted` defined is what the
  // handler reads either way.
  function firePageShow(persisted: boolean): void {
    const event = new Event('pageshow')
    Object.defineProperty(event, 'persisted', { value: persisted })
    act(() => {
      window.dispatchEvent(event)
    })
  }

  it('closes the stream when the document is navigated away (pagehide)', () => {
    const { source } = mount()

    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    // The leak this prevents: a bfcached document's open EventSource keeps a real socket, and
    // six parked documents exhaust the per-origin pool — the NEXT page load hangs.
    expect(source.closeCount).toBe(1)
  })

  it('reopens the stream when the document is restored from bfcache', () => {
    mount()

    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    firePageShow(true)

    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.last.url).toBe('/api/v1/workspace/events')
  })

  it('does nothing on the pageshow of a normal load', () => {
    mount()

    firePageShow(false)

    expect(FakeEventSource.instances).toHaveLength(1)
  })
})

describe('useGlobalEvents — run events', () => {
  it('upserts a run into the list cache without refetching', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r1', { status: 'queued' })))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([
      runRecord('r1', { status: 'queued' }),
    ])
    // The whole point: a live run emits constantly, and none of it may become HTTP traffic.
    expect(fetch).not.toHaveBeenCalled()
  })

  it('updates in place on a second event for the same run — no duplicate row', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r1', { status: 'queued' })))
    source.emit('run', stampedRun(runRecord('r1', { status: 'running', tokensUsed: 42 })))
    source.emit('run', stampedRun(runRecord('r1', { status: 'done', tokensUsed: 99 })))

    const list = client.getQueryData<ApiRun[]>(queryKeys.runs.list())
    expect(list).toHaveLength(1)
    expect(list?.[0]?.status).toBe('done')
    expect(list?.[0]?.tokensUsed).toBe(99)
  })

  it('patches a run detail cache that exists, and creates none that does not', () => {
    client.setQueryData<ApiRun>(queryKeys.runs.detail('r1'), { ...runRecord('r1'), usage: SAMPLE })
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r1', { status: 'done' })))
    source.emit('run', stampedRun(runRecord('r2', { status: 'done' })))

    const detail = client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))
    expect(detail?.status).toBe('done')
    // The live sample the GET attached survives an event that never carried one.
    expect(detail?.usage).toEqual(SAMPLE)
    // r2 was never opened: a summary must not masquerade as a fetched detail.
    expect(client.getQueryData(queryKeys.runs.detail('r2'))).toBeUndefined()
  })

  it('invalidates the changes cache on a run event so an ended run’s final writes appear (#488)', () => {
    // The Changes tab stops polling the moment a run leaves the active set, so without this the
    // last diff would wait for the next SSE reconnect. A cache the user opened must refresh.
    client.setQueryData(queryKeys.runs.changes('r1'), { files: [], stat: { adds: 0, dels: 0, files: 0 } })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r1', { status: 'done' })))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.changes('r1') })
  })

  it('does not invalidate a changes cache nobody opened — no background diff fetch', () => {
    // Mirror of the detail-cache guard: a run event for a task whose Changes tab was never viewed
    // must not spawn a fetch for a diff no one is looking at.
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r2', { status: 'done' })))

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.runs.changes('r2') })
  })

  it('refreshes the cross-project index from ANOTHER project\u2019s run event', async () => {
    // The bug this covers: every non-active project's event was dropped before it touched
    // anything, so the global Tasks page — which spans the whole registry — heard nothing and ran
    // on its poll alone. A renamed or finished task in a project you were not standing in stayed
    // stale on screen until the next tick, and the tick does not run in a hidden tab.
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r9', { status: 'done' }), 'some-other-project'))

    // Debounced: one run emits many events, and a busy workspace emits from everywhere at once.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: workspaceQueryKeys.runsIndex })
    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: workspaceQueryKeys.runsIndex }),
    )
  })

  it('still refuses to write another project\u2019s run into THIS scope\u2019s list', async () => {
    // The index is cross-project; the scoped caches are not. Widening one must not widen the other.
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('r9', { status: 'done' }), 'some-other-project'))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])
  })

  it('coalesces a burst of run events into ONE index refresh', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()

    for (const status of ['queued', 'running', 'done'] as const) {
      source.emit('run', stampedRun(runRecord('r1', { status })))
    }

    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: workspaceQueryKeys.runsIndex }),
    )
    const indexRefreshes = invalidate.mock.calls.filter(
      (call) => (call[0] as { queryKey: unknown[] }).queryKey?.[1] === 'runs-index',
    )
    expect(indexRefreshes).toHaveLength(1)
  })

  it('ignores a malformed frame and keeps serving the next one', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    source.emit('run', 'not json{')
    source.emit('run', '{"no":"id"}')
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])

    source.emit('run', stampedRun(runRecord('r1')))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toHaveLength(1)
  })

  it('drops a deleted run from the list and throws away its detail and diff caches', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [runRecord('r1'), runRecord('r2')])
    client.setQueryData(queryKeys.runs.detail('r1'), runRecord('r1'))
    client.setQueryData(queryKeys.runs.diff('r1'), { files: [] })
    const { source } = mount()

    source.emit('run-deleted', JSON.stringify({ id: 'r1', project: BOOT }))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.map((r) => r.id)).toEqual(['r2'])
    // Removed, not emptied: anything still mounted on them must go ask the server and get its 404.
    expect(client.getQueryData(queryKeys.runs.detail('r1'))).toBeUndefined()
    expect(client.getQueryData(queryKeys.runs.diff('r1'))).toBeUndefined()
    expect(client.getQueryData(queryKeys.runs.detail('r2'))).toBeUndefined()
  })
})

describe('useGlobalEvents — todos', () => {
  it('replaces the inbox cache, seeding it even when nothing fetched it', () => {
    const { source } = mount()

    source.emit('todos', JSON.stringify({ project: BOOT, items: [{ id: 't1', summary: 'Review the PR' }] }))
    expect(client.getQueryData(queryKeys.todos)).toEqual([{ id: 't1', summary: 'Review the PR' }])

    // The payload is the whole inbox, so an emptied inbox really empties the badge.
    source.emit('todos', JSON.stringify({ project: BOOT, items: [] }))
    expect(client.getQueryData(queryKeys.todos)).toEqual([])
  })
})

describe('useGlobalEvents — usage', () => {
  it('feeds the usage store and never touches the runs cache', () => {
    const list: ApiRun[] = [runRecord('r1')]
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), list)
    client.setQueryData(queryKeys.runs.detail('r1'), runRecord('r1'))
    const { source } = mount()

    source.emit('usage', JSON.stringify({ project: BOOT, usage: { r1: SAMPLE } }))

    expect(usage.get()).toEqual({ r1: SAMPLE })
    // Identity, not equality: a ~2 s tick that replaced the cached list would re-render every
    // task row in the app forever, and would write telemetry into records that are never persisted.
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toBe(list)
    expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))?.usage).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ignores ping — it is a keep-alive, not news', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()

    source.emit('ping', '')

    expect(invalidate).not.toHaveBeenCalled()
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])
    expect(usage.get()).toEqual({})
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('useGlobalEvents — provider status', () => {
  it('patches the provider cache immediately from a workspace provider-status event', () => {
    client.setQueryData(workspaceQueryKeys.providerStatus, CONNECTED_PROVIDERS)
    const { source } = mount()

    source.emit('provider-status', JSON.stringify({
      provider: 'claude',
      status: 'disconnected',
      enabled: true,
      hint: 'Authentication was rejected during a run. Reconnect, then try again.',
    }))

    expect(client.getQueryData<ProviderStatusResponse>(
      workspaceQueryKeys.providerStatus,
    )?.providers[0]).toEqual({
      provider: 'claude',
      status: 'disconnected',
      enabled: true,
      hint: 'Authentication was rejected during a run. Reconnect, then try again.',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ignores malformed frames without poisoning the next provider-status event', () => {
    client.setQueryData(workspaceQueryKeys.providerStatus, CONNECTED_PROVIDERS)
    const { source } = mount()

    source.emit('provider-status', 'not json{')
    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toBe(CONNECTED_PROVIDERS)

    source.emit('provider-status', JSON.stringify({
      provider: 'future',
      status: 'disconnected',
    }))
    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toBe(CONNECTED_PROVIDERS)

    source.emit('provider-status', JSON.stringify({
      provider: 'codex',
      status: 'disconnected',
      enabled: false,
    }))
    expect(client.getQueryData<ProviderStatusResponse>(
      workspaceQueryKeys.providerStatus,
    )?.providers[1]).toEqual({
      provider: 'codex',
      status: 'disconnected',
      enabled: false,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not invent an unfetched provider cache', () => {
    const { source } = mount()

    source.emit('provider-status', JSON.stringify({
      provider: 'claude',
      status: 'disconnected',
    }))

    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ignores malformed and unknown unfetched provider events without starting a query', () => {
    const { source } = mount()

    source.emit('provider-status', 'not json{')
    source.emit('provider-status', JSON.stringify({ provider: 'future', status: 'disconnected' }))

    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cancels a stale initial provider request and refetches after an SSE incident', async () => {
    const initial = deferredResponse()
    const replacement = deferredResponse()
    const staleConnected = {
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'connected', enabled: true },
      ],
    }
    const latched = {
      providers: [
        {
          provider: 'claude',
          status: 'disconnected',
          enabled: true,
          authFailureId: 'incident-1',
          hint: 'Reconnect, then try again.',
        },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'connected', enabled: true },
      ],
    }
    vi.mocked(fetch).mockReturnValueOnce(initial.promise).mockReturnValueOnce(replacement.promise)

    function ProviderProbe() {
      const status = useProviderStatus()
      return <output data-testid="provider-status">{status.data?.providers[0]?.status ?? 'pending'}</output>
    }

    render(
      <QueryClientProvider client={client}>
        <GlobalEventsProvider>
          <ProviderProbe />
        </GlobalEventsProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    FakeEventSource.last.emit('provider-status', JSON.stringify({
      provider: 'claude',
      status: 'disconnected',
      authFailureId: 'incident-1',
      hint: 'Reconnect, then try again.',
    }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

    await act(async () => initial.resolve(json(staleConnected)))
    expect(client.getQueryData(workspaceQueryKeys.providerStatus)).toBeUndefined()
    expect(document.querySelector('[data-testid="provider-status"]')?.textContent).not.toBe('connected')

    await act(async () => replacement.resolve(json(latched)))
    await waitFor(() => expect(client.getQueryData<ProviderStatusResponse>(
      workspaceQueryKeys.providerStatus,
    )?.providers[0]).toMatchObject({ status: 'disconnected', authFailureId: 'incident-1' }))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('coalesces a second uncached provider event into one trailing refetch', async () => {
    const initial = deferredResponse()
    const replacement = deferredResponse()
    const final = deferredResponse()
    const staleConnected = {
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'connected', enabled: true },
      ],
    }
    const onlyClaudeIncident = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'incident-a' },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'connected', enabled: true },
      ],
    }
    const bothIncidents = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'incident-a' },
        { provider: 'codex', status: 'disconnected', enabled: true, authFailureId: 'incident-b' },
        { provider: 'opencode', status: 'connected', enabled: true },
      ],
    }
    vi.mocked(fetch)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(replacement.promise)
      .mockReturnValueOnce(final.promise)

    function ProviderProbe() {
      useProviderStatus()
      return null
    }

    render(
      <QueryClientProvider client={client}>
        <GlobalEventsProvider>
          <ProviderProbe />
        </GlobalEventsProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    FakeEventSource.last.emit('provider-status', JSON.stringify({
      provider: 'claude', status: 'disconnected', authFailureId: 'incident-a',
    }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    FakeEventSource.last.emit('provider-status', JSON.stringify({
      provider: 'codex', status: 'disconnected', authFailureId: 'incident-b',
    }))
    expect(fetch).toHaveBeenCalledTimes(2)

    await act(async () => initial.resolve(json(staleConnected)))
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => replacement.resolve(json(onlyClaudeIncident)))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    await act(async () => final.resolve(json(bothIncidents)))

    await waitFor(() => expect(client.getQueryData<ProviderStatusResponse>(
      workspaceQueryKeys.providerStatus,
    )).toEqual(bothIncidents))
    await act(async () => {})
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('applies provider status while a different project scope is active', () => {
    setApiScope('other-project')
    client.setQueryData(workspaceQueryKeys.providerStatus, CONNECTED_PROVIDERS)
    const { source } = mount()

    source.emit('provider-status', JSON.stringify({
      provider: 'opencode',
      status: 'disconnected',
      enabled: true,
    }))

    expect(client.getQueryData<ProviderStatusResponse>(
      workspaceQueryKeys.providerStatus,
    )?.providers[2]).toEqual({
      provider: 'opencode',
      status: 'disconnected',
      enabled: true,
    })
  })
})

describe('useGlobalEvents — project scoping (multi-project spec, step 3.1)', () => {
  it('drops another project\'s stamped events when unscoped — no cross-project cache bleed', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('theirs'), 'other-project'))
    source.emit('todos', JSON.stringify({ project: 'other-project', items: [{ id: 't9' }] }))
    source.emit('usage', JSON.stringify({ project: 'other-project', usage: { theirs: SAMPLE } }))

    // The one stream carries every project; only the boot project's news may land here.
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])
    expect(client.getQueryData(queryKeys.todos)).toBeUndefined()
    expect(usage.get()).toEqual({})
  })

  it('drops an unstamped frame — without an owner it belongs to no one', () => {
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    // The pre-workspace wire shape. Applying it unattributed is exactly the bleed the
    // envelope exists to prevent.
    source.emit('run', JSON.stringify(runRecord('r1')))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])
  })

  it('drops stamped events until health has named the boot project, without crashing', () => {
    client.removeQueries({ queryKey: queryKeys.health })
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    // Harmless by the doctrine: at boot the authoritative queries are fetching right now.
    source.emit('run', stampedRun(runRecord('r1')))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])

    // Health answered — from here on the boot project's events flow.
    client.setQueryData(queryKeys.health, { bootProject: BOOT })
    source.emit('run', stampedRun(runRecord('r1')))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toHaveLength(1)
  })

  it('applies the scoped project\'s events — and only those — once a scope is mounted', () => {
    setApiScope('other-project')
    // Scoped keys: this cache belongs to other-project (queries.ts leads every key with the scope).
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [])
    const { source } = mount()

    source.emit('run', stampedRun(runRecord('boot-run'), BOOT))
    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())).toEqual([])

    source.emit('run', stampedRun(runRecord('theirs'), 'other-project'))
    source.emit('usage', JSON.stringify({ project: 'other-project', usage: { theirs: SAMPLE } }))

    expect(client.getQueryData<ApiRun[]>(queryKeys.runs.list())?.map((r) => r.id)).toEqual(['theirs'])
    expect(usage.get()).toEqual({ theirs: SAMPLE })
  })
})

describe('useGlobalEvents — reconcile doctrine', () => {
  /** The keys a reconcile must reach. */
  function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[] {
    return spy.mock.calls.map((call) => (call[0] as { queryKey: unknown }).queryKey)
  }

  it('does not reconcile on the first open — the queries are already fetching', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { source } = mount()

    source.open()

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('refetches the authoritative endpoints on reconnect', () => {
    const { source } = mount()
    source.open()
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    // The socket dropped; EventSource retried it on its own and got back in. Whatever happened in
    // between never reached this client, so the cache is now a guess.
    source.drop()
    source.open()

    expect(invalidatedKeys(invalidate)).toEqual([
      queryKeys.runs.all, // covers the list and every detail under it
      // The cross-project index behind the global Tasks page. Nothing else here covers it: the
      // scoped caches hold one project, and this spans the workspace.
      workspaceQueryKeys.runsIndex,
      queryKeys.todos,
      queryKeys.health, // the repo/branch chip — health is not on the stream (#369)
      queryKeys.worktrees, // the Resources panel's list/total (#483)
      workspaceQueryKeys.providerStatus,
    ])
  })

  it('refetches when a hidden tab comes back', () => {
    const { source } = mount()
    source.open()
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    setVisibility('hidden')
    expect(invalidate).not.toHaveBeenCalled()

    // A phone that slept: the tab was frozen, no error handler ever ran, and the stream may have
    // been dead for an hour. What is on screen is about to be read as true.
    setVisibility('visible')
    expect(invalidatedKeys(invalidate)).toEqual([
      queryKeys.runs.all,
      // The cross-project index behind the global Tasks page — nothing else here covers it.
      workspaceQueryKeys.runsIndex,
      queryKeys.todos,
      queryKeys.health,
      queryKeys.worktrees,
      workspaceQueryKeys.providerStatus,
    ])
  })

  it('stops listening for visibility once unmounted', () => {
    const { unmount, source } = mount()
    source.open()
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    unmount()
    setVisibility('hidden')
    setVisibility('visible')

    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('useGlobalEvents — recovery', () => {
  it('leaves an ordinary drop to the browser', () => {
    vi.useFakeTimers()
    const { source } = mount()
    source.open()

    // readyState CONNECTING: EventSource is already retrying on its own backoff, and a second
    // stream racing it would be two connections and duplicate events.
    source.drop()
    act(() => void vi.advanceTimersByTime(30_000))

    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('rebuilds a stream the browser gave up on', () => {
    vi.useFakeTimers()
    const { source } = mount()
    source.open()

    // What a restarting server produces: the request is answered with a non-2xx, EventSource closes
    // for good, and nothing would ever reopen it — the cockpit would look live showing stale state.
    source.fail()
    expect(FakeEventSource.instances).toHaveLength(1)

    act(() => void vi.advanceTimersByTime(3_000))
    expect(FakeEventSource.instances).toHaveLength(2)

    // And the rebuilt stream is a reconnect: its open reconciles.
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    FakeEventSource.last.open()
    expect(invalidate).toHaveBeenCalled()
  })

  it('does not reopen after unmount', () => {
    vi.useFakeTimers()
    const { unmount, source } = mount()
    source.fail()
    unmount()

    act(() => void vi.advanceTimersByTime(30_000))
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('reopens a dead stream immediately when the tab comes back, without waiting out the backoff', () => {
    vi.useFakeTimers()
    const { source } = mount()
    source.open()
    source.fail()

    setVisibility('visible')

    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.last.readyState).toBe(0)

    // The pending backoff must not then build a third one on top.
    act(() => void vi.advanceTimersByTime(30_000))
    expect(FakeEventSource.instances).toHaveLength(2)
  })
})

describe('GlobalEventsProvider', () => {
  it('mounts one stream for the whole tree and publishes usage to it', () => {
    function Probe() {
      const all = useUsage()
      const one = useRunUsage('r1')
      return <output data-testid="probe">{`${Object.keys(all).join(',')}|${one?.cpuPct ?? '-'}`}</output>
    }

    const view = render(
      <QueryClientProvider client={client}>
        <GlobalEventsProvider>
          <Probe />
          <Probe />
        </GlobalEventsProvider>
      </QueryClientProvider>,
    )

    // Two consumers, one connection.
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(view.getAllByTestId('probe')[0]?.textContent).toBe('|-')

    FakeEventSource.last.emit('usage', JSON.stringify({ project: BOOT, usage: { r1: SAMPLE } }))

    for (const probe of view.getAllByTestId('probe')) {
      expect(probe.textContent).toBe('r1|12')
    }
  })

  it('renders outside a provider as an idle cockpit, not a crash', () => {
    function Probe() {
      return <output data-testid="probe">{`${Object.keys(useUsage()).length}${useRunUsage('r1') ? '!' : ''}`}</output>
    }
    // Telemetry must never be the reason a tree fails to render.
    const view = render(<Probe />)
    expect(view.getByTestId('probe').textContent).toBe('0')
  })
})
