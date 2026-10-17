import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
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

beforeEach(() => {
  localStorage.clear()
  hostLayouts = {}
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
    tokenMetrics: true,
    tokenUsageMetrics: true,
    costMetrics: true,
    followups: false,
    singleProject: false,
    automations: false,
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
const activeCard = () => text(document.querySelector('[data-slot="layout-card"][data-active]'))
const columnViews = () =>
  Array.from(document.querySelectorAll('[data-slot="workspace-column"]')).map((column) => column.getAttribute('data-view'))

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

    // Terminal has no tab: the Terminal button is its one control.
    expect(cardNames()).toEqual(['Chat', 'Changes', 'Commits', 'Code'])
    expect(activeCard()).toBe('Chat')
    // One strip, never both: the old route links are gone from the header.
    expect(screen.queryByRole('link', { name: 'Changes' })).toBeNull()
    // Opening the task saves nothing: the host has never been written to.
    expect(hostLayouts.r1).toBeUndefined()
  })

  it('offers no Terminal anywhere when the cockpit allows no shell', async () => {
    stubFetch({ terminal: false })
    renderWorkspace()
    await ready()

    expect(cardNames()).not.toContain('Terminal')
    expect(screen.queryByRole('button', { name: /terminal/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New layout' }))
    await waitFor(() => expect(document.querySelector('[data-slot="view-tiles-stage"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="view-tiles-stage"] [data-view="terminal"]')).toBeNull()
    // …and never a Browser: main has no Browser column yet.
    expect(document.querySelector('[data-slot="view-tiles-stage"] [data-view="browser"]')).toBeNull()
  })

  it('puts a terminal beside the chat in a layout, saved on the host', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'New layout' }))
    await pickTile('session')
    await waitFor(() => expect(columnViews()).toEqual(['session']))
    fireEvent.click(screen.getByRole('button', { name: 'Split view' }))
    await pickTile('terminal')
    await waitFor(() => expect(columnViews()).toEqual(['session', 'terminal']))

    const terminal = await screen.findByTestId('terminal')
    expect(terminal.dataset.fill).toBe('')
    expect(terminal.dataset.run).toBe('r1')
    // The drawer toggle steps aside while a column already shows the shells.
    expect(screen.getByRole('button', { name: 'Show terminal' }).hasAttribute('disabled')).toBe(true)

    await waitFor(() => {
      const saved = reviveState(hostLayouts.r1 ?? null)
      const built = saved.layouts.find((layout) => layout.name === saved.active)
      expect(built?.columns.map((column) => column.view)).toEqual(['session', 'terminal'])
    })
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
    fireEvent.click(screen.getByRole('button', { name: 'Hide terminal' }))
    await waitFor(() => expect(screen.queryByTestId('terminal')).toBeNull())
  })

  it('folds cards until the row stops overflowing, so + is never pushed out of the strip', async () => {
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
    expect(screen.getByRole('button', { name: /more layouts/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'New layout' })).not.toBeNull()
  })

  it('opens /terminal as its own card', async () => {
    stubFetch()
    renderWorkspace('terminal')
    expect((await screen.findByTestId('terminal')).dataset.fill).toBe('')
    // No tab stands for it; the Terminal button stays lit while the shells fill a column.
    const toggle = document.querySelector('[data-action="toggle-terminal"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.textContent).toContain('in column')
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

    // The fixed Chat card stays one view; the pair lands in a saved layout of its own.
    await waitFor(() => expect(activeCard()).toBe('Chat + Changes'))
    expect(document.querySelector('[data-slot="view-drop-zones"]')).toBeNull()
    await waitFor(() => {
      const saved = reviveState(hostLayouts.r1 ?? null)
      const built = saved.layouts.find((layout) => layout.name === 'Chat + Changes')
      expect(built?.columns.map((column) => column.view)).toEqual(['session', 'changes'])
    })
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
