import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
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
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const HEALTH: HealthResponse = {
  version: '0.1.3',
  projects: [],
  bootProject: 'default',
  repoRoot: '/home/me/Projects/cezar',
  repo: { root: '/home/me/Projects/cezar', branch: 'feat/cockpit', remote: 'origin' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false },
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

const repoChip = () => document.querySelector('[data-slot="repo-chip"]')
const versionChip = () => document.querySelector('[data-slot="version-chip"]')
const navBadge = () => document.querySelector('[data-slot="nav-badge"]')

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
  it('renders the repo and version chips from /api/v1/health', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': [] })
    renderShell()

    await waitFor(() => expect(repoChip()).not.toBeNull())
    // Basename of the root, then the branch — not the whole path.
    expect(repoChip()?.textContent).toBe('cezar / feat/cockpit')
    expect(versionChip()?.textContent).toBe('v0.1.3')
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
      '/api/v1/health': { ...HEALTH, capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false } },
      '/api/v1/todos': TODOS,
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.queryByRole('link', { name: /Inbox/ })).toBeNull()
    expect(navBadge()).toBeNull()
    // Every other view is untouched — the gate owns exactly one item.
    expect(screen.getByRole('link', { name: /Tasks/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Settings/ })).toBeTruthy()
  })

  it('never asks for todos on a server with the inbox off', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false } },
      '/api/v1/todos': TODOS,
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    // The badge query is keyed on the capability, so it never runs — unlike the /inbox route,
    // nothing here needs the list before health has spoken.
    const asked = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(asked).not.toContain('/api/v1/todos')
  })

  it('renders no badge for an empty inbox', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': [] })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    // Zero follow-ups is not "0 follow-ups" — a badge reading 0 is noise the spec's chrome
    // rules do not want.
    expect(navBadge()).toBeNull()
  })

  it('shows no chips at all while health has not answered', () => {
    // A never-resolving fetch: the pending state, held.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
    renderShell()

    expect(repoChip()).toBeNull()
    expect(versionChip()).toBeNull()
    expect(navBadge()).toBeNull()
    // …and the app itself is up. The chips being empty is not a loading screen.
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
  })

  it('shows no chips when the server is unreachable, and still renders the app', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    renderShell()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // The honest empty state: cezar cannot answer what repo it is on, so it says nothing.
    // It does not invent one, and it does not take the whole cockpit down with it.
    expect(repoChip()).toBeNull()
    expect(versionChip()).toBeNull()
    expect(screen.getByText('route content')).toBeTruthy()
  })

  // CEZ_SINGLE_PROJECT pins this response to the boot row even when the saved registry has more.
  // The shell must collapse from that ordinary one-row response, not grow a second capability
  // branch for navigation: flat nav, one quick-list, repo chip, no group headers.
  it('keeps the sidebar flat when single-project mode pins the registry to the boot project', async () => {
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

    await waitFor(() => expect(repoChip()).not.toBeNull())
    expect(document.querySelector('[data-slot="project-groups"]')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(document.querySelector('[data-slot="task-quick-list"]')).not.toBeNull()
    expect(repoChip()?.textContent).toBe('cezar / feat/cockpit')
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

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
    expect(screen.getByRole('link', { name: /New task/ })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
  })

  it('renders one collapsible group per project once the workspace has two', async () => {
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
    renderShell()

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="project-group"]')).toHaveLength(2),
    )
    // The flat nav and the shared quick-list step aside — each group brings its own.
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
    expect(document.querySelector('[data-slot="task-quick-list"]')).toBeNull()
    // …and so does the repo chip, which the boot project's own group header now carries.
    expect(repoChip()).toBeNull()
  })

  it('shows the version chip even outside a git repo', async () => {
    serve({ '/api/v1/health': { ...HEALTH, repo: null }, '/api/v1/todos': [] })
    renderShell()

    // Running cezar outside a repo is supported: no repo chip, but the rest of the chrome is
    // real and must not vanish with it.
    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(versionChip()?.textContent).toBe('v0.1.3')
    expect(repoChip()).toBeNull()
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
