import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from './api/query-client'
import { queryKeys, workspaceQueryKeys } from './api/queries'
import type { ProjectsResponse, WorkspaceUiState } from '@open-mercato/cezar-api-client'
import { AppearanceProvider } from './components/appearance-provider'
import { ListViewProvider } from './components/list-view'
import { ThemeProvider } from './components/theme-provider'
import { LAST_LOCATION_STORAGE_KEY } from './lib/last-location'
import { AppRoutes, pageTitleContext } from './routes'
import { resetDraft } from './routes/new-task-draft'

// The `/` overview fetches `/api/v1/runs` on mount. A never-answering fetch keeps every route
// honestly in its loading state — this file is about the URL map, not about data.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
  // The /new draft store is a module singleton by design — isolate it per test.
  resetDraft()
  // The remembered location is per-browser (localStorage), so it outlives a render otherwise.
  localStorage.clear()
})

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** Seed the location this browser was last on — where the cockpit now remembers it. */
function rememberLocation(lastLocation: unknown): void {
  localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify(lastLocation))
}

/** The boot project (multi-project spec, step 3.2) — what `/api/v1/health.bootProject` and
 *  `/api/v1/projects.bootProject` name, and where every legacy flat URL redirects. */
const BOOT = 'boot'

/** A full-enough `/api/v1/health` answer: the redirect gate reads `bootProject`, and the routes
 *  behind it (inbox, /new) read `capabilities` — a partial seed would crash what a real health
 *  payload never crashes. `followups: true` keeps the Inbox route's real heading. */
const HEALTH = {
  version: '0.0.0-test',
  repoRoot: '/home/u/cezar',
  repo: null,
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, followups: true, singleProject: false, automations: false },
  projects: [{ id: BOOT, name: 'cezar' }],
  bootProject: BOOT,
}

const REGISTRY: ProjectsResponse = {
  projects: [
    {
      id: BOOT,
      name: 'cezar',
      root: '/home/u/cezar',
      addedAt: '',
      lastOpenedAt: '',
      source: 'local',
      status: 'ok',
    },
    {
      id: 'other',
      name: 'other-repo',
      root: '/home/u/other',
      addedAt: '',
      lastOpenedAt: '',
      source: 'local',
      status: 'ok',
    },
  ],
  bootProject: BOOT,
  projectsDir: '~/cezar/projects',
}

/** The address bar, readable from assertions: MemoryRouter keeps its location internal, so the
 *  probe publishes it — that is how the tests prove params and query survive the redirects. */
function LocationProbe() {
  const location = useLocation()
  return (
    <div
      data-testid="location"
      data-pathname={location.pathname}
      data-search={location.search}
      data-hash={location.hash}
    />
  )
}

function ProjectNavigationProbe() {
  const navigate = useNavigate()
  return <button onClick={() => navigate('/p/other/')}>Switch project</button>
}

/** Cold-load the router at a URL, exactly as a pasted deep link would — under the same providers
 *  the app shell supplies. With `seed` (the default) the health and registry answers the redirect
 *  gates need are already cached, the way a warm app has them (plus the workspace UI-state the
 *  appearance provider reads); `seed: false` is the cold state where the boot id is still unknown.
 *  Passing `null` skips an individual seed so error and pending behavior can be exercised without
 *  replacing the shared harness. The remembered location is NOT seeded here — it is per-browser
 *  now, so `rememberLocation` writes it to localStorage instead. */
function renderAt(
  entry: string,
  {
    seed = true,
    health = HEALTH,
    registry = REGISTRY,
    uiState = {},
  }: {
    seed?: boolean
    health?: typeof HEALTH | null
    registry?: ProjectsResponse | null
    uiState?: WorkspaceUiState | Record<string, unknown> | null
  } = {},
) {
  const client = createQueryClient()
  if (seed) {
    // Scope is unset while seeding, so `queryKeys.health` is the unscoped `['default','health']`
    // key the legacy-redirect gate reads.
    if (health !== null) client.setQueryData(queryKeys.health, health)
    if (registry !== null) client.setQueryData(workspaceQueryKeys.projects, registry)
    if (uiState !== null) client.setQueryData(workspaceQueryKeys.uiState, uiState)
  }
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <AppearanceProvider>
          <MemoryRouter initialEntries={[entry]}>
            <ListViewProvider>
              <AppRoutes />
              <LocationProbe />
            </ListViewProvider>
          </MemoryRouter>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
  return client
}

