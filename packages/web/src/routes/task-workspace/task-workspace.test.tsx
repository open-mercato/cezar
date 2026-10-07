import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, HealthResponse } from '@open-mercato/cezar-api-client'

import { readState, storageKey, type ViewId } from './layout-state'
import { TaskWorkspaceRoute } from './task-workspace'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const RUN: ApiRun = {
  id: 'r1',
  title: 'do the thing plz',
  titleSummary: 'Do the thing',
  workflow: 'quick-task',
  task: 'Summarize what this project does.',
  status: 'review',
  createdAt: '2026-07-15T08:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  worktreePath: '/tmp/wt/r1',
  branch: 'cez/abc12345',
  baseBranch: 'main',
  seenAt: '2026-07-15T09:00:00.000Z',
  steps: [
    { id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's-1' },
  ],
}

const HEALTH: HealthResponse = {
  version: '0.0.0-test',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  checks: [],
  defaultRunner: 'claude',
  forge: { kind: 'github', available: true },
  capabilities: { localHandoff: true, terminal: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, dispatch: false },
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style: the run, health, and empty answers for everything the embedded
 *  views ask for, so a column renders its real empty state rather than a crash. */
function stubFetch(overrides: Record<string, () => Response> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === `/api/v1/runs/${RUN.id}`) return jsonResponse(RUN)
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(HEALTH)
      if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/history`)) {
        return jsonResponse({ events: [], olderCursor: null, newerCursor: null })
      }
      if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/events`)) return jsonResponse([])
      if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/drafts`)) return jsonResponse({ surfaces: {} })
      if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/changes`)) {
        return jsonResponse({ files: [], stat: { adds: 0, dels: 0, files: 0 } })
      }
      if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/commits`)) return jsonResponse({ commits: [] })
      if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/files`)) {
        return jsonResponse({ type: 'dir', path: '', entries: [] })
      }
      if (method === 'GET' && path === '/api/v1/runs') return jsonResponse([RUN])
      if (method === 'GET' && path === '/api/v1/repo') return jsonResponse(HEALTH.repo)
      return jsonResponse({ error: `unstubbed: ${path}` }, 404)
    }),
  )
}

