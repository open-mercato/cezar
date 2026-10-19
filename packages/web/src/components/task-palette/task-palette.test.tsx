import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { HealthResponse, RunRecord } from '@open-mercato/cezar-api-client'
import { CommandPalette } from '@/components/command-palette'
import { ThemeProvider } from '@/components/theme-provider'
import { recordTaskVisit, resetRecentTasks } from '@/lib/recent-tasks'
import { publishTaskWorkspace, resetTaskWorkspaceBridge, type TaskWorkspaceBridge } from '@/lib/task-workspace-bridge'

import * as telemetry from '@/lib/telemetry'

import { paletteMode, rankPaths, TaskPalette, taskIdFromPath } from './task-palette'

// Spies over the real helpers (their `send` is a no-op under test): the palettes' wiring is what
// is asserted here, the helpers themselves in `lib/telemetry-palette.test.ts`.
vi.mock('@/lib/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/telemetry')>()
  return {
    ...actual,
    trackPaletteOpened: vi.fn(),
    trackPaletteDismissed: vi.fn(),
    trackPaletteModes: vi.fn(),
    trackTaskSwitched: vi.fn(),
    countTaskCommand: vi.fn(),
    trackShortcutRebound: vi.fn(),
  }
})

const fetchMock = vi.fn<typeof fetch>()
let sent: { method: string; path: string; body: unknown }[] = []
let uiState: Record<string, unknown> = {}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  localStorage.clear()
  resetRecentTasks()
  resetTaskWorkspaceBridge()
  sent = []
  uiState = {}
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function run(id: string, title: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    title,
    workflow: 'quick-task',
    task: title,
    status: 'done',
    createdAt: '2026-10-17T10:00:00Z',
    finishedAt: '2026-10-17T10:05:00Z',
    seenAt: '2026-10-17T10:06:00Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...extra,
  }
}

const RUNS = [run('r1', 'Fix the login redirect'), run('r2', 'Add dark mode toggle'), run('r3', 'Refactor the store')]

const HEALTH: HealthResponse = {
  version: '0.0.0-test',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, terminal: false, designMode: false, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, automations: false, dispatch: false },
}

/** A second project's task, known to the palettes through the cross-project index. */
const BLOG_TASK = run('b1', 'Blog follow-up')
const TWO_PROJECTS = [
  { id: 'shop', name: 'shop', root: '/repos/shop', addedAt: '2026-07-01T10:00:00Z', lastOpenedAt: '2026-07-01T10:00:00Z', source: 'local', status: 'ok' },
  { id: 'blog', name: 'blog', root: '/repos/blog', addedAt: '2026-07-01T10:00:00Z', lastOpenedAt: '2026-07-01T10:00:00Z', source: 'local', status: 'ok' },
]

function serve(runs: RunRecord[] = RUNS, { multiProject = false } = {}): void {
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    sent.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (method === 'POST' && path.endsWith('/pin')) return json({ ...runs[0], pinned: true })
    if (path === '/api/v1/runs') return json(runs)
    const detail = /^\/api\/v1\/(?:p\/[^/]+\/)?runs\/([^/?]+)$/.exec(path)
    const found = detail && [...runs, BLOG_TASK].find((candidate) => candidate.id === detail[1])
    if (found && method === 'DELETE') return json({ deleted: true })
    if (found) return json(found)
    if (path === '/api/v1/health') return json(HEALTH)
    if (path === '/api/v1/projects') {
      return json(
        multiProject
          ? { projects: TWO_PROJECTS, bootProject: 'shop', projectsDir: '/repos' }
          : { projects: [], bootProject: 'default', projectsDir: '/repos' },
      )
    }
    if (path === '/api/v1/workspace/runs-index') {
      const { id, title, status, createdAt, archived, workflow } = BLOG_TASK
      return json({
        runs: [{ id, title, status, createdAt, archived, workflow, projectId: 'blog', lastActivityAt: createdAt }],
        perProjectLimit: 200,
        truncated: [],
      })
    }
    if (path === '/api/v1/ui-state') return json({})
    if (path === '/api/v1/workspace/ui-state') {
      if (method === 'PUT') uiState = { ...uiState, ...(JSON.parse(String(init?.body)) as object) }
      return json(uiState)
    }
    if (path === '/api/v1/skills') return json([])
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  })
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

