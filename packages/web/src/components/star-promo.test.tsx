import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import type { DashboardInsights, RunRecord, StarCountPayload } from '@open-mercato/cezar-api-client'
import {
  STAR_ASK_KEY,
  STAR_ASK_PENDING_MS,
  STAR_ASK_PRESENCE_MS,
  STAR_ASK_SETTLE_MS,
  STAR_TOAST_SEEN_KEY,
} from '@/lib/star-promo'
import { StarPromo } from './star-promo'

/**
 * The star ask, wired: cache observation → presence → dialog.
 *
 * Most cases here are about a silence. What makes the dialog a request rather than a nag is the
 * set of moments it declines to open in — a first try, an empty room, a person mid-sentence —
 * so those are what this pins.
 */

let clients: QueryClient[] = []
let visibility: DocumentVisibilityState = 'visible'

function run(id: string, status: RunRecord['status']): RunRecord {
  return {
    id,
    title: `task ${id}`,
    workflow: 'default',
    task: 'do it',
    status,
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
  }
}
const AVAILABLE: StarCountPayload = { available: true, count: 1234, url: 'https://github.com/open-mercato/cezar' }
const UNAVAILABLE: StarCountPayload = { available: false, url: 'https://github.com/open-mercato/cezar' }
/** Two finished runs and one about to finish: the third success is the qualifying moment. */
const SEED = [run('a', 'done'), run('b', 'review'), run('c', 'running')]
const THIRD_DONE = [run('a', 'done'), run('b', 'review'), run('c', 'done')]

function mount(starCount: StarCountPayload | undefined = AVAILABLE, seed: RunRecord[] = SEED) {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
  const client = createQueryClient()
  clients.push(client)
  if (starCount) client.setQueryData(workspaceQueryKeys.starCount, starCount)
  client.setQueryData(queryKeys.runs.list(), seed)
  render(
    <QueryClientProvider client={client}>
      <StarPromo />
    </QueryClientProvider>,
  )
  const patch = (runs: RunRecord[]) => act(() => client.setQueryData(queryKeys.runs.list(), runs))
  return { client, patch }
}
const touch = () => act(() => fireEvent.pointerDown(window))
const settle = () => act(() => vi.advanceTimersByTime(STAR_ASK_SETTLE_MS))
const dialog = () => screen.queryByRole('dialog')
const record = () => JSON.parse(localStorage.getItem(STAR_ASK_KEY) ?? 'null')

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-02T12:00:00.000Z') })
  localStorage.clear()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  for (const client of clients) client.clear()
  clients = []
  localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('StarPromo', () => {
  it('asks when a run ends well, the user has three successes and is at the screen', () => {
    const { patch } = mount()
    touch()
    patch(THIRD_DONE)
    expect(dialog()).toBeNull() // never under a click in flight
    settle()
    expect(dialog()).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Is cezar pulling its weight?' })).toBeTruthy()
    expect(screen.getByText(/1\.2k stars on GitHub/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Star cezar on GitHub/ }).getAttribute('href')).toBe(
      'https://github.com/open-mercato/cezar',
    )
    expect(record()).toMatchObject({ asks: 1 })
  })

  it('stays silent for a first try — fewer than three successes is not "really uses cezar"', () => {
    const { patch } = mount(AVAILABLE, [run('a', 'done'), run('c', 'running')])
    touch()
    patch([run('a', 'done'), run('c', 'done')])
    settle()
    expect(dialog()).toBeNull()
  })

  it('waits for someone to come back to a hidden tab, then asks', () => {
    const { patch } = mount()
    visibility = 'hidden'
    touch()
    patch(THIRD_DONE)
    settle()
    expect(dialog()).toBeNull()
    act(() => vi.advanceTimersByTime(5 * 60_000))
    visibility = 'visible'
    touch()
    settle()
    expect(dialog()).not.toBeNull()
  })

  it('does not ask an empty room: no movement within the presence window means not watching', () => {
    const { patch } = mount()
    touch()
    act(() => vi.advanceTimersByTime(STAR_ASK_PRESENCE_MS + 1))
    patch(THIRD_DONE)
    settle()
    expect(dialog()).toBeNull()
    touch()
    settle()
    expect(dialog()).not.toBeNull()
  })

  it('lets a held success expire after the pending window', () => {
    const { patch } = mount()
    visibility = 'hidden'
    patch(THIRD_DONE)
    act(() => vi.advanceTimersByTime(STAR_ASK_PENDING_MS + 1))
    visibility = 'visible'
    touch()
    settle()
    expect(dialog()).toBeNull()
  })

  it('never interrupts typing', () => {
    const { patch } = mount()
    const field = document.createElement('textarea')
    document.body.append(field)
    field.focus()
    touch()
    patch(THIRD_DONE)
    settle()
    expect(dialog()).toBeNull()
    field.blur()
    touch()
    settle()
    expect(dialog()).not.toBeNull()
    field.remove()
  })

  it('stays silent on a cold boot full of finished runs', () => {
    mount(AVAILABLE, THIRD_DONE)
    touch()
    settle()
    expect(dialog()).toBeNull()
  })

  it('stays silent when promos are off — CEZ_NO_BANNER=1 reaches the browser as available:false', () => {
    const { patch } = mount(UNAVAILABLE)
    touch()
    patch(THIRD_DONE)
    settle()
    expect(dialog()).toBeNull()
  })

  it('counts the retired toast as an ask, so a recent toast holds the dialog back', () => {
    localStorage.setItem(STAR_TOAST_SEEN_KEY, new Date().toISOString())
    const { patch } = mount()
    touch()
    patch(THIRD_DONE)
    settle()
    expect(dialog()).toBeNull()
  })

  it('records "Don\'t ask again" for good, and "Maybe later" as a snooze', () => {
    const { patch } = mount()
    touch()
    patch(THIRD_DONE)
    settle()
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Maybe later' })))
    expect(record()).toEqual({ asks: 1, lastAskedAt: new Date().toISOString() })
    localStorage.setItem(STAR_ASK_KEY, JSON.stringify({ asks: 0 }))
    patch(SEED)
    touch()
    patch(THIRD_DONE)
    settle()
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Don’t ask again' })))
    expect(record()).toMatchObject({ outcome: 'never' })
  })

  it('records a star when the link is followed', () => {
    const { patch } = mount()
    touch()
    patch(THIRD_DONE)
    settle()
    act(() => fireEvent.click(screen.getByRole('link', { name: /Star cezar on GitHub/ })))
    expect(record()).toMatchObject({ outcome: 'starred' })
    expect(dialog()).toBeNull()
  })

  it('makes the case with the user\'s own last 30 days when they are known', () => {
    const { client, patch } = mount()
    client.setQueryData([...workspaceQueryKeys.dashboard, 'insights', '30d'], {
      delivered: { completedTasks: 23, prsOpened: 4, prsTouched: 4, issues: 1, additions: 966, deletions: 667, files: 27, measuredTasks: 22 },
    } as unknown as DashboardInsights)
    touch()
    patch(THIRD_DONE)
    settle()
    expect(screen.getByText('Your last 30 days with cezar')).toBeTruthy()
    expect(screen.getByText('23')).toBeTruthy()
    expect(screen.getByText('+966')).toBeTruthy()
  })
})
