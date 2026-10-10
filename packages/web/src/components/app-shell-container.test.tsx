import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import type {
  HealthResponse,
  ProviderStatusResponse,
  RunRecord,
  SkillsUpdateState,
} from '@open-mercato/cezar-api-client'
import { AppShellContainer, repoChipOf, skillsUpdateMarkerOf } from '@/components/app-shell-container'
import { ThemeProvider } from '@/components/theme-provider'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  document.title = 'cezar'
  vi.stubGlobal('fetch', fetchMock)
  // jsdom ships no matchMedia; the shell's breakpoint effect and the theme toggle need one.
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  )
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  setViewport(1024)
  localStorage.clear()
})

/** A phone is a width: the shell's breakpoint hook reads `innerWidth` (see app-shell.test.tsx). */
function setViewport(width: number) {
  ;(window as { innerWidth: number }).innerWidth = width
}

const HEALTH: HealthResponse = {
  version: '0.1.3',
  projects: [],
  bootProject: 'default',
  repoRoot: '/home/me/Projects/cezar',
  repo: { root: '/home/me/Projects/cezar', branch: 'feat/cockpit', remote: 'origin' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, terminal: true, preview: true, designMode: true, fileEdit: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, automations: false, dispatch: false },
}

/** One registered project — the degenerate workspace every existing install upgrades into. */
const PROJECT = {
  id: 'cezar',
  name: 'cezar',
  root: '/home/me/Projects/cezar',
  addedAt: '2026-07-01T00:00:00.000Z',
  lastOpenedAt: '2026-07-20T12:00:00.000Z',
  source: 'local' as const,
  status: 'ok' as const,
  branch: 'main',
}

const TODOS = [
  { id: 't1', summary: 'Review the PR' },
  { id: 't2', summary: 'Rebase the branch' },
]

const PROVIDERS: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'disconnected', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
    { provider: 'cursor', status: 'not-installed', enabled: true },
  ],
}

/** Answer each endpoint the shell reads; anything else 404s loudly rather than silently
 *  resolving to `{}` and making a broken wiring look fine. */
function serve(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input)
    const response =
      path === '/api/v1/providers/status'
        ? (routes[path] ?? PROVIDERS)
        : path === '/api/v1/workspace/ui-state'
          ? (routes[path] ?? {})
          : routes[path]
    if (response === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    if (response instanceof Response) return response
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function renderShell(entry = '/', client: QueryClient = createQueryClient()) {
  return {
    client,
    ...render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppShellContainer>
            <p>route content</p>
          </AppShellContainer>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
    ),
  }
}

function renderScopedShell(
  entry: string,
  projectId: string,
  client: QueryClient = createQueryClient(),
) {
  return {
    client,
    ...render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppShellContainer>
            <ProjectScopeProvider projectId={projectId}>
              <p>route content</p>
            </ProjectScopeProvider>
          </AppShellContainer>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
    ),
  }
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    title: 'Raw task prompt',
    titleSummary: 'Implement page titles',
    workflow: 'quick-task',
    task: 'Implement page titles',
    status: 'running',
    createdAt: '2026-07-21T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...overrides,
  }
}

const slot = (name: string, scope: ParentNode = document) =>
  scope.querySelector(`[data-slot="${name}"]`) as HTMLElement | null
const rail = () => slot('rail') as HTMLElement
const navBadge = () => slot('nav-badge')
/** The project tile at the foot of the rail — what the old repo chip became. It names the project
 *  (registry entry, else the boot repo, else the brand) and carries the branch in its tooltip. */
const switcher = () => slot('project-switcher', rail()) as HTMLElement

/** `/api/v1/health` has answered and the shell has painted it: the tools status in the top bar
 *  mounts only then. (The version chip used to be this signal; it lives in a closed menu now.) */
const healthAnswered = () => waitFor(() => expect(slot('tools-menu-trigger')).not.toBeNull())

/** Radix opens a menu on pointerdown, not click. */
async function openMenu(trigger: HTMLElement): Promise<HTMLElement> {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  return await screen.findByRole('menu')
}
/** The cockpit's own menu at the head of the rail — where the version chip lives. */
const openCockpitMenu = () => openMenu(slot('footer-menu', rail()) as HTMLElement)
const openSwitcher = () => openMenu(switcher())
const projectItems = (menu: HTMLElement) =>
  [...menu.querySelectorAll<HTMLElement>('[data-slot="project-group"]')]

