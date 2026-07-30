import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import type { HealthResponse, ProjectsResponse, Skill } from '@open-mercato/cezar-api-client'
import { BookmarkletPanel } from './bookmarklets-section'

/**
 * #422: the bookmark's visible label (what a browser stamps as the bookmark's name when it is
 * dragged to the bookmarks bar) must include the current repo name so a person with several
 * cezar cockpits open can tell their bookmarks apart.
 *
 * Multi-project spec, step 3.6: the same generator, mounted under `/p/<id>/settings`, must bake
 * THAT project's URL prefix and THAT project's launch key — the second describe below.
 */

const fetchMock = vi.fn<typeof fetch>()

const HEALTH: HealthResponse = {
  version: '0.1.5',
  projects: [],
  bootProject: 'default',
  repoRoot: '/home/me/Projects/cezar',
  repo: { root: '/home/me/Projects/cezar', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false },
}

const SKILLS: Skill[] = [
  { name: 'om-fix', body: '', path: '.ai/skills/om-fix.md', source: 'ai' },
]

function serve(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input)
    if (!(path in routes)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    return new Response(JSON.stringify(routes[path]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

/**
 * Mount the panel the way the router does: at a `/p/<id>/settings/bookmarklets` URL, optionally
 * inside a project scope. `scope: null` is the BOOT project's real shape — the URL names it but
 * the provider is unscoped, so the API paths stay legacy (see routes.tsx).
 */
function renderPanel(
  skills: readonly Skill[] = SKILLS,
  { at = '/p/cezar/settings/bookmarklets', scope = null }: { at?: string; scope?: string | null } = {},
) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[at]}>
        <ProjectScopeProvider projectId={scope}>
          <BookmarkletPanel skills={skills} />
        </ProjectScopeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const label = (text: string) =>
  [...document.querySelectorAll('[data-slot="bm-link"]')].find((el) => el.textContent?.trim() === text)

/** The program a browser would run — the generated `href` is set imperatively after mount. */
const hrefOf = (slot: string) =>
  decodeURIComponent(
    document.querySelector(`[data-slot="${slot}"] [data-slot="bm-link"]`)?.getAttribute('href') ?? '',
  )

describe('BookmarkletPanel repo-name labels (#422)', () => {
  it('stamps the repo name (the sidebar chip basename) into the generic and per-skill labels', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/launch-key': { key: 'sekret' } })
    renderPanel()

    await waitFor(() => expect(label('cezar (cezar): this PR/issue')).toBeTruthy())
    expect(label('/om-fix (cezar)')).toBeTruthy()
  })

  it('falls back to the plain, repo-less label while health is unknown', () => {
    // A never-resolving fetch: health stays pending, so the repo name is not yet known.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
    renderPanel()

    expect(label('cezar: this PR/issue')).toBeTruthy()
    expect(label('/om-fix')).toBeTruthy()
    expect(label('/om-fix (cezar)')).toBeFalsy()
  })

  it('falls back to the plain label outside a git repository', async () => {
    serve({ '/api/v1/health': { ...HEALTH, repo: null }, '/api/v1/launch-key': { key: 'sekret' } })
    renderPanel()

    await waitFor(() => expect(label('cezar: this PR/issue')).toBeTruthy())
    expect(label('/om-fix')).toBeTruthy()
  })
})

/** The registry both projects resolve their display name against. `/api/v1/projects` is
 *  workspace-level (never scoped), so it answers the same under either mount below. */
const REGISTRY: ProjectsResponse = {
  projects: [
    {
      id: 'cezar',
      name: 'cezar',
      root: '/home/me/Projects/cezar',
      addedAt: '',
      lastOpenedAt: '',
      source: 'local',
      status: 'ok',
    },
    {
      id: 'acme',
      name: 'acme-repo',
      root: '/home/me/Projects/acme',
      addedAt: '',
      lastOpenedAt: '',
      source: 'local',
      status: 'ok',
    },
  ],
  bootProject: 'cezar',
  projectsDir: '~/cezar/projects',
}

describe('BookmarkletPanel project scoping (multi-project spec, step 3.6)', () => {
  it("bakes the ACTIVE project's URL prefix and that project's own launch key", async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/projects': REGISTRY,
      // The boot project's key, reachable at the legacy unscoped path. If the panel read this
      // one under `/p/acme`, the generated launcher would be armed with a secret acme's cockpit
      // scope rejects — the exact cross-project leak the assertions below rule out.
      '/api/v1/launch-key': { key: 'boot-key' },
      '/api/v1/p/acme/launch-key': { key: 'acme-key' },
    })
    renderPanel(SKILLS, { at: '/p/acme/settings/bookmarklets', scope: 'acme' })

    await waitFor(() => expect(hrefOf('bm-generic')).toContain('key=acme-key'))
    expect(hrefOf('bm-generic')).toContain(`/p/acme/new?'+q`)
    expect(hrefOf('bm-generic')).not.toContain('boot-key')
    // The name stamp comes from the registry entry for THIS project, not from `/api/v1/health`
    // (workspace-level: it always describes the boot repo).
    expect(label('cezar (acme-repo): this PR/issue')).toBeTruthy()
    expect(label('/om-fix (acme-repo)')).toBeTruthy()
  })

  it('names the boot project too — it is unscoped, but the URL still says which project', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/projects': REGISTRY, '/api/v1/launch-key': { key: 'boot-key' } })
    renderPanel(SKILLS, { at: '/p/cezar/settings/bookmarklets', scope: null })

    await waitFor(() => expect(hrefOf('bm-generic')).toContain('key=boot-key'))
    // The boot project mounts UNSCOPED, so only the URL prefix can answer here.
    expect(hrefOf('bm-generic')).toContain(`/p/cezar/new?'+q`)
    // …and the protected query grammar is untouched by the prefix.
    expect(hrefOf('bm-generic')).toContain(`q='auto=0&key=boot-key&ref='`)
  })

  it('falls back to the boot project when the URL carries no prefix at all', async () => {
    // A legacy flat URL still mid-redirect: health names the boot project, so the generated
    // launcher already lands where the redirect would have taken it.
    serve({ '/api/v1/health': { ...HEALTH, bootProject: 'cezar' }, '/api/v1/launch-key': { key: 'k' } })
    renderPanel(SKILLS, { at: '/settings/bookmarklets', scope: null })

    await waitFor(() => expect(hrefOf('bm-generic')).toContain(`/p/cezar/new?'+q`))
  })

  it('degrades to the legacy flat /new when nothing names a project', async () => {
    // Registry and health both unavailable. The flat path is not a dead end — the cockpit
    // permanently redirects it to the boot project, so the launcher still lands.
    serve({ '/api/v1/launch-key': { key: 'k' } })
    renderPanel(SKILLS, { at: '/settings/bookmarklets', scope: null })

    await waitFor(() => expect(hrefOf('bm-generic')).toContain('key=k'))
    expect(hrefOf('bm-generic')).toContain(`/new?'+q`)
    expect(hrefOf('bm-generic')).not.toContain('/p/')
  })
})