function renderWorkspace(view?: ViewId) {
  const path = view === undefined ? '/tasks/:id' : `/tasks/:id/${view}`
  const entry = view === undefined ? '/tasks/r1' : `/tasks/r1/${view}`
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path={path} element={<TaskWorkspaceRoute view={view} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const cards = () => Array.from(document.querySelectorAll('[data-slot="layout-card"]'))
const cardNames = () => cards().map((card) => card.textContent?.replace(/\s+/g, ' ').trim())
const columns = () => Array.from(document.querySelectorAll('[data-slot="workspace-column"]'))
const columnViews = () => columns().map((column) => column.getAttribute('data-view'))
const dividers = () => Array.from(document.querySelectorAll('[data-slot="column-divider"]'))

/** The workspace is painted once the run resolves. */
async function ready() {
  await waitFor(() => expect(document.querySelector('[data-route="task-workspace"]')).not.toBeNull())
}

/** Radix menus open on `pointerdown`, which is the house pattern (run-header.test.tsx). */
async function openColumnMenu(index = 0) {
  const menus = screen.getAllByRole('button', { name: /^Menu kolumny/ })
  fireEvent.pointerDown(menus[index]!)
  await waitFor(() => expect(screen.queryByText('Zmień widok')).not.toBeNull())
}

/** The view items appear twice in a column menu — under `Zmień widok` and under `Dodaj kolumnę`.
 *  `which` picks the group, since the labels are what distinguish two identical lists. */
function pickView(label: string, which: 'change' | 'add') {
  const items = screen.getAllByRole('menuitem', { name: label })
  fireEvent.click(which === 'change' ? items[0]! : items[items.length - 1]!)
}

describe('the task workspace', () => {
  it('opens a clean visit on one full-width Czat column, under the run header', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    // The familiar anchor is still there…
    expect(document.querySelector('[data-slot="run-header"]')).not.toBeNull()
    // …with the layout strip in place of the four route tabs, and never both (spec §2).
    expect(cardNames()).toEqual(['Czat'])
    expect(screen.queryByRole('link', { name: 'Changes' })).toBeNull()
    expect(columnViews()).toEqual(['session'])
    // One column means no divider to drag.
    expect(dividers()).toHaveLength(0)
  })

  it('adds a second column from the column menu and gives it a divider', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    await openColumnMenu()
    pickView('Zmiany', 'add')

    await waitFor(() => expect(columnViews()).toEqual(['session', 'changes']))
    expect(dividers()).toHaveLength(1)
    // Two columns start at half width each (spec §5.2).
    expect(columns().map((column) => (column as HTMLElement).style.width)).toEqual(['50%', '50%'])
  })

  it('resizes the pair either side of a divider with the keyboard', async () => {
    stubFetch()
    localStorage.setItem(
      storageKey('r1'),
      JSON.stringify({
        layouts: [{ name: 'Czat', columns: [{ view: 'session', width: 50 }, { view: 'files', width: 50 }] }],
        active: 'Czat',
      }),
    )
    renderWorkspace()
    await ready()
    await waitFor(() => expect(dividers()).toHaveLength(1))

    const divider = dividers()[0]!
    expect(divider.getAttribute('role')).toBe('separator')
    expect(divider.getAttribute('aria-orientation')).toBe('vertical')
    expect(divider.getAttribute('aria-valuenow')).toBe('50')

    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    await waitFor(() =>
      expect(columns().map((column) => (column as HTMLElement).style.width)).toEqual(['52%', '48%']),
    )
    // Shift takes a bigger bite, and the separator reports where it now sits.
    fireEvent.keyDown(dividers()[0]!, { key: 'ArrowLeft', shiftKey: true })
    await waitFor(() =>
      expect(columns().map((column) => (column as HTMLElement).style.width)).toEqual(['42%', '58%']),
    )
    expect(dividers()[0]!.getAttribute('aria-valuenow')).toBe('42')
  })

  it('closes a column and divides the rest equally', async () => {
    stubFetch()
    localStorage.setItem(
      storageKey('r1'),
      JSON.stringify({
        layouts: [
          {
            name: 'Czat',
            columns: [
              { view: 'session', width: 60 },
              { view: 'files', width: 20 },
              { view: 'commits', width: 20 },
            ],
          },
        ],
        active: 'Czat',
      }),
    )
    renderWorkspace()
    await ready()
    await waitFor(() => expect(columnViews()).toHaveLength(3))

    fireEvent.click(screen.getByRole('button', { name: 'Zamknij kolumnę Pliki' }))
    await waitFor(() => expect(columnViews()).toEqual(['session', 'commits']))
    expect(columns().map((column) => (column as HTMLElement).style.width)).toEqual(['50%', '50%'])
  })

  it('closes the whole card when the last column goes, and offers a new one', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'Zamknij kolumnę Czat' }))
    await waitFor(() => expect(screen.queryByText('Brak układów')).not.toBeNull())
    expect(cards()).toHaveLength(0)
    expect(columns()).toHaveLength(0)
  })

  it('creates a card from Nowy układ and keeps the layout names unique', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    for (const expected of [2, 3]) {
      fireEvent.pointerDown(screen.getByRole('button', { name: /Nowy układ/ }))
      await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Commity' })).not.toBeNull())
      fireEvent.click(screen.getByRole('menuitem', { name: 'Commity' }))
      await waitFor(() => expect(cards()).toHaveLength(expected))
    }

    expect(cardNames()).toEqual(['Czat', 'Commity', 'Commity 2'])
  })

  it('renames a card from its context menu', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    fireEvent.contextMenu(cards()[0]!)
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Zmień nazwę' })).not.toBeNull())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Zmień nazwę' }))

    const field = await screen.findByLabelText('Nazwa układu Czat')
    fireEvent.change(field, { target: { value: 'Debug' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(cardNames()).toEqual(['Debug']))
    // …and it survives a reload of the very same task.
    expect(readState('r1').layouts.map((layout) => layout.name)).toEqual(['Debug'])
  })

  it('persists a built workspace for the next visit', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    await openColumnMenu()
    pickView('Pliki', 'add')
    await waitFor(() => expect(columnViews()).toEqual(['session', 'files']))

    const saved = readState('r1')
    expect(saved.layouts[0]!.columns.map((column) => column.view)).toEqual(['session', 'files'])
  })

  it('opens a deep link as its own card and leaves the saved layouts alone', async () => {
    stubFetch()
    localStorage.setItem(
      storageKey('r1'),
      JSON.stringify({
        layouts: [{ name: 'Czat', columns: [{ view: 'session', width: 100 }] }],
        active: 'Czat',
      }),
    )
    renderWorkspace('changes')
    await ready()

    await waitFor(() => expect(cardNames()).toEqual(['Czat', 'Zmiany']))
    expect(columnViews()).toEqual(['changes'])
    // The layout that was already there is untouched (spec §5.3).
    expect(readState('r1').layouts[0]!.columns).toEqual([{ view: 'session', width: 100 }])
  })

  it('recovers a malformed saved workspace to the one-column default without an error', async () => {
    stubFetch()
    localStorage.setItem(storageKey('r1'), '{ not json at all')
    renderWorkspace()
    await ready()

    expect(cardNames()).toEqual(['Czat'])
    expect(columnViews()).toEqual(['session'])
  })

  it('gives each column its own scroller, so the embedded views scroll inside it', async () => {
    stubFetch()
    localStorage.setItem(
      storageKey('r1'),
      JSON.stringify({
        layouts: [{ name: 'Czat', columns: [{ view: 'files', width: 50 }, { view: 'commits', width: 50 }] }],
        active: 'Czat',
      }),
    )
    renderWorkspace()
    await ready()

    await waitFor(() => expect(columns()).toHaveLength(2))
    // `data-slot="main"` is load-bearing, not decoration: the thread, the diff and the commit list
    // all find their scroll container with `closest('[data-slot="main"]')`.
    for (const column of columns()) {
      const scroller = column.querySelector('[data-slot="main"]')
      expect(scroller).not.toBeNull()
      expect(scroller!.className).toContain('overflow-y-auto')
    }
  })

  it('shows one column at a time on a narrow viewport', async () => {
    stubFetch()
    // jsdom has no matchMedia, which `useIsDesktop` counts as desktop — stub the narrow answer.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    localStorage.setItem(
      storageKey('r1'),
      JSON.stringify({
        layouts: [{ name: 'Czat', columns: [{ view: 'files', width: 50 }, { view: 'commits', width: 50 }] }],
        active: 'Czat',
      }),
    )
    renderWorkspace()
    await ready()

    await waitFor(() => expect(document.querySelector('[data-narrow]')).not.toBeNull())
    // Both columns are reachable as tabs, but only one is painted.
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Pliki', 'Commity'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(tabs[1]!)
    await waitFor(() => expect(screen.getAllByRole('tab')[1]!.getAttribute('aria-selected')).toBe('true'))
  })

  it('keeps two tasks apart when the route swaps run ids without remounting', async () => {
    stubFetch()
    localStorage.setItem(
      storageKey('r1'),
      JSON.stringify({
        layouts: [{ name: 'Tylko r1', columns: [{ view: 'files', width: 100 }] }],
        active: 'Tylko r1',
      }),
    )
    renderWorkspace()
    await ready()
    await waitFor(() => expect(cardNames()).toEqual(['Tylko r1']))

    // r2 has nothing saved, so it must open on its own default — never r1's card (spec §5.3).
    expect(readState('r2').layouts.map((layout) => layout.name)).toEqual(['Czat'])
  })
})