/** What the switcher's tooltip says — `<name> · <branch>`. */
async function switcherTooltip(): Promise<string | null> {
  fireEvent.focus(switcher())
  return (await screen.findByRole('tooltip')).textContent
}

describe('repoChipOf', () => {
  it.each([
    { name: 'a plain root', root: '/home/me/Projects/cezar', expected: 'cezar' },
    { name: 'a trailing slash', root: '/home/me/cezar/', expected: 'cezar' },
    { name: 'a windows path', root: 'C:\\Users\\me\\cezar', expected: 'cezar' },
    { name: 'the filesystem root as a repo', root: '/', expected: null },
  ])('takes the basename of $name', ({ root, expected }) => {
    const chip = repoChipOf({ ...HEALTH, repo: { root, branch: 'main' } })
    expect(chip?.name ?? null).toBe(expected)
  })

  it('is null while health is unknown, and outside a git repo', () => {
    expect(repoChipOf(undefined)).toBeNull()
    expect(repoChipOf({ ...HEALTH, repo: null })).toBeNull()
  })
})

const UPDATE: SkillsUpdateState = {
  status: 'available', available: true, autoUpdateEnabled: true, inherited: true,
  checkedAt: '2026-07-22T00:00:00.000Z', updatedAt: null, scopes: [], needsUpgradeNotes: false,
}

describe('skillsUpdateMarkerOf', () => {
  it.each([
    ['loading', undefined, false],
    ['available', UPDATE, true],
    ['proven available with an error', { ...UPDATE, status: 'error' as const }, true],
    ['current', { ...UPDATE, status: 'current' as const, available: false }, false],
    ['unavailable', { ...UPDATE, status: 'unavailable' as const, available: false }, false],
    ['updating', { ...UPDATE, status: 'updating' as const }, false],
  ])('%s → %s', (_name, state, expected) => {
    expect(skillsUpdateMarkerOf(state)).toBe(expected)
  })
})

