import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import type { RunRecord, RunStatus, WorkspaceUiState } from '@open-mercato/cezar-api-client'
import { RunNotifications } from './run-notifications'

/**
 * The notification trigger's wiring (R6 Step 1.7): cache observation → Notification.
 *
 * UNIT-PINNED ON PURPOSE: the `Notification` constructor is stubbed. Headless Chromium has the
 * API but never displays anything and Playwright cannot observe a constructed notification, so
 * an e2e assertion would be a stub test with extra steps — the honest pin is here, against the
 * real cache-subscription path (`setQueryData` is exactly what the SSE layer calls).
 */

let clients: QueryClient[] = []

/** The toggle lives in the GLOBAL ui-state since step 3.5 — seed the workspace key, which is
 *  the only one `RunNotifications` reads. */
function makeClient(uiState: WorkspaceUiState): QueryClient {
  const client = createQueryClient()
  client.setQueryData(workspaceQueryKeys.uiState, uiState)
  clients.push(client)
  return client
}

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    title: 'Normalize the agent-event protocol',
    workflow: 'default',
    task: 'normalize the protocol',
    status: 'running',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

/** A Notification stand-in: records constructions, throws never. */
function stubNotification(permission: NotificationPermission = 'granted') {
  const constructed: Array<{ title: string; options?: NotificationOptions }> = []
  function FakeNotification(this: unknown, title: string, options?: NotificationOptions) {
    constructed.push({ title, options })
  }
  ;(FakeNotification as unknown as { permission: string }).permission = permission
  vi.stubGlobal('Notification', FakeNotification)
  return constructed
}

/** Same override pattern as global-events.test.tsx; the own property is removed in afterEach. */
function hideTab(hidden = true) {
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  })
}

/** Mount the trigger, seed the run list, then apply the same patch the SSE layer would. */
function mount(uiState: WorkspaceUiState, seed: RunRecord[]) {
  // Queries would otherwise fire real fetches for ui-state/runs — keep them honestly pending.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
  const client = makeClient(uiState)
  client.setQueryData(queryKeys.runs.list(), seed)
  render(
    <QueryClientProvider client={client}>
      <RunNotifications />
    </QueryClientProvider>,
  )
  const patch = (runs: RunRecord[]) => act(() => client.setQueryData(queryKeys.runs.list(), runs))
  return { client, patch }
}

afterEach(() => {
  cleanup()
  for (const client of clients) client.clear()
  clients = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // Drop the visibility override so the next test starts from happy-dom's own 'visible'.
  delete (document as unknown as Record<string, unknown>).visibilityState
})

describe('RunNotifications', () => {
  it('notifies when a run enters waiting while the tab is hidden', () => {
    const constructed = stubNotification('granted')
    hideTab()
    const { patch } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])

    patch([run({ status: 'waiting' })])

    expect(constructed).toEqual([
      {
        title: 'Normalize the agent-event protocol',
        options: { body: 'Task needs you', tag: 'cezar-run-r1' },
      },
    ])
  })

  it('review and failed transitions notify too — one per run, tagged for replacement', () => {
    const constructed = stubNotification('granted')
    hideTab()
    const { patch } = mount({ notifications: { enabled: true } }, [
      run({ id: 'a', status: 'running' }),
      run({ id: 'b', status: 'running' }),
    ])

    patch([run({ id: 'a', status: 'review' }), run({ id: 'b', status: 'failed' })])

    expect(constructed.map((n) => [n.options?.tag, n.options?.body])).toEqual([
      ['cezar-run-a', 'Task needs review'],
      ['cezar-run-b', 'Task failed'],
    ])
  })

  it('the seeded list never notifies — a run already waiting at mount is the dot’s job', () => {
    const constructed = stubNotification('granted')
    hideTab()
    mount({ notifications: { enabled: true } }, [run({ status: 'waiting' })])
    expect(constructed).toEqual([])
  })

  it('the toggle gates: disabled (and the default OFF) stays silent', () => {
    const constructed = stubNotification('granted')
    hideTab()
    for (const uiState of [{}, { notifications: { enabled: false } }] as WorkspaceUiState[]) {
      const { patch } = mount(uiState, [run({ status: 'running' })])
      patch([run({ status: 'waiting' })])
    }
    expect(constructed).toEqual([])
  })

  it('a visible tab stays silent', () => {
    const constructed = stubNotification('granted')
    hideTab(false)
    const { patch } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])
    patch([run({ status: 'waiting' })])
    expect(constructed).toEqual([])
  })

  it('permission denied degrades to silence — no construction, no throw', () => {
    const constructed = stubNotification('denied')
    hideTab()
    const { patch } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])
    patch([run({ status: 'waiting' })])
    expect(constructed).toEqual([])
  })

  it('no Notification API at all degrades to silence', () => {
    vi.stubGlobal('Notification', undefined)
    hideTab()
    const { patch } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])
    expect(() => patch([run({ status: 'waiting' })])).not.toThrow()
  })

  it('a constructor that throws (Android Chrome) is swallowed — the courtesy never crashes the app', () => {
    hideTab()
    const Throwing = vi.fn(() => {
      throw new Error('Use ServiceWorkerRegistration.showNotification() instead.')
    })
    ;(Throwing as unknown as { permission: string }).permission = 'granted'
    vi.stubGlobal('Notification', Throwing)
    const { patch } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])
    expect(() => patch([run({ status: 'waiting' })])).not.toThrow()
    expect(Throwing).toHaveBeenCalledOnce()
  })

  it('statuses are tracked while disabled, so enabling later never replays old transitions', async () => {
    const constructed = stubNotification('granted')
    hideTab()
    const { client, patch } = mount({ notifications: { enabled: false } }, [
      run({ status: 'running' }),
    ])

    // The transition happens with the toggle off…
    patch([run({ status: 'waiting' })])
    expect(constructed).toEqual([])

    // …then the user enables (Settings PUT lands in the same cache). The macrotask flush lets
    // the query observer's deferred notification re-render the component with the new flag.
    act(() => client.setQueryData(workspaceQueryKeys.uiState, { notifications: { enabled: true } }))
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))

    // A token tick re-announces the unchanged waiting state — still no notification, because
    // the transition was observed (and remembered) while the toggle was off.
    patch([run({ status: 'waiting', tokensUsed: 42 })])
    expect(constructed).toEqual([])

    // A REAL new transition after enabling does notify.
    patch([run({ status: 'running', tokensUsed: 50 })])
    patch([run({ status: 'review', tokensUsed: 51 })])
    expect(constructed.map((n) => n.options?.body)).toEqual(['Task needs review'])
  })

  it('ignores unrelated cache updates (a detail query moving is not the run list)', () => {
    const constructed = stubNotification('granted')
    hideTab()
    const { client } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])
    act(() => client.setQueryData(queryKeys.runs.detail('r1'), run({ status: 'waiting' })))
    expect(constructed).toEqual([])
  })
})

// Type-level guard: the statuses this suite drives are real RunStatus members.
const _statuses: RunStatus[] = ['running', 'waiting', 'review', 'failed']
void _statuses
