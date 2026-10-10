import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { ShellProviders } from '@/test/shell-providers'
import type { ApiRun, HealthResponse } from '@open-mercato/cezar-api-client'

import { reviveState, type ViewId, type WorkspaceState } from './layout-state'

// The Graph column lazily pulls `@xyflow/react` and its layout engine. This suite is about the
// LAYOUT, so the view stands in — what matters here is that the column mounts and says which
// run it was handed.
vi.mock('../workflow-graph/task-graph', () => ({
  GraphView: ({ run, embedded }: { run: { id: string }; embedded?: boolean }) => (
    <div data-testid="graph-view" data-run={run.id} data-embedded={embedded ? '' : undefined} />
  ),
}))

const { TaskWorkspaceRoute } = await import('./task-workspace')

beforeEach(() => {
  localStorage.clear()
  hostLayouts = {}
  // The strip MEASURES how many cards fit and folds the rest into its `…` menu. jsdom lays nothing
  // out — every width is 0 — so without a row to measure the strip would fold every card but the
  // active one. Give it a wide one: this suite is about the cards, not about the fold.
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(2000)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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
  capabilities: { localHandoff: true, terminal: true, preview: true, designMode: true, fileEdit: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, dispatch: false },
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

/** What the app shell gives the route: the query cache, and the shell's own contexts — the split
 *  button's tooltip needs the provider the sidebar mounts. */
function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <ShellProviders>{children}</ShellProviders>
    </QueryClientProvider>
  )
}