describe('sidebar wiring', () => {
  it.each([
    ['/settings/global', false],
    ['/tasks', true],
  ] as const)('keeps the boot tracker across global navigation on %s (singleProject=%s)', async (entry, singleProject) => {
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { ...HEALTH.capabilities, singleProject, followups: false } },
      '/api/v1/projects': { projects: [{ ...PROJECT, tracker: 'linear' }], bootProject: PROJECT.id, projectsDir: '/repos' },
    })
    setViewport(390)
    renderShell(entry)

    // The rail (in the tree at every width) offers the boot project's tracker from a page that
    // belongs to no project…
    const onRail = await screen.findByRole('link', { name: 'Linear' })
    expect(rail().contains(onRail)).toBe(true)
    expect(onRail.getAttribute('href')).toBe('/p/cezar/tracker')
    // …and so does the phone's sheet.
    fireEvent.click(within(slot('top-bar') as HTMLElement).getByRole('button', { name: 'Toggle Sidebar' }))
    const drawer = await screen.findByRole('dialog', { name: 'Sidebar' })
    expect(within(drawer).getByRole('link', { name: 'Linear' }).getAttribute('href')).toBe('/p/cezar/tracker')
    // Radix arms its outside-pointer listener a tick after opening; then a whole backdrop tap.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const overlay = slot('sheet-overlay') as HTMLElement
    fireEvent.pointerDown(overlay)
    fireEvent.click(overlay)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sidebar' })).toBeNull())
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    await waitFor(() => expect(document.querySelector('[data-nav-to="/tracker"]')?.textContent).toContain('Linear'))
  })

  it('renders the repo and the version from /api/v1/health', async () => {
    const root = '/home/me/Projects/storefront'
    serve({ '/api/v1/health': { ...HEALTH, repoRoot: root, repo: { ...HEALTH.repo, root } }, '/api/v1/todos': [] })
    renderShell()

    await healthAnswered()
    // Basename of the root — not the whole path — and the branch beside it in the tooltip.
    expect(switcher().getAttribute('aria-label')).toBe('Project: storefront. Switch project')
    expect(slot('repo-chip', switcher())?.textContent).toBe('s')
    expect(await switcherTooltip()).toBe('storefront · feat/cockpit')
    const menu = await openCockpitMenu()
    expect(slot('version-chip', menu)?.textContent).toBe('v0.1.3')
  })

  it('renders the inbox badge from /api/v1/todos', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': TODOS })
    renderShell()

    await waitFor(() => expect(navBadge()).not.toBeNull())
    expect(navBadge()?.textContent).toBe('2')
    expect(screen.getByRole('link', { name: /Inbox/ })).toBeTruthy()
  })

  // #471 — the global inbox is opt-in; the shell must not offer what the server cannot fill.
  it('drops the Inbox nav item and its badge when the server has follow-ups off', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { localHandoff: true, terminal: true, preview: true, designMode: true, fileEdit: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false } },
      '/api/v1/todos': TODOS,
    })
    renderShell()

    await healthAnswered()
    expect(screen.queryByRole('link', { name: /Inbox/ })).toBeNull()
    expect(navBadge()).toBeNull()
    // Every other view is untouched — the gate owns exactly one item.
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'Tasks' })).toBeTruthy()
    expect(within(nav).getByRole('link', { name: 'Project settings' })).toBeTruthy()
  })

  it('never asks for todos on a server with the inbox off', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { localHandoff: true, terminal: true, preview: true, designMode: true, fileEdit: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false } },
      '/api/v1/todos': TODOS,
    })
    renderShell()

    await healthAnswered()
    // The badge query is keyed on the capability, so it never runs — unlike the /inbox route,
    // nothing here needs the list before health has spoken.
    const asked = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(asked).not.toContain('/api/v1/todos')
  })

  // #801 — the same honesty rule for the opt-in automations capability. Both cases carry a
  // reachable forge, so the ONLY thing deciding the Automations item here is the capability:
  // before the flag, every project with a GitHub remote saw that tab.
  const WITH_FORGE = { ...HEALTH, forge: { kind: 'github' as const, available: true } }

  it('drops the Automations nav item when the server has automations off', async () => {
    serve({ '/api/v1/health': WITH_FORGE, '/api/v1/todos': [] })
    renderShell()

    await healthAnswered()
    expect(screen.queryByRole('link', { name: /Automations/ })).toBeNull()
    // The gate owns exactly one item — GitHub is forge-gated, not automations-gated.
    expect(screen.getByRole('link', { name: /GitHub/ })).toBeTruthy()
  })

  it('shows the Automations nav item once health reports the capability', async () => {
    serve({
      '/api/v1/health': { ...WITH_FORGE, capabilities: { ...HEALTH.capabilities, automations: true } },
      '/api/v1/todos': [],
    })
    renderShell()

    await healthAnswered()
    expect(screen.getByRole('link', { name: /Automations/ })).toBeTruthy()
  })

  it('renders no badge for an empty inbox', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': [] })
    renderShell()

    await healthAnswered()
    // Zero follow-ups is not "0 follow-ups" — a badge reading 0 is noise the spec's chrome
    // rules do not want.
    expect(navBadge()).toBeNull()
  })

  it('claims nothing while health has not answered', async () => {
    // A never-resolving fetch: the pending state, held.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
    renderShell()

    // No project is known, so the switcher names the brand — it does not make one up, and it
    // has no branch to show.
    expect(switcher().getAttribute('aria-label')).toBe('Project: cezar. Switch project')
    expect(navBadge()).toBeNull()
    expect(slot('tools-menu-trigger')).toBeNull()
    // Health-gated areas wait for the server's word; the ungated ones are already there.
    expect(screen.queryByRole('link', { name: 'Inbox' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'GitHub' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Git' })).toBeTruthy()
    // …and the app itself is up. The chrome being quiet is not a loading screen.
    expect(screen.getByText('route content')).toBeTruthy()
    expect(rail()).not.toBeNull()
    expect(await switcherTooltip()).toBe('cezar')
    const menu = await openCockpitMenu()
    expect(slot('version-chip', menu)).toBeNull()
  })

  it('shows no chips when the server is unreachable, and still renders the app', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    renderShell()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // The honest empty state: cezar cannot answer what repo it is on, so it says nothing.
    // It does not invent one, and it does not take the whole cockpit down with it.
    expect(switcher().getAttribute('aria-label')).toBe('Project: cezar. Switch project')
    expect(slot('tools-menu-trigger')).toBeNull()
    expect(screen.getByText('route content')).toBeTruthy()
    expect(await switcherTooltip()).toBe('cezar')
    const menu = await openCockpitMenu()
    expect(slot('version-chip', menu)).toBeNull()
  })

  // CEZ_SINGLE_PROJECT pins this response to the boot row even when the saved registry has more.
  // The shell must work from that ordinary one-row response, not grow a second capability
  // branch for navigation: the same rail, pointed at the one project, and a switcher that
  // lists exactly that project.
  it('shows the one project when single-project mode pins the registry to the boot project', async () => {
    serve({
      '/api/v1/health': {
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, singleProject: true },
      },
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'cezar', projectsDir: '/home/me/cezar/projects' },
      '/api/v1/runs': [],
    })
    renderShell()

    await healthAnswered()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'Git' }).getAttribute('href')).toBe('/p/cezar/git'),
    )
    // The registry's own branch for the project, not the boot checkout's stale one.
    expect(await switcherTooltip()).toBe('cezar · main')
    const menu = await openSwitcher()
    expect(projectItems(menu).map((item) => item.dataset.project)).toEqual(['cezar'])
  })

  it('hides add-project chrome when health reports single-project mode', async () => {
    serve({
      '/api/v1/health': {
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, singleProject: true },
      },
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'cezar', projectsDir: '/home/me/cezar/projects' },
      '/api/v1/runs': [],
    })
    renderShell()

    await healthAnswered()
    expect(screen.getByRole('link', { name: /New task/ })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    const menu = await openSwitcher()
    await waitFor(() => expect(projectItems(menu)).toHaveLength(1))
    expect(slot('add-project-local', menu)).toBeNull()
    expect(slot('add-project-clone', menu)).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: 'Manage projects' })).toBeNull()
  })

  it('offers add-project chrome when the server is not in single-project mode', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'cezar', projectsDir: '/home/me/cezar/projects' },
      '/api/v1/runs': [],
    })
    renderShell()

    await healthAnswered()
    const menu = await openSwitcher()
    expect(slot('add-project-local', menu)).not.toBeNull()
    expect(slot('add-project-clone', menu)).not.toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'Manage projects' })).toBeTruthy()
  })

  // One project is on screen at a time: a second project adds a row to the switcher, it does
  // not add a second navigation (the per-project sidebar groups this replaced did).
  it('lists every project in the switcher once the workspace has two, and keeps one navigation', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': {
        projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' }],
        bootProject: 'cezar',
        projectsDir: '/home/me/cezar/projects',
      },
      '/api/v1/workspace/ui-state': {},
      '/api/v1/p/cezar/runs': [],
    })
    renderShell('/p/shop/')

    await healthAnswered()
    await waitFor(() => expect(switcher().getAttribute('aria-label')).toBe('Project: shop. Switch project'))
    // Exactly one navigation, and it is the project's the URL names.
    const navs = screen.getAllByRole('navigation', { name: 'Main' })
    expect(navs).toHaveLength(1)
    expect(within(navs[0]!).getByRole('link', { name: 'Git' }).getAttribute('href')).toBe('/p/shop/git')

    const menu = await openSwitcher()
    expect(projectItems(menu).map((item) => item.dataset.project)).toEqual(['cezar', 'shop'])
    expect(projectItems(menu).map((item) => item.hasAttribute('data-active'))).toEqual([false, true])
  })

  it('does not write a non-boot project run list into the boot cache key', async () => {
    const bootRun = run({ id: 'boot-run', titleSummary: 'Boot task' })
    const shopRun = run({ id: 'shop-run', titleSummary: 'Shop task' })
    serve({
      '/api/v1/health': { ...HEALTH, bootProject: 'cezar' },
      '/api/v1/todos': [],
      '/api/v1/projects': {
        projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'shop', lastOpenedAt: '2026-07-21T00:00:00.000Z' }],
        bootProject: 'cezar',
        projectsDir: '/home/me/cezar/projects',
      },
      '/api/v1/p/cezar/runs': [bootRun],
      '/api/v1/p/shop/runs': [shopRun],
      '/api/v1/workspace/ui-state': {},
    })
    const { client } = renderScopedShell('/p/shop/', 'shop')

    await waitFor(() =>
      expect(client.getQueryData<RunRecord[]>(['shop', 'runs', 'list'])?.map((row) => row.id)).toEqual([
        'shop-run',
      ]),
    )
    expect(client.getQueryData(['default', 'runs', 'list'])).toBeUndefined()
  })

  it('shows the version chip even outside a git repo', async () => {
    serve({ '/api/v1/health': { ...HEALTH, repo: null }, '/api/v1/todos': [] })
    renderShell()

    // Running cezar outside a repo is supported: no repo to name (the switcher falls back to
    // the brand, with no branch), but the rest of the chrome is real and must not vanish with it.
    await healthAnswered()
    expect(switcher().getAttribute('aria-label')).toBe('Project: cezar. Switch project')
    expect(await switcherTooltip()).toBe('cezar')
    const menu = await openCockpitMenu()
    expect(slot('version-chip', menu)?.textContent).toBe('v0.1.3')
  })

  it('wires the provider query into the AppShell banner slot', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'not-installed', enabled: true },
          { provider: 'opencode', status: 'disconnected', enabled: true },
        { provider: 'cursor', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderShell('/p/cezar/')

    const banner = await screen.findByRole('status')
    expect(banner.textContent).toContain('No agent provider credentials were found.')
    expect(document.querySelector('[data-slot="banner-slot"]')?.contains(banner)).toBe(true)
  })

  it('shows a runtime authentication incident in the global banner slot', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'disconnected', enabled: true, authFailureId: 'open-1' },
        { provider: 'cursor', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderShell('/p/cezar/')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(
      'Provider authentication failed during a task: OpenCode.',
    )
    expect(document.querySelector('[data-slot="banner-slot"]')?.contains(alert)).toBe(true)
  })

  it('keeps the shell and route content when provider status fails', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': new Response(JSON.stringify({ error: 'unavailable' }), { status: 500 }),
    })
    const client = createQueryClient()
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, retry: false },
    })
    renderShell('/', client)

    await waitFor(() =>
      expect(client.getQueryState(workspaceQueryKeys.providerStatus)?.status).toBe('error'),
    )
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="app-shell"]')).not.toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the shell and route content when a successful provider response is malformed', async () => {
    const secret = 'unexpected-provider-payload'
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': { providers: [null, { provider: 'future', status: secret }] },
    })
    const client = createQueryClient()
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, retry: false },
    })
    renderShell('/', client)

    await waitFor(() =>
      expect(client.getQueryState(workspaceQueryKeys.providerStatus)?.status).toBe('error'),
    )
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="app-shell"]')).not.toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(secret)).toBeNull()
  })
})

