import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { AppRoutes } from '@/routes'

/**
 * The GitHub tab's ROUTE WIRING, tested through the real `AppRoutes` (#730).
 *
 * `github.test.tsx` mounts `GithubRoute` under a hand-written route map — which is the right tool
 * for the component's behaviour, but structurally cannot catch a defect that lives in
 * `routes.tsx`, because the hand-written map is a copy rather than the thing itself.
 *
 * And one such defect shipped: the bare `/github` used to render a wrapper component while
 * `/github/issues/:n` rendered `GithubRoute`. React reconciles by element TYPE, so clicking a
 * cross-state search hit — which navigates from the first path to the second — unmounted the
 * route and reset its search text to `''`. With the query gone, `searchHits` was empty and the
 * detail pane answered *"#N is not among the open issues"* about the item the user had just
 * clicked, advising them to search for it. `/github/prs` → `/github/prs/:n` never had the bug,
 * because both already rendered one type; that asymmetry is exactly what these two tests pin.
 *
 * Both directions are asserted so neither can regress alone, and both go through the REAL route
 * table, so reintroducing a wrapper for either entry path fails here.
 */

const CLOSED_ISSUE = {
  kind: 'issue' as const,
  number: 4507,
  title: 'payment session amount drifts from the order total',
  author: 'wojciechszyjka',
  createdAt: '2026-07-25T07:08:17.000Z',
  labels: [],
  body: 'A closed issue — never present in the open list.',
  url: 'https://github.com/acme/demo/issues/4507',
  comments: 0,
}

const MERGED_PR = {
  kind: 'pr' as const,
  number: 4507,
  title: 'reconcile payment-session amount with order total',
  author: 'wojciechszyjka',
  createdAt: '2026-07-25T07:08:17.000Z',
  labels: [],
  body: 'A merged PR — never present in the open list.',
  url: 'https://github.com/acme/demo/pull/4507',
  comments: 0,
  isDraft: false,
  checks: null,
}

const OPEN_ISSUE = {
  kind: 'issue' as const,
  number: 142,
  title: 'Login form drops session on refresh',
  author: 'ada',
  createdAt: '2026-07-09T08:00:00.000Z',
  labels: [],
  body: '',
  url: 'https://github.com/acme/demo/issues/142',
  comments: 0,
}

const OPEN_PR = {
  kind: 'pr' as const,
  number: 137,
  title: 'Stream tokens over SSE',
  author: 'grace',
  createdAt: '2026-07-11T08:00:00.000Z',
  labels: [],
  body: '',
  url: 'https://github.com/acme/demo/pull/137',
  comments: 0,
  isDraft: false,
  checks: null,
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** The whole app boots here, not just the tab, so the shell's own reads are answered too. The
 *  search route serves the ONE cross-state hit; the list serves an open set that deliberately
 *  excludes it, which is the split the whole feature exists for. */
function stubServer(kind: 'issue' | 'pr') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/health') {
        return json({
          version: '0.0.0-test',
          repoRoot: '/r',
          repo: { root: '/r', branch: 'main' },
          defaultRunner: 'claude',
          checks: [],
          forge: { kind: 'github', available: true },
          capabilities: {
            localHandoff: true,
            tokenMetrics: false,
            tokenUsageMetrics: false,
            costMetrics: false,
            followups: false,
            singleProject: true,
            automations: false,
          },
          projects: [{ id: 'boot', name: 'r' }],
          bootProject: 'boot',
        })
      }
      if (path === '/api/v1/projects') {
        return json({ projects: [{ id: 'boot', name: 'r', root: '/r' }], bootProject: 'boot' })
      }
      if (path === '/api/v1/github' || path.startsWith('/api/v1/github?')) {
        return json({
          available: true,
          repo: 'acme/demo',
          syncedAt: '2026-07-15T08:00:00.000Z',
          issues: [OPEN_ISSUE],
          prs: [OPEN_PR],
        })
      }
      if (path.includes('/api/v1/github/search')) {
        return json({ available: true, items: [kind === 'issue' ? CLOSED_ISSUE : MERGED_PR] })
      }
      if (path.startsWith('/api/v1/github/checks')) return json({ available: true, checks: {} })
      if (path.startsWith('/api/v1/github/comments/')) return json({ available: true, comments: [] })
      if (path === '/api/v1/skills') return json([])
      if (path === '/api/v1/workflows') return json({ workflows: [] })
      return json({})
    }),
  )
}

/** The URL has to be asserted, not assumed. With no `:n` the tab already renders `searchHits[0]`
 *  in the detail pane, so "the closed issue is on screen" is true BEFORE the navigation too — a
 *  click that silently failed to navigate would sail past that assertion while the real defect
 *  (what happens on the hop) went untested. */
function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

function renderApp(entry: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const pathname = () => document.querySelector('[data-testid="location"]')?.textContent

const searchBox = () => document.querySelector<HTMLInputElement>('[data-slot="gh-search"]')!
const hits = () => document.querySelector('[data-slot="gh-search-hits"]')
const detail = () => document.querySelector('[data-slot="gh-detail-inner"]')

beforeEach(() => {
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
  vi.unstubAllGlobals()
})

describe('cross-state hits stay open across a real route navigation (#730)', () => {
  it('/github → /github/issues/:n keeps the clicked hit', async () => {
    stubServer('issue')
    renderApp('/github')
    await waitFor(() => expect(searchBox()).not.toBeNull(), { timeout: 5000 })

    fireEvent.change(searchBox(), { target: { value: '4507' } })
    await waitFor(() => expect(hits()).not.toBeNull(), { timeout: 5000 })

    fireEvent.click(within(hits() as HTMLElement).getByRole('link'))

    // The hop actually happened…
    await waitFor(() => expect(pathname()).toMatch(/github\/issues\/4507$/), { timeout: 5000 })
    // …and it RECONCILED rather than remounted: the query survives, the hit is still rendered,
    // and the detail pane shows the closed issue rather than the "not among the open" shrug.
    await waitFor(
      () => expect(detail()?.textContent).toContain('payment session amount drifts'),
      { timeout: 5000 },
    )
    expect(searchBox().value).toBe('4507')
    expect(hits()).not.toBeNull()
    expect(detail()?.textContent ?? '').not.toContain('is not among the open')
  })

  it('/github/prs → /github/prs/:n keeps the clicked hit', async () => {
    stubServer('pr')
    renderApp('/github/prs')
    await waitFor(() => expect(searchBox()).not.toBeNull(), { timeout: 5000 })

    fireEvent.change(searchBox(), { target: { value: '4507' } })
    await waitFor(() => expect(hits()).not.toBeNull(), { timeout: 5000 })

    fireEvent.click(within(hits() as HTMLElement).getByRole('link'))

    await waitFor(() => expect(pathname()).toMatch(/github\/prs\/4507$/), { timeout: 5000 })
    await waitFor(
      () => expect(detail()?.textContent).toContain('reconcile payment-session amount'),
      { timeout: 5000 },
    )
    expect(searchBox().value).toBe('4507')
    expect(hits()).not.toBeNull()
    expect(detail()?.textContent ?? '').not.toContain('is not among the open')
  })
})