function routeName(): string | null {
  return document.querySelector('[data-route]')?.getAttribute('data-route') ?? null
}

function currentPathname(): string | null {
  return screen.getByTestId('location').getAttribute('data-pathname')
}

function currentSearch(): string | null {
  return screen.getByTestId('location').getAttribute('data-search')
}

function currentHash(): string | null {
  return screen.getByTestId('location').getAttribute('data-hash')
}

describe('pageTitleContext', () => {
  it.each([
    ['/p/cezar/', 'Tasks'],
    ['/new', 'New task'],
    ['/p/cezar/compare/group-1', 'Compare'],
    ['/p/cezar/git', 'Git'],
    ['/p/cezar/git/commits/abc123', 'Git'],
    ['/p/cezar/github/issues/543', 'GitHub'],
    ['/p/cezar/skills', 'Skills'],
    ['/p/cezar/inbox', 'Inbox'],
    ['/p/cezar/workflows/quick-task', 'Workflows'],
    ['/p/cezar/settings/agents', 'Settings'],
    ['/settings/global/projects', 'Settings'],
  ])('labels %s as %s', (pathname, pageLabel) => {
    expect(pageTitleContext(pathname)).toEqual({ pageLabel, taskId: null })
  })

  it.each([
    '/p/cezar/tasks/run-1',
    '/p/cezar/tasks/run-1/changes',
    '/p/cezar/tasks/run-1/files',
    '/p/cezar/tasks/run-1/commits/abc123',
  ])('returns the task lookup key for %s', (pathname) => {
    expect(pageTitleContext(pathname)).toEqual({ pageLabel: null, taskId: 'run-1' })
  })

  it('does not invent a label for an unknown route', () => {
    expect(pageTitleContext('/p/cezar/not-a-route')).toEqual({ pageLabel: null, taskId: null })
  })
})

/** The URL contract from the spec's "Routing — every surface is a URL" section, now under the
 *  `/p/:projectId` prefix (multi-project spec, step 3.2). These paths are pasteable links;
 *  changing one breaks a teammate's bookmark, so the map is asserted URL-by-URL. */
const ROUTE_CASES: Array<[url: string, route: string, title: string]> = [
  ['/', 'tasks', 'Tasks'],
  // The real full-screen composer (R4 Step 1.1): the hero title is the page heading.
  ['/new', 'new', 'What should the agent work on?'],
  // The real thread view (Step R3.1): with fetch never answering it is honestly loading.
  ['/tasks/abc123', 'task-thread', 'Loading task…'],
  // The real R5 tab routes: with fetch never answering they are honestly loading.
  ['/tasks/abc123/changes', 'task-changes', 'Loading changes…'],
  ['/tasks/abc123/files', 'task-files', 'Loading files…'],
  // The real compare view (Step R3 2.3): with fetch never answering it is honestly loading.
  ['/compare/grp-1', 'compare', 'Loading variants…'],
  // The real repo view (R5 Step 1.7): with fetch never answering it is honestly loading —
  // and every segment is its own URL, commit deep links included.
  ['/git', 'repo-git', 'Loading repository…'],
  ['/git/commits', 'repo-git', 'Loading repository…'],
  ['/git/commits/abc1234', 'repo-git', 'Loading repository…'],
  ['/git/branches', 'repo-git', 'Loading repository…'],
  // The real GitHub tab (R6 Step 1.1): with fetch never answering every github URL is
  // honestly loading — lists and item deep links included.
  ['/github', 'github', 'Loading GitHub…'],
  ['/github/prs', 'github', 'Loading GitHub…'],
  ['/github/issues/42', 'github', 'Loading GitHub…'],
  ['/github/prs/7', 'github', 'Loading GitHub…'],
  ['/inbox', 'inbox', 'Inbox'],
  // The real workflow builder (R6 Step 1.6): with fetch never answering both the list URL
  // and a named deep link are honestly loading.
  ['/workflows', 'workflows', 'Loading workflows…'],
  ['/workflows/ship-it', 'workflows', 'Loading workflows…'],
  ['/skills', 'skills', 'Skills'],
  // Project settings only (step 3.5) — appearance/notifications/resources/projects moved to
  // the unscoped `/settings/global/*` area, covered in its own describe below.
  ['/settings', 'settings', 'Settings'],
  ['/settings/agents', 'settings-agents', 'Agents'],
  ['/settings/agent-config', 'settings-agent-config', 'Agent config'],
  ['/settings/worktrees', 'settings-worktrees', 'Worktrees'],
  ['/settings/bookmarklets', 'settings-bookmarklets', 'Bookmarklets'],
  ['/settings/prompt-templates', 'settings-prompt-templates', 'Prompt templates'],
]