function renderPalettes(entry: string, options: { multiProject?: boolean } = {}) {
  serve(RUNS, options)
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <CommandPalette />
          <TaskPalette />
          <LocationProbe />
          <textarea data-testid="composer" aria-label="composer" />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const pressP = (target: Element | Window = window, init: KeyboardEventInit = { metaKey: true }) =>
  act(() => {
    fireEvent.keyDown(target, { key: 'p', ...init })
  })
const palette = () => document.querySelector<HTMLElement>('[data-slot="task-palette"]')
const input = () => palette()!.querySelector<HTMLInputElement>('[cmdk-input]')!
const selectedRow = () => palette()!.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]')
const location = () => screen.getByTestId('location').textContent

describe('⌘P on a task page acts on that task', () => {
  it('opens with the task named and its actions listed', async () => {
    renderPalettes('/tasks/r1')
    await pressP()
    const subject = await screen.findByText('Fix the login redirect', { selector: '[data-slot="task-palette-subject"] *' })
    expect(subject).toBeTruthy()
    expect(await within(palette()!).findByText('Pin')).toBeTruthy()
    expect(within(palette()!).getByText('Archive')).toBeTruthy()
  })

  it('Pin goes through the shared mutation, labelled as the palette for telemetry', async () => {
    renderPalettes('/tasks/r1')
    await pressP()
    fireEvent.click(await within(palette()!).findByText('Pin'))
    await waitFor(() => expect(sent.find((request) => request.path.endsWith('/pin'))).toBeDefined())
    expect(sent.find((request) => request.path.endsWith('/pin'))?.body).toEqual({ pinned: true, surface: 'palette' })
    await waitFor(() => expect(palette()).toBeNull())
  })

  it('fires from inside a text field, where the browser would otherwise print', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' })
    renderPalettes('/tasks/r1')
    const composer = screen.getByTestId('composer')
    composer.focus()
    await pressP(composer, { ctrlKey: true })
    expect(palette()).toBeNull()
    await pressP(composer, { metaKey: true })
    expect(palette()).not.toBeNull()
  })

  it('repeated ⌘P walks the switcher, and Enter opens the task', async () => {
    recordTaskVisit('r3')
    recordTaskVisit('r2')
    recordTaskVisit('r1')
    renderPalettes('/tasks/r1')
    await pressP()
    await within(palette()!).findByText('Pin')
    await pressP()
    await waitFor(() => expect(selectedRow()?.dataset.runId).toBe('r2'))
    expect(input().value).toBe('@')
    await pressP()
    await waitFor(() => expect(selectedRow()?.dataset.runId).toBe('r3'))
    fireEvent.keyDown(input(), { key: 'Enter' })
    // The live list's rows carry their project — here the boot alias.
    await waitFor(() => expect(location()).toBe('/p/default/tasks/r3'))
  })

  it('Tab on a task in the switcher acts on it in place; Backspace walks back', async () => {
    renderPalettes('/tasks/r1')
    await pressP()
    fireEvent.change(input(), { target: { value: '@dark' } })
    await waitFor(() => expect(selectedRow()?.dataset.runId).toBe('r2'))
    fireEvent.keyDown(input(), { key: 'Tab' })
    expect(await screen.findByText('Add dark mode toggle', { selector: '[data-slot="task-palette-subject"] *' })).toBeTruthy()
    expect(location()).toBe('/tasks/r1')
    fireEvent.keyDown(input(), { key: 'Backspace' })
    await waitFor(() => expect(input().value).toBe('@'))
  })

  it('Tab on a task in another project goes there and acts on it', async () => {
    renderPalettes('/tasks/r1', { multiProject: true })
    await pressP()
    await within(palette()!).findByText('Pin')
    fireEvent.change(input(), { target: { value: '@blog' } })
    await waitFor(() => expect(selectedRow()?.dataset.runId).toBe('b1'))
    fireEvent.keyDown(input(), { key: 'Tab' })
    await waitFor(() => expect(location()).toBe('/p/blog/tasks/b1'))
    expect(await screen.findByText('Blog follow-up', { selector: '[data-slot="task-palette-subject"] *' })).toBeTruthy()
    expect(await within(palette()!).findByText('Pin')).toBeTruthy()
  })

  it('⌘P during a rename leaves it, so Enter on the switcher never renames to "@"', async () => {
    renderPalettes('/tasks/r1')
    await pressP()
    fireEvent.click(await within(palette()!).findByText('Rename…'))
    await waitFor(() => expect(input().value).toBe('Fix the login redirect'))
    await pressP(input())
    await waitFor(() => expect(palette()!.dataset.mode).toBe('tasks'))
    expect(input().value).toBe('@')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(sent.some((request) => request.method === 'PATCH')).toBe(false)
  })

  it('Rename edits the title in the palette input', async () => {
    renderPalettes('/tasks/r1')
    await pressP()
    fireEvent.click(await within(palette()!).findByText('Rename…'))
    await waitFor(() => expect(input().value).toBe('Fix the login redirect'))
    fireEvent.change(input(), { target: { value: 'Fix the auth redirect' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await waitFor(() =>
      expect(sent.find((request) => request.method === 'PATCH')?.body).toEqual({ title: 'Fix the auth redirect' }),
    )
  })
})

describe('shortcuts', () => {
  beforeEach(() => vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' }))

  function bridge(overrides: Partial<TaskWorkspaceBridge> = {}): TaskWorkspaceBridge {
    return {
      runId: 'r1',
      views: ['session', 'changes', 'commits'],
      activeView: 'session',
      openView: vi.fn(),
      openViewBeside: vi.fn(),
      layouts: [],
      selectLayout: vi.fn(),
      newLayout: vi.fn(),
      maximized: false,
      toggleMaximized: vi.fn(),
      splitView: null,
      terminal: { allowed: true, open: false, inColumn: false, toggle: vi.fn(), openInColumn: vi.fn() },
      focusComposer: null,
      openFile: vi.fn(),
      markedUnread: vi.fn(),
      ...overrides,
    }
  }

  const press = (target: Element | Window, code: string, key: string, init: KeyboardEventInit) =>
    act(() => {
      fireEvent.keyDown(target, { code, key, ...init })
    })

  it('the defaults run on the task on screen with the palette shut — even from a text field', async () => {
    const workspace = bridge()
    publishTaskWorkspace(workspace)
    renderPalettes('/tasks/r1')
    const composer = screen.getByTestId('composer')
    composer.focus()
    await waitFor(async () => {
      await press(composer, 'Digit2', '2', { metaKey: true })
      expect(workspace.openView).toHaveBeenCalledWith('changes')
    })
    await press(composer, 'Slash', '/', { metaKey: true })
    expect(workspace.terminal.openInColumn).toHaveBeenCalled()
    // ⌥ chords type in a text field, so they never fire there.
    expect(palette()).toBeNull()
  })

  it('a stored shortcut runs its command; one that is not on offer stays the browser’s', async () => {
    uiState = { keybindings: { pin: 'Mod+Shift+L', 'git:push': 'Mod+Shift+U' } }
    renderPalettes('/tasks/r1')
    await waitFor(async () => {
      await press(window, 'KeyL', 'l', { metaKey: true, shiftKey: true })
      expect(sent.find((request) => request.path.endsWith('/pin'))?.body).toEqual({ pinned: true, surface: 'shortcut' })
    })
    const event = new KeyboardEvent('keydown', { code: 'KeyU', key: 'u', metaKey: true, shiftKey: true, cancelable: true })
    act(() => {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
  })

  async function deleteDialogForPickedTask() {
    await pressP()
    await within(palette()!).findByText('Pin')
    fireEvent.change(input(), { target: { value: '@dark' } })
    await waitFor(() => expect(selectedRow()?.dataset.runId).toBe('r2'))
    fireEvent.keyDown(input(), { key: 'Tab' })
    await screen.findByText('Add dark mode toggle', { selector: '[data-slot="task-palette-subject"] *' })
    fireEvent.click(await within(palette()!).findByText('Delete…'))
    return screen.findByRole('alertdialog')
  }

  it('a dialog on a picked task hands the shortcuts back to the page once it closes', async () => {
    uiState = { keybindings: { pin: 'Mod+Shift+L' } }
    renderPalettes('/tasks/r1')
    const confirm = await deleteDialogForPickedTask()
    fireEvent.click(within(confirm).getByText('Keep it'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(async () => {
      await press(window, 'KeyL', 'l', { metaKey: true, shiftKey: true })
      expect(sent.some((request) => request.path.endsWith('/runs/r1/pin'))).toBe(true)
    })
    expect(sent.some((request) => request.path.endsWith('/runs/r2/pin'))).toBe(false)
  })

  it('deleting a picked task leaves the page on screen where it is', async () => {
    renderPalettes('/tasks/r1')
    const confirm = await deleteDialogForPickedTask()
    fireEvent.click(within(confirm).getByText('Delete'))
    await waitFor(() =>
      expect(sent.some((request) => request.method === 'DELETE' && request.path.endsWith('/runs/r2'))).toBe(true),
    )
    // The deletion's success handler runs once the response lands.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(location()).toBe('/tasks/r1')
  })

  it('⇧↵ on a palette row records a shortcut and saves it to the workspace', async () => {
    renderPalettes('/tasks/r1')
    await pressP()
    await within(palette()!).findByText('Pin')
    fireEvent.change(input(), { target: { value: 'pin' } })
    await waitFor(() => expect(selectedRow()?.dataset.commandId).toBe('pin'))
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true })
    expect(await within(palette()!).findByText('Press the keys for this command…')).toBeTruthy()

    // A chord cezar owns is refused, and nothing is saved.
    fireEvent.keyDown(input(), { code: 'KeyK', key: 'k', metaKey: true })
    expect(await within(palette()!).findByText(/taken by the browser or cezar/)).toBeTruthy()
    expect(sent.some((request) => request.method === 'PUT')).toBe(false)

    fireEvent.keyDown(input(), { code: 'KeyL', key: 'l', metaKey: true, shiftKey: true })
    await waitFor(() =>
      expect(sent.find((request) => request.method === 'PUT')?.body).toEqual({ keybindings: { pin: 'Mod+Shift+L' } }),
    )
    // Back on the list, the row now wears its chord.
    await waitFor(() => expect(within(palette()!).getByText('⇧⌘L')).toBeTruthy())
  })
})

describe('⌘P off a task page', () => {
  it('opens the switcher, most recently opened first', async () => {
    recordTaskVisit('r3')
    renderPalettes('/')
    await pressP()
    expect(input().value).toBe('@')
    await waitFor(() => expect(selectedRow()?.dataset.runId).toBe('r3'))
  })
})

describe('⌘K hands a task to ⌘P', () => {
  it('Tab on a ⌘K task row opens ⌘P acting on that task', async () => {
    renderPalettes('/')
    act(() => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true })
    })
    const search = await screen.findByPlaceholderText(/Search projects, tasks/)
    fireEvent.change(search, { target: { value: 'dark' } })
    await waitFor(() =>
      expect(document.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-run-id')).toBe('r2'),
    )
    fireEvent.keyDown(search, { key: 'Tab' })
    expect(await screen.findByText('Add dark mode toggle', { selector: '[data-slot="task-palette-subject"] *' })).toBeTruthy()
    expect(screen.queryByPlaceholderText(/Search projects, tasks/)).toBeNull()
  })
})

describe('the grammar', () => {
  it.each([
    ['', true, 'all', ''],
    ['', false, 'tasks', ''],
    ['@log', true, 'tasks', 'log'],
    ['>pin', true, 'commands', 'pin'],
    ['#src', true, 'files', 'src'],
    ['#src', false, 'tasks', 'src'],
  ] as const)('%j (subject: %s) → %s / %j', (search, hasSubject, mode, query) => {
    expect(paletteMode(search, hasSubject)).toEqual({ mode, query })
  })

  it('reads the task from scoped and flat routes', () => {
    expect(taskIdFromPath('/p/shop/tasks/r1')).toBe('r1')
    expect(taskIdFromPath('/p/shop/tasks/r1/changes')).toBe('r1')
    expect(taskIdFromPath('/tasks/r1')).toBe('r1')
    expect(taskIdFromPath('/p/shop/tasks')).toBeUndefined()
    expect(taskIdFromPath('/dashboard')).toBeUndefined()
  })

  it('ranks file names above directory hits and caps the list', () => {
    const paths = ['src/header/index.ts', 'src/run-header.tsx', 'README.md']
    expect(rankPaths(paths, 'header')[0]).toBe('src/run-header.tsx')
    expect(rankPaths(paths, 'zzz')).toEqual([])
    expect(rankPaths(Array.from({ length: 100 }, (_, index) => `f${index}.ts`), '')).toHaveLength(50)
  })
})

describe('telemetry', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports an opening, the command run from a row, and its own surface on the pin', async () => {
    renderPalettes('/tasks/r1')
    await pressP()
    expect(telemetry.trackPaletteOpened).toHaveBeenCalledWith('task')
    fireEvent.click(await within(palette()!).findByText('Pin'))
    expect(telemetry.countTaskCommand).toHaveBeenCalledWith('pin', 'palette')
    await waitFor(() => expect(sent.find((request) => request.path.endsWith('/pin'))?.body).toEqual({ pinned: true, surface: 'palette' }))
    // Choosing something is not a dismissal.
    expect(telemetry.trackPaletteDismissed).not.toHaveBeenCalled()
  })

  it('a shortcut is counted as a shortcut, and its pin labelled `shortcut`', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' })
    uiState = { keybindings: { pin: 'Mod+Shift+L' } }
    renderPalettes('/tasks/r1')
    await waitFor(async () => {
      await act(() => {
        fireEvent.keyDown(window, { code: 'KeyL', key: 'l', metaKey: true, shiftKey: true })
      })
      expect(sent.find((request) => request.path.endsWith('/pin'))?.body).toEqual({ pinned: true, surface: 'shortcut' })
    })
    expect(telemetry.countTaskCommand).toHaveBeenCalledWith('pin', 'shortcut')
    expect(telemetry.countTaskCommand).not.toHaveBeenCalledWith('pin', 'palette')
  })

  it('the palette coming back on its own (the rename shortcut) is not a new opening', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' })
    uiState = { keybindings: { rename: 'Mod+Shift+E' } }
    renderPalettes('/tasks/r1')
    await waitFor(async () => {
      await act(() => {
        fireEvent.keyDown(window, { code: 'KeyE', key: 'e', metaKey: true, shiftKey: true })
      })
      expect(palette()).not.toBeNull()
    })
    await waitFor(() => expect(input().value).toBe('Fix the login redirect'))
    expect(telemetry.trackPaletteOpened).not.toHaveBeenCalled()
    expect(telemetry.countTaskCommand).toHaveBeenCalledWith('rename', 'shortcut')
  })

  it('a cycled ⌘P ⌘P ↵ is a `cycle` switch; Escape from the switcher is a `tasks` dismissal with its modes', async () => {
    recordTaskVisit('r2')
    recordTaskVisit('r1')
    renderPalettes('/tasks/r1')
    await pressP()
    await within(palette()!).findByText('Pin')
    await pressP()
    await waitFor(() => expect(selectedRow()?.dataset.runId).toBe('r2'))
    fireEvent.keyDown(input(), { key: 'Enter' })
    await waitFor(() => expect(telemetry.trackTaskSwitched).toHaveBeenCalledWith('cycle'))

    await pressP()
    fireEvent.change(input(), { target: { value: '@1482' } })
    fireEvent.keyDown(input(), { key: 'Escape' })
    await waitFor(() => expect(telemetry.trackPaletteDismissed).toHaveBeenCalledWith('tasks'))
    const modes = vi.mocked(telemetry.trackPaletteModes).mock.calls.map(([used]) => [...used])
    expect(modes).toContainEqual(['tasks', 'pr_number'])
  })
})
