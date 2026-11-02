import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { resetViewMemory } from '@/lib/view-memory'
import type { ApiRun, HealthResponse } from '@open-mercato/cezar-api-client'

import { reviveState, type ViewId } from './layout-state'

// The terminal needs xterm and a PTY; this suite is about the layout, so the view stands in and
// says how it was mounted (a column fills, the drawer docks).
vi.mock('./terminal-drawer', () => ({
  TerminalDrawer: ({ runId, fill }: { runId: string; fill?: boolean }) => (
    <section data-testid="terminal" data-run={runId} data-fill={fill ? '' : undefined} />
  ),
}))
vi.mock('../workflow-graph/task-graph', () => ({
  TaskGraphView: ({ run }: { run: { id: string } }) => <div data-testid="graph-view" data-run={run.id} />,
}))

const { TaskWorkspaceRoute, classifyReference } = await import('./task-workspace')

let hostLayouts: Record<string, unknown> = {}
/** `~/.cezar/ui-state.json`: where layouts saved for every task live (`savedLayouts`). */
let hostUiState: Record<string, unknown> = {}

beforeEach(() => {
  localStorage.clear()
  hostLayouts = {}
  hostUiState = {}
  // jsdom lays nothing out; give the strip room so it does not fold every card into `…`.
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(2000)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  resetViewMemory()
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

const health = (terminal: boolean): HealthResponse => ({
  version: '0.0.0-test',
  runtimeId: '00000000-0000-4000-8000-000000000001',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  checks: [],
  defaultRunner: 'claude',
  forge: { kind: 'github', available: true },
  capabilities: {
    localHandoff: true,
    terminal,
    designMode: true,
    tokenMetrics: true,
    tokenUsageMetrics: true,
    costMetrics: true,
    followups: false,
    singleProject: false,
    automations: false,
    webhooks: false,
    dispatch: false,
  },
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubFetch({ terminal = true }: { terminal?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      if (method === 'GET' && path === `/api/v1/runs/${RUN.id}`) return jsonResponse(RUN)
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(health(terminal))
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
      const layouts = /^\/api\/v1\/runs\/([^/]+)\/layouts$/.exec(path)
      if (layouts) {
        const runId = decodeURIComponent(layouts[1]!)
        if (method === 'GET') return jsonResponse({ layouts: hostLayouts[runId] ?? null })
        if (method === 'PUT') {
          hostLayouts[runId] = JSON.parse(String(init.body ?? '{}'))
          return jsonResponse({ layouts: hostLayouts[runId] })
        }
      }
      if (path === '/api/v1/workspace/ui-state') {
        if (method === 'PUT') hostUiState = { ...hostUiState, ...JSON.parse(String(init.body ?? '{}')) }
        return jsonResponse(hostUiState)
      }
      if (method === 'GET' && path === '/api/v1/runs') return jsonResponse([RUN])
      if (method === 'GET' && path === '/api/v1/repo') return jsonResponse(health(terminal).repo)
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

const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, ' ').trim()
const cardNames = () => Array.from(document.querySelectorAll('[data-slot="layout-card"]')).map(text)
// The view tab that shows, else the saved layout the Layout menu names.
const activeCard = () =>
  text(document.querySelector('[data-slot="layout-card"][data-active]')) ??
  document.querySelector('[data-action="layouts"][data-active-layout]')?.getAttribute('data-active-layout') ??
  undefined
const terminalTab = () => document.querySelector<HTMLElement>('[data-slot="layout-card"][data-fixed="terminal"]')

const openLayoutMenu = () => fireEvent.keyDown(screen.getByRole('button', { name: /^Layout/ }), { key: 'Enter' })
const columnViews = () =>
  Array.from(document.querySelectorAll('[data-slot="workspace-layout"][data-active] [data-slot="workspace-column"]')).map((column) => column.getAttribute('data-view'))

async function ready() {
  await waitFor(() => expect(document.querySelector('[data-route="task-workspace"]')).not.toBeNull())
  await waitFor(() => expect(activeCard()).toBeDefined())
}

async function pickTile(view: ViewId) {
  const tile = () => document.querySelector<HTMLElement>(`[data-slot="view-tiles-stage"] [data-view="${view}"]`)
  await waitFor(() => expect(tile()).not.toBeNull())
  fireEvent.click(tile()!)
}

describe('the task workspace (main)', () => {
  it('opens on Chat, with the layout strip in place of the route tabs', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    // Changes second; Terminal last, as a tab that toggles the drawer.
    expect(cardNames()).toEqual(['Chat', 'Changes', 'Commits', 'Files', 'Preview', 'Terminal'])
    expect(activeCard()).toBe('Chat')
    // One strip, never both: the old route links are gone from the header.
    expect(screen.queryByRole('link', { name: 'Changes' })).toBeNull()
    // Opening the task saves nothing: the host has never been written to.
    expect(hostLayouts.r1).toBeUndefined()
  })

  it('holding ⌘ prints each tab’s number on it; a quick ⌘ press or letting go hides them', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' })
    stubFetch()
    renderWorkspace()
    await ready()
    const hints = () => Array.from(document.querySelectorAll('[data-slot="tab-key-hint"]')).map(text)

    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    fireEvent.keyUp(window, { key: 'Meta' })
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(hints()).toEqual([])

    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    // The six views, then Notes — saved layouts are not numbered.
    await waitFor(() => expect(hints()).toEqual(['1', '2', '3', '4', '5', '6', '7']))
    fireEvent.keyUp(window, { key: 'Meta' })
    await waitFor(() => expect(hints()).toEqual([]))
    vi.unstubAllGlobals()
  })

  it('shows no tab numbers while a palette or dialog has the keyboard — ⌘N would not switch', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' })
    stubFetch()
    renderWorkspace()
    await ready()
    const hints = () => document.querySelectorAll('[data-slot="tab-key-hint"]').length

    // Held while a dialog is already up: nothing.
    const dialog = document.body.appendChild(Object.assign(document.createElement('div'), { role: 'dialog' }))
    dialog.setAttribute('role', 'dialog')
    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(hints()).toBe(0)
    fireEvent.keyUp(window, { key: 'Meta' })
    dialog.remove()

    // Held, hints up — then ⌘K opens a palette: they go.
    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    await waitFor(() => expect(hints()).toBeGreaterThan(0))
    document.body.appendChild(dialog)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    await waitFor(() => expect(hints()).toBe(0))
    fireEvent.keyUp(window, { key: 'Meta' })
    dialog.remove()
    vi.unstubAllGlobals()
  })

  it('off a Mac, shows no tab numbers while the terminal has focus — Ctrl chords are the shell’s there', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'Linux x86_64' })
    stubFetch()
    renderWorkspace()
    await ready()
    const hints = () => document.querySelectorAll('[data-slot="tab-key-hint"]').length
    const term = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'xterm' }))
    const helper = term.appendChild(document.createElement('textarea'))
    helper.focus()

    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(hints()).toBe(0)
    fireEvent.keyUp(window, { key: 'Control' })

    term.remove()
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
    await waitFor(() => expect(hints()).toBeGreaterThan(0))
    fireEvent.keyUp(window, { key: 'Control' })
    vi.unstubAllGlobals()
  })

  it('offers no Terminal anywhere when the cockpit allows no shell', async () => {
    stubFetch({ terminal: false })
    renderWorkspace()
    await ready()

    expect(cardNames()).not.toContain('Terminal')
    expect(screen.queryByRole('button', { name: /terminal/i })).toBeNull()
    // ⌥-click splits Chat into the working arrangement; its Split view opens the tile picker.
    fireEvent.click(document.querySelector<HTMLElement>('[data-fixed="changes"]')!, { altKey: true })
    await waitFor(() => expect(columnViews()).toEqual(['session', 'changes']))
    const splits = screen.getAllByRole('button', { name: 'Split view' })
    fireEvent.click(splits[splits.length - 1]!)
    await waitFor(() => expect(document.querySelector('[data-slot="view-tiles-stage"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="view-tiles-stage"] [data-view="terminal"]')).toBeNull()
    // The Preview needs no shell: it is offered either way.
    expect(document.querySelector('[data-slot="view-tiles-stage"] [data-view="browser"]')).not.toBeNull()
  })

  it('opens the Preview deep link on the real Preview, with its saved tabs and Design Mode', async () => {
    hostLayouts.r1 = {
      layouts: [
        {
          name: 'Browser',
          columns: [{ view: 'browser', width: 100, browser: { tabs: ['http://localhost:3000/', ''], active: 1 } }],
        },
      ],
      active: 'Chat',
    }
    stubFetch()
    renderWorkspace('browser')
    await ready()

    await waitFor(() => expect(activeCard()).toBe('Preview'))
    expect(columnViews()).toEqual(['browser'])
    expect(document.querySelectorAll('[data-slot="browser-tab"]')).toHaveLength(2)
    expect(document.querySelector('[data-slot="browser-design-toggle"]')).not.toBeNull()
  })

  it('puts a terminal beside the chat in a layout, saved on the host', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    fireEvent.click(document.querySelector<HTMLElement>('[data-fixed="changes"]')!, { altKey: true })
    await waitFor(() => expect(columnViews()).toEqual(['session', 'changes']))
    const splits = screen.getAllByRole('button', { name: 'Split view' })
    fireEvent.click(splits[splits.length - 1]!)
    await pickTile('terminal')
    await waitFor(() => expect(columnViews()).toEqual(['session', 'changes', 'terminal']))

    const terminal = await screen.findByTestId('terminal')
    expect(terminal.dataset.fill).toBe('')
    expect(terminal.dataset.run).toBe('r1')
    expect(terminalTab()?.hasAttribute('data-on')).toBe(true)

    await waitFor(() => {
      const saved = reviveState(hostLayouts.r1 ?? null)
      const built = saved.layouts.find((layout) => layout.name === saved.active)
      expect(built?.columns.map((column) => column.view)).toEqual(['session', 'changes', 'terminal'])
    })
  })

  it('opens the Terminal tab as a view of its own, like Preview — a click never adds it to what shows', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    fireEvent.click(terminalTab()!)
    await waitFor(() => expect(activeCard()).toBe('Terminal'))
    expect(columnViews()).toEqual(['terminal'])
    expect((await screen.findByTestId('terminal')).dataset.fill).toBe('')

    // ⌥-click is the way to put it beside a view.
    fireEvent.click(document.querySelector<HTMLElement>('[data-fixed="session"]')!)
    await waitFor(() => expect(activeCard()).toBe('Chat'))
    fireEvent.click(terminalTab()!, { altKey: true })
    await waitFor(() => expect(columnViews()).toEqual(['session', 'terminal']))

    // A column's "Move to bottom" docks the same shells as the drawer.
    fireEvent.click(screen.getByRole('button', { name: 'Move to bottom' }))
    await waitFor(() => expect(columnViews()).not.toContain('terminal'))
    expect((await screen.findByTestId('terminal')).dataset.fill).toBeUndefined()
  })

  it('drops the Terminal tab beside the view it was opened from when the Terminal itself shows', async () => {
    stubFetch()
    renderWorkspace()
    await ready()
    fireEvent.click(document.querySelector<HTMLElement>('[data-fixed="changes"]')!)
    await waitFor(() => expect(activeCard()).toBe('Changes'))
    fireEvent.click(terminalTab()!)
    await waitFor(() => expect(activeCard()).toBe('Terminal'))

    const data = new Map<string, string>()
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      get types() {
        return [...data.keys()]
      },
      effectAllowed: 'all',
      dropEffect: 'none',
    }
    fireEvent.dragStart(terminalTab()!, { dataTransfer })
    const right = await waitFor(() => {
      const zones = document.querySelectorAll('[data-slot="view-drop-zones"] [data-drop-zone="insert"]')
      expect(zones.length).toBe(2)
      return zones[1]!
    })
    fireEvent.dragOver(right, { dataTransfer })
    fireEvent.drop(right, { dataTransfer })
    await waitFor(() => expect(columnViews()).toEqual(['changes', 'terminal']))

    // ⌥-click from the Terminal does the same.
    fireEvent.click(terminalTab()!)
    await waitFor(() => expect(activeCard()).toBe('Terminal'))
    fireEvent.click(terminalTab()!, { altKey: true })
    await waitFor(() => expect(columnViews()).toEqual(['changes', 'terminal']))
  })

  it('gives a lone view its bar — the split only: no name, no view switcher, no close', async () => {
    stubFetch()
    renderWorkspace()
    await ready()
    const header = await waitFor(() => document.querySelector<HTMLElement>('[data-slot="workspace-column-header"]')!)
    expect(header.textContent).not.toContain('Chat')
    expect(header.querySelector('[data-action="split-view"]')).not.toBeNull()
    expect(header.querySelector('[data-action="change-view"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close Chat' })).toBeNull()

    // Splitting the Chat tab builds the working arrangement; the Chat tab stays one view.
    fireEvent.click(screen.getByRole('button', { name: 'Split view' }))
    await pickTile('files')
    await waitFor(() => expect(activeCard()).toBe('Custom'))
    expect(columnViews()).toEqual(['session', 'files'])
    expect(document.querySelectorAll('[data-action="change-view"]')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Close Chat' })).not.toBeNull()
  })

  it('docks the drawer under any layout, and the ` key toggles it', async () => {
    stubFetch()
    renderWorkspace('changes')
    await ready()
    await waitFor(() => expect(activeCard()).toBe('Changes'))
    expect(screen.queryByTestId('terminal')).toBeNull()

    fireEvent.keyDown(window, { key: '`' })
    const drawer = await screen.findByTestId('terminal')
    expect(drawer.dataset.fill).toBeUndefined()
    // The tab is lit while the drawer is up; the view that shows stays.
    expect(terminalTab()?.hasAttribute('data-on')).toBe(true)
    expect(activeCard()).toBe('Changes')
    fireEvent.keyDown(window, { key: '`' })
    await waitFor(() => expect(screen.queryByTestId('terminal')).toBeNull())
  })

  it('folds tabs until the row stops overflowing, so the Layout menu is never pushed out of the strip', async () => {
    // jsdom lays nothing out: a 300px row whose content is 100px per card plus its two buttons.
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(300)
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      if (this.getAttribute('data-slot') !== 'layout-cards') return 0
      return this.querySelectorAll('[data-slot="layout-card"]').length * 100 + 60
    })
    stubFetch()
    renderWorkspace()
    await ready()

    await waitFor(() => expect(cardNames().length).toBeLessThanOrEqual(2))
    expect(activeCard()).toBe('Chat')
    expect(screen.getByRole('button', { name: /more views/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /^Layout/ })).not.toBeNull()
  })

  it('opens /terminal as its own card', async () => {
    stubFetch()
    renderWorkspace('terminal')
    expect((await screen.findByTestId('terminal')).dataset.fill).toBe('')
    await waitFor(() => expect(activeCard()).toBe('Terminal'))
    expect(terminalTab()?.getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps a left layout mounted, hidden, so going back to Changes does not rebuild it', async () => {
    stubFetch()
    renderWorkspace()
    await ready()
    const visible = () => document.querySelector('[data-slot="workspace-layout"][data-active]')
    const select = (view: ViewId) =>
      fireEvent.click(document.querySelector(`[data-slot="layout-card"][data-fixed="${view}"]`) as HTMLElement)

    select('changes')
    await waitFor(() => expect(columnViews()).toEqual(['changes']))
    const changes = visible()

    select('session')
    await waitFor(() => expect(columnViews()).toEqual(['session']))
    expect(changes?.isConnected).toBe(true)
    expect(changes?.hasAttribute('data-active')).toBe(false)

    select('changes')
    await waitFor(() => expect(columnViews()).toEqual(['changes']))
    expect(visible()).toBe(changes)
  })

  it('sends the \\ key to the layout on screen, never to a kept one hidden behind it', async () => {
    stubFetch()
    renderWorkspace()
    await ready()
    // ⌥-click builds a split layout, whose windows carry Split view buttons.
    fireEvent.click(document.querySelector<HTMLElement>('[data-fixed="changes"]')!, { altKey: true })
    await waitFor(() => expect(columnViews()).toEqual(['session', 'changes']))

    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="layout-card"][data-fixed="changes"]')!)
    await waitFor(() => expect(columnViews()).toEqual(['changes']))
    const hidden = () => document.querySelector('[data-slot="workspace-layout"]:not([data-active])')
    // The split layout is kept, hidden, with its Split view buttons still in the DOM.
    expect(hidden()?.querySelector('[data-action="split-view"]')).not.toBeNull()

    // The key splits the layout on screen — the hidden one sits later in the DOM, so a stage-wide
    // lookup would have pressed ITS last Split view instead.
    fireEvent.keyDown(document.body, { key: '\\' })
    await waitFor(() =>
      expect(document.querySelector('[data-slot="workspace-layout"][data-active] [data-slot="view-tiles-stage"]')).not.toBeNull(),
    )
  })

  it('gives each task its own Changes view — the previous task\'s diff never renders under the next', async () => {
    // Both tasks open on Changes. A guard: one ChangesView reused across them would let its
    // deferred diff hand the second task's first render the first task's files.
    const onChanges = { layouts: [{ name: 'Chat', columns: [{ view: 'session', width: 100 }] }, { name: 'Changes', columns: [{ view: 'changes', width: 100 }] }], active: 'Changes' }
    hostLayouts = { r1: onChanges, r2: onChanges }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        const run = /^\/api\/v1\/runs\/(r[12])(\/.*)?$/.exec(path)
        if (path === '/api/v1/health') return jsonResponse(health(true))
        if (path === '/api/v1/runs') return jsonResponse([RUN, { ...RUN, id: 'r2' }])
        if (path === '/api/v1/repo') return jsonResponse(health(true).repo)
        if (!run) return jsonResponse({ error: `unstubbed: ${path}` }, 404)
        const [, id, rest = ''] = run
        if (rest === '') return jsonResponse({ ...RUN, id })
        if (rest === '/layouts') return jsonResponse({ layouts: (init.method ?? 'GET') === 'GET' ? hostLayouts[id!] : JSON.parse(String(init.body)) })
        if (rest.startsWith('/drafts')) return jsonResponse({ surfaces: {} })
        if (rest.startsWith('/changes')) return jsonResponse({ files: [], stat: { adds: 0, dels: 0, files: 0 } })
        return jsonResponse([])
      }),
    )
    let navigate: (to: string) => void = () => {}
    function Navigator() {
      const go = useNavigate()
      navigate = (to) => void go(to)
      return null
    }
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Navigator />
          <Routes>
            <Route path="/tasks/:id" element={<TaskWorkspaceRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const changesView = () => document.querySelector('[data-route="task-changes"]')
    await waitFor(() => expect(changesView()).not.toBeNull())
    const first = changesView()

    navigate('/tasks/r2')
    await waitFor(() => expect(document.querySelector('[data-route="task-workspace"]')?.getAttribute('data-run-id')).toBe('r2'))
    await waitFor(() => expect(changesView()).not.toBeNull())
    expect(changesView()).not.toBe(first)
  })

  it('never keeps a Preview layout once left — a hidden page would keep running', async () => {
    stubFetch()
    renderWorkspace()
    await ready()
    fireEvent.click(document.querySelector('[data-slot="layout-card"][data-fixed="browser"]') as HTMLElement)
    await waitFor(() => expect(columnViews()).toEqual(['browser']))
    const preview = document.querySelector('[data-slot="workspace-layout"][data-active]')

    fireEvent.click(document.querySelector('[data-slot="layout-card"][data-fixed="session"]') as HTMLElement)
    await waitFor(() => expect(columnViews()).toEqual(['session']))
    expect(preview?.isConnected).toBe(false)
  })

  it('splits the screen when a view tab is dropped beside the chat', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    const tab = document.querySelector('[data-slot="layout-card"][data-fixed="changes"]') as HTMLElement
    const data = new Map<string, string>()
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      get types() {
        return [...data.keys()]
      },
      effectAllowed: 'all',
      dropEffect: 'none',
    }
    fireEvent.dragStart(tab, { dataTransfer })
    const zones = await waitFor(() => {
      const found = document.querySelectorAll('[data-slot="view-drop-zones"] [data-drop-zone="insert"]')
      expect(found.length).toBe(2)
      return found
    })
    fireEvent.dragOver(zones[1]!, { dataTransfer })
    fireEvent.drop(zones[1]!, { dataTransfer })

    // The fixed Chat card stays one view; the pair is the task's working arrangement, not a new layout.
    await waitFor(() => expect(activeCard()).toBe('Custom'))
    expect(document.querySelector('[data-slot="view-drop-zones"]')).toBeNull()
    await waitFor(() => {
      const saved = reviveState(hostLayouts.r1 ?? null)
      const built = saved.layouts.find((layout) => layout.name === 'Custom')
      expect(built?.columns.map((column) => column.view)).toEqual(['session', 'changes'])
    })
  })

  it('saves a layout only when the user names it, for every task, and opens it from the Layout menu', async () => {
    hostUiState = { savedLayouts: [{ name: 'Debug', columns: [{ view: 'files', width: 60 }, { view: 'terminal', width: 40 }] }] }
    stubFetch()
    renderWorkspace()
    await ready()

    // Splitting names nothing: the task's working arrangement, and still one saved layout.
    fireEvent.click(document.querySelector<HTMLElement>('[data-fixed="changes"]')!, { altKey: true })
    await waitFor(() => expect(activeCard()).toBe('Custom'))
    expect(hostUiState.savedLayouts).toHaveLength(1)

    openLayoutMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Save current view as layout/ }))
    const field = await screen.findByRole('textbox', { name: 'Layout name' })
    expect((field as HTMLInputElement).value).toBe('Chat + Changes')
    // A view tab's name is not a layout's.
    fireEvent.change(field, { target: { value: 'Changes' } })
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(field, { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(activeCard()).toBe('Review'))
    await waitFor(() =>
      expect(hostUiState.savedLayouts).toEqual([
        { name: 'Debug', columns: [{ view: 'files', width: 60 }, { view: 'terminal', width: 40 }] },
        { name: 'Review', columns: [{ view: 'session', width: 50 }, { view: 'changes', width: 50 }] },
      ]),
    )

    // A layout saved elsewhere opens here with its own arrangement.
    openLayoutMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Debug/ }))
    await waitFor(() => expect(activeCard()).toBe('Debug'))
    expect(columnViews()).toEqual(['files', 'terminal'])

    openLayoutMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete saved layout Review' }))
    await waitFor(() => expect(hostUiState.savedLayouts).toEqual([expect.objectContaining({ name: 'Debug' })]))

    // The menu stays open after a ×. The row's × is pointer-only; Delete on the focused row does
    // the same from the keyboard.
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: /Debug/ }), { key: 'Delete' })
    await waitFor(() => expect(hostUiState.savedLayouts).toEqual([]))
  })
})

describe('classifyReference', () => {
  it('claims task paths and commit shas, and leaves prose alone', () => {
    expect(classifyReference('src/app.ts:12')).toEqual({ view: 'files', value: 'src/app.ts' })
    expect(classifyReference('/tmp/wt/r1/src/a.ts', '/tmp/wt/r1')).toEqual({ view: 'files', value: 'src/a.ts' })
    expect(classifyReference('3f7eaf02')).toEqual({ view: 'commits', value: '3f7eaf02' })
    expect(classifyReference('/etc/passwd')).toBeNull()
    expect(classifyReference('e.g')).toBeNull()
  })
})
