import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry, RunRecord } from '@open-mercato/cezar-api-client'
import { ListViewProvider } from '@/components/list-view'
import { ProjectGroups } from '@/components/project-groups'
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from '@/lib/sidebar-collapse'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** Seed the per-browser collapse map the sidebar reads at mount. */
function storeCollapsed(collapsed: Record<string, boolean>): void {
  localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsed))
}

function storedCollapsed(): unknown {
  const raw = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
  return raw === null ? null : JSON.parse(raw)
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
    branch: 'main',
    forge: 'github',
    ...over,
  }
}

let seq = 0

function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: 'done',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * Answer each endpoint the sidebar reads; anything else 404s loudly rather than silently
 * resolving and making a broken wiring look fine.
 *
 * Collapse is deliberately NOT among those endpoints — it is per-browser state (localStorage),
 * so a group toggle must cost this map zero requests.
 */
function serve(routes: Record<string, unknown>, uiState: Record<string, unknown> = {}): void {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    // The workspace ui-state is answered for every case, because the drawer now reads the
    // hand-picked project order from it (#952) — a 404 there would silently disable reordering
    // in every test rather than in the ones that mean to.
    if (url === '/api/v1/workspace/ui-state') {
      if ((init?.method ?? 'GET') === 'PUT') {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>
        return json({ ...uiState, ...patch })
      }
      return json(uiState)
    }
    const body = routes[url]
    if (body === undefined) return json({ error: 'not found' }, 404)
    return json(body)
  })
}

function renderGroups(
  projects: ProjectListEntry[],
  entry = '/p/cezar/',
  // #801: workspace-wide, unlike the per-project forge gate — one env var on the one server that
  // serves every group. Off by default here, exactly as a default server reports it.
  { automations = false }: { automations?: boolean } = {},
) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <ListViewProvider>
          <ProjectGroups projects={projects} bootProjectId="cezar" automationsAvailable={automations} />
        </ListViewProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const group = (id: string) =>
  document.querySelector(`[data-slot="project-group"][data-project="${id}"]`) as HTMLElement

/** The disclosure button — addressed by slot rather than by role, because the row also carries
 *  the reorder grip (#952) and "the button in this group" stopped being one button. */
const header = (id: string) =>
  group(id).querySelector('[data-slot="project-group-header"]') as HTMLButtonElement

const grip = (id: string) =>
  group(id).querySelector('[data-slot="project-group-grip"]') as HTMLButtonElement | null

/** How many times the workspace ui-state has been asked for — the sidebar reads it for the
 *  project order, so "no request" assertions became "no EXTRA request" ones. */
const uiStateRequests = () =>
  fetchMock.mock.calls.filter((call) => String(call[0]).includes('/workspace/ui-state')).length

/** Every task row of a group, in render order — the rows are `[data-slot="quick-list-row"]`
 *  links inside the group's body. */
function taskLinks(id: string): HTMLAnchorElement[] {
  return Array.from(
    group(id).querySelectorAll('[data-slot="quick-list-bucket"] a[href^="/p/"]'),
  ) as HTMLAnchorElement[]
}

