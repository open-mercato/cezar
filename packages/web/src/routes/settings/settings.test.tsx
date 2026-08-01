import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { AppearanceProvider } from '@/components/appearance-provider'
import { ThemeProvider } from '@/components/theme-provider'
import { AppRoutes } from '@/routes'
import { SETTINGS_SECTIONS, visibleSettingsSections } from './registry'

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
function serve(uiState: Record<string, unknown> = {}) {
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
          ],
        })
      if (url === '/api/v1/models?runner=codex') return json({ runner: 'codex', models: [], source: 'unavailable', stale: false })
      return new Promise<never>(() => {})
    }),
  )
}

/** Enough of `GET /api/v1/config` for the Agents section to render its form. */
const AGENTS_CONFIG = {
  baseBranch: null,
  defaultRunner: 'claude',
  systemPrompt: null,
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
function gateSeededClient(singleProject = false) {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    capabilities: { localHandoff: true, followups: true, singleProject },
  })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderAt(entry: string, { singleProject = false }: { singleProject?: boolean } = {}) {
  render(
    <QueryClientProvider client={gateSeededClient(singleProject)}>
      <ThemeProvider>
        <AppearanceProvider>
          <MemoryRouter initialEntries={[entry]}>
            <AppRoutes />
          </MemoryRouter>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => serve())

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  delete document.documentElement.dataset.accent
  delete document.documentElement.dataset.density
  delete document.documentElement.dataset.width
  document.documentElement.classList.remove('light')
})

const PROJECT_SECTIONS = ['agents', 'agent-config', 'worktrees', 'bookmarklets', 'prompt-templates']
const GLOBAL_SECTIONS = [
  'appearance',
  'notifications',
  'resources',
  'skills',
  // Agent accounts (spec 2026-07-29-agent-profiles) sit beside Projects: both describe the
  // machine and the person at it, not any one repo.
  'accounts',
  'projects',
]

describe('the section registry', () => {
  it('declares the spec §Settings sections, later ones hidden', () => {
    const byId = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]))
    for (const id of [...PROJECT_SECTIONS, ...GLOBAL_SECTIONS]) {
      expect(byId.get(id as never)?.hidden).toBeUndefined()
    }
    // Listed in the registry but hidden until implemented (later phase).
    for (const id of ['keyboard']) {
      expect(byId.get(id as never)?.hidden).toBe(true)
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
      'appearance', 'notifications', 'resources', 'skills', 'accounts',
    ])
    expect(visibleSettingsSections('global', { singleProject: false }).map((s) => s.id)).toEqual(GLOBAL_SECTIONS)
    expect(visibleSettingsSections('global').map((s) => s.id)).toEqual(GLOBAL_SECTIONS)
  })
})

describe('the settings shell', () => {
  it('renders the PROJECT nav from the registry — project sections only', () => {
    renderAt('/settings/agents')
    const nav = document.querySelector('[data-slot="settings-nav"]')!
    const ids = [...nav.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
    expect(ids).toEqual(PROJECT_SECTIONS)
    // The active section is marked for assistive tech, not just by color.
    expect(nav.querySelector('[aria-current="page"]')?.getAttribute('data-section')).toBe('agents')
    // The mobile pill row renders through the same registry — the two can never disagree.
    const pills = document.querySelector('[data-slot="settings-nav-mobile"]')!
    expect([...pills.querySelectorAll('[data-section]')].length).toBe(PROJECT_SECTIONS.length)
  })

  it('renders the GLOBAL nav at /settings/global — global sections, unprefixed links', () => {
    renderAt('/settings/global/appearance')
    const nav = document.querySelector('[data-slot="settings-nav"]')!
    expect(nav.getAttribute('data-scope')).toBe('global')
    const ids = [...nav.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
    expect(ids).toEqual(GLOBAL_SECTIONS)
    // The whole point of the plain (non-scoped) links: no `/p/<id>` prefix may appear, or the
    // target would not be a route at all.
    expect(nav.querySelector('[data-section="resources"]')?.getAttribute('href')).toBe(
      '/settings/global/resources',
    )
    expect(nav.querySelector('[data-section="skills"]')?.getAttribute('href')).toBe(
      '/settings/global/skills',
    )
  })

  it('/settings is the project registry as an index — one card per visible section', () => {
    renderAt('/settings')
    const index = document.querySelector('[data-slot="settings-index"]')!
    const ids = [...index.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
    expect(ids).toEqual(PROJECT_SECTIONS)
    // Scope-aware links (step 3.2): the flat `to` picks up the active project's prefix.
    expect(index.querySelector('[data-section="bookmarklets"]')?.getAttribute('href')).toBe(
      '/p/boot/settings/bookmarklets',
    )
    // …and the cross-link out of the project area is NOT prefixed.
    expect(document.querySelector('[data-slot="settings-global-link"]')?.getAttribute('href')).toBe(
      '/settings/global',
    )
  })

  it('/settings/global is the global registry as an index', () => {
    renderAt('/settings/global')
    const index = document.querySelector('[data-slot="settings-index"]')!
    const ids = [...index.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
    expect(ids).toEqual(GLOBAL_SECTIONS)
    expect(index.querySelector('[data-section="projects"]')?.getAttribute('href')).toBe(
      '/settings/global/projects',
    )
  })

  it('single-project mode removes Projects from the global index and navigation', () => {
    renderAt('/settings/global', { singleProject: true })
    expect(document.querySelector('[data-slot="settings-index"] [data-section="projects"]')).toBeNull()
    expect(document.querySelector('[data-slot="settings-nav"] [data-section="projects"]')).toBeNull()
    expect(document.querySelector('[data-section="resources"]')).not.toBeNull()
  })

  it('a moved section keeps its old URL working: /settings/appearance → the global twin', async () => {
    renderAt('/settings/appearance')
    // Legacy flat URL → boot project → the section's new global home. Two redirects, one hop
    // each, and the address bar ends up naming the real place.
    await waitFor(() => {
      expect(document.querySelector('[data-route="settings-global-appearance"]')).not.toBeNull()
    })
  })

  it('unfinished sections say so through the shared CenteredState template', () => {
    // Hidden sections are not routed (their URLs 404) — render the registry component
    // directly to pin the placeholder contract itself.
    const Keyboard = SETTINGS_SECTIONS.find((s) => s.id === 'keyboard')!.component
    render(<Keyboard />)
    const state = document.querySelector('[data-slot="centered-state"]')
    expect(state?.textContent).toContain('later phase')
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
