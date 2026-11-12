import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'
import { PROJECT_FOLDERS_STORAGE_KEY } from '@/lib/project-folders'

import { ProjectSwitcher, matchesProjectQuery, projectCounts, switcherShortcutFromEvent } from './project-switcher'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  localStorage.clear()
  vi.unstubAllGlobals()
})

function project(over: Partial<ProjectListEntry> = {}): ProjectListEntry {
  return {
    id: 'cezar',
    name: 'cezar',
    root: '/home/me/Projects/cezar',
    addedAt: '2026-07-01T00:00:00.000Z',
    lastOpenedAt: '2026-07-20T12:00:00.000Z',
    source: 'local',
    status: 'ok',
    branch: 'main',
    forge: 'github',
    ...over,
  }
}

function indexRow(over: Partial<RunIndexEntry> & { projectId: string; id: string }): RunIndexEntry {
  return {
    title: over.id,
    status: 'done',
    createdAt: '2026-07-14T10:00:00.000Z',
    lastActivityAt: '2026-07-14T10:00:00.000Z',
    archived: false,
    workflow: 'quick-task',
    ...over,
  } as RunIndexEntry
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function serve(routes: Record<string, unknown>, uiState: Record<string, unknown> = {}): void {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/v1/workspace/ui-state') {
      if ((init?.method ?? 'GET') === 'PUT') {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>
        return json({ ...uiState, ...patch })
      }
      return json(uiState)
    }
    if (url === '/api/v1/workspace/runs-index') {
      return json(routes[url] ?? { runs: [], perProjectLimit: 200, truncated: [], referenceStatuses: {} })
    }
    const body = routes[url]
    if (body === undefined) return json({ error: 'not found' }, 404)
    return json(body)
  })
}

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderSwitcher(projects: ProjectListEntry[], activeId = 'cezar', entry = '/p/cezar/', singleProject = false) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <ProjectSwitcher projects={projects} activeId={activeId} singleProject={singleProject} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const trigger = () => document.querySelector('[data-slot="project-switcher"]') as HTMLButtonElement
const open = async () => {
  fireEvent.click(trigger())
  return screen.findByRole('listbox', { name: 'Switch project' })
}
const rows = () => [...document.querySelectorAll('[data-slot="switcher-project"]')].map((el) => el.getAttribute('data-project'))
const sections = () => [...document.querySelectorAll('[data-slot="switcher-section"]')].map((el) => el.getAttribute('data-folder') ?? 'none')
const three = () => [
  project(),
  project({ id: 'shop', name: 'shop', branch: 'feat/checkout', lastOpenedAt: '2026-07-19T00:00:00.000Z' }),
  project({ id: 'blog', name: 'blog', branch: 'main', lastOpenedAt: '2026-07-10T00:00:00.000Z' }),
]