describe('ProjectGroups', () => {
  it('caps an expanded group at 10 rows and links More… at that project’s tasks pane', async () => {
    const runs = Array.from({ length: 15 }, () => run())
    serve({ '/api/v1/p/cezar/runs': runs })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    await waitFor(() => expect(taskLinks('cezar').length).toBeGreaterThan(0))
    // Ten of fifteen — the spec's "10 most recent tasks", counted across buckets.
    expect(taskLinks('cezar')).toHaveLength(10)

    const more = within(group('cezar')).getByRole('link', { name: 'More…' })
    expect(more.getAttribute('href')).toBe('/p/cezar/')
  })

  it('orders groups by lastOpenedAt and only fetches the expanded one', async () => {
    serve({ '/api/v1/p/cezar/runs': [] })
    renderGroups([
      project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-18T00:00:00.000Z' }),
      project(),
    ])

    await waitFor(() => expect(header('cezar').getAttribute('aria-expanded')).toBe('true'))
    expect(
      Array.from(document.querySelectorAll('[data-slot="project-group"]')).map((el) =>
        el.getAttribute('data-project'),
      ),
    ).toEqual(['cezar', 'shop'])
    // The collapsed group costs one registry row, never a runs request.
    expect(header('shop').getAttribute('aria-expanded')).toBe('false')
    const asked = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(asked).not.toContain('/api/v1/p/shop/runs')
  })

  it('renders each group’s nav scoped to that project', async () => {
    storeCollapsed({ shop: false })
    serve({ '/api/v1/p/cezar/runs': [], '/api/v1/p/shop/runs': [] })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    await waitFor(() => expect(header('shop').getAttribute('aria-expanded')).toBe('true'))
    const shopNav = within(group('shop')).getByRole('navigation', { name: 'shop navigation' })
    expect(within(shopNav).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/p/shop/',
      '/p/shop/git',
      '/p/shop/github',
      '/p/shop/skills',
      '/p/shop/workflows',
      '/p/shop/settings',
    ])
    // Only the group that owns the URL lights a nav row — `/p/cezar/` is the Tasks area of
    // exactly one project, not of every project whose nav lists a Tasks row.
    expect(within(shopNav).queryByRole('link', { current: 'page' })).toBeNull()
    const cezarNav = within(group('cezar')).getByRole('navigation', { name: 'cezar navigation' })
    expect(within(cezarNav).getByRole('link', { current: 'page' }).textContent).toBe('Tasks')
  })

  it("gates each group's GitHub tab on that project's own forge (#698)", async () => {
    // Two expanded groups, one with a GitHub remote and one without: the GitHub nav item must
    // follow each entry's own `forge` field, not one workspace-wide answer — the exact failure
    // was every group hiding (or showing) GitHub based on the folder cezar was LAUNCHED in.
    storeCollapsed({ plain: false })
    serve({
      '/api/v1/p/cezar/runs': [],
      '/api/v1/p/plain/runs': [],
    })
    renderGroups([
      project(),
      project({ id: 'plain', name: 'plain', forge: undefined, lastOpenedAt: '2026-07-19T00:00:00.000Z' }),
    ])

    await waitFor(() => expect(header('plain').getAttribute('aria-expanded')).toBe('true'))
    const cezarNav = within(group('cezar')).getByRole('navigation', { name: 'cezar navigation' })
    expect(within(cezarNav).getByRole('link', { name: 'GitHub' }).getAttribute('href')).toBe('/p/cezar/github')
    const plainNav = within(group('plain')).getByRole('navigation', { name: 'plain navigation' })
    expect(within(plainNav).queryByRole('link', { name: 'GitHub' })).toBeNull()
  })

  // #801: every group reads ONE workspace capability, so no group can offer Automations while
  // another hides it — and with the opt-in off, none of them offers it at all.
  it("gates every group's Automations tab on the workspace capability (#801)", async () => {
    storeCollapsed({ shop: false })
    serve({ '/api/v1/p/cezar/runs': [], '/api/v1/p/shop/runs': [] })
    const shop = project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })
    const view = renderGroups([project(), shop], '/p/cezar/', { automations: true })

    await waitFor(() => expect(header('shop').getAttribute('aria-expanded')).toBe('true'))
    for (const id of ['cezar', 'shop']) {
      const nav = within(group(id)).getByRole('navigation', { name: `${id} navigation` })
      expect(within(nav).getByRole('link', { name: 'Automations' }).getAttribute('href'))
        .toBe(`/p/${id}/automations`)
    }

    view.unmount()
    renderGroups([project(), shop])
    await waitFor(() => expect(header('shop').getAttribute('aria-expanded')).toBe('true'))
    for (const id of ['cezar', 'shop']) {
      const nav = within(group(id)).getByRole('navigation', { name: `${id} navigation` })
      expect(within(nav).queryByRole('link', { name: 'Automations' })).toBeNull()
    }
  })

  it('round-trips a collapse through this browser’s storage, never the server', async () => {
    serve({ '/api/v1/p/cezar/runs': [] })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    await waitFor(() => expect(header('cezar').getAttribute('aria-expanded')).toBe('true'))
    // The drawer DOES read workspace ui-state once, for the hand-picked project order (#952) —
    // what must not happen is a toggle costing a request, so measure from here.
    const uiStateReadsBefore = uiStateRequests()

    fireEvent.click(header('cezar'))
    await waitFor(() => expect(header('cezar').getAttribute('aria-expanded')).toBe('false'))
    expect(storedCollapsed()).toEqual({ cezar: true })

    // …and expanding it again writes the other way, composing with the entry already stored.
    fireEvent.click(header('cezar'))
    await waitFor(() => expect(header('cezar').getAttribute('aria-expanded')).toBe('true'))
    expect(storedCollapsed()).toEqual({ cezar: false })

    // Not one request either way: the collapse map never leaves this browser.
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).not.toContain('PUT')
    expect(uiStateRequests()).toBe(uiStateReadsBefore)
  })

  it('starts from the stored collapse rather than the active-project default', async () => {
    storeCollapsed({ cezar: true })
    serve({
      '/api/v1/p/cezar/runs': [],
    })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    // The active project, pinned shut by the user, stays shut across a reload.
    await waitFor(() => expect(header('cezar').getAttribute('aria-expanded')).toBe('false'))
  })

  it('badges a group with its needs-you count', async () => {
    serve({
      '/api/v1/p/cezar/runs': [run({ status: 'waiting' }), run({ status: 'review' }), run()],
    })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    await waitFor(() =>
      expect(group('cezar').querySelector('[data-slot="project-attention"]')?.textContent).toBe('2'),
    )
    // Nothing waiting, nothing to badge — a "0" here is noise, not information.
    expect(group('shop').querySelector('[data-slot="project-attention"]')).toBeNull()
  })

  it("the boot group reads the 'default' cache entry — the one the stream patches", async () => {
    // The boot project mounts UNSCOPED (routes.tsx), so the main view and the SSE patcher both
    // live under the 'default' scope key. The boot group must share that entry, or its list and
    // needs-you badge freeze at whatever the expand-time fetch answered.
    const client = createQueryClient()
    serve({ '/api/v1/p/cezar/runs': [] })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/p/cezar/']}>
          <ListViewProvider>
            <ProjectGroups projects={[project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })]} bootProjectId="cezar" />
          </ListViewProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(header('cezar').getAttribute('aria-expanded')).toBe('true'))
    expect(taskLinks('cezar')).toHaveLength(0)

    // A live `run` event lands in the cache exactly where global-events writes it: under
    // ['default', 'runs', 'list'], never under the boot project's own id.
    client.setQueryData(['default', 'runs', 'list'], [run({ status: 'waiting' })])

    await waitFor(() => expect(taskLinks('cezar')).toHaveLength(1))
    expect(group('cezar').querySelector('[data-slot="project-attention"]')?.textContent).toBe('1')
    // The non-boot group keeps its own per-project key untouched.
    expect(taskLinks('shop')).toHaveLength(0)
  })

  it('keeps pinned rows past the 10-row cap, and spends the budget on the rest (#935)', async () => {
    const runs = [
      ...Array.from({ length: 15 }, () => run()),
      run({ id: 'kept-a', pinned: true }),
      run({ id: 'kept-b', pinned: true }),
    ]
    serve({ '/api/v1/p/cezar/runs': runs })
    renderGroups([project()])

    await waitFor(() => expect(taskLinks('cezar').length).toBeGreaterThan(0))
    // Twelve: both pins, plus the ten the ordinary buckets are still allowed.
    expect(taskLinks('cezar')).toHaveLength(12)
    const pinnedBucket = group('cezar').querySelector('[data-bucket="Pinned"]')
    expect(pinnedBucket?.querySelectorAll('[data-slot="task-row"]')).toHaveLength(2)
  })

  it("pins through the row's OWN project, not the one the URL names (#935)", async () => {
    // The failure this pins: `queryScope()` would address whichever project the page is standing
    // in, so a pin on another group's row would 404 — or, with a colliding run id, pin the wrong
    // task in the wrong repo.
    const posts: string[] = []
    fetchMock.mockImplementation(async (input, init: RequestInit = {}) => {
      const path = String(input)
      if (init.method === 'POST') {
        posts.push(path)
        return json({})
      }
      if (path === '/api/v1/p/cezar/runs') return json([run({ id: 'other-project-task' })])
      if (path === '/api/v1/p/shop/runs') return json([])
      return json({ error: 'not found' }, 404)
    })
    // Standing in `shop`, with the boot project's group open beside it.
    storeCollapsed({ cezar: false })
    renderGroups(
      [project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })],
      '/p/shop/',
    )

    await waitFor(() => expect(taskLinks('cezar')).toHaveLength(1))
    fireEvent.click(within(group('cezar')).getByRole('button', { name: 'Pin task' }))
    await waitFor(() => expect(posts).toEqual(['/api/v1/p/cezar/runs/other-project-task/pin']))
  })

  it('renders a missing project greyed and inert, with no nav behind it', async () => {
    serve({ '/api/v1/p/cezar/runs': [] })
    renderGroups([project(), project({ id: 'gone', name: 'old-spike', status: 'missing', lastOpenedAt: '2026-07-01T00:00:00.000Z' })])

    await waitFor(() => expect(group('gone')).not.toBeNull())
    expect(group('gone').querySelector('[data-slot="project-missing"]')?.textContent).toBe(
      'folder not found',
    )
    // Every pane of a missing project 409s, so there is nothing to expand into and nothing to
    // link at — the row states the fact and stops.
    expect(within(group('gone')).queryByRole('button')).toBeNull()
    expect(within(group('gone')).queryAllByRole('link')).toHaveLength(0)
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain('/api/v1/p/gone/runs')
  })

  /**
   * A `/p/` prefix is the ONLY thing that makes a project the one you are standing in. On the
   * global pages — `/tasks` and `/settings/global` — there is no such prefix and no selected
   * project, so nothing may be painted as selected: highlighting the boot project while the
   * user reads an all-projects table says the page is about that project when it is not.
   */
  it('marks no project as selected on a page that belongs to none', async () => {
    serve({ '/api/v1/p/cezar/runs': [] })
    renderGroups(
      [project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })],
      '/tasks',
    )

    await waitFor(() => expect(group('cezar')).not.toBeNull())
    for (const id of ['cezar', 'shop']) {
      expect(group(id).hasAttribute('data-active')).toBe(false)
      expect(group(id).querySelector('[aria-current="page"]')).toBeNull()
    }
    // The boot group still OPENS by default: landing on a global page must not fold the whole
    // sidebar shut — that is a different question from which one is selected.
    expect(header('cezar').getAttribute('aria-expanded')).toBe('true')
  })

  /**
   * The hand-picked order (#952). The merge rule itself is table-tested in
   * `lib/project-order.test.ts` and the write path in `lib/use-project-order.test.tsx`; what is
   * worth proving here is that the drawer is wired to both — and that the drag affordance is a
   * real, labelled, keyboard-reachable control. The drag GESTURE is e2e's job, as it is for the
   * workflow builder's step list.
   */
  describe('reorder', () => {
    const three = () => [
      project(),
      project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' }),
      project({ id: 'blog', name: 'blog', lastOpenedAt: '2026-07-10T00:00:00.000Z' }),
    ]
    const renderedOrder = () =>
      Array.from(document.querySelectorAll('[data-slot="project-group"]')).map((el) =>
        el.getAttribute('data-project'),
      )

    it('renders the stored order instead of the lastOpenedAt sort', async () => {
      serve({ '/api/v1/p/cezar/runs': [] }, { sidebar: { projectOrder: ['blog', 'cezar', 'shop'] } })
      renderGroups(three())

      await waitFor(() => expect(renderedOrder()).toEqual(['blog', 'cezar', 'shop']))
    })

    it('floats a project registered since the last drag to the top', async () => {
      // `cezar` was never placed, so it is the one that just arrived — visible, and one drag from
      // wherever the user wants it, rather than buried under a curated list.
      serve({ '/api/v1/p/cezar/runs': [] }, { sidebar: { projectOrder: ['blog', 'shop'] } })
      renderGroups(three())

      await waitFor(() => expect(renderedOrder()).toEqual(['cezar', 'blog', 'shop']))
    })

    it('ignores stored ids that are no longer registered', async () => {
      serve(
        { '/api/v1/p/cezar/runs': [] },
        { sidebar: { projectOrder: ['ghost', 'shop', 'cezar', 'blog'] } },
      )
      renderGroups(three())

      await waitFor(() => expect(renderedOrder()).toEqual(['shop', 'cezar', 'blog']))
    })

    it('gives every group a labelled grip that says where it is', async () => {
      serve({ '/api/v1/p/cezar/runs': [] }, { sidebar: { projectOrder: ['cezar', 'shop', 'blog'] } })
      renderGroups(three())

      await waitFor(() => expect(grip('cezar')?.disabled).toBe(false))
      expect(grip('cezar')?.getAttribute('aria-label')).toBe('Reorder cezar, position 1 of 3')
      expect(grip('blog')?.getAttribute('aria-label')).toBe('Reorder blog, position 3 of 3')
      // A real focusable control, which is what dnd-kit's Space/arrows/Space path lifts from.
      expect(grip('shop')?.tagName).toBe('BUTTON')
      grip('shop')?.focus()
      expect(document.activeElement).toBe(grip('shop'))
    })

    it('shows the grip at rest where there is no hover, and hides it where there is', async () => {
      // The grip used to be `opacity-0` revealed only by hover / `:focus-visible`, neither of
      // which a tap produces — so the mobile drawer, one of the two devices this feature exists
      // to reconcile, had a drag affordance nobody could see. Asserted on the class list rather
      // than a computed style because jsdom resolves no media queries at all: what is being
      // pinned is that the coarse-pointer reveal is PRESENT, and that `disabled` still undoes it.
      serve({ '/api/v1/p/cezar/runs': [] }, { sidebar: { projectOrder: ['cezar', 'shop', 'blog'] } })
      renderGroups(three())

      await waitFor(() => expect(grip('cezar')?.disabled).toBe(false))
      const enabled = grip('cezar')!.className
      expect(enabled).toContain('opacity-0')
      expect(enabled).toContain('[@media(hover:none)]:opacity-100')

      cleanup()
      // A grip with nothing to do must not be the one thing a phone DOES show.
      serve({ '/api/v1/p/cezar/runs': [] })
      renderGroups([project()])
      await waitFor(() => expect(grip('cezar')?.disabled).toBe(true))
      expect(grip('cezar')!.className).toContain('[@media(hover:none)]:opacity-0')
    })

    it('offers no grip on a project whose folder is gone', async () => {
      serve({ '/api/v1/p/cezar/runs': [] })
      renderGroups([
        project(),
        project({ id: 'gone', name: 'old-spike', status: 'missing', lastOpenedAt: '2026-07-01T00:00:00.000Z' }),
      ])

      await waitFor(() => expect(group('gone')).not.toBeNull())
      expect(grip('gone')).toBeNull()
      // It still holds its place in the list rather than being pushed anywhere special.
      expect(renderedOrder()).toEqual(['cezar', 'gone'])
    })

    it('cannot reorder a single-project registry', async () => {
      serve({ '/api/v1/p/cezar/runs': [] })
      renderGroups([project()])

      await waitFor(() => expect(group('cezar')).not.toBeNull())
      expect(grip('cezar')?.disabled).toBe(true)
    })

    it('disables the grips until the workspace ui-state has answered', async () => {
      // A write composed before the authoritative GET lands would drop the file's other keys on
      // the server's shallow merge, so the affordance waits rather than gambling.
      fetchMock.mockImplementation(async (input) => {
        const url = String(input)
        if (url === '/api/v1/workspace/ui-state') return new Promise<never>(() => {})
        return json(url === '/api/v1/p/cezar/runs' ? [] : { error: 'not found' }, 200)
      })
      renderGroups(three())

      await waitFor(() => expect(grip('cezar')).not.toBeNull())
      expect(grip('cezar')?.disabled).toBe(true)
      // …and the fallback order still renders, so the drawer is never blank on a slow read.
      expect(renderedOrder()).toEqual(['cezar', 'shop', 'blog'])
    })
  })

  it('still marks the scoped project on a project page', async () => {
    serve({ '/api/v1/p/shop/runs': [] })
    renderGroups(
      [project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })],
      '/p/shop/git',
    )

    await waitFor(() => expect(group('shop')).not.toBeNull())
    expect(group('shop').hasAttribute('data-active')).toBe(true)
    expect(group('cezar').hasAttribute('data-active')).toBe(false)
    // …and the nav row for the URL's own area is the current page inside that group only.
    expect(group('shop').querySelector('[aria-current="page"]')?.textContent).toBe('Git')
    expect(group('cezar').querySelector('[aria-current="page"]')).toBeNull()
  })
})