describe('scoped route map (/p/:projectId)', () => {
  for (const [url, route, title] of ROUTE_CASES) {
    it(`/p/${BOOT}${url} → ${route}`, () => {
      renderAt(`/p/${BOOT}${url}`)
      expect(routeName()).toBe(route)
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title)
    })
  }

  // The tab lives in the path, so /tasks/:id/changes must not fall back to the thread.
  it('a task tab deep link renders the tab, not the thread', () => {
    renderAt(`/p/${BOOT}/tasks/abc123/changes`)
    expect(document.querySelector('[data-route="task-thread"]')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Loading task…' })).toBeNull()
  })

  // MCP lives inside Agent config; keyboard remains hidden and unrouted.
  const unknown = [
    '/nope-404',
    '/tasks',
    '/settings/nope',
    '/settings/mcp',
    '/settings/keyboard',
    '/tasks/abc123/nope',
    '/compare',
  ]
  for (const url of unknown) {
    it(`/p/${BOOT}${url} → the 404 route`, () => {
      renderAt(`/p/${BOOT}${url}`)
      expect(routeName()).toBe('not-found')
    })
  }

  // Step 4.1: the 404 is a CenteredState with a way home, not a bare stub — and its way home
  // stays inside the active project (the scope-aware Link).
  it('the 404 renders a CenteredState with a back-to-tasks action scoped to the project', () => {
    renderAt(`/p/${BOOT}/definitely-not-a-route`)
    expect(routeName()).toBe('not-found')
    expect(document.querySelector('[data-route="not-found"] [data-slot="centered-state"]')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Page not found')
    expect(screen.getByRole('link', { name: 'Back to tasks' }).getAttribute('href')).toBe(`/p/${BOOT}/`)
  })

  // The area rule (nav links, tab links…) — spot-checked through the Settings shell, whose
  // section links are plain flat `to`s routed through the scope-aware Link.
  it('navigation links generated inside a project carry its prefix', () => {
    renderAt(`/p/${BOOT}/settings`)
    const link = document.querySelector('[data-slot="settings-index"] a[data-section="agents"]')
    expect(link?.getAttribute('href')).toBe(`/p/${BOOT}/settings/agents`)
  })

  it('remounts the same page and loads its new scope when the project param changes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/runs' || path === '/api/v1/p/other/runs') {
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      }
      return new Promise<never>(() => {})
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = createQueryClient()
    client.setQueryData(queryKeys.health, HEALTH)
    client.setQueryData(workspaceQueryKeys.projects, REGISTRY)
    render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <AppearanceProvider>
            <MemoryRouter initialEntries={[`/p/${BOOT}/`]}>
              <ListViewProvider>
                <AppRoutes />
                <ProjectNavigationProbe />
              </ListViewProvider>
            </MemoryRouter>
          </AppearanceProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    )

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/v1/runs')).toBe(true),
    )
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'stale filter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Switch project' }))

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/v1/p/other/runs')).toBe(true),
    )
    expect((screen.getByLabelText('Search tasks') as HTMLInputElement).value).toBe('')
  })
})

/**
 * Global settings (step 3.5) — the one area OUTSIDE `/p/:projectId`. Two things must hold: the
 * URLs render without any project scope, and the sections that MOVED there keep their old
 * project-scoped URLs alive as redirects, so pre-split bookmarks still land.
 */