describe('ProjectSwitcher', () => {
  it('names the active project, its branch and status on the control', () => {
    serve({})
    renderSwitcher(three())
    expect(trigger().getAttribute('aria-label')).toBe('Project: cezar — switch project')
    expect(trigger().querySelector('[data-slot="project-switcher-name"]')?.textContent).toBe('cezar')
    expect(trigger().querySelector('[data-slot="project-switcher-branch"]')?.textContent).toBe('main')
    expect(trigger().querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('groups projects by folder, with the loose ones in a trailing "No folder" group', async () => {
    localStorage.setItem(
      PROJECT_FOLDERS_STORAGE_KEY,
      JSON.stringify([
        { id: 'clients', name: 'Clients', projectIds: ['shop'] },
        { id: 'om', name: 'Open Mercato', projectIds: ['cezar'] },
      ]),
    )
    serve({})
    renderSwitcher(three())
    await open()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(sections()).toEqual(['clients', 'om', 'none'])
    const headings = [...document.querySelectorAll('[cmdk-group-heading]')].map((el) => el.textContent)
    expect(headings[0]).toContain('Clients')
    expect(headings[0]).toContain('· 1')
    expect(headings[2]).toContain('No folder')
    expect(within(document.querySelector('[data-folder="clients"]') as HTMLElement).getByText('shop')).toBeTruthy()
    expect(within(document.querySelector('[data-folder="om"]') as HTMLElement).getByText('cezar')).toBeTruthy()
    expect(document.querySelector('[data-folder="clients"] [data-slot="project-folder-grip"]')).not.toBeNull()
  })

  it('shows no folder heading at all without folders', async () => {
    serve({})
    renderSwitcher(three())
    await open()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(document.querySelectorAll('[cmdk-group-heading]')).toHaveLength(1)
    expect(document.querySelector('[cmdk-group-heading]')?.textContent).toContain('No folder')
  })

  it('filters by name and by branch', async () => {
    serve({})
    renderSwitcher(three())
    await open()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'sho' } })
    await waitFor(() => expect(rows()).toEqual(['shop']))
    fireEvent.change(input, { target: { value: 'checkout' } })
    await waitFor(() => expect(rows()).toEqual(['shop']))
    fireEvent.change(input, { target: { value: 'MAIN' } })
    await waitFor(() => expect(rows()).toEqual(['cezar', 'blog']))
    fireEvent.change(input, { target: { value: 'zzz' } })
    await waitFor(() => expect(rows()).toEqual([]))
    expect(screen.getByText('No project matches.')).toBeTruthy()
  })

  it('hides empty folders while searching', async () => {
    localStorage.setItem(PROJECT_FOLDERS_STORAGE_KEY, JSON.stringify([{ id: 'clients', name: 'Clients', projectIds: ['shop'] }]))
    serve({})
    renderSwitcher(three())
    await open()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'blog' } })
    await waitFor(() => expect(sections()).toEqual(['none']))
  })

  it('ticks the current project and navigates to a picked project’s Now page', async () => {
    serve({})
    renderSwitcher(three())
    await open()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(document.querySelector('[data-slot="switcher-project"][data-project="cezar"]')?.hasAttribute('data-current')).toBe(true)
    expect(document.querySelector('[data-slot="switcher-project"][data-project="cezar"] [role="option"]')?.getAttribute('aria-current')).toBe('true')
    fireEvent.click(document.querySelector('[data-slot="switcher-project"][data-project="shop"] [role="option"]') as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/shop/'))
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  })

  it('walks the list with ↑↓ and picks with ↵', async () => {
    serve({})
    renderSwitcher(three())
    await open()
    await waitFor(() => expect(rows()).toHaveLength(3))
    const input = screen.getByRole('combobox')
    // The current project is pre-selected, so ↓ lands on the next one.
    await waitFor(() =>
      expect(document.querySelector('[role="option"][aria-selected="true"]')?.getAttribute('data-value')).toBe('cezar'),
    )
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() =>
      expect(document.querySelector('[role="option"][aria-selected="true"]')?.getAttribute('data-value')).toBe('shop'),
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/shop/'))
  })

  it('closes on Escape', async () => {
    serve({})
    renderSwitcher(three())
    await open()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  })

  it('opens with ⌘⇧P / Ctrl+Shift+P (⌘P is the task palette’s), not from a text field', async () => {
    serve({})
    renderSwitcher(three())
    fireEvent.keyDown(window, { key: 'P', metaKey: true, shiftKey: true })
    await screen.findByRole('listbox', { name: 'Switch project' })
    expect(switcherShortcutFromEvent({ key: 'p', metaKey: false, ctrlKey: true, shiftKey: true, altKey: false, repeat: false })).toBe(true)
    expect(switcherShortcutFromEvent({ key: 'p', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false })).toBe(false)
    expect(switcherShortcutFromEvent({ key: 'p', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, repeat: true })).toBe(false)
  })

  it('badges each row with its needs-you and running counts from the one runs index', async () => {
    serve({
      '/api/v1/workspace/runs-index': {
        runs: [
          indexRow({ projectId: 'cezar', id: 'a', status: 'review' }),
          indexRow({ projectId: 'cezar', id: 'b', status: 'waiting' }),
          indexRow({ projectId: 'cezar', id: 'c', status: 'running' }),
          indexRow({ projectId: 'shop', id: 'd', status: 'running' }),
          indexRow({ projectId: 'shop', id: 'e', status: 'review', archived: true }),
        ],
        perProjectLimit: 200,
        truncated: [],
        referenceStatuses: {},
      },
    })
    renderSwitcher(three())
    // Closed, the switcher asks for nothing.
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('/api/v1/workspace/runs-index')
    await open()
    const row = (id: string) => document.querySelector(`[data-slot="switcher-project"][data-project="${id}"]`) as HTMLElement
    await waitFor(() => expect(row('cezar').querySelector('[data-slot="project-attention"]')?.textContent).toBe('2'))
    expect(row('cezar').querySelector('[data-slot="project-running"]')?.textContent).toContain('1')
    expect(row('shop').querySelector('[data-slot="project-attention"]')).toBeNull()
    expect(row('shop').querySelector('[data-slot="project-running"]')?.textContent).toContain('1')
    expect(row('blog').querySelector('[data-slot="project-attention"]')).toBeNull()
    expect(row('blog').querySelector('[data-slot="project-running"]')).toBeNull()
  })

  it('renders a missing project inert and dimmed, and leads with an unregistered boot folder', async () => {
    serve({})
    renderSwitcher([
      project(),
      project({ id: 'gone', name: 'old-spike', status: 'missing', lastOpenedAt: '2026-07-01T00:00:00.000Z' }),
      project({ id: 'serve', name: 'served', unregistered: true, lastOpenedAt: '2026-01-01T00:00:00.000Z' }),
    ])
    await open()
    await waitFor(() => expect(rows()).toEqual(['serve', 'cezar', 'gone']))
    const gone = document.querySelector('[data-slot="switcher-project"][data-project="gone"]') as HTMLElement
    expect(gone.querySelector('[role="option"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(gone.querySelector('[data-slot="project-missing"]')?.textContent).toBe('folder not found')
    expect((gone.querySelector('[data-slot="project-grip"]') as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('[data-project="serve"] [data-slot="project-unregistered"]')?.textContent).toBe('not saved')
  })

  describe('reorder (#952)', () => {
    it('renders the stored order instead of the lastOpenedAt sort', async () => {
      serve({}, { sidebar: { projectOrder: ['blog', 'cezar', 'shop'] } })
      renderSwitcher(three())
      await open()
      await waitFor(() => expect(rows()).toEqual(['blog', 'cezar', 'shop']))
    })

    it('floats a project registered since the last drag to the top', async () => {
      serve({}, { sidebar: { projectOrder: ['blog', 'shop'] } })
      renderSwitcher(three())
      await open()
      await waitFor(() => expect(rows()).toEqual(['cezar', 'blog', 'shop']))
    })

    it('gives every row a labelled grip, enabled once the ui-state has answered', async () => {
      serve({}, { sidebar: { projectOrder: ['cezar', 'shop', 'blog'] } })
      renderSwitcher(three())
      await open()
      const grip = (id: string) => document.querySelector(`[data-project="${id}"] [data-slot="project-grip"]`) as HTMLButtonElement
      await waitFor(() => expect(grip('cezar').disabled).toBe(false))
      expect(grip('cezar').getAttribute('aria-label')).toBe('Reorder cezar')
      expect(grip('shop').tagName).toBe('BUTTON')
      // A grip click never selects the row.
      fireEvent.click(grip('shop'))
      expect(screen.getByTestId('location').textContent).toBe('/p/cezar/')
    })

    it('cannot reorder a single-project registry, nor while searching', async () => {
      serve({})
      renderSwitcher([project()])
      await open()
      await waitFor(() => expect(rows()).toEqual(['cezar']))
      expect((document.querySelector('[data-slot="project-grip"]') as HTMLButtonElement).disabled).toBe(true)
      cleanup()
      serve({})
      renderSwitcher(three())
      await open()
      await waitFor(() => expect((document.querySelector('[data-project="shop"] [data-slot="project-grip"]') as HTMLButtonElement).disabled).toBe(false))
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sh' } })
      await waitFor(() => expect((document.querySelector('[data-project="shop"] [data-slot="project-grip"]') as HTMLButtonElement).disabled).toBe(true))
    })
  })

  describe('footer', () => {
    it('offers Add project and New folder; single-project mode drops Add project', async () => {
      serve({})
      renderSwitcher(three())
      await open()
      expect(screen.getByRole('button', { name: 'Add project' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'New folder' })).toBeTruthy()
      cleanup()
      serve({})
      renderSwitcher(three(), 'cezar', '/p/cezar/', true)
      await open()
      expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
      expect(screen.getByRole('button', { name: 'New folder' })).toBeTruthy()
    })

    it('creates a folder through the dialog and files the picked project in it', async () => {
      localStorage.setItem(PROJECT_FOLDERS_STORAGE_KEY, JSON.stringify([{ id: 'old', name: 'Old Folder', projectIds: ['shop'] }]))
      serve({})
      renderSwitcher(three())
      await open()
      fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
      fireEvent.change(await screen.findByPlaceholderText('Client name'), { target: { value: 'New Folder' } })
      fireEvent.click(screen.getByRole('checkbox', { name: 'shop' }))
      fireEvent.click(screen.getByRole('button', { name: 'Save folder' }))

      const stored = JSON.parse(localStorage.getItem(PROJECT_FOLDERS_STORAGE_KEY) ?? '[]') as Array<{ id: string; name: string; projectIds: string[] }>
      expect(stored.find((f) => f.id === 'old')?.projectIds).toEqual([])
      expect(stored.find((f) => f.name === 'New Folder')?.projectIds).toEqual(['shop'])
      await waitFor(() => expect(sections()).toHaveLength(3))
    })
  })
})

describe('projectCounts', () => {
  it('counts needs-you and running per project, skipping archived rows', () => {
    const counts = projectCounts([
      indexRow({ projectId: 'a', id: '1', status: 'review' }),
      indexRow({ projectId: 'a', id: '2', status: 'failed', awaitingAnswerSince: '2026-07-14T10:00:00.000Z' }),
      indexRow({ projectId: 'a', id: '3', status: 'running' }),
      indexRow({ projectId: 'a', id: '4', status: 'running', archived: true }),
      indexRow({ projectId: 'b', id: '5', status: 'done' }),
    ])
    expect(counts.get('a')).toEqual({ needsYou: 2, running: 1 })
    expect(counts.get('b')).toEqual({ needsYou: 0, running: 0 })
    expect(projectCounts(undefined).size).toBe(0)
  })
})

describe('matchesProjectQuery', () => {
  it('matches name or branch, case-insensitively, and everything on a blank query', () => {
    expect(matchesProjectQuery({ name: 'cezar', branch: 'feat/x' }, '')).toBe(true)
    expect(matchesProjectQuery({ name: 'cezar', branch: 'feat/x' }, 'CEZ')).toBe(true)
    expect(matchesProjectQuery({ name: 'cezar', branch: 'feat/x' }, 'feat/')).toBe(true)
    expect(matchesProjectQuery({ name: 'cezar' }, 'feat')).toBe(false)
  })
})