function renderWorkspace(view?: ViewId) {
  const path = view === undefined ? '/tasks/:id' : `/tasks/:id/${view}`
  const entry = view === undefined ? '/tasks/r1' : `/tasks/r1/${view}`
  return render(
    <Providers>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path={path} element={<TaskWorkspaceRoute view={view} />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  )
}

/** Buttons that drive the MemoryRouter's own history, so Back and Forward are real POPs. */
function HistoryProbe() {
  const navigate = useNavigate()
  return (
    <>
      <button type="button" aria-label="go-changes" onClick={() => void navigate('/tasks/r1/changes')} />
      <button type="button" aria-label="go-r2" onClick={() => void navigate('/tasks/r2')} />
      <button type="button" aria-label="back" onClick={() => void navigate(-1)} />
      <button type="button" aria-label="forward" onClick={() => void navigate(1)} />
    </>
  )
}

/** The fixed cards of a task with no workflow graph, left to right: one per view, always there. */
const FIXED = ['Chat', 'Changes', 'Commits', 'Code', 'Browser']
/** The saved layouts a task is born with — one plain card per view, each drawn as its fixed card. */
const BORN = ['Chat', 'Changes', 'Commits', 'Code', 'Browser', 'Graph']

const cards = () => Array.from(document.querySelectorAll('[data-slot="layout-card"]'))
const cardNames = () => cards().map((card) => card.textContent?.replace(/\s+/g, ' ').trim())
/** The cards of layouts the user built — the ones that can be renamed and closed. */
const builtCards = () => cards().filter((card) => !card.hasAttribute('data-fixed'))
const activeCard = () =>
  document.querySelector('[data-slot="layout-card"][data-active]')?.textContent?.replace(/\s+/g, ' ').trim()
const columns = () => Array.from(document.querySelectorAll('[data-slot="workspace-column"]'))
const columnViews = () => columns().map((column) => column.getAttribute('data-view'))
const dividers = () => Array.from(document.querySelectorAll('[data-slot="column-divider"]'))
const stage = () => document.querySelector('[data-slot="workspace-stage"]')
const savedNames = (runId: string) => savedLayouts(runId).layouts.map((layout) => layout.name)
const savedViews = (runId: string, name: string) =>
  savedLayouts(runId).layouts.find((layout) => layout.name === name)?.columns.map((column) => column.view)

/** The workspace is painted once the run resolves, and usable once the host has answered with
 *  this task's layouts — which is when a card first wears the active mark. */
async function ready() {
  await waitFor(() => expect(document.querySelector('[data-route="task-workspace"]')).not.toBeNull())
  await waitFor(() => expect(activeCard()).toBeDefined())
}

/** The strip's `+`: a new, EMPTY layout, whose stage is the tile picker for its first view. */
async function newLayout() {
  fireEvent.click(screen.getByRole('button', { name: 'New layout' }))
  await waitFor(() => expect(document.querySelector('[data-slot="view-tiles-stage"]')).not.toBeNull())
}

/** Pick a view's tile — in an empty layout, or in a window that was just split off. Found by the
 *  view id, which is the hook a copy change cannot move. */
async function pickTile(view: ViewId) {
  const tile = () => document.querySelector<HTMLElement>(`[data-slot="view-tiles-stage"] [data-view="${view}"]`)
  await waitFor(() => expect(tile()).not.toBeNull())
  fireEvent.click(tile()!)
}

/** Build a two-window layout the way a user does: `+`, a tile, split, another tile. */
async function buildPair(first: ViewId, second: ViewId) {
  await newLayout()
  await pickTile(first)
  await waitFor(() => expect(columnViews()).toEqual([first]))
  fireEvent.click(screen.getByRole('button', { name: 'Split view' }))
  await pickTile(second)
  await waitFor(() => expect(columnViews()).toEqual([first, second]))
}

describe('the task workspace', () => {
  it('opens a clean visit on Chat, under the run header', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    // The familiar anchor is still there…
    expect(document.querySelector('[data-slot="run-header"]')).not.toBeNull()
    // …with the layout strip in place of the four route tabs, and never both (spec §2): one fixed
    // card per view, Chat first and showing.
    expect(cardNames()).toEqual(FIXED)
    expect(activeCard()).toBe('Chat')
    expect(screen.getByRole('button', { name: 'Chat', pressed: true })).not.toBeNull()
    expect(screen.queryByRole('link', { name: 'Changes' })).toBeNull()
    // A fixed card is a standing surface, not a saved layout: nothing to close or rename.
    expect(builtCards()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /^Close layout/ })).toBeNull()
    // Chat is the task's home: the conversation fills the stage in its own scroller, with no
    // column chrome around it and so no divider to drag.
    expect(stage()!.querySelector('[data-slot="main"]')).not.toBeNull()
    expect(columns()).toHaveLength(0)
    expect(dividers()).toHaveLength(0)
  })

  it('shows the view of the fixed card that was picked, without minting a layout', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    await waitFor(() => expect(columnViews()).toEqual(['files']))
    expect(activeCard()).toBe('Code')
    expect(cardNames()).toEqual(FIXED)
    // A fixed card stays the one view it stands for: its window has no header to edit it by.
    expect(document.querySelector('[data-slot="workspace-column-header"]')).toBeNull()
    await waitFor(() => expect(savedLayouts('r1').active).toBe('Code'))
    expect(savedNames('r1')).toEqual(BORN)
  })

  it('splits a window of a built layout and gives the pair a divider', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    await buildPair('session', 'changes')

    expect(dividers()).toHaveLength(1)
    // Two columns start at half width each (spec §5.2).
    expect(columns().map((column) => (column as HTMLElement).style.width)).toEqual(['50%', '50%'])
  })

  it('resizes the pair either side of a divider with the keyboard', async () => {
    stubFetch()
    seedLayouts('r1', {
        layouts: [{ name: 'Pair', columns: [{ view: 'session', width: 50 }, { view: 'files', width: 50 }] }],
        active: 'Pair',
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
            name: 'Trio',
            columns: [
              { view: 'session', width: 60 },
              { view: 'files', width: 20 },
              { view: 'commits', width: 20 },
            ],
          },
        ],
        active: 'Trio',
      })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(columnViews()).toHaveLength(3))

    fireEvent.click(screen.getByRole('button', { name: 'Close Code' }))
    await waitFor(() => expect(columnViews()).toEqual(['session', 'commits']))
    expect(columns().map((column) => (column as HTMLElement).style.width)).toEqual(['50%', '50%'])
  })

  it('empties the card when the last column goes, and offers the tiles to refill it', async () => {
    // Spec §5.2: "Closing the last column leaves the layout card IN PLACE with an empty area" to
    // add another view from, and §10: "A saved layout may intentionally have no columns". Closing
    // the CARD is the separate act, with its own X.
    stubFetch()
    seedLayouts('r1', { layouts: [{ name: 'Solo', columns: [{ view: 'files', width: 100 }] }], active: 'Solo' })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(columnViews()).toEqual(['files']))

    fireEvent.click(screen.getByRole('button', { name: 'Close Code' }))
    await waitFor(() => expect(columns()).toHaveLength(0))
    expect(cardNames()).toEqual([...FIXED, 'Solo'])
    expect(activeCard()).toBe('Solo')
    expect(screen.queryByText('No layouts')).toBeNull()
    expect(screen.getByRole('heading', { name: 'What should this layout show?' })).not.toBeNull()
    // And the emptied card is what gets saved — a layout with no columns, not a closed one.
    await waitFor(() => expect(savedLayouts('r1').layouts).toEqual([{ name: 'Solo', columns: [] }]))
  })

  it('refills an emptied card from its tiles', async () => {
    stubFetch()
    seedLayouts('r1', { layouts: [{ name: 'Solo', columns: [{ view: 'files', width: 100 }] }], active: 'Solo' })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(columnViews()).toEqual(['files']))

    fireEvent.click(screen.getByRole('button', { name: 'Close Code' }))
    await waitFor(() => expect(columns()).toHaveLength(0))

    await pickTile('commits')
    await waitFor(() => expect(columnViews()).toEqual(['commits']))
    expect(cardNames()).toEqual([...FIXED, 'Solo'])
  })

  it('creates a card from New layout and keeps the layout names unique', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    for (const expected of [1, 2]) {
      await newLayout()
      await waitFor(() => expect(builtCards()).toHaveLength(expected))
    }

    // Numbered by position among the task's layouts, the six it was born with included.
    expect(cardNames()).toEqual([...FIXED, 'Layout 7', 'Layout 8'])
    expect(activeCard()).toBe('Layout 8')
  })

  it('renames a card from its context menu', async () => {
    stubFetch()
    seedLayouts('r1', { layouts: [{ name: 'Notes', columns: [{ view: 'files', width: 100 }] }], active: 'Notes' })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(builtCards()).toHaveLength(1))

    fireEvent.contextMenu(builtCards()[0]!)
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Rename layout' })).not.toBeNull())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename layout' }))

    const field = await screen.findByLabelText('Layout name Notes')
    fireEvent.change(field, { target: { value: 'Debug' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(cardNames()).toEqual([...FIXED, 'Debug']))
    // …and it survives a reload of the very same task.
    await waitFor(() => expect(savedNames('r1')).toEqual(['Debug']))
  })

  it('renames a card on a double-click, which is the gesture the spec names', async () => {
    // Spec §5.2: "Double-click a card to rename it." The context menu keeps the same action for
    // discoverability, but the double-click is the requirement.
    stubFetch()
    seedLayouts('r1', { layouts: [{ name: 'Notes', columns: [{ view: 'files', width: 100 }] }], active: 'Notes' })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(builtCards()).toHaveLength(1))

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Notes', current: 'page' }))

    const field = await screen.findByLabelText('Layout name Notes')
    fireEvent.change(field, { target: { value: 'Debug' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(cardNames()).toEqual([...FIXED, 'Debug']))
  })

  it('persists a built workspace for the next visit', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    await buildPair('session', 'files')

    // The save is debounced (spec §5.3 — a divider drag must not be one write per pointermove),
    // so this waits for it rather than sampling the instant after the click.
    await waitFor(() => expect(savedViews('r1', 'Layout 7')).toEqual(['session', 'files']))
    expect(savedNames('r1')).toEqual([...BORN, 'Layout 7'])
    expect(savedLayouts('r1').active).toBe('Layout 7')
  })

  it('does not mint a card for every Back-and-Forward across a deep link', async () => {
    // Six presses used to leave `Changes 2, 3, 4` behind, saved on the host: Back cleared the hop,
    // so the Forward looked like a fresh arrival. §5.3 — "existing saved layouts remain
    // unchanged" — and §10's browser-history clause.
    //
    // The user split their Changes card, so the link has no plain card of that view to select and
    // must MINT one — which is the only case where a second arrival could mint another.
    stubFetch()
    seedLayouts('r1', {
      layouts: [
        { name: 'Chat', columns: [{ view: 'session', width: 100 }] },
        { name: 'Changes', columns: [{ view: 'changes', width: 50 }, { view: 'files', width: 50 }] },
      ],
      active: 'Chat',
    })
    render(
      <Providers>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskWorkspaceRoute />} />
            <Route path="/tasks/:id/changes" element={<TaskWorkspaceRoute view="changes" />} />
          </Routes>
          <HistoryProbe />
        </MemoryRouter>
      </Providers>,
    )
    await ready()
    await waitFor(() => expect(cardNames()).toEqual([...FIXED, 'Changes']))
    expect(activeCard()).toBe('Chat')

    fireEvent.click(screen.getByRole('button', { name: 'go-changes' }))
    await waitFor(() => expect(cardNames()).toEqual([...FIXED, 'Changes', 'Changes 2']))
    await waitFor(() => expect(columnViews()).toEqual(['changes']))

    for (let round = 0; round < 3; round += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'back' }))
      // Back gives the selection up again: the canonical URL shows what was there before the hop.
      await waitFor(() => expect(activeCard()).toBe('Chat'))
      expect(columns()).toHaveLength(0)
      fireEvent.click(screen.getByRole('button', { name: 'forward' }))
      await waitFor(() => expect(columnViews()).toEqual(['changes']))
      expect(activeCard()).toBe('Changes 2')
    }

    // Still the one card the first hop made.
    expect(cardNames()).toEqual([...FIXED, 'Changes', 'Changes 2'])
    await waitFor(() => expect(savedLayouts('r1').active).toBe('Changes 2'))
    expect(savedNames('r1')).toEqual(['Chat', 'Changes', 'Changes 2'])
  })

  it('does not mint a card when a deep link is crossed back and forth on a fresh task', async () => {
    // The everyday case: the task still has the plain Changes card it was born with, so the link
    // selects it — there is nothing to mint, however many times the entry is revisited.
    stubFetch()
    render(
      <Providers>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskWorkspaceRoute />} />
            <Route path="/tasks/:id/changes" element={<TaskWorkspaceRoute view="changes" />} />
          </Routes>
          <HistoryProbe />
        </MemoryRouter>
      </Providers>,
    )
    await ready()
    expect(activeCard()).toBe('Chat')

    fireEvent.click(screen.getByRole('button', { name: 'go-changes' }))
    await waitFor(() => expect(columnViews()).toEqual(['changes']))
    expect(activeCard()).toBe('Changes')

    for (let round = 0; round < 3; round += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'back' }))
      await waitFor(() => expect(activeCard()).toBe('Chat'))
      fireEvent.click(screen.getByRole('button', { name: 'forward' }))
      await waitFor(() => expect(activeCard()).toBe('Changes'))
    }

    expect(cardNames()).toEqual(FIXED)
    await waitFor(() => expect(savedLayouts('r1').active).toBe('Changes'))
    expect(savedNames('r1')).toEqual(BORN)
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

    await buildPair('session', 'changes')
    await waitFor(() => expect(savedViews('r1', 'Layout 7')).toEqual(['session', 'changes']))
    const afterBuild = puts.length

    const divider = dividers()[0]!
    for (let step = 0; step < 12; step += 1) {
      fireEvent.keyDown(divider, { key: 'ArrowRight' })
    }
    await waitFor(() =>
      expect(savedLayouts('r1').layouts.find((layout) => layout.name === 'Layout 7')!.columns[0]!.width).toBe(74),
    )

    // Twelve moves, one save — not twelve.
    expect(puts.length - afterBuild).toBe(1)
  })

  it('saves the last change even when you leave the task straight away', async () => {
    // The other half of the debounce. Cancelling the pending timer on the way out loses the
    // user's final change — build a split, leave, come back to the layout you had before it —
    // and the first attempt at a flush looked for a pending TIMER, which React's
    // declaration-order cleanup had already cleared. This pins the outcome, not the mechanism.
    stubFetch()
    const view = renderWorkspace()
    await ready()

    await buildPair('session', 'files')

    // Leave well inside the debounce window.
    view.unmount()

    await waitFor(() => expect(savedViews('r1', 'Layout 7')).toEqual(['session', 'files']))
  })

  it('opens a deep link on the card of its view and leaves the saved layouts alone', async () => {
    stubFetch()
    seedLayouts('r1', {
        layouts: [{ name: 'Chat', columns: [{ view: 'session', width: 100 }] }],
        active: 'Chat',
      })
    renderWorkspace('changes')
    await ready()

    await waitFor(() => expect(columnViews()).toEqual(['changes']))
    // The view the URL asked for is one of the fixed cards, so that is the card that lights up —
    // not a second, closable `Changes` drawn beside it.
    expect(activeCard()).toBe('Changes')
    expect(cardNames()).toEqual(FIXED)
    // Named after the view the URL asked for (spec §5.3, §11), not the `Layout N` counter…
    await waitFor(() => expect(savedNames('r1')).toEqual(['Chat', 'Changes']))
    expect(savedViews('r1', 'Changes')).toEqual(['changes'])
    // …and the layout that was already there is untouched (spec §5.3).
    expect(savedLayouts('r1').layouts[0]!.columns).toEqual([{ view: 'session', width: 100 }])
  })

  it('recovers a malformed saved workspace to the default cards without an error', async () => {
    stubFetch()
    seedLayouts('r1', '{ not json at all')
    renderWorkspace()
    await ready()

    expect(cardNames()).toEqual(FIXED)
    expect(activeCard()).toBe('Chat')
    expect(stage()!.querySelector('[data-slot="main"]')).not.toBeNull()
    expect(columns()).toHaveLength(0)
  })

  it('gives each column its own scroller, so the embedded views scroll inside it', async () => {
    stubFetch()
    seedLayouts('r1', {
        layouts: [{ name: 'Pair', columns: [{ view: 'files', width: 50 }, { view: 'commits', width: 50 }] }],
        active: 'Pair',
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
      layouts: [{ name: 'Solo', columns: [{ view: 'files', width: 100 }] }],
      active: 'Solo',
    })
    renderWorkspace()
    await ready()

    await waitFor(() => expect(document.querySelector('[data-narrow]')).not.toBeNull())
    expect(queries).toContain('(min-width: 1024px)')
  })

  it('offers the split on a narrow viewport too', async () => {
    // A narrow screen shows one window at a time, with the SAME controls a window has on a wide
    // one — so a layout can still grow there, and the split lands you on the new window's tiles.
    stubFetch()
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    seedLayouts('r1', {
      layouts: [{ name: 'Solo', columns: [{ view: 'files', width: 100 }] }],
      active: 'Solo',
    })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(document.querySelector('[data-narrow]')).not.toBeNull())

    const split = document.querySelector('[data-narrow] [data-action="split-view"]')
    expect(split).not.toBeNull()
    expect((split as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(split!)
    await waitFor(() => expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Code', 'New window']))
    expect(screen.getAllByRole('tab')[1]!.getAttribute('aria-selected')).toBe('true')
    await pickTile('commits')
    await waitFor(() => expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Code', 'Commits']))
  })

  it('shows one column at a time on a narrow viewport', async () => {
    stubFetch()
    // jsdom has no matchMedia, which `useIsDesktop` counts as desktop — stub the narrow answer.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    seedLayouts('r1', {
        layouts: [{ name: 'Pair', columns: [{ view: 'files', width: 50 }, { view: 'commits', width: 50 }] }],
        active: 'Pair',
      })
    renderWorkspace()
    await ready()

    await waitFor(() => expect(document.querySelector('[data-narrow]')).not.toBeNull())
    // Both columns are reachable as tabs, but only one is painted.
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Code', 'Commits'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelectorAll('[data-narrow] [data-slot="main"]')).toHaveLength(1)

    // The switcher is the shared Tabs primitive, which selects on the press rather than the click.
    fireEvent.mouseDown(tabs[1]!, { button: 0 })
    await waitFor(() => expect(screen.getAllByRole('tab')[1]!.getAttribute('aria-selected')).toBe('true'))
    expect(screen.getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('button', { name: 'Commits — change view' })).not.toBeNull()
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
    // three-column layout. The grip and the empty stretch of the bar drag the window instead;
    // the buttons never do.
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
    const grips = Array.from(header.querySelectorAll('[draggable="true"]'))
    expect(grips.length).toBeGreaterThan(0)
    expect(grips.some((grip) => grip.getAttribute('title') === 'Drag to reorder')).toBe(true)
    for (const grip of grips) {
      // No button is a grip, and no button sits inside one.
      expect(grip.closest('button')).toBeNull()
      expect(grip.querySelector('button')).toBeNull()
    }
    for (const button of Array.from(header.querySelectorAll('button'))) {
      expect(button.closest('[draggable="true"]')).toBeNull()
    }

    // And the close X still closes, which is the behaviour the grip was costing.
    fireEvent.click(screen.getByRole('button', { name: 'Close Chat' }))
    await waitFor(() => expect(columnViews()).toEqual(['changes']))
  })

  it('offers Graph as a view and mounts it embedded in a column', async () => {
    // Spec §5.1 (amended): the task's live workflow graph is a workspace view, so a layout can
    // hold it beside the conversation instead of it being a page of its own.
    stubFetch()
    renderWorkspace()
    await ready()

    await buildPair('session', 'graph')

    const graph = await screen.findByTestId('graph-view')
    // Embedded, so it drops its own RunHeader — the workspace already has one.
    expect(graph.getAttribute('data-embedded')).toBe('')
    expect(graph.getAttribute('data-run')).toBe('r1')
  })

  it('opens /tasks/:id/graph on its Graph card, like every other task URL', async () => {
    // Before this, the graph was a page of its own with the legacy tab strip, and nothing in the
    // workspace could reach it (§5.3 now covers all five task URLs).
    const withWorkflow = {
      ...RUN,
      workflowDef: { name: 'quick-task', steps: [], source: 'built-in' },
    }
    stubFetch({ 'GET /api/v1/runs/r1': () => jsonResponse(withWorkflow) })
    seedLayouts('r1', {
      layouts: [{ name: 'Chat', columns: [{ view: 'session', width: 100 }] }],
      active: 'Chat',
    })
    renderWorkspace('graph')
    await ready()

    await waitFor(() => expect(columnViews()).toEqual(['graph']))
    // A task with a workflow has a Graph card, right after Chat, and the link lights it.
    expect(cardNames()).toEqual(['Chat', 'Graph', 'Changes', 'Commits', 'Code', 'Browser'])
    expect(activeCard()).toBe('Graph')
    const graph = await screen.findByTestId('graph-view')
    expect(graph.getAttribute('data-embedded')).toBe('')
    await waitFor(() => expect(savedNames('r1')).toEqual(['Chat', 'Graph']))
  })

  it('keeps two tasks apart when the route swaps run ids without remounting', async () => {
    stubFetch({ 'GET /api/v1/runs/r2': () => jsonResponse({ ...RUN, id: 'r2' }) })
    seedLayouts('r1', {
        layouts: [{ name: 'Tylko r1', columns: [{ view: 'files', width: 100 }] }],
        active: 'Tylko r1',
      })
    render(
      <Providers>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskWorkspaceRoute />} />
          </Routes>
          <HistoryProbe />
        </MemoryRouter>
      </Providers>,
    )
    await ready()
    await waitFor(() => expect(cardNames()).toEqual([...FIXED, 'Tylko r1']))
    expect(activeCard()).toBe('Tylko r1')

    // Same route element, another task: r2 has nothing saved, so it must open on its own default —
    // never r1's card (spec §5.3).
    fireEvent.click(screen.getByRole('button', { name: 'go-r2' }))
    await waitFor(() =>
      expect(document.querySelector('[data-route="task-workspace"]')?.getAttribute('data-run-id')).toBe('r2'),
    )
    await waitFor(() => expect(activeCard()).toBe('Chat'))
    expect(cardNames()).toEqual(FIXED)
    expect(savedNames('r2')).toEqual(BORN)
    // …and r1 still has what it had.
    expect(savedNames('r1')).toEqual(['Tylko r1'])
  })
})
