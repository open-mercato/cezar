import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { AppearanceProvider } from '@/components/appearance-provider'
import { OPEN_COMMAND_PALETTE_EVENT } from '@/components/command-palette'
import { ListViewProvider } from '@/components/list-view'
import { ThemeProvider } from '@/components/theme-provider'
import { recordSettingsReturn, resetSettingsReturn } from '@/lib/settings-return'
import { AppRoutes } from '@/routes'
import { SETTINGS_SECTIONS, settingsSectionsByScope, visibleSettingsSections } from './registry'

/**
 * The Settings shell + Appearance section (R6 Step 1.3): registry rendering, hidden gating,
 * the project/global scope split (step 3.5), the appearance round-trip against a stubbed
 * ui-state API, and boot application of persisted values. The URL map itself (including
 * hidden sections 404ing) lives in routes.test.tsx.
 *
 * The scope split is what most of this file now pins, and it is pinned where it is observable:
 * WHICH STORE a section writes. Appearance and Notifications must reach
 * `/api/v1/workspace/ui-state` (global), Agents must reach `/api/v1/config` (project) — the stub
 * below answers both and records every request, so a section writing the wrong one shows up as
 * a wrong URL rather than as a passing test.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

/** Both ui-state stores plus the project config answer; everything else the routes fetch stays
 *  honestly pending. Both stores are served on purpose — a section writing to the wrong one
 *  would otherwise hang instead of failing loudly. */
function serve(uiState: Record<string, unknown> = {}, { projectsDown = false }: { projectsDown?: boolean } = {}) {
  requests = []
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  const projectUiState: Record<string, unknown> = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      if (projectsDown && url === '/api/v1/projects') return new Response('registry down', { status: 500 })
      if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json(uiState)
      if (url === '/api/v1/workspace/ui-state' && method === 'PUT')
        return json({ ...uiState, ...(body as Record<string, unknown>) })
      if (url === '/api/v1/ui-state' && method === 'GET') return json(projectUiState)
      if (url === '/api/v1/ui-state' && method === 'PUT')
        return json({ ...projectUiState, ...(body as Record<string, unknown>) })
      if (url === '/api/v1/config') return json(AGENTS_CONFIG)
      if (url === '/api/v1/providers/status')
        return json({
          providers: [
            { provider: 'claude', status: 'connected', enabled: true },
            { provider: 'codex', status: 'connected', enabled: true },
            { provider: 'opencode', status: 'connected', enabled: true },
            { provider: 'cursor', status: 'connected', enabled: true },
        ],
        })
      if (url.startsWith('/api/v1/models?runner=')) {
        const runner = url.includes('cursor') ? 'cursor' : 'codex'
        return json({ runner, models: [], source: 'unavailable', stale: false })
      }
      return new Promise<never>(() => {})
    }),
  )
}

/** Enough of `GET /api/v1/config` for the Agents section to render its form. */
const AGENTS_CONFIG = {
  baseBranch: null,
  defaultRunner: 'claude',
  systemPrompt: null,
  branchNaming: null,
  defaultModels: {},
  maxParallel: 2,
  memoryLimitMb: null,
  worktreeRetention: 10,
  liveTitleUpdates: null,
  reviewGate: null,
}

/** Seeds the step-3.2 route gates — boot id (legacy redirect) + registry (known-check) — so a
 *  flat entry URL lands scoped immediately. The boot project mounts UNSCOPED, so the exact
 *  `/api/v1/*` paths this file's fetch stub matches stay byte-identical. */
function gateSeededClient(singleProject = false, projects: ProjectListEntry[] = []) {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    capabilities: { localHandoff: true, terminal: false, followups: true, singleProject },
  })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects,
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

/** The address bar, readable from assertions — how the Back/Escape tests prove where they went. */
function LocationProbe() {
  const location = useLocation()
  return (
    <span data-testid="location" data-search={location.search} data-hash={location.hash}>
      {location.pathname}
    </span>
  )
}
const currentPathname = () => screen.getByTestId('location').textContent