describe('the global settings area (/settings/global)', () => {
  const GLOBAL_CASES: Array<[string, string, string]> = [
    ['/settings/global', 'settings-global', 'Global settings'],
    ['/settings/global/appearance', 'settings-global-appearance', 'Appearance'],
    ['/settings/global/notifications', 'settings-global-notifications', 'Notifications'],
    ['/settings/global/resources', 'settings-global-resources', 'Resources'],
    ['/settings/global/skills', 'settings-global-skills', 'Skills'],
    ['/settings/global/projects', 'settings-global-projects', 'Projects'],
  ]
  for (const [url, route, title] of GLOBAL_CASES) {
    it(`${url} → ${route}, unscoped`, () => {
      renderAt(url)
      expect(routeName()).toBe(route)
      // Never redirected into a project: the pathname is the one that was asked for.
      expect(currentPathname()).toBe(url)
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title)
    })
  }

  // #801: a bookmarked deep link into any of the four `/automations*` routes still resolves — the
  // route map is unchanged — but the view says the feature is off instead of rendering an editor
  // whose every request would 409.
  for (const path of ['automations', 'automations/new', 'automations/a-1', 'automations/a-1/log']) {
    it(`/${path} renders the disabled state while the capability is off`, async () => {
      renderAt(`/p/${BOOT}/${path}`)
      expect(currentPathname()).toBe(`/p/${BOOT}/${path}`)
      expect(routeName()).toBe('automations')
      expect(await screen.findByText('GitHub automations are off')).not.toBeNull()
      expect(screen.getByText(/CEZ_AUTOMATIONS=1/)).not.toBeNull()
    })
  }

  // The window before health answers is the one that bites: `/automations/new` used to paint a
  // full creation form optimistically, so a cold deep link on a gated server offered a submit
  // that POSTs into a 409. No mode renders until the capability is known.
  it('holds every /automations mode on a loading state until health answers', () => {
    renderAt(`/p/${BOOT}/automations/new`, { health: null })
    expect(routeName()).toBe('automations')
    expect(screen.getByText('Loading automations…')).not.toBeNull()
    expect(document.querySelector('#automation-name')).toBeNull()
    expect(screen.queryByText('GitHub automations are off')).toBeNull()
  })

  it('omits the Projects route when single-project mode is active', () => {
    renderAt('/settings/global/projects', {
      health: { ...HEALTH, capabilities: { ...HEALTH.capabilities, singleProject: true } },
    })
    expect(routeName()).not.toBe('settings-global-projects')
    expect(screen.queryByRole('heading', { level: 1, name: 'Projects' })).toBeNull()
  })

  // A moved section's old URL, in both spellings a bookmark can have it.
  for (const id of ['appearance', 'notifications', 'resources']) {
    it(`/p/${BOOT}/settings/${id} redirects to the global twin`, () => {
      renderAt(`/p/${BOOT}/settings/${id}`)
      expect(currentPathname()).toBe(`/settings/global/${id}`)
      expect(routeName()).toBe(`settings-global-${id}`)
    })

    it(`the legacy flat /settings/${id} lands on the global twin too`, () => {
      renderAt(`/settings/${id}`)
      expect(currentPathname()).toBe(`/settings/global/${id}`)
    })

    it(`/settings/${id} carries query AND hash through BOTH redirect hops`, () => {
      // The legacy flat URL takes two hops — `LegacyPathRedirect` into the boot project, then
      // the moved-section redirect out to the global twin. `settingsSectionPath` returns a bare
      // pathname, so the second hop is exactly where a bookmark's `?…#…` used to disappear.
      renderAt(`/settings/${id}?tab=x&y=a%2Fb#anchor`)
      expect(currentPathname()).toBe(`/settings/global/${id}`)
      expect(currentSearch()).toBe('?tab=x&y=a%2Fb')
      expect(currentHash()).toBe('#anchor')
    })

    it(`/p/${BOOT}/settings/${id} carries query AND hash on the single hop`, () => {
      renderAt(`/p/${BOOT}/settings/${id}?tab=x#anchor`)
      expect(currentPathname()).toBe(`/settings/global/${id}`)
      expect(currentSearch()).toBe('?tab=x')
      expect(currentHash()).toBe('#anchor')
    })
  }
})

