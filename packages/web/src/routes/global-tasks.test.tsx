import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'
import { ListViewProvider, useListView } from '@/components/list-view'
import { __clearRememberedStatusesForTests, workspaceQueryKeys } from '@/api/queries'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { GlobalTasksRoute } from './global-tasks'
import { resolveConflictsPrompt } from './task-thread/run-actions'

/**
 * The global Tasks page, wired to stubbed `/api/v1/projects` + `/api/v1/workspace/runs-index`.
 *
 * The behaviors worth a DOM test rather than a unit one: the rows link into each task's OWN
 * project (this page renders outside every scope, so a scoped link would silently point at the
 * wrong repo), the tag chips are a real multi-select, and the truncation notice is not silent.
 */

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  // Reference statuses are remembered for the LIFETIME OF THE TAB, deliberately (a re-keyed batch
  // must not blank the chips) — which in vitest means one case's statuses would otherwise be
  // remembered by the next one in this file.
  __clearRememberedStatusesForTests()
})

const PROJECTS: ProjectListEntry[] = [
  {
    id: 'api',
    name: 'API',
    root: '/repos/api',
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
    tags: ['storefront'],
    repoUrl: 'https://github.com/acme/api',
  },
  {
    id: 'web',
    name: 'Web',
    root: '/repos/web',
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
    tags: ['storefront'],
  },
  {
    id: 'infra',
    name: 'Infra',
    root: '/repos/infra',
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
  },
]

const RUNS: RunIndexEntry[] = [
  {
    projectId: 'api',
    id: 'a1',
    title: 'Add checkout endpoint',
    status: 'running',
    createdAt: '2026-07-14T10:00:00Z',
    archived: false,
    workflow: 'quick-task',
    branch: 'feat/checkout',
    // Several at once: opened on an issue, about one PR, having created another.
    pullRequestUrl: 'https://github.com/acme/api/pull/42',
    referencedPullRequestUrl: 'https://github.com/acme/api/pull/40',
    referencedIssueUrl: 'https://github.com/acme/api/issues/12',
    markerRefs: { pr: 40, issue: 12 },
  },
  {
    projectId: 'web',
    id: 'w1',
    title: 'Checkout page',
    status: 'review',
    createdAt: '2026-07-14T09:00:00Z',
    archived: false,
    workflow: 'plan-first',
    issueNumber: 7,
    referencedIssueUrl: 'https://github.com/acme/web/issues/7',
  },
  {
    projectId: 'infra',
    id: 'i1',
    title: 'Bump the runner',
    status: 'done',
    createdAt: '2026-07-14T08:00:00Z',
    archived: false,
    workflow: 'quick-task',
  },
]

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let sent: { method: string; path: string; body?: unknown }[] = []