function renderAt(
  entry: string,
  { singleProject = false, projects = [] }: { singleProject?: boolean; projects?: ProjectListEntry[] } = {},
) {
  render(
    <QueryClientProvider client={gateSeededClient(singleProject, projects)}>
      <ThemeProvider>
        <AppearanceProvider>
          <MemoryRouter initialEntries={[entry]}>
            {/* ListViewProvider: the Back fallback lands on the tasks pane, which reads it. */}
            <ListViewProvider>
              <AppRoutes />
            </ListViewProvider>
            <LocationProbe />
            {/* A form field outside every section — what the Escape test focuses. */}
            <input data-testid="field" aria-label="field" />
          </MemoryRouter>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

/** A registry worth a tree: the boot project, a second one, and one whose folder is gone. */
const entry = (id: string, extra: Partial<ProjectListEntry> = {}): ProjectListEntry => ({
  id,
  name: id,
  root: `/work/${id}`,
  addedAt: '2026-07-20T09:00:00.000Z',
  lastOpenedAt: '2026-07-20T09:00:00.000Z',
  source: 'local',
  status: 'ok',
  ...extra,
})
const REGISTRY = [
  entry('boot', { name: 'cezar', branch: 'main' }),
  entry('other', { name: 'storefront', lastOpenedAt: '2026-07-19T09:00:00.000Z' }),
  entry('gone', { name: 'old-repo', status: 'missing', lastOpenedAt: '2026-07-18T09:00:00.000Z' }),
]

beforeEach(() => {
  serve()
  resetSettingsReturn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  delete document.documentElement.dataset.accent
  delete document.documentElement.dataset.density
  delete document.documentElement.dataset.width
  document.documentElement.classList.remove('light')
})

const PROJECT_SECTIONS = ['tracker', 'secrets', 'integrations', 'agents', 'instructions', 'tasks', 'agent-config', 'worktrees', 'bookmarklets']
const GLOBAL_SECTIONS = [
  'appearance',
  'notifications',
  // Task-palette shortcuts (spec 2026-10-17-task-palette) — the person at the keyboard.
  'keyboard',
  'resources',
  'skills',
  // Agent accounts (spec 2026-07-29-agent-profiles) sit beside Projects: both describe the
  // machine and the person at it, not any one repo.
  'workspace-secrets',
  'accounts',
  'projects',
  // Telemetry consent (docs/telemetry.md) — one answer per machine.
  'privacy',
]

describe('the section registry', () => {
  it('declares the spec §Settings sections, all of them implemented', () => {
    const byId = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]))
    for (const id of [...PROJECT_SECTIONS, ...GLOBAL_SECTIONS]) {
      expect(byId.get(id as never)?.hidden).toBeUndefined()
    }
  })

  it('splits the sections by scope (step 3.5) — each id belongs to exactly one area', () => {
    expect(visibleSettingsSections('project').map((s) => s.id)).toEqual(PROJECT_SECTIONS)
    expect(visibleSettingsSections('global').map((s) => s.id)).toEqual(GLOBAL_SECTIONS)
    // No id may appear in both areas — the two navs would then link to two different pages
    // under the same name, and the `settings/<id>` legacy redirect would be ambiguous.
    expect(PROJECT_SECTIONS.filter((id) => GLOBAL_SECTIONS.includes(id))).toEqual([])
  })

  it('hides Projects only when the single-project capability is active', () => {
    // Accounts survives: a single-project cockpit still runs on ONE of possibly several logins,
    // so "which account" is orthogonal to "how many projects".
    expect(visibleSettingsSections('global', { singleProject: true }).map((s) => s.id)).toEqual([
      'appearance', 'notifications', 'keyboard', 'resources', 'skills', 'workspace-secrets', 'accounts', 'privacy',
    ])
    expect(visibleSettingsSections('global', { singleProject: false }).map((s) => s.id)).toEqual(GLOBAL_SECTIONS)
    expect(visibleSettingsSections('global').map((s) => s.id)).toEqual(GLOBAL_SECTIONS)
  })
})