/** Legacy flat URLs (BACKWARD_COMPATIBILITY.md): every pre-multi-project path redirects to the
 *  boot project's scoped twin with params intact — old bookmarks keep landing. */
describe('legacy flat URLs redirect to the boot project', () => {
  it('restores the last settled project page from the exact bare root', () => {
    rememberLocation({
      projectId: 'other',
      pathname: '/p/other/tasks/run-1/changes',
      search: '?file=x',
      hash: '#L2',
    })
    renderAt('/')

    expect(currentPathname()).toBe('/p/other/tasks/run-1/changes')
    expect(currentSearch()).toBe('?file=x')
    expect(currentHash()).toBe('#L2')
    expect(routeName()).toBe('task-changes')
  })

  it('keeps an explicit legacy deep link even when another location was saved', () => {
    rememberLocation({ projectId: 'other', pathname: '/p/other/tasks/run-1' })
    renderAt('/tasks/run-2?file=y#L3')

    expect(currentPathname()).toBe('/p/boot/tasks/run-2')
    expect(currentSearch()).toBe('?file=y')
    expect(currentHash()).toBe('#L3')
  })

  it('treats query or hash on / as an explicit boot-project URL', () => {
    rememberLocation({ projectId: 'other', pathname: '/p/other/tasks/run-1' })
    renderAt('/?shared=1#section')

    expect(currentPathname()).toBe('/p/boot/')
    expect(currentSearch()).toBe('?shared=1')
    expect(currentHash()).toBe('#section')
  })

  it.each([
    [
      'malformed',
      REGISTRY,
      { projectId: 'boot', pathname: '/p/other/tasks/run-1' },
    ],
    [
      'unknown',
      REGISTRY,
      { projectId: 'unknown', pathname: '/p/unknown/tasks/run-1' },
    ],
    [
      'missing',
      {
        ...REGISTRY,
        projects: [
          ...REGISTRY.projects,
          { ...REGISTRY.projects[1]!, id: 'gone', name: 'gone', status: 'missing' as const },
        ],
      },
      { projectId: 'gone', pathname: '/p/gone/tasks/run-1' },
    ],
  ])('falls back to the boot project for a %s saved location', (_case, registry, lastLocation) => {
    rememberLocation(lastLocation)
    renderAt('/', { registry })

    expect(currentPathname()).toBe('/p/boot/')
    expect(routeName()).toBe('tasks')
  })

  it('restores a registered not-git project', () => {
    rememberLocation({ projectId: 'other', pathname: '/p/other/' })
    renderAt('/', {
      registry: {
        ...REGISTRY,
        projects: REGISTRY.projects.map((project) =>
          project.id === 'other' ? { ...project, status: 'not-git' as const } : project,
        ),
      },
    })

    expect(currentPathname()).toBe('/p/other/')
    expect(routeName()).toBe('tasks')
  })

  it.each([
    ['the boot project', { projectId: 'boot', pathname: '/p/boot/tasks/run-1' }, '/p/boot/tasks/run-1'],
    ['another project', { projectId: 'other', pathname: '/p/other/tasks/run-1' }, '/p/boot/'],
  ])('with the registry unavailable, handles a saved location for %s', async (_case, lastLocation, expected) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith('/api/v1/projects')) {
          return new Response(JSON.stringify({ error: 'down' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Promise<never>(() => {})
      }),
    )

    rememberLocation(lastLocation)
    renderAt('/', { registry: null })

    await waitFor(() => expect(currentPathname()).toBe(expected), { timeout: 4_000 })
  })

  it('keeps the quiet resolving surface while bare-root inputs are pending', () => {
    renderAt('/', { seed: false })

    expect(routeName()).toBe('scope-resolving')
    expect(currentPathname()).toBe('/')
  })

  it('uses the registry boot project when health fails instead of resolving forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith('/api/v1/health')) {
          return new Response(JSON.stringify({ error: 'down' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Promise<never>(() => {})
      }),
    )

    rememberLocation({ projectId: 'other', pathname: '/p/other/tasks/run-1' })
    renderAt('/', { health: null })

    await waitFor(() => expect(currentPathname()).toBe('/p/other/tasks/run-1'), {
      timeout: 4_000,
    })
    expect(routeName()).toBe('task-thread')
  })

  it('falls through the default alias when health and registry both fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (
          String(input).startsWith('/api/v1/health') ||
          String(input).startsWith('/api/v1/projects')
        ) {
          return new Response(JSON.stringify({ error: 'down' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Promise<never>(() => {})
      }),
    )

    renderAt('/', { health: null, registry: null })

    await waitFor(
      () => {
        expect(currentPathname()).toBe('/p/default/')
        expect(routeName()).toBe('tasks')
      },
      { timeout: 4_000 },
    )
  })

  for (const [url, route] of ROUTE_CASES) {
    it(`${url} → /p/${BOOT}${url}`, () => {
      renderAt(url)
      expect(routeName()).toBe(route)
      expect(currentPathname()).toBe(`/p/${BOOT}${url === '/' ? '/' : url}`)
    })
  }

  it('preserves a query byte-for-byte across the redirect', () => {
    // /skills keeps its `?skill=` selection in the URL, so the address bar itself proves the
    // redirect carried the query untouched (the /new composer consumes-then-clears its own).
    const search = '?skill=om-code-review&x=a%2Fb&auto=1'
    renderAt(`/skills${search}`)
    expect(currentPathname()).toBe(`/p/${BOOT}/skills`)
    expect(currentSearch()).toBe(search)
    expect(routeName()).toBe('skills')
  })

  it('preserves the hash too — /settings/skills through both hops', () => {
    // `/settings/skills` moved to `/skills`, so a legacy flat link redirects twice. Query
    // survival was already asserted; the hash is the half that was silently dropped.
    renderAt('/settings/skills?skill=om-code-review#usage')
    expect(currentPathname()).toBe(`/p/${BOOT}/skills`)
    expect(currentSearch()).toBe('?skill=om-code-review')
    expect(currentHash()).toBe('#usage')
    expect(routeName()).toBe('skills')
  })

  it('delivers the full bookmarklet grammar into the composer (spec 011 contract)', () => {
    renderAt('/new?skill=om-code-review&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1&auto=1&key=s3cret')
    expect(currentPathname()).toBe(`/p/${BOOT}/new`)
    expect(routeName()).toBe('new')
    // auto=1 + key armed the unattended start — only possible if every param survived.
    expect(document.querySelector('[data-slot="auto-starting"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('s3cret')
  })

  it('renders the quiet resolving state while the boot id is unknown — never a wrong screen', () => {
    renderAt('/tasks/abc123', { seed: false })
    expect(routeName()).toBe('scope-resolving')
    expect(currentPathname()).toBe('/tasks/abc123')
  })

  it('an unknown legacy path still ends at the scoped 404', () => {
    renderAt('/definitely-not-a-route')
    expect(routeName()).toBe('not-found')
    expect(currentPathname()).toBe(`/p/${BOOT}/definitely-not-a-route`)
  })

  it('a bare /p names no project and lands on the boot project home', () => {
    renderAt('/p')
    expect(routeName()).toBe('tasks')
    expect(currentPathname()).toBe(`/p/${BOOT}/`)
  })
})

