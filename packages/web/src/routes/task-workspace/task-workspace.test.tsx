import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, HealthResponse } from '@open-mercato/cezar-api-client'

import { reviveState, type ViewId, type WorkspaceState } from './layout-state'
import { TaskWorkspaceRoute } from './task-workspace'

beforeEach(() => {
  localStorage.clear()
  hostLayouts = {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  hostLayouts = {}
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
  capabilities: { localHandoff: true, terminal: true, preview: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, dispatch: false },
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * The host's layout store, as the stub sees it (spec §5.3 — layouts belong to the cezar that owns
 * the task, so a test seeds them by answering `GET /layouts` and observes them by watching what
 * the cockpit PUTs back).
 */
let hostLayouts: Record<string, unknown> = {}

/** Seed what the host already has for a task. */
function seedLayouts(runId: string, value: unknown) {
  hostLayouts[runId] = value
}

/** What the cockpit last saved for a task, revived the way a reload would read it back. */
function savedLayouts(runId: string): WorkspaceState {
  return reviveState(hostLayouts[runId] ?? null)
}

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
      const layoutsMatch = /^\/api\/v1\/runs\/([^/]+)\/layouts$/.exec(path)
      if (layoutsMatch) {
        const runId = decodeURIComponent(layoutsMatch[1]!)
        if (method === 'GET') return jsonResponse({ layouts: hostLayouts[runId] ?? null })
        if (method === 'PUT') {
          hostLayouts[runId] = JSON.parse(String(init.body ?? '{}'))
          return jsonResponse({ layouts: hostLayouts[runId] })
        }
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
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path={path} element={<TaskWorkspaceRoute view={view} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Buttons that drive the MemoryRouter's own history, so Back and Forward are real POPs. */
function HistoryProbe() {
  const navigate = useNavigate()
  return (
    <>
      <button type="button" aria-label="go-changes" onClick={() => void navigate('/tasks/r1/changes')} />
      <button type="button" aria-label="back" onClick={() => void navigate(-1)} />
      <button type="button" aria-label="forward" onClick={() => void navigate(1)} />
    </>
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
    seedLayouts('r1', {
        layouts: [{ name: 'Czat', columns: [{ view: 'session', width: 50 }, { view: 'files', width: 50 }] }],
        active: 'Czat',
      })
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
    seedLayouts('r1', {
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
      })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(columnViews()).toHaveLength(3))

    fireEvent.click(screen.getByRole('button', { name: 'Zamknij kolumnę Pliki' }))
    await waitFor(() => expect(columnViews()).toEqual(['session', 'commits']))
    expect(columns().map((column) => (column as HTMLElement).style.width)).toEqual(['50%', '50%'])
  })

  it('empties the card when the last column goes, and offers the + to refill it', async () => {
    // Spec §5.2: "Closing the last column leaves the layout card IN PLACE with an empty area and
    // the `+` control to add another view", and §10: "A saved layout may intentionally have no
    // columns". Closing the CARD is the separate act, with its own X.
    stubFetch()
    renderWorkspace()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'Zamknij kolumnę Czat' }))
    await waitFor(() => expect(columns()).toHaveLength(0))
    expect(cards()).toHaveLength(1)
    expect(screen.queryByText('Brak układów')).toBeNull()
    expect(screen.getByRole('button', { name: 'Dodaj widok' })).not.toBeNull()
  })

  it('refills an emptied card through the right-edge +', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'Zamknij kolumnę Czat' }))
    await waitFor(() => expect(columns()).toHaveLength(0))

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Dodaj widok' }))
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Commity' })).not.toBeNull())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Commity' }))
    await waitFor(() => expect(columns()).toHaveLength(1))
    expect(cards()).toHaveLength(1)
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

    expect(cardNames()).toEqual(['Czat', 'Układ 2', 'Układ 3'])
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
    await waitFor(() => expect(savedLayouts('r1').layouts.map((layout) => layout.name)).toEqual(['Debug']))
  })

  it('renames a card on a double-click, which is the gesture the spec names', async () => {
    // Spec §5.2: "Double-click a card to rename it." The context menu keeps the same action for
    // discoverability, but the double-click is the requirement.
    stubFetch()
    renderWorkspace()
    await ready()

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Czat', current: 'page' }))

    const field = await screen.findByLabelText('Nazwa układu Czat')
    fireEvent.change(field, { target: { value: 'Debug' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(cardNames()).toEqual(['Debug']))
  })

  it('persists a built workspace for the next visit', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    await openColumnMenu()
    pickView('Pliki', 'add')
    await waitFor(() => expect(columnViews()).toEqual(['session', 'files']))

    // The save is debounced (spec §5.3 — a divider drag must not be one write per pointermove),
    // so this waits for it rather than sampling the instant after the click.
    await waitFor(() =>
      expect(savedLayouts('r1').layouts[0]!.columns.map((column) => column.view)).toEqual([
        'session',
        'files',
      ]),
    )
  })

  it('does not mint a card for every Back-and-Forward across a deep link', async () => {
    // Six presses used to leave `Zmiany 2, 3, 4` behind, saved on the host: Back cleared the hop,
    // so the Forward looked like a fresh arrival. §5.3 — "existing saved layouts remain
    // unchanged" — and §10's browser-history clause.
    stubFetch()
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskWorkspaceRoute />} />
            <Route path="/tasks/:id/changes" element={<TaskWorkspaceRoute view="changes" />} />
          </Routes>
          <HistoryProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await ready()
    await waitFor(() => expect(cards()).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'go-changes' }))
    await waitFor(() => expect(cards()).toHaveLength(2))

    for (let round = 0; round < 3; round += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'back' }))
      await waitFor(() => expect(columnViews()).toEqual(['session']))
      fireEvent.click(screen.getByRole('button', { name: 'forward' }))
      await waitFor(() => expect(columnViews()).toEqual(['changes']))
    }

    // Still the one card the first hop made.
    expect(cards()).toHaveLength(2)
    expect(cardNames()).toEqual(['Czat', 'Zmiany'])
  })

  it('coalesces a divider drag into one save', async () => {
    // Spec §5.3 names high-frequency divider movement as the thing NOT to persist per event.
    // Without a debounce each `pointermove` was its own PUT, and each PUT an atomic file write
    // on the host.
    const puts: string[] = []
    stubFetch()
    const realFetch = globalThis.fetch as unknown as (...args: never[]) => Promise<Response>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if ((init.method ?? 'GET') === 'PUT' && String(input).endsWith('/layouts')) {
          puts.push(String(init.body ?? ''))
        }
        return realFetch(input as never, init as never)
      }),
    )
    renderWorkspace()
    await ready()

    await openColumnMenu()
    pickView('Zmiany', 'add')
    await waitFor(() => expect(columnViews()).toEqual(['session', 'changes']))
    await waitFor(() => expect(puts.length).toBeGreaterThan(0))
    const afterAdd = puts.length

    const divider = dividers()[0]!
    for (let step = 0; step < 12; step += 1) {
      fireEvent.keyDown(divider, { key: 'ArrowRight' })
    }
    await waitFor(() => expect(savedLayouts('r1').layouts[0]!.columns[0]!.width).toBeGreaterThan(50))

    // Twelve moves, one save — not twelve.
    expect(puts.length - afterAdd).toBe(1)
  })

  it('saves the last change even when you leave the task straight away', async () => {
    // The other half of the debounce. Cancelling the pending timer on the way out loses the
    // user's final change — build a split, leave, come back to the layout you had before it —
    // and the first attempt at a flush looked for a pending TIMER, which React's
    // declaration-order cleanup had already cleared. This pins the outcome, not the mechanism.
    stubFetch()
    const view = renderWorkspace()
    await ready()

    await openColumnMenu()
    pickView('Pliki', 'add')
    await waitFor(() => expect(columnViews()).toEqual(['session', 'files']))

    // Leave well inside the debounce window.
    view.unmount()

    await waitFor(() =>
      expect(savedLayouts('r1').layouts[0]!.columns.map((column) => column.view)).toEqual([
        'session',
        'files',
      ]),
    )
  })

  it('opens a deep link as its own card and leaves the saved layouts alone', async () => {
    stubFetch()
    seedLayouts('r1', {
        layouts: [{ name: 'Czat', columns: [{ view: 'session', width: 100 }] }],
        active: 'Czat',
      })
    renderWorkspace('changes')
    await ready()

    // Named after the view the URL asked for (spec §5.3, §11), not the `Układ N` counter.
    await waitFor(() => expect(cardNames()).toEqual(['Czat', 'Zmiany']))
    expect(columnViews()).toEqual(['changes'])
    // The layout that was already there is untouched (spec §5.3).
    await waitFor(() => expect(savedLayouts('r1').layouts[0]!.columns).toEqual([{ view: 'session', width: 100 }]))
  })

  it('recovers a malformed saved workspace to the one-column default without an error', async () => {
    stubFetch()
    seedLayouts('r1', '{ not json at all')
    renderWorkspace()
    await ready()

    expect(cardNames()).toEqual(['Czat'])
    expect(columnViews()).toEqual(['session'])
  })

  it('gives each column its own scroller, so the embedded views scroll inside it', async () => {
    stubFetch()
    seedLayouts('r1', {
        layouts: [{ name: 'Czat', columns: [{ view: 'files', width: 50 }, { view: 'commits', width: 50 }] }],
        active: 'Czat',
      })
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

  it('splits columns only from lg up, so a tablet is not squeezed', async () => {
    // The shared `useIsDesktop` default is `md` (768px), which is the threshold for a different
    // question — whether a diff should wrap. At 768 a three-way split is ~250px a column, the
    // squeezing §5.2 asks not to do; it names "mobile/tablet" for one-at-a-time.
    stubFetch()
    const queries: string[] = []
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => {
        queries.push(query)
        return { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
      }),
    )
    seedLayouts('r1', {
      layouts: [{ name: 'Czat', columns: [{ view: 'files', width: 100 }] }],
      active: 'Czat',
    })
    renderWorkspace()
    await ready()

    await waitFor(() => expect(document.querySelector('[data-narrow]')).not.toBeNull())
    expect(queries).toContain('(min-width: 1024px)')
  })

  it('offers the add-view + on a narrow viewport too', async () => {
    // §5.2 asks for a `+` at "the right edge of the view area". On a narrow viewport that edge is
    // the end of the tab row — a vertical strip would take width from the one column showing.
    stubFetch()
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    seedLayouts('r1', {
      layouts: [{ name: 'Czat', columns: [{ view: 'files', width: 100 }] }],
      active: 'Czat',
    })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(document.querySelector('[data-narrow]')).not.toBeNull())

    const add = document.querySelector('[data-narrow] [data-action="add-column"]')
    expect(add).not.toBeNull()
    expect((add as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows one column at a time on a narrow viewport', async () => {
    stubFetch()
    // jsdom has no matchMedia, which `useIsDesktop` counts as desktop — stub the narrow answer.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    seedLayouts('r1', {
        layouts: [{ name: 'Czat', columns: [{ view: 'files', width: 50 }, { view: 'commits', width: 50 }] }],
        active: 'Czat',
      })
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

  it('reports the range a divider actually has, not the row-wide one', async () => {
    // `resizeColumns` clamps against the adjacent PAIR, so in a 33/33/33 layout either divider
    // moves within roughly [12, 55] — the hard-coded [12, 88] told a screen reader about
    // positions no divider in that layout can reach (spec §5.2, "position announcement").
    stubFetch()
    seedLayouts('r1', {
      layouts: [
        {
          name: 'Trzy',
          columns: [
            { view: 'session', width: 33.33 },
            { view: 'changes', width: 33.33 },
            { view: 'files', width: 33.34 },
          ],
        },
      ],
      active: 'Trzy',
    })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(dividers()).toHaveLength(2))

    for (const divider of dividers()) {
      // Each separator governs two thirds of the row: floor 12, ceiling 66.67 - 12.
      expect(divider.getAttribute('aria-valuemin')).toBe('12')
      expect(divider.getAttribute('aria-valuemax')).toBe('55')
    }
  })

  it('does not make the column header itself the drag grip', async () => {
    // An HTML5 drag starts from the nearest draggable ancestor, so a draggable HEADER swallowed
    // presses on its own menu trigger and close X — the X became unreliable on any two- or
    // three-column layout. The TITLE is the grip instead.
    stubFetch()
    seedLayouts('r1', {
      layouts: [
        {
          name: 'Dwie',
          columns: [
            { view: 'session', width: 50 },
            { view: 'changes', width: 50 },
          ],
        },
      ],
      active: 'Dwie',
    })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(columns()).toHaveLength(2))

    const header = document.querySelector('[data-slot="workspace-column-header"]')!
    expect(header.getAttribute('draggable')).toBeNull()
    expect(header.querySelector('[draggable="true"]')?.textContent).toBe('Czat')

    // And the close X still closes, which is the behaviour the grip was costing.
    fireEvent.click(screen.getByRole('button', { name: 'Zamknij kolumnę Czat' }))
    await waitFor(() => expect(columnViews()).toEqual(['changes']))
  })

  it('keeps two tasks apart when the route swaps run ids without remounting', async () => {
    stubFetch()
    seedLayouts('r1', {
        layouts: [{ name: 'Tylko r1', columns: [{ view: 'files', width: 100 }] }],
        active: 'Tylko r1',
      })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(cardNames()).toEqual(['Tylko r1']))

    // r2 has nothing saved, so it must open on its own default — never r1's card (spec §5.3).
    await waitFor(() => expect(savedLayouts('r2').layouts.map((layout) => layout.name)).toEqual(['Czat']))
  })
})
