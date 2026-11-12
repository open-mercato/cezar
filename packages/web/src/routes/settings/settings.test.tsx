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
import {
  projectRailHint,
  SETTINGS_REDIRECTS,
  SETTINGS_SECTIONS,
  settingsSectionsByScope,
  settingsSectionsInGroup,
  visibleSettingsSections,
} from './registry'

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
  profile: null, taskWorkspace: null, landing: null, landingBlocked: null, requiredChecks: [], defaultSkill: null, askSkill: null, teamSkills: true,
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

const PROJECT_SECTIONS = ['instructions', 'tracker', 'secrets', 'webhooks', 'agents', 'tasks', 'agent-config', 'worktrees', 'bookmarklets', 'integrations']
/** The global nav, in rail order: "You", then "Workspace" (design doc, Proposal 8). */
const YOU_SECTIONS = ['appearance', 'keyboard', 'notifications']
const WORKSPACE_SECTIONS = ['agents', 'behaviour', 'data-privacy', 'projects']
const GLOBAL_SECTIONS = [...YOU_SECTIONS, ...WORKSPACE_SECTIONS]
/** The pages that merged (Proposal 8): old id → the page and the card it became. */
const MERGED: Array<[string, string, string]> = [
  ['manager', 'behaviour', 'manager'],
  ['resources', 'behaviour', 'resources'],
  ['accounts', 'agents', 'accounts'],
  ['skills', 'agents', 'skills'],
  ['global-instructions', 'agents', 'global-instructions'],
  ['workspace-secrets', 'data-privacy', 'workspace-secrets'],
  ['transfer', 'data-privacy', 'transfer'],
  ['privacy', 'data-privacy', 'privacy'],
]

describe('the section registry', () => {
  it('declares the spec §Settings sections, all of them implemented', () => {
    const ids = SETTINGS_SECTIONS.filter((s) => !s.redirect).map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length - 1) // `agents` exists in BOTH scopes
    expect(SETTINGS_SECTIONS.every((s) => typeof s.component === 'function')).toBe(true)
    expect(SETTINGS_SECTIONS.filter((s) => s.redirect).map((s) => s.id)).toEqual(MERGED.map(([old]) => old))
  })

  it('splits the sections by scope — the nav never lists a merged page\'s old id', () => {
    expect(visibleSettingsSections('project').map((s) => s.id)).toEqual(PROJECT_SECTIONS)
    // The route table keeps the merged ids (their URLs must answer); the nav drops them.
    expect(visibleSettingsSections('global').map((s) => s.id)).toEqual([...GLOBAL_SECTIONS, ...MERGED.map(([old]) => old)])
    expect(settingsSectionsByScope().global.map((s) => s.id)).toEqual(GLOBAL_SECTIONS)
    expect(settingsSectionsByScope().project.map((s) => s.id)).toEqual(PROJECT_SECTIONS)
    expect(settingsSectionsInGroup('you').map((s) => s.id)).toEqual(YOU_SECTIONS)
    expect(settingsSectionsInGroup('workspace').map((s) => s.id)).toEqual(WORKSPACE_SECTIONS)
  })

  it('maps every merged page to the card it became', () => {
    expect([...SETTINGS_REDIRECTS].map(([old, to]) => [old, to.to, to.hash])).toEqual(MERGED)
  })

  it('hides Projects only when the single-project capability is active', () => {
    expect(visibleSettingsSections('global', { singleProject: true }).map((s) => s.id)).not.toContain('projects')
    expect(visibleSettingsSections('global', { singleProject: false }).map((s) => s.id)).toContain('projects')
    expect(settingsSectionsByScope({ singleProject: true }).global.map((s) => s.id)).not.toContain('projects')
  })

  it('the rail hint names only the project pages a capability has gated away', () => {
    const all = settingsSectionsByScope().project
    expect(projectRailHint(all)).toBeNull()
    expect(projectRailHint(all.filter((s) => s.id !== 'worktrees'))).toBe('Worktrees appears when the project unlocks it')
    expect(projectRailHint(all.filter((s) => !['agents', 'worktrees', 'bookmarklets'].includes(s.id)))).toBe(
      'Agents, Worktrees and Bookmarklets appear when the project unlocks them',
    )
  })
})