describe('the settings shell', () => {
  const nav = () => document.querySelector('[data-slot="settings-nav"]')!
  const sectionIds = (root: Element) =>
    [...root.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
  const projectSectionLinks = (projectId: string) =>
    [...nav().querySelectorAll<HTMLAnchorElement>(`[data-project="${projectId}"][data-project-section]`)]

  it('exposes both areas at once through settingsSectionsByScope', () => {
    expect(settingsSectionsByScope().global.map((s) => s.id)).toEqual(GLOBAL_SECTIONS)
    expect(settingsSectionsByScope().project.map((s) => s.id)).toEqual(PROJECT_SECTIONS)
    expect(settingsSectionsByScope({ singleProject: true }).global.map((s) => s.id)).not.toContain('projects')
  })

  it('renders ONE nav on a project page: the global sections, then the project tree with the URL\'s project open', () => {
    renderAt('/settings/agents', { projects: REGISTRY })
    expect(nav().getAttribute('data-scope')).toBe('project')
    // The global rows are the flat `[data-section]` links, unprefixed — same as at /settings/global.
    expect(sectionIds(nav())).toEqual(GLOBAL_SECTIONS)
    expect(nav().querySelector('[data-section="resources"]')?.getAttribute('href')).toBe('/settings/global/resources')
    // No global row is current on a project page…
    expect(nav().querySelector('[data-section][aria-current="page"]')).toBeNull()

    // …the tree lists every registered project, most recently opened first, and only the
    // project the URL names is expanded.
    const rows = [...nav().querySelectorAll('[data-slot="settings-project"]')]
    expect(rows.map((row) => row.getAttribute('data-project'))).toEqual(['boot', 'other', 'gone'])
    expect(rows[0]?.hasAttribute('data-expanded')).toBe(true)
    expect(rows[1]?.hasAttribute('data-expanded')).toBe(false)
    expect(projectSectionLinks('other')).toHaveLength(0)

    // Its section links are EXPLICITLY scoped to that project, and the active one is marked.
    const links = projectSectionLinks('boot')
    expect(links.map((el) => el.getAttribute('data-project-section'))).toEqual(PROJECT_SECTIONS)
    expect(links.map((el) => el.getAttribute('href'))).toEqual(
      PROJECT_SECTIONS.map((id) => `/p/boot/settings/${id}`),
    )
    expect(nav().querySelector('[data-project-section][aria-current="page"]')?.getAttribute('data-project-section')).toBe('agents')
    // With Agents open, another project's name is a one-click switch to ITS Agents; the active
    // project's own name only folds its menu.
    expect(rows[1]?.querySelector('[data-slot="settings-project-link"]')?.getAttribute('href')).toBe('/p/other/settings/agents')
    expect(rows[0]?.querySelector('[data-slot="settings-project-link"]')).toBeNull()
    expect(rows[0]?.querySelector('[data-slot="settings-project-toggle"]')).not.toBeNull()
    expect(rows[0]?.textContent).toContain('cezar')
    // No branch in settings — the row is the project's name only.
    expect(rows[0]?.textContent).not.toContain('main')
  })

  it('expanding another project links into THAT project, not the active one', () => {
    renderAt('/settings/agents', { projects: REGISTRY })
    fireEvent.click(screen.getByRole('button', { name: 'Expand storefront' }))
    const links = projectSectionLinks('other')
    expect(links.map((el) => el.getAttribute('href'))).toEqual(
      PROJECT_SECTIONS.map((id) => `/p/other/settings/${id}`),
    )
    // Not the active project: none of its rows may claim the current page.
    expect(links.some((el) => el.getAttribute('aria-current') === 'page')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse storefront' }))
    expect(projectSectionLinks('other')).toHaveLength(0)
  })

  it('on mobile the hamburger opens the same sidebar as a drawer, which closes once a section is picked', async () => {
    renderAt('/settings/global/appearance', { projects: REGISTRY })
    expect(document.querySelector('[data-slot="settings-mobile-drawer"]')).toBeNull()
    // The top bar's first control is the menu, not Back — Back lives inside the drawer.
    const bar = document.querySelector('[data-slot="settings-mobile-bar"]')!
    expect(bar.querySelector('[data-slot="settings-back"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open settings menu' }))

    const drawer = await waitFor(() => {
      const el = document.querySelector('[data-slot="settings-mobile-drawer"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(drawer.getAttribute('role')).toBe('dialog')
    // The SAME content as the desktop column: Back, both groups, the launcher.
    expect(drawer.querySelector('[data-slot="settings-back"]')).not.toBeNull()
    expect(drawer.textContent).toContain('General settings')
    expect(drawer.textContent).toContain('Project settings')
    expect(drawer.querySelector('[data-slot="command-palette-hint"]')).not.toBeNull()

    fireEvent.click(drawer.querySelector('[data-section="resources"]')!)
    expect(currentPathname()).toBe('/settings/global/resources')
    await waitFor(() => expect(document.querySelector('[data-slot="settings-mobile-drawer"]')).toBeNull())
  })

  it('a project name reveals its menu when no project section is open, and switches section when one is', () => {
    // Global page: nothing to switch to — the name is a disclosure, not a link.
    renderAt('/settings/global/appearance', { projects: REGISTRY })
    const other = () => nav().querySelector('[data-slot="settings-project"][data-project="other"]')!
    expect(other().querySelector('a[data-slot="settings-project-link"]')).toBeNull()
    fireEvent.click(other().querySelector('[data-slot="settings-project-toggle"]')!)
    expect(other().hasAttribute('data-expanded')).toBe(true)
    expect(projectSectionLinks('other')).toHaveLength(PROJECT_SECTIONS.length)
    fireEvent.click(other().querySelector('[data-slot="settings-project-toggle"]')!)
    expect(other().hasAttribute('data-expanded')).toBe(false)
    cleanup()

    // On a project's General page, clicking the other project lands on ITS General — and the
    // previous project folds, since expansion follows the URL's project.
    renderAt('/settings', { projects: REGISTRY })
    const boot = () => nav().querySelector('[data-slot="settings-project"][data-project="boot"]')!
    expect(boot().hasAttribute('data-expanded')).toBe(true)
    fireEvent.click(other().querySelector('a[data-slot="settings-project-link"]')!)
    expect(currentPathname()).toBe('/p/other/settings')
    expect(other().hasAttribute('data-expanded')).toBe(true)
    expect(boot().hasAttribute('data-expanded')).toBe(false)
    expect(
      nav().querySelector('[data-project="other"][data-slot="settings-project-general"]')?.getAttribute('aria-current'),
    ).toBe('page')
    cleanup()

    // Project page with Worktrees open: clicking the other project lands on ITS Worktrees.
    renderAt('/settings/worktrees', { projects: REGISTRY })
    fireEvent.click(other().querySelector('a[data-slot="settings-project-link"]')!)
    expect(currentPathname()).toBe('/p/other/settings/worktrees')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Worktrees')
    // …and it is now the expanded one, with its Worktrees row current.
    expect(other().hasAttribute('data-expanded')).toBe(true)
    expect(nav().querySelector('[data-project-section][aria-current="page"]')?.getAttribute('data-project')).toBe('other')
  })

  it('every project section keeps a way BACK to its index: the "General" entries (main #772)', () => {
    renderAt('/settings/worktrees', { projects: REGISTRY })
    // The global area has no index row — its index is a redirect, not a page.
    expect(nav().querySelector('[data-slot="settings-nav-index"]')).toBeNull()
    // The ACTIVE project's own index (its General page), scoped to it.
    expect(
      nav().querySelector('[data-project="boot"][data-slot="settings-project-general"]')?.getAttribute('href'),
    ).toBe('/p/boot/settings')
    // The mobile pill row carries it too — the index is the ONLY place small screens see it.
    expect(
      document.querySelector('[data-slot="settings-nav-mobile"] [data-slot="settings-nav-index"]')?.getAttribute('href'),
    ).toBe('/p/boot/settings')
    // A section is open, so neither General is the current page.
    expect(document.querySelector('[data-slot="settings-nav-index"][aria-current="page"]')).toBeNull()
    expect(document.querySelector('[data-slot="settings-project-general"][aria-current="page"]')).toBeNull()
  })

  it('"General" is the current entry on the project index itself', () => {
    renderAt('/settings', { projects: REGISTRY })
    expect(
      nav().querySelector('[data-project="boot"][data-slot="settings-project-general"]')?.getAttribute('aria-current'),
    ).toBe('page')
    // The project index is a page of its own (folder, registry facts), not only a card menu.
    expect(document.querySelector('[data-slot="project-general"], [data-route="settings"]')).not.toBeNull()
  })

  it('/settings/global is no card menu: it redirects to the first global section, query and hash kept', () => {
    renderAt('/settings/global?agent=codex#x', { projects: REGISTRY })
    expect(currentPathname()).toBe(`/settings/global/${GLOBAL_SECTIONS[0]}`)
    expect(document.querySelector(`[data-route="settings-global-${GLOBAL_SECTIONS[0]}"]`)).not.toBeNull()
    expect(nav().querySelector('[aria-current="page"]')?.getAttribute('data-section')).toBe(GLOBAL_SECTIONS[0])
    // Nothing that repeated the sidebar survives.
    expect(document.querySelector('[data-slot="settings-index"]')).toBeNull()
    expect(document.querySelector('[data-slot="settings-project-index"]')).toBeNull()
    expect(document.querySelector('[data-slot="settings-nav-index"]')).toBeNull()
    expect(screen.getByTestId('location').getAttribute('data-search')).toBe('?agent=codex')
    expect(screen.getByTestId('location').getAttribute('data-hash')).toBe('#x')
  })

  it('renders the SAME nav at /settings/global — global row current, no project row current', () => {
    renderAt('/settings/global/appearance', { projects: REGISTRY })
    expect(nav().getAttribute('data-scope')).toBe('global')
    expect(sectionIds(nav())).toEqual(GLOBAL_SECTIONS)
    expect(nav().querySelector('[aria-current="page"]')?.getAttribute('data-section')).toBe('appearance')
    expect(nav().querySelector('[data-section="skills"]')?.getAttribute('href')).toBe('/settings/global/skills')
    // The tree is there too, every project collapsed: no project is in scope on a global page.
    const rows = [...nav().querySelectorAll('[data-slot="settings-project"]')]
    expect(rows).toHaveLength(3)
    expect(rows.some((row) => row.hasAttribute('data-expanded'))).toBe(false)
    expect(nav().querySelector('[data-project-section]')).toBeNull()
  })

  it('an UNREGISTERED boot project (cezar started from a task worktree) gets no row — it is not a project', () => {
    // The registry lists two other projects but not `boot`; health knows the boot repo.
    const others = REGISTRY.filter((p) => p.id !== 'boot')
    const client = gateSeededClient(false, others)
    client.setQueryData(queryKeys.health, {
      bootProject: 'boot',
      repoRoot: '/work/checkouts/my-repo',
      repo: { root: '/work/checkouts/my-repo', branch: 'feature/x' },
      capabilities: { localHandoff: true, followups: true, singleProject: false },
    })
    const at = (entry: string) => {
      render(
        <QueryClientProvider client={client}>
          <ThemeProvider>
            <AppearanceProvider>
              <MemoryRouter initialEntries={[entry]}>
                <ListViewProvider>
                  <AppRoutes />
                </ListViewProvider>
              </MemoryRouter>
            </AppearanceProvider>
          </ThemeProvider>
        </QueryClientProvider>,
      )
      const out = {
        rows: [...document.querySelectorAll('[data-slot="settings-nav"] [data-slot="settings-project"]')].map((row) => row.getAttribute('data-project')),
        nav: nav().textContent ?? '',
        sections: projectSectionLinks('boot').map((el) => el.getAttribute('href')),
      }
      cleanup()
      return out
    }
    // Global page and another project's page: registered projects only, no boot row anywhere.
    for (const entry of ['/settings/global', '/p/other/settings/agents']) {
      const seen = at(entry)
      expect(seen.rows).toEqual(['other', 'gone'])
      expect(seen.sections).toEqual([])
      expect(seen.nav).not.toContain('my-repo')
    }
    // Its OWN page is the one exception: its sections render flat, and the registered projects
    // get no rows beside them, so it never appears as one of the list.
    const own = at('/p/boot/settings/agents')
    expect(own.rows).toEqual([])
    expect(own.nav).toContain('This project')
    expect(own.sections).toEqual(PROJECT_SECTIONS.map((id) => `/p/boot/settings/${id}`))
  })

  it('renders no stray `end` attribute on the pill row — the project pills are real NavLinks', () => {
    renderAt('/settings/agents', { projects: REGISTRY })
    const pills = document.querySelector('[data-slot="settings-nav-mobile"]')!
    expect(pills.querySelector('[end]')).toBeNull()
    expect(pills.getAttribute('aria-label')).toBe('Sections of this area')
    // NavLink's own matching marks the open section.
    expect(pills.querySelector('[data-section="agents"]')?.getAttribute('aria-current')).toBe('page')
  })

  it('a fold made on one project\'s page does not follow the user to another project and back', () => {
    renderAt('/settings', { projects: REGISTRY })
    const boot = () => nav().querySelector('[data-slot="settings-project"][data-project="boot"]')!
    const other = () => nav().querySelector('[data-slot="settings-project"][data-project="other"]')!
    fireEvent.click(screen.getByRole('button', { name: 'Collapse cezar' }))
    expect(boot().hasAttribute('data-expanded')).toBe(false)
    // Switch to the other project's General, then back to boot's.
    fireEvent.click(other().querySelector('a[data-slot="settings-project-link"]')!)
    expect(currentPathname()).toBe('/p/other/settings')
    fireEvent.click(boot().querySelector('a[data-slot="settings-project-link"]')!)
    expect(currentPathname()).toBe('/p/boot/settings')
    // Back on its own page it is open again: the earlier fold belonged to the earlier page.
    expect(boot().hasAttribute('data-expanded')).toBe(true)
  })

  it('a double-click on the chevron toggles twice, not zero times', () => {
    renderAt('/settings/global/appearance', { projects: REGISTRY })
    const other = () => nav().querySelector('[data-slot="settings-project"][data-project="other"]')!
    const chevron = () => screen.getByRole('button', { name: /^(Expand|Collapse) storefront$/ })
    fireEvent.click(chevron())
    fireEvent.click(chevron())
    expect(other().hasAttribute('data-expanded')).toBe(false)
    fireEvent.click(chevron())
    expect(other().hasAttribute('data-expanded')).toBe(true)
  })

  it('the drawer and the column never share an id, and only the drawer uses touch-size rows', async () => {
    renderAt('/settings/agents', { projects: REGISTRY })
    fireEvent.click(screen.getByRole('button', { name: 'Open settings menu' }))
    const drawer = await waitFor(() => {
      const el = document.querySelector('[data-slot="settings-mobile-drawer"]')
      expect(el).not.toBeNull()
      return el!
    })
    const ids = [...document.querySelectorAll('[id^="settings-project-"]')].map((el) => el.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThanOrEqual(2)
    // Every expanded body is what its own chevron controls.
    for (const button of document.querySelectorAll('[aria-controls^="settings-project-"]')) {
      expect(document.getElementById(button.getAttribute('aria-controls')!)).not.toBeNull()
    }
    // 44px rows in the drawer; the desktop column keeps the app sidebar's 34px.
    expect(drawer.querySelector('[data-section="appearance"]')?.className).toContain('h-11')
    expect(nav().querySelector('[data-section="appearance"]')?.className).not.toContain('h-11')
    expect(drawer.querySelector('[data-slot="settings-back"]')?.className).toContain('h-11')
  })

  it('a single MISSING project renders inert in flat mode, and a lone project is named on a global page', () => {
    const gone = [entry('gone', { name: 'old-repo', status: 'missing' })]
    renderAt('/settings/global/appearance', { projects: gone })
    const tree = () => nav().querySelector('[data-slot="settings-project-tree"]')!
    expect(tree().textContent).toContain('old-repo')
    expect(tree().textContent).not.toContain('This project')
    expect(tree().querySelector('a, button')).toBeNull()
    expect(tree().textContent).toContain('folder not found')
    expect(tree().textContent).toContain('remove it in Projects')
    cleanup()

    renderAt('/settings/global/appearance', { projects: [entry('solo', { name: 'solo-repo' })] })
    expect(nav().querySelector('[data-slot="settings-project-tree"]')?.textContent).toContain('solo-repo')
    expect(nav().querySelector('[data-slot="settings-project-tree"]')?.textContent).not.toContain('This project')
    cleanup()

    renderAt('/p/solo/settings/agents', { projects: [entry('solo', { name: 'solo-repo' })] })
    expect(nav().querySelector('[data-slot="settings-project-tree"]')?.textContent).toContain('This project')
  })

  it('an unknown project id is NOT named after the boot repo when the registry cannot answer', async () => {
    // The registry query is in its ERROR state: the scope gate then lets an unknown id through
    // rather than showing a permanent "Loading…", and the tree must not dress it up as the boot
    // repo just because health knows that one. Seeded as an errored query with retry-on-mount
    // off: with it on, every observer the page mounts refetches, TanStack flips a data-less
    // errored query back to pending, the gate unmounts the page, and the two loop — a
    // pre-existing shape of the gate's error fall-through, outside this change.
    serve({}, { projectsDown: true })
    const client = createQueryClient()
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false, retryOnMount: false } })
    client
      .getQueryCache()
      .build(client, { queryKey: workspaceQueryKeys.projects, queryFn: () => Promise.reject(new Error('down')) })
      .setState({ status: 'error', error: new Error('down'), errorUpdateCount: 1, fetchStatus: 'idle', data: undefined })
    client.setQueryData(queryKeys.health, {
      bootProject: 'boot',
      repoRoot: '/work/checkouts/my-repo',
      repo: { root: '/work/checkouts/my-repo', branch: 'main' },
      capabilities: { localHandoff: true, followups: true, singleProject: false },
    })
    render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <AppearanceProvider>
            <MemoryRouter initialEntries={['/p/whatever/settings/agents']}>
              <ListViewProvider>
                <AppRoutes />
              </ListViewProvider>
            </MemoryRouter>
          </AppearanceProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Agents'))
    expect(document.querySelector('[data-slot="settings-scope-chip"]')?.textContent).toBe('whatever')
    expect(document.querySelector('[data-slot="settings-scope-chip"]')?.textContent).not.toContain('my-repo')
  })

  it('a missing project is listed but inert — its panes would all 409', () => {
    renderAt('/settings/global/appearance', { projects: REGISTRY })
    const gone = nav().querySelector('[data-slot="settings-project"][data-project="gone"]')!
    expect(gone.getAttribute('data-status')).toBe('missing')
    expect(gone.textContent).toContain('folder not found')
    expect(gone.querySelector('a, button')).toBeNull()
  })

  it('with a single registered project the tree flattens into that project\'s sections', () => {
    // The default seed registers nothing, so the URL's project is the only one in the tree.
    renderAt('/settings/agents')
    expect(nav().querySelector('[data-slot="settings-project"]')).toBeNull()
    expect(nav().textContent).toContain('This project')
    const links = projectSectionLinks('boot')
    expect(links.map((el) => el.getAttribute('data-project-section'))).toEqual(PROJECT_SECTIONS)
    expect(nav().querySelector('[data-project-section][aria-current="page"]')?.getAttribute('data-project-section')).toBe('agents')
    // The mobile pill row renders the CURRENT area's sections, led by the way up.
    const pills = document.querySelector('[data-slot="settings-nav-mobile"]')!
    expect(sectionIds(pills)).toEqual(PROJECT_SECTIONS)
    const up = pills.querySelector('[data-slot="settings-all-pill"]')
    expect(up?.getAttribute('href')).toBe('/settings/global')
    expect(up?.textContent).toBe('‹ General settings')
  })

  it('keeps the ⌘K launcher, the version and star chips and the theme toggle in the sidebar footer, and the launcher opens the palette', () => {
    const client = gateSeededClient(false, REGISTRY)
    client.setQueryData(queryKeys.health, {
      bootProject: 'boot',
      version: '0.14.0',
      latestVersion: '0.15.0',
      capabilities: { localHandoff: true, followups: true, singleProject: false },
    })
    client.setQueryData(workspaceQueryKeys.starCount, { available: true, count: 335 })
    render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <AppearanceProvider>
            <MemoryRouter initialEntries={['/settings/global/appearance']}>
              <AppRoutes />
            </MemoryRouter>
          </AppearanceProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    )
    const footer = document.querySelector('[data-slot="settings-sidebar-footer"]')!
    const hint = footer.querySelector<HTMLButtonElement>('[data-slot="command-palette-hint"]')!
    expect(hint).not.toBeNull()
    expect(footer.querySelector('[data-slot="theme-toggle"]')).not.toBeNull()
    // The app footer's chips, from the same cached data.
    expect(footer.querySelector('[data-slot="version-chip"]')?.textContent).toBe('v0.14.0')
    expect(footer.querySelector('[data-slot="version-chip"]')?.getAttribute('data-update-available')).toBe('true')
    expect(footer.querySelector('[data-slot="star-chip"]')?.textContent).toContain('335')
    const opened = vi.fn()
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, opened)
    fireEvent.click(hint)
    expect(opened).toHaveBeenCalledTimes(1)
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, opened)
    // The mobile top bar repeats neither control — it is the app's top bar shape: menu + title.
    const bar = document.querySelector('[data-slot="settings-mobile-bar"]')!
    expect(bar.querySelector('[data-slot="theme-toggle"]')).toBeNull()
    expect(bar.querySelector('[data-slot="command-palette-hint"], [data-slot="settings-search"]')).toBeNull()
  })

  it('the sidebar IS the app sidebar frame: resizable, sharing the stored width', () => {
    localStorage.setItem('cez-sidebar-width', '350')
    renderAt('/settings/agents', { projects: REGISTRY })
    const sidebar = document.querySelector<HTMLElement>('[data-slot="settings-sidebar"]')!
    // The width the app sidebar was dragged to is this column's width too — one preference.
    expect(sidebar.style.width).toBe('350px')
    const handle = sidebar.querySelector<HTMLElement>('[data-slot="sidebar-resize-handle"]')!
    expect(handle.getAttribute('role')).toBe('separator')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(sidebar.style.width).toBe('366px')
    expect(localStorage.getItem('cez-sidebar-width')).toBe('366')
    localStorage.removeItem('cez-sidebar-width')
  })

  it('the sidebar reuses the app sidebar frame: Back + brand up top, labelled groups, no breadcrumb', () => {
    renderAt('/settings/agents', { projects: REGISTRY })
    const sidebar = document.querySelector('[data-slot="settings-sidebar"]')!
    expect(sidebar.className).toContain('bg-sidebar')
    expect(sidebar.querySelector('[data-slot="settings-back"]')).not.toBeNull()
    expect(sidebar.querySelector('[data-slot="brand-lockup"]')).not.toBeNull()
    // Both groups are labelled, so "General settings" is as obvious as "Project settings".
    expect(nav().textContent).toContain('General settings')
    expect(nav().textContent).toContain('Project settings')
    // The page header is the current page only: the title with its project beside it, then
    // the one-liner. No breadcrumb, no corner badge.
    const header = document.querySelector('[data-slot="settings-header"]')!
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Agents')
    // `project / view`: the project name leads, a slash separates, the view is the heading.
    expect(header.querySelector('[data-slot="settings-scope-chip"]')?.textContent).toBe('cezar')
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.previousElementSibling?.textContent).toBe('/')
    expect(h1.previousElementSibling?.previousElementSibling?.getAttribute('data-slot')).toBe('settings-scope-chip')
    expect(h1.parentElement?.textContent).toBe('cezar/Agents')
    expect(header.textContent).toContain('Providers, default runner and models.')
    expect(header.querySelector('nav')).toBeNull()
    // Desktop only: below `md` the mobile bar titles the page, so the header hides itself.
    expect(header.className).toContain('hidden')
    expect(header.className).toContain('md:flex')
    const bar = document.querySelector('[data-slot="settings-mobile-bar"]')!
    expect(bar.textContent).toContain('Agents')
    expect(bar.textContent).toContain('cezar')
  })

  it('a global page carries no project marker, and the project index is titled by the project', () => {
    renderAt('/settings/global/resources', { projects: REGISTRY })
    expect(document.querySelector('[data-slot="settings-scope-chip"]')).toBeNull()
    cleanup()
    renderAt('/settings', { projects: REGISTRY })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('cezar')
  })

  it('Back returns to the last non-settings page, however many settings pages were visited', () => {
    recordSettingsReturn({ pathname: '/p/other/git', search: '', hash: '' })
    renderAt('/settings/global/appearance', { projects: REGISTRY })
    fireEvent.click(document.querySelector('[data-slot="settings-back"]')!)
    expect(currentPathname()).toBe('/p/other/git')
  })

  it('Back falls back to the tasks pane of the project in scope on a cold load', () => {
    renderAt('/settings/worktrees', { projects: REGISTRY })
    fireEvent.click(document.querySelector('[data-slot="settings-back"]')!)
    expect(currentPathname()).toBe('/p/boot/')
  })

  it('Escape leaves settings — unless a form field has focus', () => {
    recordSettingsReturn({ pathname: '/p/boot/skills', search: '', hash: '' })
    renderAt('/settings/global/resources', { projects: REGISTRY })
    fireEvent.keyDown(screen.getByTestId('field'), { key: 'Escape' })
    expect(currentPathname()).toBe('/settings/global/resources')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(currentPathname()).toBe('/p/boot/skills')
  })

  it('/settings is the project registry as an index — one card per visible section', () => {
    renderAt('/settings')
    const index = document.querySelector('[data-slot="settings-index"]')!
    expect(sectionIds(index)).toEqual(PROJECT_SECTIONS)
    // Scope-aware links (step 3.2): the flat `to` picks up the active project's prefix.
    expect(index.querySelector('[data-section="bookmarklets"]')?.getAttribute('href')).toBe(
      '/p/boot/settings/bookmarklets',
    )
    // The old cross-link paragraph is gone — the breadcrumb and the nav are the way up.
    expect(document.querySelector('[data-slot="settings-global-link"]')).toBeNull()
  })

  it('single-project mode removes Projects from the global navigation', () => {
    renderAt('/settings/global', { singleProject: true, projects: REGISTRY })
    expect(document.querySelector('[data-slot="settings-index"] [data-section="projects"]')).toBeNull()
    expect(document.querySelector('[data-slot="settings-nav"] [data-section="projects"]')).toBeNull()
    expect(document.querySelector('[data-slot="settings-project-index"]')).toBeNull()
    expect(document.querySelector('[data-section="resources"]')).not.toBeNull()
    // The tree flattens too: one project, no chevron rows.
    expect(document.querySelector('[data-slot="settings-project"]')).toBeNull()
  })

  it('a moved section keeps its old URL working: /settings/appearance → the global twin', async () => {
    renderAt('/settings/appearance')
    // Legacy flat URL → boot project → the section's new global home. Two redirects, one hop
    // each, and the address bar ends up naming the real place.
    await waitFor(() => {
      expect(document.querySelector('[data-route="settings-global-appearance"]')).not.toBeNull()
    })
  })

})