/** The top bar's trail is built here, from the route and the same registry/run data the document
 *  title reads — the shell only paints it. */
describe('top bar trail wiring', () => {
  const trail = () =>
    [...(slot('top-bar') as HTMLElement).querySelectorAll<HTMLElement>('[data-slot="breadcrumb-item"]')].map(
      (item) => [item.textContent, item.querySelector('a')?.getAttribute('href') ?? null],
    )
  const registry = (projects: unknown[]) => ({ projects, bootProject: 'cezar', projectsDir: '/home/me/cezar/projects' })

  it('leads with the project and ends on the page', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, bootProject: 'cezar' },
      '/api/v1/todos': [],
      '/api/v1/projects': registry([{ ...PROJECT, id: 'shop', name: 'Storefront' }]),
      '/api/v1/runs': [],
    })
    renderShell('/p/shop/git')

    await waitFor(() => expect(trail()).toEqual([['Storefront', '/p/shop/'], ['Git', null]]))
  })

  it('puts the Tasks list between the project and an open task, named by its title', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, bootProject: 'cezar' },
      '/api/v1/todos': [],
      '/api/v1/projects': registry([{ ...PROJECT, id: 'shop', name: 'Storefront' }]),
      '/api/v1/runs': [],
      '/api/v1/p/shop/runs': [run()],
    })
    renderShell('/p/shop/tasks/run-1')

    await waitFor(() =>
      expect(trail()).toEqual([
        ['Storefront', '/p/shop/'],
        ['Tasks', '/p/shop/'],
        ['Implement page titles', null],
      ]),
    )
  })

  it('names no project on a page that belongs to none', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, bootProject: 'cezar' },
      '/api/v1/todos': [],
      '/api/v1/projects': registry([PROJECT]),
      '/api/v1/runs': [],
    })
    renderShell('/settings/global/projects')

    await healthAnswered()
    expect(trail()).toEqual([['Global settings', null]])
  })
})