describe('the settings rail', () => {
  const nav = () => document.querySelector('[data-slot="settings-nav"]')!
  const sectionIds = (root: Element) =>
    [...root.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
  const group = (name: string) => nav().querySelector(`[data-slot="settings-nav-group"][data-group="${name}"]`)!
  const switcher = () => nav().querySelector<HTMLElement>('[data-slot="settings-project-switcher"]')
  const projectSectionLinks = (projectId: string) =>
    [...nav().querySelectorAll<HTMLAnchorElement>(`[data-project="${projectId}"][data-project-section]`)]
  const options = () => [...document.querySelectorAll<HTMLElement>('[data-slot="settings-project-option"]')]

  beforeEach(() => {
    // The switcher is a Radix popover around a cmdk list; neither exists in jsdom.
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  })

  it('renders three groups — You, Workspace, Project — and no per-project tree', () => {
    renderAt('/settings/global/appearance', { projects: REGISTRY })
    expect([...nav().querySelectorAll('[data-slot="settings-nav-group"]')].map((g) => g.getAttribute('data-group'))).toEqual([
      'you', 'workspace', 'project',
    ])
    expect(group('you').textContent).toContain('You')
    expect(sectionIds(group('you'))).toEqual(YOU_SECTIONS)
    expect(group('workspace').textContent).toContain('Workspace')
    expect(sectionIds(group('workspace'))).toEqual(WORKSPACE_SECTIONS)
    expect(nav().querySelector('[data-section="behaviour"]')?.getAttribute('href')).toBe('/settings/global/behaviour')
    expect(nav().querySelector('[aria-current="page"]')?.getAttribute('data-section')).toBe('appearance')
    // Where the workspace settings live — said once, in the group that writes there.
    expect(group('workspace').textContent).toContain('Stored in ~/.cezar')
    expect(group('project').textContent).toContain('Project')
    // The old tree is gone: no row per registered project, no chevrons.
    expect(nav().querySelector('[data-slot="settings-project"], [data-slot="settings-project-tree"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /^(Expand|Collapse) / })).toBeNull()
  })

  it('on a global page the project group names the boot project and links into ITS pages', () => {
    renderAt('/settings/global/appearance', { projects: REGISTRY })
    expect(switcher()?.getAttribute('data-project')).toBe('boot')
    expect(switcher()?.textContent).toContain('cezar')
    expect(nav().querySelector('[data-project="boot"][data-slot="settings-project-general"]')?.getAttribute('href')).toBe('/p/boot/settings')
    const links = projectSectionLinks('boot')
    expect(links.map((el) => el.getAttribute('data-project-section'))).toEqual(PROJECT_SECTIONS)
    expect(links.map((el) => el.getAttribute('href'))).toEqual(PROJECT_SECTIONS.map((id) => `/p/boot/settings/${id}`))
    // No project page is current on a global page.
    expect(nav().querySelector('[data-project-section][aria-current="page"]')).toBeNull()
    // Only ONE project's pages are listed.
    expect(nav().querySelectorAll('[data-project-section]')).toHaveLength(PROJECT_SECTIONS.length)
    // Nothing is gated on this server, so the rail says nothing about unlocking.
    expect(nav().querySelector('[data-slot="settings-project-gated-hint"]')).toBeNull()
  })

  it('on a project page the rail names the URL\'s project with its page current, and no global row current', () => {
    renderAt('/settings/agents', { projects: REGISTRY })
    expect(nav().getAttribute('data-scope')).toBe('project')
    expect(switcher()?.getAttribute('data-project')).toBe('boot')
    expect(nav().querySelector('[data-section][aria-current="page"]')).toBeNull()
    expect(nav().querySelector('[data-project-section][aria-current="page"]')?.getAttribute('data-project-section')).toBe('agents')
    // The project's name only — no branch: settings describe the repo, not what is checked out.
    expect(switcher()?.textContent).not.toContain('main')
  })

  it('the switcher lists every registered project, current checked, a gone one inert — and switches to the SAME page', async () => {
    renderAt('/settings/worktrees', { projects: REGISTRY })
    const button = screen.getByRole('button', { name: /Switch project/ })
    expect(button.getAttribute('data-slot')).toBe('settings-project-switcher')
    fireEvent.click(button)
    await waitFor(() => expect(options()).toHaveLength(3))
    expect(options().map((o) => o.getAttribute('data-project'))).toEqual(['boot', 'other', 'gone'])
    expect(options()[0]?.hasAttribute('data-current')).toBe(true)
    expect(options()[1]?.hasAttribute('data-current')).toBe(false)
    expect(options()[2]?.getAttribute('aria-disabled')).toBe('true')
    expect(options()[2]?.textContent).toContain('folder not found')
    expect(document.querySelector('[cmdk-input]')?.getAttribute('aria-label')).toBe('Find a project')

    fireEvent.click(options()[1]!)
    await waitFor(() => expect(currentPathname()).toBe('/p/other/settings/worktrees'))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Worktrees')
    expect(switcher()?.getAttribute('data-project')).toBe('other')
    expect(switcher()?.textContent).toContain('storefront')
    expect(nav().querySelector('[data-project-section][aria-current="page"]')?.getAttribute('data-project')).toBe('other')
  })

  it('from a project\'s General the switcher lands on the other project\'s General', async () => {
    renderAt('/settings', { projects: REGISTRY })
    expect(nav().querySelector('[data-project="boot"][data-slot="settings-project-general"]')?.getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByRole('button', { name: /Switch project/ }))
    await waitFor(() => expect(options()).toHaveLength(3))
    fireEvent.click(options()[1]!)
    await waitFor(() => expect(currentPathname()).toBe('/p/other/settings'))
    expect(nav().querySelector('[data-project="other"][data-slot="settings-project-general"]')?.getAttribute('aria-current')).toBe('page')
  })

  it('with nothing to switch between the switcher is a plain name', () => {
    // The default seed registers nothing, so the URL's project is the only one.
    renderAt('/settings/agents')
    expect(switcher()?.hasAttribute('data-static')).toBe(true)
    expect(screen.queryByRole('button', { name: /Switch project/ })).toBeNull()
    expect(projectSectionLinks('boot').map((el) => el.getAttribute('data-project-section'))).toEqual(PROJECT_SECTIONS)
    cleanup()
    // Single-project mode: a registry with several projects still offers no switch.
    renderAt('/settings/global/appearance', { singleProject: true, projects: REGISTRY })
    expect(switcher()?.hasAttribute('data-static')).toBe(true)
    expect(document.querySelector('[data-slot="settings-nav"] [data-section="projects"]')).toBeNull()
    expect(document.querySelector('[data-section="behaviour"]')).not.toBeNull()
  })

  it('a gone project shows a note where its pages would be', () => {
    renderAt('/settings/global/appearance', { projects: [entry('gone', { name: 'old-repo', status: 'missing' })] })
    expect(switcher()?.textContent).toContain('old-repo')
    expect(nav().querySelector('[data-slot="settings-project-missing"]')?.textContent).toContain('remove it in Projects')
    expect(nav().querySelector('[data-project-section]')).toBeNull()
  })

  it('an UNREGISTERED boot project (cezar started from a task worktree) is never offered — only its own page shows it', async () => {
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
        current: switcher()?.getAttribute('data-project'),
        nav: nav().textContent ?? '',
        sections: projectSectionLinks('boot').map((el) => el.getAttribute('href')),
      }
      cleanup()
      return out
    }
    // Global page and another project's page: a registered project is in view, never the boot one.
    expect(at('/settings/global/appearance')).toMatchObject({ current: 'other', sections: [] })
    expect(at('/settings/global/appearance').nav).not.toContain('my-repo')
    expect(at('/p/other/settings/agents')).toMatchObject({ current: 'other', sections: [] })
    // Its OWN page is the exception: its sections render, named after the boot repo's folder.
    const own = at('/p/boot/settings/agents')
    expect(own.current).toBe('boot')
    expect(own.nav).toContain('my-repo')
    expect(own.sections).toEqual(PROJECT_SECTIONS.map((id) => `/p/boot/settings/${id}`))
  })

  it('on mobile the hamburger opens the same rail as a drawer, which closes once a page is picked', async () => {
    renderAt('/settings/global/appearance', { projects: REGISTRY })
    expect(document.querySelector('[data-slot="settings-mobile-drawer"]')).toBeNull()
    const bar = document.querySelector('[data-slot="settings-mobile-bar"]')!
    expect(bar.querySelector('[data-slot="settings-back"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open settings menu' }))

    const drawer = await waitFor(() => {
      const el = document.querySelector('[data-slot="settings-mobile-drawer"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(drawer.getAttribute('role')).toBe('dialog')
    expect(drawer.querySelector('[data-slot="settings-back"]')).not.toBeNull()
    for (const label of ['You', 'Workspace', 'Project']) expect(drawer.textContent).toContain(label)
    expect(drawer.querySelector('[data-slot="settings-project-switcher"]')).not.toBeNull()
    expect(drawer.querySelector('[data-slot="command-palette-hint"]')).not.toBeNull()
    // 44px rows in the drawer; the desktop column keeps the app sidebar's 34px.
    expect(drawer.querySelector('[data-section="appearance"]')?.className).toContain('h-11')
    expect(nav().querySelector('[data-section="appearance"]')?.className).not.toContain('h-11')

    fireEvent.click(drawer.querySelector('[data-section="behaviour"]')!)
    expect(currentPathname()).toBe('/settings/global/behaviour')
    await waitFor(() => expect(document.querySelector('[data-slot="settings-mobile-drawer"]')).toBeNull())
  })

  it('the content column is 720px wide with the heading and one-liner at the top', () => {
    renderAt('/settings/agents', { projects: REGISTRY })
    const content = document.querySelector('[data-slot="settings-content"]')!
    expect(content.className).toContain('max-w-[720px]')
    const header = content.querySelector('[data-slot="settings-header"]')!
    expect(header).not.toBeNull()
    expect(content.firstElementChild).toBe(header)
    // `project / view`: the project name leads, a slash separates, the view is the heading.
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.textContent).toBe('Agents')
    expect(h1.previousElementSibling?.textContent).toBe('/')
    expect(header.querySelector('[data-slot="settings-scope-chip"]')?.textContent).toBe('cezar')
    expect(header.querySelector('[data-slot="settings-description"]')?.textContent).toBe('Providers, default runner and models.')
    expect(header.querySelector('nav')).toBeNull()
    // The mobile bar titles the page the same way.
    const bar = document.querySelector('[data-slot="settings-mobile-bar"]')!
    expect(bar.textContent).toContain('Agents')
    expect(bar.textContent).toContain('cezar')
    // The sidebar IS the app sidebar frame: Back + brand up top.
    const sidebar = document.querySelector('[data-slot="settings-sidebar"]')!
    expect(sidebar.className).toContain('bg-sidebar')
    expect(sidebar.querySelector('[data-slot="settings-back"]')).not.toBeNull()
    expect(sidebar.querySelector('[data-slot="brand-lockup"]')).not.toBeNull()
  })

  it('the mobile pill row lists the current area, led by the way up on project pages', () => {
    renderAt('/settings/agents')
    const pills = document.querySelector('[data-slot="settings-nav-mobile"]')!
    expect(pills.querySelector('[end]')).toBeNull()
    expect(sectionIds(pills)).toEqual(PROJECT_SECTIONS)
    expect(pills.querySelector('[data-section="agents"]')?.getAttribute('aria-current')).toBe('page')
    expect(pills.querySelector('[data-slot="settings-all-pill"]')?.getAttribute('href')).toBe('/settings/global')
    expect(pills.querySelector('[data-slot="settings-nav-index"]')?.getAttribute('href')).toBe('/p/boot/settings')
    cleanup()
    renderAt('/settings/global/keyboard', { projects: REGISTRY })
    expect(sectionIds(document.querySelector('[data-slot="settings-nav-mobile"]')!)).toEqual(GLOBAL_SECTIONS)
  })

  it('/settings/global is no card menu: it redirects to the first global section, query and hash kept', () => {
    renderAt('/settings/global?agent=codex#x', { projects: REGISTRY })
    expect(currentPathname()).toBe(`/settings/global/${GLOBAL_SECTIONS[0]}`)
    expect(document.querySelector(`[data-route="settings-global-${GLOBAL_SECTIONS[0]}"]`)).not.toBeNull()
    expect(document.querySelector('[data-slot="settings-index"]')).toBeNull()
    expect(screen.getByTestId('location').getAttribute('data-search')).toBe('?agent=codex')
    expect(screen.getByTestId('location').getAttribute('data-hash')).toBe('#x')
  })

  it('a global page carries no project marker, and the project index is titled by the project', () => {
    renderAt('/settings/global/behaviour', { projects: REGISTRY })
    expect(document.querySelector('[data-slot="settings-scope-chip"]')).toBeNull()
    cleanup()
    renderAt('/settings', { projects: REGISTRY })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('cezar')
  })

  it('keeps the ⌘K launcher, the version and star chips and the theme toggle in the sidebar footer', () => {
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
    expect(footer.querySelector('[data-slot="version-chip"]')?.textContent).toBe('v0.14.0')
    expect(footer.querySelector('[data-slot="star-chip"]')?.textContent).toContain('335')
    const opened = vi.fn()
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, opened)
    fireEvent.click(hint)
    expect(opened).toHaveBeenCalledTimes(1)
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, opened)
  })

  it('the sidebar IS the app sidebar frame: resizable, sharing the stored width', () => {
    localStorage.setItem('cez-sidebar-width', '350')
    renderAt('/settings/agents', { projects: REGISTRY })
    const sidebar = document.querySelector<HTMLElement>('[data-slot="settings-sidebar"]')!
    expect(sidebar.style.width).toBe('350px')
    const handle = sidebar.querySelector<HTMLElement>('[data-slot="sidebar-resize-handle"]')!
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(sidebar.style.width).toBe('366px')
    localStorage.removeItem('cez-sidebar-width')
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
    renderAt('/settings/global/behaviour', { projects: REGISTRY })
    fireEvent.keyDown(screen.getByTestId('field'), { key: 'Escape' })
    expect(currentPathname()).toBe('/settings/global/behaviour')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(currentPathname()).toBe('/p/boot/skills')
  })

  it('/settings is the project registry as an index — one card per visible section', () => {
    renderAt('/settings')
    const index = document.querySelector('[data-slot="settings-index"]')!
    expect(sectionIds(index)).toEqual(PROJECT_SECTIONS)
    expect(index.querySelector('[data-section="bookmarklets"]')?.getAttribute('href')).toBe('/p/boot/settings/bookmarklets')
    expect(document.querySelector('[data-route="settings"]')).not.toBeNull()
  })

  it('a moved section keeps its old URL working: /settings/appearance → the global twin', async () => {
    renderAt('/settings/appearance')
    await waitFor(() => {
      expect(document.querySelector('[data-route="settings-global-appearance"]')).not.toBeNull()
    })
  })
})