/** `/p/default/…` is the reserved boot alias (never an allocated slug): it resolves to the boot
 *  project and normalizes to the real slug in the address bar. */
describe('the /p/default alias', () => {
  it('normalizes /p/default/tasks/x to /p/<boot>/tasks/x', () => {
    renderAt('/p/default/tasks/x')
    expect(routeName()).toBe('task-thread')
    expect(currentPathname()).toBe(`/p/${BOOT}/tasks/x`)
  })

  it('keeps the query while normalizing', () => {
    renderAt('/p/default/skills?skill=om-code-review')
    expect(currentPathname()).toBe(`/p/${BOOT}/skills`)
    expect(currentSearch()).toBe('?skill=om-code-review')
  })

  it('normalizes the bare /p/default to the boot project home', () => {
    renderAt('/p/default')
    expect(routeName()).toBe('tasks')
    expect(currentPathname()).toBe(`/p/${BOOT}/`)
  })

  it('a registry error still resolves the alias via health instead of loading forever', async () => {
    // `/api/v1/projects` down, `/api/v1/health` already answered (it names the same boot slug): the
    // alias must not park on the quiet resolving screen for good — health is the fallback.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith('/api/v1/projects')) {
          return new Response(JSON.stringify({ error: 'down' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Promise<never>(() => {})
      }),
    )
    const client = createQueryClient()
    client.setQueryData(queryKeys.health, HEALTH)
    render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <AppearanceProvider>
            <MemoryRouter initialEntries={['/p/default/tasks/x']}>
              <ListViewProvider>
                <AppRoutes />
                <LocationProbe />
              </ListViewProvider>
            </MemoryRouter>
          </AppearanceProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    )
    // The client retries a 5xx once with ~1 s of backoff before erroring — give it room.
    await waitFor(() => expect(currentPathname()).toBe(`/p/${BOOT}/tasks/x`), { timeout: 4000 })
    expect(routeName()).toBe('task-thread')
  })

  it('with the registry errored and no health either, the alias mounts the scope rather than spin', async () => {
    // Nothing can name the real boot slug, but the server-side `default` alias answers every
    // `/api/v1/p/default/*` route as the boot project — mounting the routed view (whose own error
    // states are the honest surface) beats a permanent "Loading…".
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith('/api/v1/projects')) {
          return new Response(JSON.stringify({ error: 'down' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Promise<never>(() => {})
      }),
    )
    renderAt('/p/default', { seed: false })
    // The client retries a 5xx once with ~1 s of backoff before erroring — give it room.
    await waitFor(() => expect(routeName()).toBe('tasks'), { timeout: 4000 })
    expect(currentPathname()).toBe('/p/default')
  })
})