describe('document title wiring', () => {
  const REGISTRY = {
    projects: [PROJECT],
    bootProject: 'cezar',
    projectsDir: '/home/me/cezar/projects',
  }
  const HEALTH_WITH_BOOT = { ...HEALTH, bootProject: 'cezar' }

  it('combines the selected project with scoped page context', async () => {
    serve({
      '/api/v1/health': HEALTH_WITH_BOOT,
      '/api/v1/todos': [],
      '/api/v1/projects': {
        ...REGISTRY,
        projects: [{ ...PROJECT, id: 'shop', name: 'Storefront' }],
      },
      '/api/v1/runs': [],
    })
    renderShell('/p/shop/git')

    await waitFor(() => expect(document.title).toBe('Storefront — Git · cezar'))
  })

  it('falls back to the boot repository name when the registry is unavailable', async () => {
    serve({ '/api/v1/health': HEALTH_WITH_BOOT, '/api/v1/todos': [], '/api/v1/runs': [] })
    renderShell('/p/cezar/')

    await waitFor(() => expect(document.title).toBe('cezar — Tasks · cezar'))
  })

  it('keeps global settings and a no-repo task route free of invented project context', async () => {
    serve({
      '/api/v1/health': { ...HEALTH_WITH_BOOT, repo: null },
      '/api/v1/todos': [],
      '/api/v1/projects': REGISTRY,
      '/api/v1/runs': [],
    })
    const global = renderShell('/settings/global/projects')

    await waitFor(() => expect(document.title).toBe('Settings · cezar'))
    global.unmount()

    renderShell('/tasks/missing')
    await waitFor(() => expect(document.title).toBe('cezar'))
  })

  it('updates after in-app navigation without remounting the shell', async () => {
    serve({
      '/api/v1/health': HEALTH_WITH_BOOT,
      '/api/v1/todos': [],
      '/api/v1/projects': REGISTRY,
      '/api/v1/runs': [],
    })
    renderShell('/p/cezar/')

    await waitFor(() => expect(document.title).toBe('cezar — Tasks · cezar'))
    fireEvent.click(screen.getByRole('link', { name: 'Git' }))
    await waitFor(() => expect(document.title).toBe('cezar — Git · cezar'))
  })

  it('reacts to live project and task title cache updates', async () => {
    const initialRun = run()
    serve({
      '/api/v1/health': HEALTH_WITH_BOOT,
      '/api/v1/todos': [],
      '/api/v1/projects': {
        ...REGISTRY,
        projects: [{ ...PROJECT, id: 'shop', name: 'Storefront' }],
      },
      '/api/v1/runs': [],
      '/api/v1/p/shop/runs': [initialRun],
    })
    const { client } = renderShell('/p/shop/tasks/run-1')

    await waitFor(() =>
      expect(document.title).toBe('Storefront — Implement page titles · cezar'),
    )

    act(() => {
      client.setQueryData(workspaceQueryKeys.projects, {
        ...REGISTRY,
        projects: [{ ...PROJECT, id: 'shop', name: 'Renamed storefront' }],
      })
      client.setQueryData(['shop', 'runs', 'list'], [
        { ...initialRun, titleSummary: 'Rename browser titles' },
      ])
    })

    await waitFor(() =>
      expect(document.title).toBe('Renamed storefront — Rename browser titles · cezar'),
    )
  })
})