describe('merged pages keep their old links', () => {
  for (const [old, to, hash] of MERGED) {
    it(`/settings/global/${old} lands on /settings/global/${to}#${hash}, query kept`, () => {
      renderAt(`/settings/global/${old}?x=1`, { projects: REGISTRY })
      expect(currentPathname()).toBe(`/settings/global/${to}`)
      expect(screen.getByTestId('location').getAttribute('data-search')).toBe('?x=1')
      expect(screen.getByTestId('location').getAttribute('data-hash')).toBe(`#${hash}`)
      expect(document.querySelector(`[data-route="settings-global-${to}"]`)).not.toBeNull()
      // The card the old page became is on the new page, under that very id — Manager only on
      // a server with managers, which this seed is not.
      if (hash !== 'manager') expect(document.getElementById(hash)).not.toBeNull()
    })
  }

  it('keeps a hash the link already carries', () => {
    renderAt('/settings/global/accounts#foo', { projects: REGISTRY })
    expect(currentPathname()).toBe('/settings/global/agents')
    expect(screen.getByTestId('location').getAttribute('data-hash')).toBe('#foo')
  })

  it('the project-area spelling hops twice: /p/<id>/settings/resources → the Behaviour page', async () => {
    renderAt('/p/boot/settings/resources?tab=x', { projects: REGISTRY })
    await waitFor(() => expect(currentPathname()).toBe('/settings/global/behaviour'))
    expect(screen.getByTestId('location').getAttribute('data-search')).toBe('?tab=x')
    expect(screen.getByTestId('location').getAttribute('data-hash')).toBe('#resources')
  })

  it('a merged page\'s old id is never a rail entry', () => {
    renderAt('/settings/global/appearance', { projects: REGISTRY })
    for (const [old] of MERGED) expect(document.querySelector(`[data-slot="settings-nav"] [data-section="${old}"]`)).toBeNull()
  })

  it('/p/<id>/settings/agents is still the PROJECT Agents page — the global one shares the id, not the route', () => {
    renderAt('/settings/agents', { projects: REGISTRY })
    expect(currentPathname()).toBe('/p/boot/settings/agents')
    expect(document.querySelector('[data-route="settings-agents"]')).not.toBeNull()
    expect(document.querySelector('[data-route="settings-global-agents"]')).toBeNull()
  })

  it('the Manager card on Behaviour appears only on a server that says it has managers', async () => {
    renderAt('/settings/global/behaviour', { projects: REGISTRY })
    expect(document.querySelector('[data-slot="manager-confirm-settings"]')).toBeNull()
    cleanup()
    const client = gateSeededClient(false, REGISTRY)
    client.setQueryData(queryKeys.health, {
      bootProject: 'boot',
      capabilities: { localHandoff: true, followups: true, singleProject: false, managers: true },
    })
    render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <AppearanceProvider>
            <MemoryRouter initialEntries={['/settings/global/behaviour']}>
              <AppRoutes />
            </MemoryRouter>
          </AppearanceProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(document.querySelector('[data-slot="manager-confirm-settings"]')).not.toBeNull())
    expect(document.getElementById('manager')).not.toBeNull()
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
        appearance: { accent: 'violet', density: 'compact', width: 'wide' },
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
        appearance: { accent: 'lime', density: 'comfortable', width: 'wide' },
      })
    })
  })

  it('reading width round-trip: Narrow stamps the root and PUTs the full object; back to Full clears it', async () => {
    serve({ appearance: { accent: 'violet' } })
    renderAt('/settings/global/appearance')
    // Wait for the server value to settle (Violet is server-provided; Full is the default and
    // would report "checked" from the mirror before the GET even lands), so the pending load
    // can't clobber the width write we're about to make.
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked')).toBe('true')
    })
    expect(screen.getByRole('radio', { name: 'Full' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: 'Narrow' }))
    expect(document.documentElement.dataset.width).toBe('narrow')
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body).toEqual({
        appearance: { accent: 'violet', density: 'comfortable', width: 'narrow' },
      })
    })

    // Full is the default — the attribute must come OFF the root, not be written as data-width="wide".
    fireEvent.click(screen.getByRole('radio', { name: 'Full' }))
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
      appearance: { accent: 'violet', density: 'comfortable', width: 'wide' },
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