function stubFetch({
  runs = RUNS,
  projects = PROJECTS,
  truncated = [] as string[],
  indexStatus = 200,
  archiveStatus = 200,
  costMetrics = true,
  refStatus,
  indexStatuses,
}: {
  runs?: RunIndexEntry[]
  projects?: ProjectListEntry[]
  truncated?: string[]
  indexStatus?: number
  archiveStatus?: number
  costMetrics?: boolean
  /** Per-project chip status, as the forge would answer it. Absent = the forge is unreachable,
   *  which is the only honest default here: no `gh`, no statuses, neutral chips. */
  refStatus?: Record<
    string,
    { prs?: Record<number, string>; issues?: Record<number, string>; conflicts?: number[] }
  >
  /** What the runs-index itself already knew — the free, no-round-trip path. */
  indexStatuses?: Record<string, { prs: Record<number, string>; issues: Record<number, string> }>
} = {}) {
  sent = []
  seenAt = undefined
  // Stateful, like the real server: an archive really flips the flag, so the invalidation
  // refetch answers with the moved row rather than putting the old one back.
  let index = runs.map((run) => ({ ...run }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({
        method,
        path,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      if (path === '/api/v1/providers/status') {
        return jsonResponse({ providers: [{ provider: 'claude', status: 'connected', enabled: true }] })
      }
      // The FULL record, which this page's index row deliberately is not: the conflict panel's
      // action fetches it (per project, on open) to learn whether the task can be spoken to.
      const detail = /^\/api\/v1\/p\/([^/]+)\/runs\/([^/]+)$/.exec(path)
      if (detail && method === 'GET') {
        const [, projectId, id] = detail
        const found = index.find((run) => run.projectId === projectId && run.id === id)
        if (!found) return jsonResponse({ error: 'not found' }, 404)
        return jsonResponse({ ...found, task: found.title, tokensUsed: 0, steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 'sess-1' }] })
      }
      const message = /^\/api\/v1\/p\/([^/]+)\/runs\/([^/]+)\/(messages|continue)$/.exec(path)
      if (message && method === 'POST') return jsonResponse({ ok: true })
      if (path === '/api/v1/health') {
        // Only the slice `usageMetricVisibility` reads — the host's cost/token gate.
        return jsonResponse({ capabilities: { costMetrics, tokenUsageMetrics: true } })
      }
      if (path === '/api/v1/projects') {
        return jsonResponse({ projects, bootProject: 'api', projectsDir: '/repos' })
      }
      if (path === '/api/v1/workspace/runs-index') {
        if (indexStatus !== 200) return jsonResponse({ error: 'workspace unreadable' }, indexStatus)
        return jsonResponse({
          runs: index.map((run) => (seenAt === undefined ? run : { ...run, seenAt })),
          perProjectLimit: 200,
          truncated,
          // Statuses the server already had, riding along with the rows — see `indexedStatuses`.
          referenceStatuses: indexStatuses ?? {},
        })
      }
      const status = /^\/api\/v1\/p\/([^/]+)\/github\/ref-status/.exec(path)
      if (status) {
        const answer = refStatus?.[status[1]!]
        // `recheckAfterMs` is the server's call on when to ask again — part of the shape, so the
        // fixture carries it.
        if (!answer) return jsonResponse({ available: false, reason: 'gh CLI not found', recheckAfterMs: 300_000 })
        return jsonResponse({
          available: true,
          prs: answer.prs ?? {},
          issues: answer.issues ?? {},
          ...(answer.conflicts ? { conflicts: answer.conflicts } : {}),
          recheckAfterMs: null,
        })
      }
      const receipt = /^\/api\/v1\/p\/([^/]+)\/runs\/([^/]+)\/(read|unread)$/.exec(path)
      if (receipt && method === 'POST') {
        const [, projectId, id, route] = receipt
        index = index.map((run) => {
          if (run.projectId !== projectId || run.id !== id) return run
          if (route === 'unread') {
            const { seenAt: _dropped, ...rest } = run
            return rest
          }
          return { ...run, seenAt: '2026-07-14T12:00:00Z' }
        })
        return jsonResponse(index.find((run) => run.id === id))
      }
      const archive = /^\/api\/v1\/p\/([^/]+)\/runs\/([^/]+)\/archive$/.exec(path)
      if (archive && method === 'POST') {
        if (archiveStatus !== 200) return jsonResponse({ error: 'still running' }, archiveStatus)
        const [, projectId, id] = archive
        const archived = (JSON.parse(String(init.body)) as { archived: boolean }).archived
        index = index.map((run) =>
          run.projectId === projectId && run.id === id ? { ...run, archived } : run,
        )
        return jsonResponse(index.find((run) => run.id === id))
      }
      return jsonResponse({ error: `unexpected ${path}` }, 404)
    }),
  )
}