describe('the appearance section (global scope)', () => {
  it('persisted values apply at boot: server ui-state stamps the root and the controls', async () => {
    serve({ appearance: { accent: 'violet', density: 'compact' } })
    renderAt('/settings/global/appearance')

    await waitFor(() => {
      expect(document.documentElement.dataset.accent).toBe('violet')
    })
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(screen.getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    // The mirror follows the server, so the next cold load pre-paints the truth.
    expect(localStorage.getItem('cez-accent')).toBe('violet')
    expect(localStorage.getItem('cez-density')).toBe('compact')
  })

  it('accent round-trip: apply immediately, PUT the FULL appearance object', async () => {
    serve({ appearance: { density: 'compact' } })
    renderAt('/settings/global/appearance')
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Violet' }))
    expect(document.documentElement.dataset.accent).toBe('violet')

    // The whole object, not a partial — the server's ui-state merge is shallow, so a bare
    // `{ accent }` would silently drop the stored density.
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body).toEqual({
        appearance: { accent: 'violet', density: 'compact', width: 'narrow' },
      })
    })
    expect(localStorage.getItem('cez-accent')).toBe('violet')
  })

  it('density flips back to the default and the attribute comes OFF the root', async () => {
    serve({ appearance: { density: 'compact' } })
    renderAt('/settings/global/appearance')
    await waitFor(() => {
      expect(document.documentElement.dataset.density).toBe('compact')
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Comfortable' }))
    expect(document.documentElement.hasAttribute('data-density')).toBe(false)
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body).toEqual({
        appearance: { accent: 'lime', density: 'comfortable', width: 'narrow' },
      })
    })
  })

  it('reading width round-trip: Wide stamps the root and PUTs the full object; back to Narrow clears it', async () => {
    serve({ appearance: { accent: 'violet' } })
    renderAt('/settings/global/appearance')
    // Wait for the server value to settle (Violet is server-provided; Narrow is the default and
    // would report "checked" from the mirror before the GET even lands), so the pending load
    // can't clobber the width write we're about to make.
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked')).toBe('true')
    })
    expect(screen.getByRole('radio', { name: 'Narrow' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: 'Wide' }))
    expect(document.documentElement.dataset.width).toBe('wide')
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body).toEqual({
        appearance: { accent: 'violet', density: 'comfortable', width: 'wide' },
      })
    })

    // Narrow is the default — the attribute must come OFF the root, not be written as data-width="narrow".
    fireEvent.click(screen.getByRole('radio', { name: 'Narrow' }))
    await waitFor(() => {
      expect(document.documentElement.hasAttribute('data-width')).toBe(false)
    })
  })

  it('theme rides the existing theme system: class + localStorage, no ui-state write', async () => {
    renderAt('/settings/global/appearance')

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(localStorage.getItem('cez-theme')).toBe('light')
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(localStorage.getItem('cez-theme')).toBe('dark')

    // Theme is per-browser by design (pre-paint) — it must never leak into ui-state.json.
    await waitFor(() => {
      expect(requests.some((r) => r.url === '/api/v1/workspace/ui-state' && r.method === 'GET')).toBe(true)
    })
    expect(requests.some((r) => r.method === 'PUT' && r.url.endsWith('ui-state'))).toBe(false)
  })
})

