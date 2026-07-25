import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { FsBrowseResponse, ProjectListEntry } from '@/api/types'
import { AddProjectDialog } from '@/components/add-project-dialog'

/**
 * The add-project folder browser (multi-project spec, step 4.2).
 *
 * Driven through a stubbed `fetch` rather than a mocked client: the request the dialog actually
 * puts on the wire (`?path=`, the POST body) is half of what this step is, and a mocked client
 * would assert the dialog's intent instead of its behavior.
 */

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function project(over: Partial<ProjectListEntry> = {}): ProjectListEntry {
  return {
    id: 'cezar',
    name: 'cezar',
    root: '/home/me/Projects/cezar',
    addedAt: '2026-07-01T00:00:00.000Z',
    lastOpenedAt: '2026-07-20T12:00:00.000Z',
    source: 'local',
    status: 'ok',
    ...over,
  }
}

/** The two listings every test browses: the root (`~`, no parent) and one level down. */
const HOME: FsBrowseResponse = {
  path: '/home/me',
  parent: null,
  dirs: [{ name: 'Projects', path: '/home/me/Projects', isRepo: false }],
  truncated: false,
}

const PROJECTS: FsBrowseResponse = {
  path: '/home/me/Projects',
  parent: '/home/me',
  dirs: [
    { name: 'cezar', path: '/home/me/Projects/cezar', isRepo: true },
    { name: 'notes', path: '/home/me/Projects/notes', isRepo: false },
  ],
  truncated: false,
}

type Answers = {
  /** Keyed by the `path` query value; `''` is the browse root. */
  browse?: Record<string, Response | (() => Response)>
  projects?: ProjectListEntry[]
  /** What `POST /api/projects` answers. Receives the posted root. */
  register?: (root: string) => Response
}

const posted: { root: string }[] = []

function serve({ browse = { '': json(HOME) }, projects = [], register }: Answers = {}): void {
  posted.length = 0
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/projects' && init?.method === 'POST') {
      const root = (JSON.parse(String(init.body)) as { root: string }).root
      posted.push({ root })
      return register ? register(root) : json({ project: project({ id: 'added', root }) })
    }
    if (url.pathname === '/api/projects') return json({ projects, bootProject: 'cezar', projectsDir: '~/cezar/projects' })
    if (url.pathname === '/api/fs/browse') {
      const answer = browse[url.searchParams.get('path') ?? '']
      if (answer === undefined) return json({ error: 'unexpected browse path' }, 500)
      return typeof answer === 'function' ? answer() : answer.clone()
    }
    return json({ error: `unexpected ${String(init?.method ?? 'GET')} ${url.pathname}` }, 404)
  })
}

/** Makes the post-registration navigation assertable. */
function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderDialog() {
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/cezar/']}>
        <AddProjectDialog open onOpenChange={onOpenChange} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onOpenChange }
}

const rows = () => within(document.querySelector('[data-slot="fs-listing"]') as HTMLElement)
const breadcrumb = () => document.querySelector('[data-slot="fs-breadcrumb"]') as HTMLElement
const addButton = () => document.querySelector('[data-slot="add-project-confirm"]') as HTMLButtonElement
const target = () => document.querySelector('[data-slot="add-project-target"]') as HTMLElement