function renderPage(client = createQueryClient(), entry = '/tasks') {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <ListViewProvider>
          <GlobalTasksRoute />
          <Toaster />
          <LocationProbe />
        </ListViewProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Makes the URL assertable — the filters ARE the URL, so this is the state under test. */
function LocationProbe() {
  const location = useLocation()
  return <span data-testid="search">{location.search}</span>
}

const search = () => screen.getByTestId('search').textContent ?? ''

/** Reads the SHARED Active/Archived context — the one the sidebar and the per-project table use. */
function SharedViewProbe() {
  const [view] = useListView()
  return <span data-testid="shared-view">{view}</span>
}

/** Set by the receipt test: what the index answers as `seenAt` on its NEXT read. */
let seenAt: string | undefined

const unreadMarkers = () => [...document.querySelectorAll('[aria-label="unread"]')]

const rowIds = () =>
  [...document.querySelectorAll('[data-slot="global-task-row"]')].map(
    (row) => row.getAttribute('data-run-id') ?? '',
  )

describe('global tasks page', () => {
  it('lists every project’s tasks and links each into its OWN project', async () => {
    stubFetch()
    renderPage()

    await screen.findByText('Add checkout endpoint')
    expect(rowIds()).toEqual(['a1', 'w1', 'i1'])
    // The whole reason this page cannot use the scope-aware Link: each row leaves for a
    // different project.
    expect(screen.getByRole('link', { name: 'Add checkout endpoint' }).getAttribute('href')).toBe(
      '/p/api/tasks/a1',
    )
    expect(screen.getByRole('link', { name: 'Checkout page' }).getAttribute('href')).toBe(
      '/p/web/tasks/w1',
    )
  })

  it('filters by tag across projects, and toggles back off', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const storefront = screen.getByRole('button', { name: /storefront/ })
    fireEvent.click(storefront)
    // One tag, two repos — which is the entire point of tagging connected repositories.
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1']))
    expect(storefront.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(storefront)
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1', 'i1']))
  })

  it('finds the repos nobody has tagged yet', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    fireEvent.click(screen.getByRole('button', { name: /Untagged/ }))
    await waitFor(() => expect(rowIds()).toEqual(['i1']))
  })

  it('ORs two tag chips rather than intersecting them', async () => {
    stubFetch({
      projects: [
        { ...PROJECTS[0]!, tags: ['storefront'] },
        { ...PROJECTS[1]!, tags: ['frontend'] },
        PROJECTS[2]!,
      ],
    })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    fireEvent.click(screen.getByRole('button', { name: /storefront/ }))
    fireEvent.click(screen.getByRole('button', { name: /frontend/ }))
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1']))
  })

  it('searches across title, project and branch', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const search = screen.getAllByLabelText('Search tasks across projects')[0]!
    fireEvent.change(search, { target: { value: 'web checkout' } })
    await waitFor(() => expect(rowIds()).toEqual(['w1']))

    // Branch has no column here — dropping it gave the width to the task title — but pasting a
    // branch name to find the task that made it still works, exactly as it does in the
    // per-project table whose Branch column is folded by default.
    expect(document.querySelector('[data-slot="global-tasks-table"]')!.textContent).not.toContain(
      'feat/checkout',
    )
    fireEvent.change(search, { target: { value: 'feat/checkout' } })
    await waitFor(() => expect(rowIds()).toEqual(['a1']))
  })

  it('groups by tag, fanning a task out under every tag its project carries', async () => {
    stubFetch({
      projects: [{ ...PROJECTS[0]!, tags: ['backend', 'storefront'] }, PROJECTS[1]!, PROJECTS[2]!],
    })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    fireEvent.click(within(screen.getByRole('group', { name: 'Group tasks by' })).getByText('Tag'))

    await waitFor(() => {
      const keys = [...document.querySelectorAll('[data-slot="task-group"]')].map((group) =>
        group.getAttribute('data-group-key'),
      )
      expect(keys).toEqual(['storefront', 'backend', ' untagged'])
    })
    const storefront = document.querySelector('[data-group-key="storefront"]')!
    expect(
      [...storefront.querySelectorAll('[data-slot="global-task-row"]')].map((row) =>
        row.getAttribute('data-run-id'),
      ),
    ).toEqual(['a1', 'w1'])
  })

  describe('filters live in the URL', () => {
    it('restores a filtered, grouped view from the query string alone', async () => {
      // The refresh case: a reload re-enters the route with only the URL to go on.
      stubFetch()
      renderPage(createQueryClient(), '/tasks?tag=storefront&status=running&group=tag')
      await screen.findByText('Add checkout endpoint')

      expect(rowIds()).toEqual(['a1'])
      expect(
        screen.getByRole('button', { name: /storefront/ }).getAttribute('aria-pressed'),
      ).toBe('true')
      expect(
        within(screen.getByRole('group', { name: 'Group tasks by' }))
          .getByText('Tag')
          .getAttribute('aria-pressed'),
      ).toBe('true')
    })

    it('writes each facet into the URL as it is picked', async () => {
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')
      expect(search()).toBe('')

      fireEvent.click(screen.getByRole('button', { name: /storefront/ }))
      await waitFor(() => expect(search()).toBe('?tag=storefront'))

      fireEvent.click(
        within(screen.getByRole('group', { name: 'Group tasks by' })).getByText('Project'),
      )
      await waitFor(() => expect(search()).toBe('?tag=storefront&group=project'))

      // Releasing the grouping drops the key rather than spelling out a default.
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Group tasks by' })).getByText('Project'),
      )
      await waitFor(() => expect(search()).toBe('?tag=storefront'))
    })

    it('carries the search box into the URL, debounced', async () => {
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')

      const box = screen.getAllByLabelText('Search tasks across projects')[0]!
      fireEvent.change(box, { target: { value: 'checkout' } })
      // Typed immediately, in the URL a beat later — a history write per keystroke is what
      // browsers rate-limit.
      expect((box as HTMLInputElement).value).toBe('checkout')
      await waitFor(() => expect(search()).toBe('?q=checkout'))
      expect(rowIds()).toEqual(['a1', 'w1'])
    })

    it('counts the grouping in the Clear badge, not just the facets', async () => {
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.click(screen.getByRole('button', { name: /storefront/ }))
      await waitFor(() => expect(screen.getByRole('button', { name: /^Clear/ }).textContent).toContain('(1)'))

      fireEvent.click(
        within(screen.getByRole('group', { name: 'Group tasks by' })).getByText('Tag'),
      )
      // One tag plus a grouping is two things applied — the badge said (1) before.
      await waitFor(() => expect(screen.getByRole('button', { name: /^Clear/ }).textContent).toContain('(2)'))
    })

    it('clears the grouping too — Clear is the one way back to a plain list', async () => {
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')

      const groupBy = () => within(screen.getByRole('group', { name: 'Group tasks by' }))
      // Grouping alone, no filters: the button must still be offered.
      fireEvent.click(groupBy().getByText('Project'))
      await waitFor(() => expect(search()).toBe('?group=project'))
      const clear = await screen.findByRole('button', { name: /^Clear/ })

      fireEvent.click(clear)
      await waitFor(() => expect(search()).toBe(''))
      await waitFor(() => {
        const groups = document.querySelectorAll('[data-slot="task-group"]')
        expect(groups).toHaveLength(1)
        expect(groups[0]!.getAttribute('data-group-key')).toBe('all')
      })
    })

    it('empties the URL when the filters are cleared', async () => {
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.click(screen.getByRole('button', { name: /storefront/ }))
      await waitFor(() => expect(search()).toBe('?tag=storefront'))

      fireEvent.click(screen.getByRole('button', { name: /^Clear/ }))
      await waitFor(() => expect(search()).toBe(''))
      expect(rowIds()).toEqual(['a1', 'w1', 'i1'])
    })

    it('adds and removes the archived flag, leaving active as the bare default', async () => {
      stubFetch({ runs: RUNS.map((run) => (run.id === 'i1' ? { ...run, archived: true } : run)) })
      renderPage()
      await screen.findByText('Add checkout endpoint')
      // Active is the default, so a normal link carries no key for it.
      expect(search()).toBe('')

      fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
      await waitFor(() => expect(search()).toBe('?archived=1'))
      await waitFor(() => expect(rowIds()).toEqual(['i1']))

      fireEvent.click(screen.getByRole('button', { name: 'Active' }))
      await waitFor(() => expect(search()).toBe(''))
      await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1']))
    })

    it('restores the archived view from the URL alone', async () => {
      stubFetch({ runs: RUNS.map((run) => (run.id === 'i1' ? { ...run, archived: true } : run)) })
      renderPage(createQueryClient(), '/tasks?archived=1')
      await screen.findByText('Bump the runner')

      expect(rowIds()).toEqual(['i1'])
      expect(screen.getByRole('button', { name: 'Archived' }).getAttribute('aria-pressed')).toBe(
        'true',
      )
    })

    it('keeps the view alongside the filters rather than dropping one for the other', async () => {
      stubFetch()
      renderPage(createQueryClient(), '/tasks?archived=1')
      // The chips come from the registry, so wait for it rather than for the URL, which is
      // already what it will be.
      const storefront = await screen.findByRole('button', { name: /storefront/ })
      expect(search()).toBe('?archived=1')

      // A filter change re-encodes the whole state; the view must survive it, and vice versa.
      fireEvent.click(storefront)
      await waitFor(() => expect(search()).toBe('?tag=storefront&archived=1'))

      fireEvent.click(screen.getByRole('button', { name: 'Active' }))
      await waitFor(() => expect(search()).toBe('?tag=storefront'))
    })

    it('publishes the view to the shared filter context, so other surfaces agree', async () => {
      // The context is what keeps this page, the per-project table and the sidebar quick-list
      // answering one question. Here the URL is the authority and the context follows it.
      stubFetch()
      render(
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={['/tasks?archived=1']}>
            <ListViewProvider>
              <GlobalTasksRoute />
              <SharedViewProbe />
            </ListViewProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      )

      await waitFor(() => expect(screen.getByTestId('shared-view').textContent).toBe('archived'))
    })

    it('keeps the untagged bucket readable in a shared link', async () => {
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.click(screen.getByRole('button', { name: /Untagged/ }))
      await waitFor(() => expect(search()).toBe('?untagged=1'))
      expect(rowIds()).toEqual(['i1'])
    })
  })

  it('releases the grouping when its button is pressed again', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const groupBy = () => within(screen.getByRole('group', { name: 'Group tasks by' }))
    // No "None" button to hunt for — the pressed one is the off switch.
    expect(groupBy().queryByText('None')).toBeNull()

    fireEvent.click(groupBy().getByText('Project'))
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="task-group"]').length).toBeGreaterThan(1),
    )
    expect(groupBy().getByText('Project').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(groupBy().getByText('Project'))
    await waitFor(() => {
      const groups = document.querySelectorAll('[data-slot="task-group"]')
      expect(groups).toHaveLength(1)
      expect(groups[0]!.getAttribute('data-group-key')).toBe('all')
    })
    expect(groupBy().getByText('Project').getAttribute('aria-pressed')).toBe('false')
  })

  it('clears every facet at once', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    fireEvent.click(screen.getByRole('button', { name: /storefront/ }))
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1']))

    fireEvent.click(screen.getByRole('button', { name: /^Clear/ }))
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1', 'i1']))
  })

  it('shows the PR / issue chip each task actually references', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    // `a1` carries several — the plural case has its own test; here, the strongest leads.
    const prs = screen.getAllByRole('link', { name: /pull request for Add checkout endpoint/ })
    expect(prs[0]!.getAttribute('href')).toBe('https://github.com/acme/api/pull/42')
    expect(prs[0]!.textContent).toContain('#42')

    const issue = screen.getByRole('link', { name: /issue for Checkout page/ })
    expect(issue.getAttribute('href')).toBe('https://github.com/acme/web/issues/7')
    expect(issue.textContent).toContain('#7')
  })

  it('shows every reference a task has, not just the strongest', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const row = document.querySelector('[data-slot="global-task-row"][data-run-id="a1"]')!
    // The row itself paints the STRONGEST one — the width belongs to the task title — and the
    // rest are one hover away behind the `+N`.
    expect([...row.querySelectorAll('a[data-slot$="-chip"]')].map((chip) => chip.getAttribute('href'))).toEqual([
      'https://github.com/acme/api/pull/42',
    ])
    expect(row.querySelector('[data-slot="reference-overflow"]')?.textContent).toBe('+2')
  })

  it('collapses a pathological pile of references into a named +N', async () => {
    stubFetch({
      runs: [
        {
          ...RUNS[0]!,
          // Four distinct references — one past what the cell paints.
          pullRequestUrl: 'https://github.com/acme/api/pull/42',
          referencedPullRequestUrl: 'https://github.com/acme/api/pull/40',
          referencedIssueUrl: 'https://github.com/acme/api/issues/12',
          issueNumber: 99,
          markerRefs: { pr: 40, issue: 12 },
        },
      ],
    })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    expect(document.querySelectorAll('a[data-slot$="-chip"]')).toHaveLength(1)
    const overflow = screen.getByRole('button', { name: /Show all 4 references/ })
    expect(overflow.textContent).toBe('+3')

    // Collapsed, never unreachable: opening it lists EVERY reference as a real link.
    fireEvent.click(overflow)
    const list = await screen.findByText('References')
    const chips = [...list.parentElement!.querySelectorAll('[data-slot$="-chip"]')]
    expect(chips.map((chip) => chip.textContent?.trim())).toEqual([
      '#42',
      '#40',
      'Issue #12',
      'Issue #99',
    ])
    expect(chips[2]!.getAttribute('href')).toBe('https://github.com/acme/api/issues/12')
    // Known only by number, but the project's own repo makes it a real link too — every
    // reference in the list is clickable.
    expect(chips[3]!.getAttribute('href')).toBe('https://github.com/acme/api/issues/99')
  })

  it('links a reference known only by number, from the project’s own repo', async () => {
    stubFetch({ runs: [{ ...RUNS[0]!, pullRequestUrl: undefined, referencedPullRequestUrl: undefined, referencedIssueUrl: undefined, markerRefs: undefined, prNumber: 5127 }] })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const chip = document.querySelector('[data-slot="pr-chip"]')!
    expect(chip.tagName).toBe('A')
    expect(chip.getAttribute('href')).toBe('https://github.com/acme/api/pull/5127')
  })

  it('leaves a number-only reference inert when its project has no known repo', async () => {
    // Inert text beats a link that goes somewhere invented.
    stubFetch({
      projects: PROJECTS.map((project) => ({ ...project, repoUrl: undefined })),
      runs: [{ ...RUNS[0]!, pullRequestUrl: undefined, referencedPullRequestUrl: undefined, referencedIssueUrl: undefined, markerRefs: undefined, prNumber: 5127 }],
    })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    expect(document.querySelector('[data-slot="pr-chip"]')!.tagName).toBe('SPAN')
  })

  it('paints chips from the INDEX, without waiting on a ref-status answer', async () => {
    // The statuses ride along with the rows that carry the references, so the chips are coloured
    // in the same paint as the table rather than a round trip later. `refStatus` is deliberately
    // left unset: the lazy route answers "gh CLI not found" here, so a coloured chip can ONLY
    // have come from the index. (The refresh request still goes out — this removes the wait
    // before first paint, not the cadence that keeps a status current.)
    stubFetch({ indexStatuses: { api: { prs: { 42: 'merged' }, issues: {} } } })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    await waitFor(() =>
      expect(document.querySelector('[data-slot="pr-chip"]')?.getAttribute('data-status')).toBe('merged'),
    )
  })

  it('still asks about references the index had nothing warm for', async () => {
    // Cache-only on the server means a cold reference is simply absent — the lazy route stays the
    // thing that actually goes and looks.
    stubFetch({
      indexStatuses: { api: { prs: { 42: 'merged' }, issues: {} } },
      refStatus: { web: { issues: { 7: 'open' } } },
    })
    renderPage()
    await screen.findByText('Checkout page')

    await waitFor(() =>
      expect(
        document.querySelector('[data-run-id="w1"] [data-slot="issue-chip"]')?.getAttribute('data-status'),
      ).toBe('open'),
    )
  })

  it('paints each chip with the state of the thing it points at', async () => {
    // The whole point of the feature: a row's `#42` says whether that PR is merged, red, or
    // waiting on a human — without opening it.
    stubFetch({
      refStatus: {
        api: { prs: { 42: 'merged', 40: 'checks-failing' }, issues: { 12: 'completed' } },
        web: { issues: { 7: 'open' } },
      },
    })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    await waitFor(() => {
      expect(document.querySelector('[data-slot="pr-chip"]')?.getAttribute('data-status')).toBe('merged')
    })
    // The web row's issue belongs to ANOTHER project — its status must come from that project's
    // answer, not from whichever one the page happens to be standing in.
    const webRow = document.querySelector('[data-run-id="w1"]')
    expect(webRow?.querySelector('[data-slot="issue-chip"]')?.getAttribute('data-status')).toBe('open')
  })

  it('asks each project once, for both kinds at a time', async () => {
    stubFetch({ refStatus: { api: { prs: { 42: 'ready' } } } })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    await waitFor(() => {
      expect(sent.filter((request) => request.path.includes('/github/ref-status')).length).toBeGreaterThan(0)
    })
    const asked = sent.filter((request) => request.path.includes('/github/ref-status'))
    // Two projects hold references (api, web); infra's row has none, so it is never asked.
    expect(asked.length).toBe(2)
    const api = asked.find((request) => request.path.includes('/p/api/'))!
    // Sorted, so re-sorting or re-filtering the table hits the same cache entry.
    expect(api.path).toContain('prs=40%2C42')
    expect(api.path).toContain('issues=12')
  })

  it('paints a conflict here exactly as the task’s own page does, and offers the same fix', async () => {
    // The inconsistency this closes: the chip was already the shared component, but the ACTION
    // was the task page's alone — so the same pull request offered a way out on one screen and
    // not on the other. The record the delivery needs is fetched here, per project, and only once
    // the panel is open: this page's index row is deliberately too slim to answer it.
    stubFetch({ refStatus: { api: { prs: { 42: 'ready', 40: 'ready' }, conflicts: [42] } } })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const chip = await waitFor(() => {
      const found = document.querySelector('[data-slot="pr-chip"][data-conflicting="true"]')
      if (!found) throw new Error('the chip has not learned about the conflict yet')
      return found as HTMLElement
    })
    // Its own colour, not the green its `ready` status would have painted.
    expect(chip.className).toContain('text-conflict')

    fireEvent.focus(chip)
    const button = await waitFor(() => screen.getByRole('button', { name: 'Resolve conflicts' }))
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    fireEvent.click(button)

    // Into the RUN'S OWN project — `queryScope()` would have named the boot project here, which
    // is the whole reason this page sends through the project-explicit seam.
    await waitFor(() => {
      const posted = sent.find((request) => request.method === 'POST' && request.path.includes('/messages'))
      expect(posted?.path).toBe('/api/v1/p/api/runs/a1/messages')
      expect(posted?.body).toMatchObject({ text: resolveConflictsPrompt(42) })
    })
  })

  it('leaves every chip neutral when the forge cannot be reached', async () => {
    // "We could not ask" must never be paintable as "nothing is wrong".
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    expect(document.querySelector('[data-slot="pr-chip"]')?.getAttribute('data-status')).toBeNull()
  })

  describe('the +N reference list', () => {
    const manyRefs = () => [
      {
        ...RUNS[0]!,
        pullRequestUrl: 'https://github.com/acme/api/pull/42',
        referencedPullRequestUrl: 'https://github.com/acme/api/pull/40',
        referencedIssueUrl: 'https://github.com/acme/api/issues/12',
        markerRefs: { pr: 40, issue: 12 },
      },
    ]
    const overflow = () => screen.getByRole('button', { name: /Show all 3 references/ })
    const listed = () =>
      [...document.querySelectorAll('[data-slot="reference-overflow-list"] [data-slot$="-chip"]')]

    it('opens on hover, and stays open while the pointer travels into it', async () => {
      stubFetch({ runs: manyRefs() })
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.pointerEnter(overflow(), { pointerType: 'mouse' })
      await waitFor(() => expect(listed()).toHaveLength(3))

      // Leaving the trigger starts a close; entering the list cancels it, which is the only way
      // the links are reachable at all.
      fireEvent.pointerLeave(overflow(), { pointerType: 'mouse' })
      const list = document.querySelector('[data-slot="reference-overflow-list"]')!
      fireEvent.pointerEnter(list, { pointerType: 'mouse' })
      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(listed()).toHaveLength(3)
    })

    it('closes once the pointer leaves both', async () => {
      stubFetch({ runs: manyRefs() })
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.pointerEnter(overflow(), { pointerType: 'mouse' })
      await waitFor(() => expect(listed()).toHaveLength(3))

      fireEvent.pointerLeave(overflow(), { pointerType: 'mouse' })
      await waitFor(() => expect(listed()).toHaveLength(0))
    })

    it('ignores the hover a TAP fires, so touch gets one clean open from the click', async () => {
      // A tap fires `pointerenter` before `click`. Without the guard the list would open under
      // the finger and then be toggled shut again by the click that follows.
      stubFetch({ runs: manyRefs() })
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.pointerEnter(overflow(), { pointerType: 'touch' })
      expect(listed()).toHaveLength(0)

      fireEvent.click(overflow())
      await waitFor(() => expect(listed()).toHaveLength(3))
    })

    it('opens on click for the keyboard too', async () => {
      stubFetch({ runs: manyRefs() })
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.click(overflow())
      await waitFor(() => expect(listed()).toHaveLength(3))
    })
  })

  describe('cost, CPU and memory', () => {
    it('shows a running task’s live sample and its cost', async () => {
      stubFetch({
        runs: [
          {
            ...RUNS[0]!,
            status: 'running',
            costUsd: 0.31,
            usage: { cpuPct: 84, rssBytes: 612 * 1024 * 1024, procCount: 3 },
          },
        ],
      })
      renderPage()
      await screen.findByText('Add checkout endpoint')

      expect(screen.getByText('$0.31')).toBeTruthy()
      const cpu = document.querySelector('[data-usage="cpu"]')!
      expect(cpu.textContent).toBe('84%')
      expect(cpu.getAttribute('data-usage-kind')).toBe('live')
      expect(document.querySelector('[data-usage="mem"]')!.textContent).toBe('612 MB')
    })

    it('falls back to the persisted peak once the run is finished', async () => {
      // The live sample stops existing with the process tree; without the peaks a finished row
      // could say nothing at all about what it took to run.
      stubFetch({
        runs: [{ ...RUNS[2]!, peakRssBytes: 900 * 1024 * 1024, peakProcCount: 4 }],
      })
      renderPage()
      await screen.findByText('Bump the runner')

      const mem = document.querySelector('[data-usage="mem"]')!
      expect(mem.textContent).toBe('peak 900 MB')
      expect(mem.getAttribute('data-usage-kind')).toBe('peak')
      // CPU has no persisted peak, so it says nothing rather than inventing one.
      expect(document.querySelector('[data-usage="cpu"]')!.getAttribute('data-usage-kind')).toBe(
        'none',
      )
    })

    it('never paints a finished run’s stale sample as live', async () => {
      stubFetch({
        runs: [
          {
            ...RUNS[2]!,
            status: 'done',
            usage: { cpuPct: 99, rssBytes: 1024, procCount: 1 },
          },
        ],
      })
      renderPage()
      await screen.findByText('Bump the runner')

      expect(document.querySelector('[data-usage="cpu"]')!.getAttribute('data-usage-kind')).toBe(
        'none',
      )
    })

    it('drops the Cost column when the host hides cost metrics', async () => {
      stubFetch({ costMetrics: false, runs: [{ ...RUNS[0]!, costUsd: 0.31 }] })
      renderPage()
      await screen.findByText('Add checkout endpoint')

      expect(screen.queryByText('Cost')).toBeNull()
      expect(screen.queryByText('$0.31')).toBeNull()
    })
  })

  describe('read / unread', () => {
    // A finished, unopened task — the state the marker exists for.
    const unreadRun = () => [
      { ...RUNS[2]!, status: 'done' as const, finishedAt: '2026-07-14T09:00:00Z' },
    ]

    it('marks a task read in its OWN project, clearing the unread marker', async () => {
      stubFetch({ runs: unreadRun() })
      renderPage()
      await screen.findByText('Bump the runner')
      expect(document.querySelectorAll('[aria-label="unread"]')).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: /Mark Bump the runner read/ }))

      await waitFor(() =>
        expect(sent.find((request) => request.method === 'POST')?.path).toBe(
          '/api/v1/p/infra/runs/i1/read',
        ),
      )
      await waitFor(() => expect(document.querySelectorAll('[aria-label="unread"]')).toHaveLength(0))
    })

    it('takes the receipt back again', async () => {
      stubFetch({
        runs: [{ ...unreadRun()[0]!, seenAt: '2026-07-14T09:00:01Z' }],
      })
      renderPage()
      await screen.findByText('Bump the runner')
      expect(document.querySelectorAll('[aria-label="unread"]')).toHaveLength(0)

      fireEvent.click(screen.getByRole('button', { name: /Mark Bump the runner unread/ }))

      await waitFor(() =>
        expect(sent.find((request) => request.method === 'POST')?.path).toBe(
          '/api/v1/p/infra/runs/i1/unread',
        ),
      )
      await waitFor(() => expect(document.querySelectorAll('[aria-label="unread"]')).toHaveLength(1))
    })

    it('is absent where there is no read state to change', async () => {
      // `a1` is still running — nothing to have read yet, and a button that did nothing would
      // say otherwise.
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')

      const running = document.querySelector('[data-slot="global-task-row"][data-run-id="a1"]')!
      expect(running.querySelector('[data-action^="mark-"]')).toBeNull()
    })
  })

  it('archives a finished task in its OWN project and drops it from Active', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Bump the runner')

    // `i1` is done; `a1` is running, so it has no archive button at all.
    const row = document.querySelector('[data-slot="global-task-row"][data-run-id="a1"]')!
    expect(row.querySelector('[data-action="archive-run"]')).toBeNull()

    fireEvent.click(
      document
        .querySelector('[data-slot="global-task-row"][data-run-id="i1"]')!
        .querySelector<HTMLButtonElement>('[data-action="archive-run"]')!,
    )

    // The request names the run's own project, not the boot one.
    await waitFor(() =>
      expect(sent.find((request) => request.method === 'POST')).toEqual({
        method: 'POST',
        path: '/api/v1/p/infra/runs/i1/archive',
        body: { archived: true },
      }),
    )
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1']))
  })

  it('restores an archived task from the Archived tab', async () => {
    stubFetch({ runs: RUNS.map((run) => (run.id === 'i1' ? { ...run, archived: true } : run)) })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
    await waitFor(() => expect(rowIds()).toEqual(['i1']))

    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-action="unarchive-run"]')!)
    await waitFor(() =>
      expect(sent.find((request) => request.method === 'POST')?.body).toEqual({ archived: false }),
    )
    await waitFor(() => expect(rowIds()).toEqual([]))
  })

  it('puts a refused archive back and shows the server’s reason', async () => {
    stubFetch({ archiveStatus: 409 })
    renderPage()
    await screen.findByText('Bump the runner')

    fireEvent.click(
      document
        .querySelector('[data-slot="global-task-row"][data-run-id="i1"]')!
        .querySelector<HTMLButtonElement>('[data-action="archive-run"]')!,
    )

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('still running'))
    // Rolled back: the row is still in the Active list.
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1', 'i1']))
  })

  it('picks up a read receipt made elsewhere, without a page refresh', async () => {
    // The reported bug: open an unread task from here, come back, and it was still bold until a
    // refresh. `useMarkRunSeen` invalidates the workspace index (queries.test.tsx pins that);
    // this is the other half — an invalidated index really is re-read when the page remounts.
    const unread: RunIndexEntry = {
      ...RUNS[2]!,
      status: 'done',
      finishedAt: '2026-07-14T09:00:00Z',
    }
    stubFetch({ runs: [unread] })
    const client = createQueryClient()
    const { unmount } = renderPage(client)
    await waitFor(() => expect(unreadMarkers()).toHaveLength(1))

    // The thread stamps the receipt server-side and invalidates the index.
    seenAt = '2026-07-14T09:00:01Z'
    await act(async () => {
      await client.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
    })
    unmount()

    renderPage(client)
    await waitFor(() => expect(unreadMarkers()).toHaveLength(0))
  })

  it('offers no project filter — a project name is a link to its own page', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    expect(document.querySelector('[data-slot="facet-project"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'API' }).getAttribute('href')).toBe('/p/api/')

    // Grouping by project turns each heading into the same door.
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Group tasks by' })).getByText('Project'),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="group-project-link"]')?.getAttribute('href'),
      ).toBe('/p/api/'),
    )
  })

  it('says which projects the index had to cap instead of showing a short list silently', async () => {
    stubFetch({ truncated: ['api'] })
    renderPage()

    const notice = await screen.findByText(/Showing the newest 200 tasks per project/)
    // Named by its registry name, not its slug.
    expect(notice.textContent).toContain('API')
  })

  it('points at Settings when the workspace has no tags at all', async () => {
    stubFetch({ projects: PROJECTS.map((project) => ({ ...project, tags: undefined })) })
    renderPage()

    const hint = await screen.findByText(/Tag connected repositories in/)
    // …and it is a real door, not a sentence naming a place the reader has to go find.
    expect(
      hint.querySelector('a[href="/settings/global/projects"]')?.textContent,
    ).toBe('Settings → Projects')
  })

  it('renders the server’s error rather than an empty table', async () => {
    stubFetch({ indexStatus: 500 })
    renderPage()

    // The query retries a 5xx once with a backoff, so this settles later than the happy paths.
    expect(
      await screen.findByText('Tasks across projects did not load', {}, { timeout: 5000 }),
    ).toBeTruthy()
  })
})