/** A deep link to a project this server never registered: the cockpit twin of the API's 404 —
 *  name the problem, list what IS registered, link out. */
describe('unknown project ids', () => {
  it('renders the not-registered screen with the registry list', () => {
    renderAt('/p/nope/tasks/x')
    expect(routeName()).toBe('unknown-project')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('nope')
    const links = Array.from(
      document.querySelectorAll('[data-slot="registered-projects"] a'),
    ).map((a) => a.getAttribute('href'))
    expect(links).toEqual([`/p/${BOOT}/`, '/p/other/'])
  })

  it('stays honestly resolving while the registry is still loading', () => {
    renderAt('/p/nope/tasks/x', { seed: false })
    expect(routeName()).toBe('scope-resolving')
  })
})

/** The bookmarklet contract (spec 011), protected by BACKWARD_COMPATIBILITY.md:
 *  `/new?skill=&ref=&auto=1&key=`. Since R4 Step 1.3 `auto=1` arms the real unattended start
 *  (the full matrix lives in routes/new-task.test.tsx); this file keeps the URL contract —
 *  through the legacy redirect, exactly as a saved bookmarklet arrives. */
describe('/new query params', () => {
  const textarea = () =>
    screen.getByLabelText('Describe a task for the agent') as HTMLTextAreaElement

  it('prefills the composer from a non-auto deep link', () => {
    renderAt('/new?skill=om-code-review&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1')
    expect(routeName()).toBe('new')
    expect(textarea().value).toBe('https://github.com/o/r/pull/1')
  })

  it('an armed auto=1 link shows the starting surface, never the composer mid-flight', () => {
    // fetch never answers here, so the key check is honestly in flight: no composer to type
    // into, no run POSTed, and the key nowhere in the DOM.
    renderAt('/new?skill=om-code-review&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1&auto=1&key=s3cret')
    expect(routeName()).toBe('new')
    expect(document.querySelector('[data-slot="auto-starting"]')).not.toBeNull()
    expect(screen.queryByLabelText('Describe a task for the agent')).toBeNull()
    expect(document.body.textContent).not.toContain('s3cret')
  })

  it('renders an empty composer without params', () => {
    renderAt('/new')
    expect(routeName()).toBe('new')
    expect(textarea().value).toBe('')
  })

  it('never prints the launch key anywhere on the page', () => {
    renderAt('/new?key=s3cret')
    expect(routeName()).toBe('new')
    expect(document.body.textContent).not.toContain('s3cret')
    expect(textarea().value).toBe('')
  })
})
