import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { useRunHistory, type RunHistoryState } from '@/api/run-history'
import { resetViewMemory } from '@/lib/view-memory'
import type { ApiRun } from '@open-mercato/cezar-api-client'

import { TaskWorkspaceRoute } from '../task-workspace/task-workspace'
import { TaskThreadRoute } from './task-thread'
import { reduceThread } from './thread-state'

vi.mock('@/api/run-history', () => ({ useRunHistory: vi.fn() }))
vi.mock('./thread-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./thread-state')>()
  return { ...actual, reduceThread: vi.fn(actual.reduceThread) }
})

const run: ApiRun = {
  id: 'r-history', title: 'History start', task: 'Task', workflow: 'harness-implement-feature',
  status: 'running', runner: 'claude', tokensUsed: 0, archived: false,
  createdAt: '2026-07-31T00:00:00.000Z',
  steps: [{ id: 'spec', name: 'Specify', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0 }],
  harness: { profile: 'multi-optimized', workflow: 'harness-implement-feature' },
}
const events = [
  { seq: 1, type: 'step-start', stepId: 'spec', ts: run.createdAt },
  { seq: 2, type: 'item.completed', stepId: 'spec', ts: run.createdAt, item: { kind: 'message', id: 'm', role: 'assistant', text: 'Starting the specification' } },
]
const history: RunHistoryState = {
  visibleEvents: events, currentEvents: events,
  isPending: false, contextPending: false, fallback: false, hasOlder: true,
  isFetchingOlder: false, olderError: undefined, retainedPages: 1,
  loadOlder: async () => {}, jumpToLatest: async () => {},
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  resetViewMemory()
})

describe('history start in both transcript entry points', () => {
  const surfaces = [['TaskThreadRoute', TaskThreadRoute], ['TaskWorkspaceRoute', TaskWorkspaceRoute]] as const

  it.each(surfaces)('guard: round3 issue6 restores the first phase label when %s reaches the start of history', async (_name, Surface) => {
    const client = createQueryClient()
    client.setQueryData(queryKeys.runs.detail(run.id), run)
    vi.mocked(useRunHistory).mockReturnValue(history)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      const body = path === `/api/v1/runs/${run.id}` ? run
        : path.endsWith('/layouts') ? { layouts: null }
        : path === '/api/v1/runs' ? [run]
        : {}
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }))
    const view = () => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/tasks/${run.id}`]}>
          <Routes><Route path="/tasks/:id" element={<Surface />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
    const { rerender } = render(view())
    await screen.findByText('Starting the specification')
    expect(document.querySelector('[data-slot="step-divider"]')).toBeNull()
    vi.mocked(useRunHistory).mockReturnValue({ ...history, hasOlder: false })
    rerender(view())
    await waitFor(() => expect(document.querySelector('[data-slot="step-divider"]')?.textContent).toBe('Specify'))
  })

  it.each(surfaces.flatMap(([name, Surface]) => [
    ['round3 issue6 does not re-reduce ordinary history when only hasOlder changes', name, Surface, false] as const,
    ['guard: round3 issue6 still re-reduces changed ordinary events', name, Surface, true] as const,
  ]))('%s in %s', async (_label, _name, Surface, changesEvents) => {
    const ordinary = { ...run, harness: undefined, workflow: 'quick-task' }
    const client = createQueryClient()
    client.setQueryData(queryKeys.runs.detail(run.id), ordinary)
    vi.mocked(useRunHistory).mockReturnValue(history)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input) === `/api/v1/runs/${run.id}` ? ordinary
        : String(input).endsWith('/layouts') ? { layouts: null }
        : String(input) === '/api/v1/runs' ? [ordinary] : {},
    ), { headers: { 'content-type': 'application/json' } })))
    const view = () => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/tasks/${run.id}`]}>
          <Routes><Route path="/tasks/:id" element={<Surface />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
    const { rerender } = render(view())
    await screen.findByText('Starting the specification')
    vi.mocked(reduceThread).mockClear()
    const nextEvents = changesEvents ? [...events, {
      seq: 3, type: 'item.completed', ts: run.createdAt,
      item: { kind: 'message', id: 'new', role: 'assistant', text: 'New ordinary output' },
    }] : events
    vi.mocked(useRunHistory).mockReturnValue({ ...history, hasOlder: false, visibleEvents: nextEvents, currentEvents: nextEvents })
    rerender(view())
    if (changesEvents) {
      expect(reduceThread).toHaveBeenCalledTimes(2)
      await screen.findByText('New ordinary output')
    } else expect(reduceThread).not.toHaveBeenCalled()
    expect(document.querySelector('[data-slot="step-divider"]')).toBeNull()
  })

  it.each(surfaces)('guard: keeps an ordinary complete history divider-free in %s', async (_name, Surface) => {
    const ordinary = { ...run, harness: undefined, workflow: 'quick-task' }
    const client = createQueryClient()
    client.setQueryData(queryKeys.runs.detail(run.id), ordinary)
    vi.mocked(useRunHistory).mockReturnValue({ ...history, hasOlder: false })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input) === `/api/v1/runs/${run.id}` ? ordinary
        : String(input).endsWith('/layouts') ? { layouts: null }
        : String(input) === '/api/v1/runs' ? [ordinary] : {},
    ), { headers: { 'content-type': 'application/json' } })))
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/tasks/${run.id}`]}>
          <Routes><Route path="/tasks/:id" element={<Surface />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByText('Starting the specification')
    expect(document.querySelector('[data-slot="step-divider"]')).toBeNull()
  })
})