/**
 * The step-3.5 acceptance test, stated as bluntly as the spec states it: appearance and
 * notifications write the GLOBAL store, agents writes the PROJECT store. Each assertion checks
 * BOTH halves — the right URL was written AND the other store was left alone — because a
 * section wired to both would satisfy a one-sided check.
 */
describe('the settings split writes the right store', () => {
  const putsTo = (url: string) => requests.filter((r) => r.method === 'PUT' && r.url === url)

  it('appearance → /api/v1/workspace/ui-state, never the per-repo one', async () => {
    renderAt('/settings/global/appearance')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Violet' })).toBeTruthy())

    fireEvent.click(screen.getByRole('radio', { name: 'Violet' }))

    await waitFor(() => expect(putsTo('/api/v1/workspace/ui-state')).toHaveLength(1))
    expect(putsTo('/api/v1/workspace/ui-state')[0]?.body).toEqual({
      appearance: { accent: 'violet', density: 'comfortable', width: 'narrow' },
    })
    expect(putsTo('/api/v1/ui-state')).toHaveLength(0)
  })

  it('notifications → /api/v1/workspace/ui-state, never the per-repo one', async () => {
    // `Notification` is absent in jsdom; the section only needs it to decide whether to ask for
    // permission, and "already granted" is the path that persists without any prompt.
    function FakeNotification() {}
    ;(FakeNotification as unknown as { permission: string }).permission = 'granted'
    vi.stubGlobal('Notification', FakeNotification)

    renderAt('/settings/global/notifications')
    const toggle = await screen.findByRole('switch', { name: 'Notify when an agent needs you' })
    fireEvent.click(toggle)

    await waitFor(() => expect(putsTo('/api/v1/workspace/ui-state')).toHaveLength(1))
    expect(putsTo('/api/v1/workspace/ui-state')[0]?.body).toEqual({ notifications: { enabled: true } })
    expect(putsTo('/api/v1/ui-state')).toHaveLength(0)
  })

  it('agents → the project-scoped /api/v1/config, never the workspace routes', async () => {
    renderAt('/settings/agents')
    const runner = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>('[data-slot="agents-runner"] [data-value="codex"]')
      expect(el).not.toBeNull()
      return el!
    })

    fireEvent.click(runner)

    await waitFor(() => expect(putsTo('/api/v1/config')).toHaveLength(1))
    expect(putsTo('/api/v1/config')[0]?.body).toEqual({ defaultRunner: 'codex' })
    expect(requests.some((r) => r.method === 'PUT' && r.url.startsWith('/api/v1/workspace/'))).toBe(false)
  })
})
