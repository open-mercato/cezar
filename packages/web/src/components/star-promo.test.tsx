import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import type { RunRecord, RunStatus, StarCountPayload } from '@open-mercato/cezar-api-client'
import { STAR_TOAST_SEEN_KEY } from '@/lib/star-promo'
import { Toaster, resetToasts } from './ui/toaster'
import { StarPromo } from './star-promo'

/**
 * The star ask's one-time toast, wired: cache observation → toast, at most once per browser.
 *
 * Every case here is about a silence. The toast itself is three lines; what makes it a request
 * rather than a nag is the set of moments it declines to fire in, so those are what this pins.
 */

let clients: QueryClient[] = []

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

const AVAILABLE: StarCountPayload = {
  available: true,
  count: 1234,
  url: 'https://github.com/open-mercato/cezar',
}
const UNAVAILABLE: StarCountPayload = { available: false, url: 'https://github.com/open-mercato/cezar' }

/** Mount the watcher over a seeded cache, then apply the patch the SSE layer would. */
function mount(starCount: StarCountPayload | undefined, seed: RunRecord[]) {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
  const client = createQueryClient()
  clients.push(client)
  if (starCount) client.setQueryData(workspaceQueryKeys.starCount, starCount)
  client.setQueryData(queryKeys.runs.list(), seed)
  render(
    <QueryClientProvider client={client}>
      <StarPromo />
      <Toaster />
    </QueryClientProvider>,
  )
  const patch = (runs: RunRecord[]) => act(() => client.setQueryData(queryKeys.runs.list(), runs))
  return { client, patch }
}

const toasts = () => screen.queryAllByRole('status').map((node) => node.textContent ?? '')

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  for (const client of clients) client.clear()
  clients = []
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('StarPromo', () => {
  it('asks once when the first run enters done, with a link to cezar', () => {
    const { patch } = mount(AVAILABLE, [run({ status: 'running' })])
    patch([run({ status: 'done' })])

    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]).toContain('🎉')
    const link = screen.getByRole('link', { name: 'Star on GitHub' })
    expect(link.getAttribute('href')).toBe('https://github.com/open-mercato/cezar')
  })

  it('treats review as a success too — it is where a run that produced a PR parks', () => {
    const { patch } = mount(AVAILABLE, [run({ status: 'running' })])
    patch([run({ status: 'review' })])
    expect(toasts()).toHaveLength(1)
  })

  it('never asks twice, however many runs succeed afterwards', () => {
    const { patch } = mount(AVAILABLE, [run({ id: 'a', status: 'running' }), run({ id: 'b', status: 'running' })])
    patch([run({ id: 'a', status: 'done' }), run({ id: 'b', status: 'running' })])
    patch([run({ id: 'a', status: 'done' }), run({ id: 'b', status: 'review' })])
    expect(toasts()).toHaveLength(1)
  })

  it('records the ask so the NEXT session stays silent', () => {
    const { patch } = mount(AVAILABLE, [run({ status: 'running' })])
    patch([run({ status: 'done' })])
    expect(localStorage.getItem(STAR_TOAST_SEEN_KEY)).not.toBeNull()

    // A fresh mount over the same storage is the next page load.
    act(() => resetToasts())
    cleanup()
    const second = mount(AVAILABLE, [run({ id: 'c', status: 'running' })])
    second.patch([run({ id: 'c', status: 'done' })])
    expect(toasts()).toHaveLength(0)
  })

  it('stays silent on a cold boot full of finished runs', () => {
    // The cache seeds from the boot fetch. Nothing there is a transition, so a user opening the
    // cockpit on a week of finished work is not congratulated on a run from Tuesday.
    mount(AVAILABLE, [run({ id: 'a', status: 'done' }), run({ id: 'b', status: 'review' })])
    expect(toasts()).toHaveLength(0)
  })

  it('stays silent for failures and cancellations', () => {
    const { patch } = mount(AVAILABLE, [run({ id: 'a', status: 'running' }), run({ id: 'b', status: 'running' })])
    patch([run({ id: 'a', status: 'failed' }), run({ id: 'b', status: 'cancelled' })])
    expect(toasts()).toHaveLength(0)
  })

  it('stays silent when promos are off — CEZ_NO_BANNER=1 reaches the browser as available:false', () => {
    const { patch } = mount(UNAVAILABLE, [run({ status: 'running' })])
    patch([run({ status: 'done' })])
    expect(toasts()).toHaveLength(0)
    // And the flag is untouched, so the ask is deferred rather than silently spent.
    expect(localStorage.getItem(STAR_TOAST_SEEN_KEY)).toBeNull()
  })

  it('stays silent while the count has not answered yet', () => {
    const { patch } = mount(undefined, [run({ status: 'running' })])
    patch([run({ status: 'done' })])
    expect(toasts()).toHaveLength(0)
  })

  it('stays silent when this browser has already seen it, even on a brand-new success', () => {
    localStorage.setItem(STAR_TOAST_SEEN_KEY, '2026-01-01T00:00:00.000Z')
    const { patch } = mount(AVAILABLE, [run({ status: 'running' })])
    patch([run({ status: 'done' })])
    expect(toasts()).toHaveLength(0)
  })

  it('keeps observing transitions while gated, so flipping a gate cannot replay an old success', () => {
    // The whole point of tracking statuses before the gate: a run that finished while promos
    // were off is history, not a queued toast.
    const client = createQueryClient()
    clients.push(client)
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    client.setQueryData(workspaceQueryKeys.starCount, UNAVAILABLE)
    client.setQueryData(queryKeys.runs.list(), [run({ status: 'running' })])
    render(
      <QueryClientProvider client={client}>
        <StarPromo />
        <Toaster />
      </QueryClientProvider>,
    )
    act(() => client.setQueryData(queryKeys.runs.list(), [run({ status: 'done' })]))
    expect(toasts()).toHaveLength(0)

    // The gate opens. The already-`done` run is not a transition any more, so nothing fires.
    act(() => client.setQueryData(workspaceQueryKeys.starCount, AVAILABLE))
    act(() => client.setQueryData(queryKeys.runs.list(), [run({ status: 'done' })]))
    expect(toasts()).toHaveLength(0)
  })

  it('blocks nothing and renders nothing of its own', () => {
    const { container } = render(
      <QueryClientProvider client={(() => {
        const client = createQueryClient()
        clients.push(client)
        return client
      })()}>
        <StarPromo />
      </QueryClientProvider>,
    )
    expect(container.innerHTML).toBe('')
  })

  it('survives an unset run list — the cache is empty before the first fetch lands', () => {
    const client = createQueryClient()
    clients.push(client)
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    client.setQueryData(workspaceQueryKeys.starCount, AVAILABLE)
    expect(() =>
      render(
        <QueryClientProvider client={client}>
          <StarPromo />
          <Toaster />
        </QueryClientProvider>,
      ),
    ).not.toThrow()
    act(() => client.setQueryData<RunRecord[]>(queryKeys.runs.list(), undefined as unknown as RunRecord[]))
    expect(toasts()).toHaveLength(0)
  })

  it('ignores statuses outside the success set', () => {
    const { patch } = mount(AVAILABLE, [run({ status: 'queued' })])
    const nonSuccess: RunStatus[] = ['running', 'waiting', 'failed', 'cancelled']
    for (const status of nonSuccess) patch([run({ status })])
    expect(toasts()).toHaveLength(0)
  })
})