describe('AddProjectDialog', () => {
  it('lists the browse root, badges git repos, and renders no "up" row when parent is null', async () => {
    serve({ browse: { '': json(HOME) } })
    renderDialog()
    await waitFor(() => expect(breadcrumb().textContent).toBe('/home/me'))
    expect(rows().getByText('Projects')).toBeTruthy()
    // parent === null AT the root: an "up" row there would only ever 400.
    expect(document.querySelector('[data-slot="fs-up"]')).toBeNull()
    // Nothing selected yet — the target is the folder being looked at.
    expect(target().textContent).toBe('/home/me')
  })

  it('navigates into a folder and back up, asking the server for each path', async () => {
    // Going back up asks for the parent by its ABSOLUTE path, not for the root sentinel — so
    // `/home/me` must be answerable both ways (`''` on first load, spelled out on the way back).
    serve({
      browse: { '': json(HOME), '/home/me': json(HOME), '/home/me/Projects': json(PROJECTS) },
    })
    renderDialog()
    await waitFor(() => expect(rows().getByText('Projects')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Open Projects' }))
    await waitFor(() => expect(breadcrumb().textContent).toBe('/home/me/Projects'))
    // The git repo is badged; the plain folder is not — and both are listed.
    expect(within(rows().getByText('cezar').closest('button') as HTMLElement).getByText('git')).toBeTruthy()
    expect(rows().getByText('notes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Up one level/ }))
    await waitFor(() => expect(breadcrumb().textContent).toBe('/home/me'))
  })

  it('registers a selected NON-GIT folder and navigates to its scope', async () => {
    serve({
      browse: { '': json(PROJECTS) },
      register: (root) => json({ project: project({ id: 'notes', name: 'notes', root, status: 'not-git' }) }),
    })
    renderDialog()
    await waitFor(() => expect(rows().getByText('notes')).toBeTruthy())
    // A folder without `.git` is selectable and registerable — the spec's explicit requirement.
    fireEvent.click(rows().getByText('notes'))
    expect(target().textContent).toBe('/home/me/Projects/notes')
    fireEvent.click(addButton())
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/notes/'))
    expect(posted).toEqual([{ root: '/home/me/Projects/notes' }])
  })

  it('registers the folder currently being browsed when nothing is selected', async () => {
    serve({ browse: { '': json(PROJECTS) } })
    renderDialog()
    await waitFor(() => expect(target().textContent).toBe('/home/me/Projects'))
    fireEvent.click(addButton())
    await waitFor(() => expect(posted).toEqual([{ root: '/home/me/Projects' }]))
  })

  it('marks an already-registered folder and navigates to it when the server answers 409', async () => {
    serve({
      browse: { '': json(PROJECTS) },
      projects: [project({ id: 'cezar', root: '/home/me/Projects/cezar' })],
      // The registry dedupes by realpath and answers the EXISTING entry — not a dead end.
      register: (root) =>
        json({ project: project({ id: 'cezar', root }), error: 'already registered as cezar' }, 409),
    })
    renderDialog()
    await waitFor(() => expect(rows().getByText('cezar')).toBeTruthy())
    expect(within(rows().getByText('cezar').closest('button') as HTMLElement).getByText('already added')).toBeTruthy()
    fireEvent.click(rows().getByText('cezar'))
    fireEvent.click(addButton())
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/cezar/'))
    expect(document.querySelector('[data-slot="add-project-error"]')).toBeNull()
  })

  it('shows a register refusal verbatim and stays put', async () => {
    serve({
      browse: { '': json(HOME) },
      register: () => json({ error: 'not a project folder: ~ is your home directory or a cezar task worktree' }, 400),
    })
    const { onOpenChange } = renderDialog()
    await waitFor(() => expect(addButton().disabled).toBe(false))
    fireEvent.click(addButton())
    await waitFor(() =>
      expect(document.querySelector('[data-slot="add-project-error"]')?.textContent).toBe(
        'not a project folder: ~ is your home directory or a cezar task worktree',
      ),
    )
    expect(screen.getByTestId('location').textContent).toBe('/p/cezar/')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('shows a browse failure instead of an empty listing', async () => {
    serve({ browse: { '': json({ error: 'path is outside the browsable root' }, 400) } })
    renderDialog()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="fs-error"]')?.textContent).toBe(
        'path is outside the browsable root',
      ),
    )
    expect(document.querySelector('[data-slot="fs-listing"]')).toBeNull()
  })

  it('surfaces the truncated flag rather than showing a silently short list', async () => {
    serve({ browse: { '': json({ ...PROJECTS, truncated: true }) } })
    renderDialog()
    await waitFor(() => expect(document.querySelector('[data-slot="fs-truncated"]')).toBeTruthy())
  })

  it('refetches the project registry after a successful add so the sidebar picks it up', async () => {
    serve({ browse: { '': json(PROJECTS) } })
    renderDialog()
    await waitFor(() => expect(addButton().disabled).toBe(false))
    const listCalls = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input) === '/api/projects' && init?.method !== 'POST',
      ).length
    const before = listCalls()
    fireEvent.click(addButton())
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before))
  })
})
