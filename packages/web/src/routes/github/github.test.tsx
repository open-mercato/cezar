import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  GithubComment,
  GithubCommentsData,
  GithubData,
  GithubItem,
  HealthResponse,
  ProviderStatusResponse,
  Runner,
  Skill,
  WorkflowsResponse,
} from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { githubTaskRef } from '@/lib/github-task'

import { GithubIndexRoute, GithubRoute, groupCommitRuns, type ThreadRow } from './github'
import { readFollowupPrompt, readFollowupSelection, writeFollowupSelection } from './hand-to-agent-draft'

beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  // Radix popovers position with floating-ui, which needs a ResizeObserver; jsdom has none.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  // The #408 follow-up persistence (remembered selection + per-item draft) is localStorage-
  // backed and jsdom's localStorage survives across tests in this file — start every test clean.
  localStorage.clear()
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const ISSUE_142: GithubItem = {
  kind: 'issue',
  number: 142,
  title: 'Login form drops session on refresh',
  author: 'ada',
  createdAt: '2026-07-09T08:00:00.000Z',
  labels: ['bug', 'auth'],
  body: 'Repro: log in, hit reload — you land back on /login.',
  url: 'https://github.com/acme/demo/issues/142',
  comments: 3,
}

const ISSUE_139: GithubItem = {
  kind: 'issue',
  number: 139,
  title: 'Add --json flag to the CLI',
  author: 'lin',
  createdAt: '2026-07-10T08:00:00.000Z',
  labels: [],
  body: '',
  url: 'https://github.com/acme/demo/issues/139',
  comments: 0,
}

const PR_137: GithubItem = {
  kind: 'pr',
  number: 137,
  title: 'Stream tokens over SSE',
  author: 'grace',
  createdAt: '2026-07-11T08:00:00.000Z',
  labels: ['perf'],
  body: 'Replaces polling with a single SSE stream.',
  url: 'https://github.com/acme/demo/pull/137',
  comments: 1,
  additions: 120,
  deletions: 30,
  checks: 'failing',
}

const GITHUB: GithubData = {
  available: true,
  repo: 'acme/demo',
  syncedAt: '2026-07-15T08:00:00.000Z',
  issues: [ISSUE_142, ISSUE_139],
  prs: [PR_137],
}

const COMMENT_TEXT: GithubComment = {
  id: 1,
  author: 'maya',
  avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
  createdAt: '2026-07-12T08:00:00.000Z',
  body: 'Confirmed on my end too — nice catch.',
  kind: 'comment',
  url: 'https://github.com/acme/demo/issues/142#issuecomment-1',
}

const COMMENT_IMAGE: GithubComment = {
  id: 2,
  author: 'noAvatar',
  createdAt: '2026-07-12T09:00:00.000Z',
  body: 'Screenshot:\n\n![shot](https://example.com/shot.png)',
  kind: 'comment',
  url: 'https://github.com/acme/demo/issues/142#issuecomment-2',
}

const REVIEW_CHANGES: GithubComment = {
  id: 3,
  author: 'rev',
  avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
  createdAt: '2026-07-12T10:00:00.000Z',
  body: 'Please add a test.',
  kind: 'review',
  reviewState: 'changes_requested',
  url: 'https://github.com/acme/demo/pull/137#pullrequestreview-3',
}

const THREAD: GithubCommentsData = { available: true, comments: [COMMENT_TEXT, COMMENT_IMAGE] }

const WORKFLOWS: WorkflowsResponse = {
  workflows: [
    { name: 'quick-task', description: 'one step', steps: [], source: 'built-in' },
    { name: 'ship-it', description: 'plan, build, review', steps: [], source: 'file' },
  ],
  issues: [],
}

// Server order is global-first ON PURPOSE: the dropdown must reorder project-first (#377).
const SKILLS: Skill[] = [
  { name: 'g-review', description: 'global review', body: '', path: '/g/g-review.md', source: 'global' },
  { name: 'om-fix', description: 'project fixer', body: '', path: '/p/om-fix.md', source: 'ai' },
  { name: 'team-x', description: 'team skill', body: '', path: '/t/team-x.md', source: 'team' },
]

const PROVIDERS_CONNECTED: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'not-installed', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

const PROVIDERS_MULTI: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'disconnected', enabled: true },
  ],
}

const PROVIDERS_NONE: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'disconnected', enabled: true },
    { provider: 'codex', status: 'unknown', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (repo-git.test.tsx): records requests, serves the fixtures,
 *  and lets a test override specific `METHOD path` keys. */
function stubFetch(
  overrides: Record<string, () => Response | Promise<Response>> = {},
): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      // Any comment-thread request defaults to the two-comment THREAD fixture; a test overrides a
      // specific `GET /api/v1/github/comments/<kind>/<n>` key to serve a different thread.
      if (method === 'GET' && path.startsWith('/api/v1/github/comments/')) return jsonResponse(THREAD)
      if (method === 'GET' && path.startsWith('/api/v1/github/prs/') && path.includes('/changes')) return jsonResponse({
        available: true, number: 137, headSha: '0123456789abcdef0123456789abcdef01234567',
        additions: 3, deletions: 1, truncated: true, reason: 'One patch was omitted.',
        files: [
          { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
          { path: 'logo.png', status: 'modified', additions: 0, deletions: 0, patchUnavailableReason: 'binary' },
        ],
      })
      // Lazy PR checks (#664) default to an empty map — a test overrides to hydrate specific glyphs.
      if (method === 'GET' && path.startsWith('/api/v1/github/checks')) {
        return jsonResponse({ available: true, checks: {} })
      }
      // The GitHub list is one fast fetch now (#664): `/api/v1/github` with an optional `?limit=…`
      // and/or `?refresh=1`. Sub-resources (`/api/v1/github/comments`, `/prs`, `/checks`) never match
      // `=== '/api/v1/github'` or `startsWith('/api/v1/github?')`, so this stays scoped to the list.
      if (method === 'GET' && (path === '/api/v1/github' || path.startsWith('/api/v1/github?'))) {
        return jsonResponse(GITHUB)
      }
      if (method === 'GET' && path === '/api/v1/workflows') return jsonResponse(WORKFLOWS)
      if (method === 'GET' && path === '/api/v1/skills') return jsonResponse(SKILLS)
      if (method === 'GET' && path === '/api/v1/providers/status') {
        return jsonResponse(PROVIDERS_CONNECTED)
      }
      if (method === 'GET' && path === '/api/v1/models?runner=codex') return jsonResponse({ runner: 'codex', models: [{ id: 'gpt-future', label: 'gpt-future', description: 'Newest' }], source: 'live', stale: false })
      if (method === 'POST' && path === '/api/v1/runs') {
        return jsonResponse({
          id: 'run-1',
          title: 'queued',
          workflow: 'quick-task',
          task: 't',
          status: 'queued',
          createdAt: '2026-07-15T08:00:00.000Z',
          tokensUsed: 0,
          archived: false,
          steps: [],
        })
      }
      return jsonResponse({})
    }),
  )
  return sent
}

/** Cold-load the tab at a URL, with the same route map routes.tsx registers — `/github` goes
 *  through `GithubIndexRoute` (#417) exactly like production, so the remembered-tab redirect
 *  is exercised the same way a real navigation would hit it. */
function renderAt(entry: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/github" element={<GithubIndexRoute />} />
          <Route path="/github/prs" element={<GithubRoute view="prs" />} />
          <Route path="/github/issues/:n" element={<GithubRoute view="issues" />} />
          <Route path="/github/prs/:n" element={<GithubRoute view="prs" />} />
          <Route path="/github/prs/:n/changes" element={<GithubRoute view="prs" changes />} />
          <Route path="/p/:projectId/github" element={<GithubIndexRoute />} />
          <Route path="/p/:projectId/github/prs" element={<GithubRoute view="prs" />} />
          <Route path="/p/:projectId/github/issues/:n" element={<GithubRoute view="issues" />} />
          <Route path="/p/:projectId/github/prs/:n" element={<GithubRoute view="prs" />} />
          <Route path="/p/:projectId/github/prs/:n/changes" element={<GithubRoute view="prs" changes />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="gh-row"]')]
const detail = () => document.querySelector('[data-slot="gh-detail-inner"]')
const promptField = () =>
  document.querySelector<HTMLTextAreaElement>('[data-slot="gh-custom-prompt"]')!
const promptValue = () => promptField().value

it('/github/prs/:n/changes renders PR-only file review navigation and completeness', async () => {
  stubFetch()
  renderAt('/github/prs/137/changes')
  expect(await screen.findByText('2 changed files')).not.toBeNull()
  expect(screen.getByRole('navigation', { name: 'Pull request detail' }).textContent).toContain('ConversationChanges')
  expect(screen.getByRole('status').textContent).toContain('One patch was omitted.')
  expect(screen.getByLabelText('Next file').hasAttribute('disabled')).toBe(false)
})

/** What the composer PRE-FILLS the box with for issue 142 (#524): the item's reference, and
 *  nothing else — no quoted body. `githubTaskRef`'s own byte-for-byte shape is pinned in
 *  `lib/github-task.test.ts`; here it is the baseline every box assertion measures against. */
const BASE = githubTaskRef(ISSUE_142)
/** The box with `extra` stacked below the pre-filled reference, `insertTemplate`'s separator. */
const baseWith = (extra: string) => `${BASE}\n\n${extra}`

// ---- lists + detail ---------------------------------------------------------------------------

describe('the GitHub tab lists', () => {
  it('/github renders the header, both count tabs, the issue rows, and the first issue’s detail', async () => {
    stubFetch()
    renderAt('/github')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-header"]')).not.toBeNull())
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('GitHub')
    expect(document.querySelector('[data-slot="gh-repo"]')?.textContent).toBe('acme/demo')

    const tabs = [...document.querySelectorAll('[data-slot="gh-tabs"] a')].map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
      current: a.getAttribute('aria-current'),
    }))
    expect(tabs).toEqual([
      { text: 'Issues · 2', href: '/github', current: 'page' },
      { text: 'Pull requests · 1', href: '/github/prs', current: null },
    ])

    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows().map((row) => row.dataset.number)).toEqual(['142', '139'])
    // Rows are deep links, not click handlers.
    expect(rows()[0]?.getAttribute('href')).toBe('/github/issues/142')

    // No URL selection → the first item's detail renders (legacy parity), marked current.
    expect(rows()[0]?.getAttribute('aria-current')).toBe('page')
    await waitFor(() => expect(detail()?.textContent).toContain('Login form drops session'))
  })

  it('/github/prs lists pull requests', async () => {
    stubFetch()
    renderAt('/github/prs')

    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]?.getAttribute('href')).toBe('/github/prs/137')
  })

  it('a PR row hydrates its checks glyph lazily by outcome (#664); an issue row shows none', async () => {
    // The list tier no longer ships `statusCheckRollup` — rows come back `checks: null` and the
    // glyph is filled in from GET /api/v1/github/checks for the on-screen window (#664).
    const p201: GithubItem = { ...PR_137, number: 201, url: 'u201', checks: null }
    const p202: GithubItem = { ...PR_137, number: 202, url: 'u202', checks: null }
    const p203: GithubItem = { ...PR_137, number: 203, url: 'u203', checks: null }
    const pr137: GithubItem = { ...PR_137, checks: null }
    stubFetch({
      'GET /api/v1/github?limit=1000': () => jsonResponse({ ...GITHUB, prs: [pr137, p201, p202, p203] }),
      'GET /api/v1/github/checks?prs=137%2C201%2C202%2C203': () =>
        jsonResponse({ available: true, checks: { 137: 'failing', 201: 'passing', 202: 'pending', 203: null } }),
    })
    renderAt('/github/prs')

    await waitFor(() => expect(rows()).toHaveLength(4))
    const glyph = (number: string) =>
      document.querySelector(`[data-slot="gh-row"][data-number="${number}"] [data-slot="gh-row-checks"]`)

    // The glyph appears a beat later, once the lazy checks query resolves.
    await waitFor(() => expect(glyph('137')?.getAttribute('data-checks')).toBe('failing'))
    expect(glyph('137')?.textContent).toBe('✗')
    expect(glyph('201')?.getAttribute('data-checks')).toBe('passing')
    expect(glyph('201')?.textContent).toBe('✓')
    expect(glyph('202')?.getAttribute('data-checks')).toBe('pending')
    expect(glyph('202')?.textContent).toBe('○')
    expect(glyph('203')).toBeNull() // null from the checks map → no CI → no glyph

    // Issues never carry `checks`, and the checks query is skipped on the Issues view.
    cleanup()
    stubFetch()
    renderAt('/github')
    await waitFor(() => expect(rows().length).toBeGreaterThan(0))
    expect(document.querySelector('[data-slot="gh-row-checks"]')).toBeNull()
  })

  it('warms the thread on row hover so opening it is instant (#664)', async () => {
    const threadRequests: string[] = []
    stubFetch()
    const origFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.startsWith('/api/v1/github/comments/')) threadRequests.push(path)
      return (origFetch as typeof fetch)(input, init as RequestInit)
    })

    renderAt('/github') // issues view; the first issue's thread loads for the detail pane
    await waitFor(() => expect(rows().length).toBeGreaterThan(0))
    await waitFor(() => expect(threadRequests.length).toBeGreaterThan(0))
    expect(threadRequests.some((p) => p === '/api/v1/github/comments/issue/139')).toBe(false)

    // Hovering a different row prefetches ITS thread before any click.
    fireEvent.mouseEnter(document.querySelector<HTMLElement>('[data-slot="gh-row"][data-number="139"]')!)
    await waitFor(() =>
      expect(threadRequests.some((p) => p === '/api/v1/github/comments/issue/139')).toBe(true),
    )
  })

  it('shows a comment-count badge only on rows with comments (#499)', async () => {
    stubFetch()
    renderAt('/github')

    await waitFor(() => expect(rows()).toHaveLength(2))
    const badge = (number: string) =>
      document.querySelector(`[data-slot="gh-row"][data-number="${number}"] [data-slot="gh-comment-count"]`)

    // #142 has 3 comments → a labelled badge; #139 has 0 → none, so quiet rows look untouched.
    expect(badge('142')?.getAttribute('data-count')).toBe('3')
    expect(badge('142')?.getAttribute('aria-label')).toBe('3 comments')
    expect(badge('142')?.textContent).toContain('3')
    expect(badge('139')).toBeNull()
  })

  it('shows the exact open count from the single fast load — no 30+ guesswork (#664)', async () => {
    // The two-shot is gone: one fast fetch (limit 1000, no rollup) returns the whole open set, so
    // the tab reports the real count instead of the old fast-batch "30+" placeholder.
    const many: GithubData = {
      ...GITHUB,
      issues: Array.from({ length: 45 }, (_, i) => ({ ...ISSUE_142, number: i + 1, url: `u${i}` })),
    }
    stubFetch({
      'GET /api/v1/github?limit=1000': () => jsonResponse(many),
    })
    renderAt('/github')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-tabs"]')).not.toBeNull())
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-tabs"] a')?.textContent).toBe('Issues · 45'),
    )
  })

  it('a row deep link selects that item and renders its detail', async () => {
    stubFetch()
    renderAt('/github/issues/139')

    await waitFor(() => expect(detail()?.textContent).toContain('Add --json flag'))
    expect(document.querySelector('[data-slot="gh-row"][data-number="139"]')?.getAttribute('aria-current')).toBe('page')
    // A blank body renders the honest placeholder, not an empty markdown shell.
    expect(document.querySelector('[data-slot="gh-body"]')?.textContent).toContain('(no description)')
  })

  it('an unknown number renders the honest not-in-list state, not a crash', async () => {
    stubFetch()
    renderAt('/github/issues/9999')

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Not in the open list' })).toBeTruthy(),
    )
  })

  it('dragging a row carries the hand-to-agent prompt as text/plain', async () => {
    stubFetch()
    renderAt('/github')
    await waitFor(() => expect(rows()).toHaveLength(2))

    const setData = vi.fn()
    fireEvent.dragStart(rows()[0]!, { dataTransfer: { setData, effectAllowed: 'none' } })
    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      expect.stringContaining('Fix GitHub issue #142: Login form drops session on refresh'),
    )
    expect(setData.mock.calls[0]?.[1]).toContain(ISSUE_142.url)
  })
})

describe('remembering the last-selected tab (#417)', () => {
  it('clicking Pull requests persists the choice via PUT /api/v1/ui-state', async () => {
    const sent = stubFetch()
    renderAt('/github')
    await waitFor(() => expect(rows()).toHaveLength(2))

    fireEvent.click(screen.getByRole('link', { name: /Pull requests/ }))

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')).toBe(
        true,
      ),
    )
    const put = sent.find((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')
    expect(put?.body).toEqual({ githubView: 'prs' })
  })

  it('opening /github restores "prs" when that was the last-selected tab', async () => {
    stubFetch({ 'GET /api/v1/ui-state': () => jsonResponse({ githubView: 'prs' }) })
    renderAt('/github')

    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]?.getAttribute('href')).toBe('/github/prs/137')
  })

  it('opening /github falls back to Issues when nothing was ever remembered', async () => {
    stubFetch({ 'GET /api/v1/ui-state': () => jsonResponse({}) })
    renderAt('/github')

    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows()[0]?.getAttribute('href')).toBe('/github/issues/142')
  })

  it('clicking Issues while "prs" is remembered switches to Issues instead of bouncing back', async () => {
    // The regression this guards: without eagerly patching the query cache on click, the
    // index route would still read the stale "prs" remembered choice and redirect the click
    // straight back to /github/prs, making the Issues tab unclickable.
    stubFetch({ 'GET /api/v1/ui-state': () => jsonResponse({ githubView: 'prs' }) })
    renderAt('/github/prs')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.click(screen.getByRole('link', { name: /^Issues/ }))

    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows().map((row) => row.dataset.number)).toEqual(['142', '139'])
  })
})

describe('the GitHub detail pane', () => {
  it('a PR renders the meta line, ± stat, label chips and the checks badge', async () => {
    stubFetch()
    renderAt('/github/prs/137')

    await waitFor(() => expect(detail()).not.toBeNull())
    const meta = document.querySelector('[data-slot="gh-meta"]')?.textContent ?? ''
    expect(meta).toContain('#137')
    expect(meta).toContain('pull request')
    expect(meta).toContain('opened by grace')
    // The comment count renders as an icon+count badge (#499), labelled for screen readers.
    const detailCount = document.querySelector('[data-slot="gh-meta"] [data-slot="gh-comment-count"]')
    expect(detailCount?.getAttribute('data-count')).toBe('1')
    expect(detailCount?.getAttribute('aria-label')).toBe('1 comment')
    expect(document.querySelector('[data-slot="gh-diffstat"]')?.textContent).toBe('+120 −30')
    expect(document.querySelector('[data-slot="gh-open-link"]')?.getAttribute('href')).toBe(PR_137.url)

    expect(document.querySelector('[data-slot="gh-label"]')?.textContent).toBe('perf')
    const checks = document.querySelector('[data-slot="gh-checks"]')
    expect(checks?.getAttribute('data-checks')).toBe('failing')
    expect(checks?.textContent).toContain('checks failing')
  })

  it('the checks badge links to the PR checks tab on GitHub, open in a new tab (#415)', async () => {
    stubFetch()
    renderAt('/github/prs/137')

    await waitFor(() => expect(detail()).not.toBeNull())
    const checks = document.querySelector('[data-slot="gh-checks"]')
    expect(checks?.tagName).toBe('A')
    expect(checks?.getAttribute('href')).toBe(`${PR_137.url}/checks`)
    expect(checks?.getAttribute('target')).toBe('_blank')
    expect(checks?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders the issue body through the markdown pipeline', async () => {
    stubFetch()
    renderAt('/github/issues/142')

    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-body"]')?.textContent).toContain(
        'Repro: log in, hit reload',
      ),
    )
  })

  it('shows authoritative merge state and requires confirmation before mutation', async () => {
    const sent = stubFetch({
      'GET /api/v1/github/prs/137/merge-state': () => jsonResponse({
        available: true,
        mergeState: {
          number: 137,
          title: PR_137.title,
          url: PR_137.url,
          state: 'open',
          isDraft: false,
          headRef: 'feat/sse',
          baseRef: 'main',
          headSha: '0123456789abcdef0123456789abcdef01234567',
          mergeable: 'mergeable',
          reviewDecision: 'approved',
          checks: [{ name: 'test', state: 'passing', required: true, url: 'https://example.com/check' }],
          methods: ['squash', 'rebase'],
          defaultMethod: 'squash',
          eligibility: 'ready',
          blockers: [],
          canMerge: true,
          canOverride: false,
        },
      }),
      'GET /api/v1/github/prs/137/merge-state?refresh=1': () => jsonResponse({
        available: true,
        mergeState: {
          number: 137,
          title: PR_137.title,
          url: PR_137.url,
          state: 'open',
          isDraft: false,
          headRef: 'feat/sse',
          baseRef: 'main',
          headSha: '0123456789abcdef0123456789abcdef01234567',
          mergeable: 'mergeable',
          reviewDecision: 'approved',
          checks: [],
          methods: ['squash'],
          defaultMethod: 'squash',
          eligibility: 'ready',
          blockers: [],
          canMerge: true,
          canOverride: false,
        },
      }),
      'POST /api/v1/github/prs/137/merge': () => jsonResponse({
        merged: true,
        number: 137,
        url: PR_137.url,
        method: 'squash',
      }),
    })
    renderAt('/github/prs/137')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-merge-box"]')?.textContent).toContain('Ready to merge'))
    expect(document.querySelectorAll('[data-slot="gh-merge-status-passing"]')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(sent.some((request) => request.path.endsWith('merge-state?refresh=1'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Squash and merge' }))
    expect(sent.some((request) => request.method === 'POST')).toBe(false)
    expect(await screen.findByText(/This will merge/)).toBeTruthy()
    fireEvent.click(within(document.querySelector('[data-slot="gh-merge-confirm"]')!).getByRole('button', { name: 'Squash and merge' }))
    await waitFor(() => expect(sent.find((request) => request.method === 'POST')?.body).toEqual({
      method: 'squash',
      expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
    }))
  })

  it('allows an explicit rules override while warning that GitHub still authorizes it', async () => {
    const sent = stubFetch({
      'GET /api/v1/github/prs/137/merge-state': () => jsonResponse({
        available: true,
        mergeState: {
          number: 137,
          title: PR_137.title,
          url: PR_137.url,
          state: 'open',
          isDraft: false,
          headRef: 'feat/sse',
          baseRef: 'main',
          headSha: '0123456789abcdef0123456789abcdef01234567',
          mergeable: 'mergeable',
          reviewDecision: 'review-required',
          checks: [{ name: 'test', state: 'pending', required: true }],
          methods: ['squash'],
          defaultMethod: 'squash',
          eligibility: 'blocked',
          blockers: [{ code: 'reviews', message: 'A required review is missing.' }],
          canMerge: false,
          canOverride: true,
        },
      }),
      'POST /api/v1/github/prs/137/merge': () => jsonResponse({
        merged: true,
        number: 137,
        url: PR_137.url,
        method: 'squash',
      }),
    })
    renderAt('/github/prs/137')

    const override = await screen.findByRole('checkbox', { name: /Merge without waiting for requirements/ })
    expect(screen.getByRole('button', { name: 'Squash and merge' }).hasAttribute('disabled')).toBe(true)
    expect(document.querySelectorAll('[data-slot="gh-merge-status-failing"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-slot="gh-merge-status-pending"]')).toHaveLength(1)
    fireEvent.click(override)
    fireEvent.click(screen.getByRole('button', { name: 'Squash and merge' }))
    expect(await screen.findByText(/asking GitHub to bypass unmet repository requirements/)).toBeTruthy()
    fireEvent.click(within(document.querySelector('[data-slot="gh-merge-confirm"]')!).getByRole('button', { name: 'Squash and merge' }))
    await waitFor(() => expect(sent.find((request) => request.method === 'POST')?.body).toEqual({
      method: 'squash',
      expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      overrideRules: true,
    }))
  })
})

// ---- comment thread (#499) --------------------------------------------------------------------

describe('the comment thread', () => {
  const thread = (kind: 'issue' | 'pr', n: number, data: GithubCommentsData) => ({
    [`GET /api/v1/github/comments/${kind}/${n}`]: () => jsonResponse(data),
  })
  const threadSection = () => document.querySelector('[data-slot="gh-thread"]')
  const entries = () => [...document.querySelectorAll<HTMLElement>('[data-slot="gh-thread-entry"]')]

  it('renders an "Activity · N comments" section with each body through the markdown pipeline', async () => {
    stubFetch(thread('issue', 142, { available: true, comments: [COMMENT_TEXT, COMMENT_IMAGE] }))
    renderAt('/github/issues/142')

    await waitFor(() => expect(threadSection()).not.toBeNull())
    // Retitled by #525: heading a twenty-row list `Comments · 2` would be incoherent once events
    // render, so the section is "Activity" and the comment count becomes a secondary.
    expect(document.querySelector('[data-slot="gh-thread-header"]')?.textContent).toBe(
      'Activity · 2 comments',
    )
    expect(entries()).toHaveLength(2)
    expect(entries()[0]?.textContent).toContain('maya')
    expect(entries()[0]?.querySelector('[data-slot="gh-thread-body"]')?.textContent).toContain(
      'Confirmed on my end too',
    )
  })

  it('renders an image comment as an <img> through the shared Markdown component', async () => {
    stubFetch(thread('issue', 142, { available: true, comments: [COMMENT_IMAGE] }))
    renderAt('/github/issues/142')

    await waitFor(() => expect(threadSection()).not.toBeNull())
    const img = document.querySelector<HTMLImageElement>('[data-slot="gh-thread-body"] img')
    expect(img?.getAttribute('src')).toBe('https://example.com/shot.png')
  })

  it('renders nothing when BOTH streams are empty — the count badge already said so', async () => {
    stubFetch(thread('issue', 139, { available: true, comments: [], events: [] }))
    renderAt('/github/issues/139')

    await waitFor(() => expect(detail()?.textContent).toContain('Add --json flag'))
    expect(threadSection()).toBeNull()
    expect(document.querySelector('[data-slot="gh-thread-error"]')).toBeNull()
  })

  it('shows a one-line reason + open-on-GitHub link when the thread is unavailable', async () => {
    stubFetch(thread('issue', 142, { available: false, reason: 'gh not installed', comments: [] }))
    renderAt('/github/issues/142')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-thread-error"]')).not.toBeNull())
    const error = document.querySelector('[data-slot="gh-thread-error"]')!
    expect(error.textContent).toContain('gh not installed')
    expect(error.querySelector('a')?.getAttribute('href')).toBe(ISSUE_142.url)
  })

  it('renders a review entry with a state chip (green/red tone tables)', async () => {
    stubFetch(thread('pr', 137, { available: true, comments: [COMMENT_TEXT, REVIEW_CHANGES] }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(entries()).toHaveLength(2))
    const review = document.querySelector('[data-slot="gh-thread-entry"][data-kind="review"]')
    const chip = review?.querySelector('[data-slot="gh-review-chip"]')
    expect(chip?.getAttribute('data-review-state')).toBe('changes_requested')
    expect(chip?.textContent).toBe('changes requested')
    expect(chip?.className).toContain('text-danger')
  })

  it('uses the real avatar when present and a letter fallback when absent', async () => {
    stubFetch(thread('issue', 142, { available: true, comments: [COMMENT_TEXT, COMMENT_IMAGE] }))
    renderAt('/github/issues/142')

    await waitFor(() => expect(entries()).toHaveLength(2))
    // COMMENT_TEXT has an avatarUrl → an <img>; COMMENT_IMAGE has none → a letter block.
    expect(entries()[0]?.querySelector('[data-slot="gh-avatar"]')?.getAttribute('src')).toBe(
      COMMENT_TEXT.avatarUrl,
    )
    const fallback = entries()[1]?.querySelector('[data-slot="gh-avatar-fallback"]')
    expect(fallback).not.toBeNull()
    expect(fallback?.textContent).toBe('n') // first letter of "noAvatar"
  })

  // ---- timeline events (#525) ----------------------------------------------

  const events = () => [...document.querySelectorAll<HTMLElement>('[data-slot="gh-event-row"]')]
  const SHA = 'abc1234' + 'f'.repeat(33)
  const EVT = {
    committed: {
      id: `evt-${SHA}`, kind: 'committed' as const, actor: 'Ada Lovelace',
      createdAt: '2026-01-02T00:00:00Z', sha: SHA, message: 'bound the timeline page loop',
    },
    labeled: {
      id: 'evt-1', kind: 'labeled' as const, actor: 'octocat',
      createdAt: '2026-01-03T00:00:00Z', label: { name: 'bug', color: 'd73a4a' },
    },
    merged: { id: 'evt-2', kind: 'merged' as const, actor: 'octocat', createdAt: '2026-01-04T00:00:00Z' },
    crossRef: {
      id: 'evt-3', kind: 'cross-referenced' as const, actor: 'octocat',
      createdAt: '2026-01-05T00:00:00Z', refNumber: 520, refTitle: 'Sibling work',
      refIsPr: true, url: 'https://github.com/o/r/pull/520',
    },
  }

  it('renders a row per event kind, each carrying data-kind for keying', async () => {
    stubFetch(thread('pr', 137, {
      available: true, comments: [],
      events: [
        EVT.committed, EVT.labeled, EVT.merged, EVT.crossRef,
        { id: 'evt-4', kind: 'assigned', actor: 'octocat', createdAt: '2026-01-06T00:00:00Z', subject: 'maya' },
        { id: 'evt-5', kind: 'renamed', actor: 'octocat', createdAt: '2026-01-07T00:00:00Z', subject: 'A better title' },
        { id: 'evt-6', kind: 'head_ref_force_pushed', actor: 'octocat', createdAt: '2026-01-08T00:00:00Z' },
        { id: 'evt-7', kind: 'closed', actor: 'octocat', createdAt: '2026-01-09T00:00:00Z' },
      ],
    }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(8))
    expect(events().map((e) => e.dataset.kind)).toEqual([
      'committed', 'labeled', 'merged', 'cross-referenced',
      'assigned', 'renamed', 'head_ref_force_pushed', 'closed',
    ])
    expect(events()[0]?.textContent).toContain('Ada Lovelace')
    expect(events()[0]?.textContent).toContain('abc1234') // short sha
    expect(events()[0]?.textContent).toContain('bound the timeline page loop')
    expect(events()[2]?.textContent).toContain('merged this')
    expect(events()[3]?.textContent).toContain('#520')
    expect(events()[4]?.textContent).toContain('assigned maya')
    expect(events()[5]?.textContent).toContain('renamed this to A better title')
    expect(events()[6]?.textContent).toContain('force-pushed')
  })

  it('renders a PR with events but ZERO comments — the motivating case', async () => {
    // The empty guard used to key on comments alone, which would hide the whole feature on a
    // merged PR carrying commits, labels and a merge event but no conversation.
    stubFetch(thread('pr', 137, { available: true, comments: [], events: [EVT.committed, EVT.merged] }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(threadSection()).not.toBeNull())
    expect(events()).toHaveLength(2)
    expect(entries()).toHaveLength(0)
    expect(document.querySelector('[data-slot="gh-thread-header"]')?.textContent).toBe(
      'Activity · 0 comments',
    )
  })

  it('interleaves comments and events chronologically', async () => {
    // The server returns two independently-capped arrays and deliberately does NOT merge them;
    // ordering is presentation. This is the merge.
    stubFetch(thread('pr', 137, {
      available: true,
      comments: [{ ...COMMENT_TEXT, createdAt: '2026-01-03T12:00:00Z' }],
      events: [
        { ...EVT.committed, createdAt: '2026-01-02T00:00:00Z' },
        { ...EVT.merged, createdAt: '2026-01-04T00:00:00Z' },
      ],
    }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(2))
    const rows = [...document.querySelectorAll('[data-slot="gh-thread-entry"], [data-slot="gh-event-row"]')]
    expect(rows.map((r) => (r as HTMLElement).dataset.slot ?? r.getAttribute('data-slot'))).toEqual([
      'gh-event-row', 'gh-thread-entry', 'gh-event-row',
    ])
  })

  it('sends refresh=1 on the BARE /github route too, where no :n is in the URL', async () => {
    // The regression the first fix batch shipped: keying the open thread off the `:n` route param
    // left the DEFAULT landing pages refreshing nothing, because with no `:n` the tab still shows
    // a thread — `selected` falls back to items[0]. The refresh must follow what is rendered.
    const threadRequests: string[] = []
    stubFetch({ 'GET /api/v1/github?refresh=1': () => jsonResponse(GITHUB) })
    const origFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.startsWith('/api/v1/github/comments/')) threadRequests.push(path)
      return (origFetch as typeof fetch)(input, init as RequestInit)
    })

    renderAt('/github') // no :n at all
    await waitFor(() => expect(threadRequests.length).toBe(1))

    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="gh-refresh"]')!)

    await waitFor(() => expect(threadRequests.some((p) => p.includes('refresh=1'))).toBe(true))
  })

  it('does not blank the open thread while refreshing it', async () => {
    // The other half of that regression: the removeQueries predicate wiped the MOUNTED thread,
    // resetting it to pending so the loading skeleton flashed under the user on every refresh.
    stubFetch({ 'GET /api/v1/github?refresh=1': () => jsonResponse(GITHUB) })
    renderAt('/github/issues/142')

    await waitFor(() => expect(document.querySelector('[data-slot="gh-thread"]')).not.toBeNull())

    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="gh-refresh"]')!)

    // The thread stays rendered throughout — never replaced by the loading skeleton.
    await waitFor(() => expect(document.querySelector('[data-slot="gh-thread"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="gh-thread-loading"]')).toBeNull()
  })

  it('orders a comment and an event made in the SAME second by their true order', async () => {
    // The two streams carry different precisions: events go through toISOString() (`…00.000Z`),
    // comments keep GitHub's `…00Z`. A raw string compare puts '.' (46) before 'Z' (90), so the
    // event would always win a same-second tie regardless of what actually happened first.
    stubFetch(thread('pr', 137, {
      available: true,
      comments: [{ ...COMMENT_TEXT, createdAt: '2026-01-03T10:00:00Z' }],
      events: [{ ...EVT.merged, createdAt: '2026-01-03T10:00:00.000Z' }],
    }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(1))
    const rows = [...document.querySelectorAll('[data-slot="gh-thread-entry"], [data-slot="gh-event-row"]')]
    // Same instant → stable sort keeps insertion order, and comments are inserted first.
    expect(rows[0]?.getAttribute('data-slot')).toBe('gh-thread-entry')
  })

  it('does not let an unparseable timestamp scramble the order', async () => {
    // normalizeReviews emits createdAt: '' for a PENDING review that has a body, and
    // Date.parse('') is NaN. An NaN comparator result coerces to +0, which makes the sort
    // INCONSISTENT rather than crashing — the row lands wherever the engine leaves it. Pinned
    // to the top explicitly instead.
    stubFetch(thread('pr', 137, {
      available: true,
      comments: [
        { ...COMMENT_TEXT, id: 91, createdAt: '' },
        { ...COMMENT_TEXT, id: 92, createdAt: '2026-01-03T00:00:00Z' },
      ],
      events: [{ ...EVT.merged, createdAt: '2026-01-02T00:00:00Z' }],
    }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(entries()).toHaveLength(2))
    const rows = [...document.querySelectorAll('[data-slot="gh-thread-entry"], [data-slot="gh-event-row"]')]
    // The timestamp-less row first, then the ordered ones — deterministic, whatever else changes.
    expect(rows.map((r) => r.getAttribute('data-slot'))).toEqual([
      'gh-thread-entry', 'gh-event-row', 'gh-thread-entry',
    ])
  })

  it('tints a label chip from the event colour', async () => {
    stubFetch(thread('pr', 137, { available: true, comments: [], events: [EVT.labeled] }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(1))
    const chip = document.querySelector<HTMLElement>('[data-slot="gh-event-label"]')
    expect(chip?.textContent).toBe('bug')
    expect(chip?.style.borderColor).not.toBe('') // tinted, not the muted fallback
  })

  it('links a cross-reference out to the referenced thread', async () => {
    stubFetch(thread('pr', 137, { available: true, comments: [], events: [EVT.crossRef] }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(1))
    expect(events()[0]?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/o/r/pull/520')
  })

  it('renders comments unchanged when the server sent no events at all', async () => {
    // The degraded path: the server fell back to the legacy comments-only fetch, so `events` is
    // absent. The thread must render exactly as it did pre-#525.
    stubFetch(thread('issue', 142, { available: true, comments: [COMMENT_TEXT] }))
    renderAt('/github/issues/142')

    await waitFor(() => expect(entries()).toHaveLength(1))
    expect(events()).toHaveLength(0)
    expect(threadSection()).not.toBeNull()
  })

  it.each([
    ['passing', '✓', 'text-success'],
    ['failing', '✗', 'text-danger'],
    ['pending', '○', 'text-muted-foreground'],
  ])('renders the %s CI glyph on a commit row', async (state, glyph, tone) => {
    stubFetch(thread('pr', 137, {
      available: true, comments: [],
      events: [{ ...EVT.committed, checks: state as 'passing' | 'failing' | 'pending' }],
    }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(1))
    const badge = document.querySelector<HTMLElement>('[data-slot="gh-commit-checks"]')
    expect(badge?.getAttribute('data-checks')).toBe(state)
    expect(badge?.textContent).toBe(glyph)
    expect(badge?.className).toContain(tone)
  })

  it('renders no glyph when checks is null AND when it is absent', async () => {
    // null = the commit has no CI configured; absent = the rollup query failed or was skipped.
    // They look identical here on purpose, but stay distinct on the wire.
    stubFetch(thread('pr', 137, {
      available: true, comments: [],
      events: [
        // Distinct authors so the Phase-2 commit-run grouping does not collapse them — this case
        // is about glyph rendering, not grouping.
        { ...EVT.committed, id: 'evt-null', actor: 'Ada Lovelace', checks: null },
        { ...EVT.committed, id: 'evt-absent', actor: 'Grace Hopper' }, // no `checks` key at all
      ],
    }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(2))
    expect(document.querySelectorAll('[data-slot="gh-commit-checks"]')).toHaveLength(0)
  })

  it('collapses a run of consecutive commits by one author, and expands on click', async () => {
    const commit = (n: number, actor = 'Ada Lovelace') => ({
      id: `evt-c${n}`, kind: 'committed' as const, actor,
      createdAt: `2026-01-0${n}T00:00:00Z`, sha: String(n).repeat(40).slice(0, 40),
      message: `commit number ${n}`, checks: 'passing' as const,
    })
    stubFetch(thread('pr', 137, {
      available: true, comments: [],
      events: [commit(1), commit(2), commit(3)],
    }))
    renderAt('/github/prs/137')

    const group = () => document.querySelector<HTMLElement>('[data-slot="gh-commit-group"]')
    await waitFor(() => expect(group()).not.toBeNull())

    // Collapsed: one summary row, no individual commit rows.
    expect(group()?.dataset.open).toBe('false')
    expect(group()?.textContent).toContain('added 3 commits')
    expect(group()?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(events()).toHaveLength(0)

    fireEvent.click(group()!.querySelector('button')!)

    // Expanded: each commit keeps its own message AND its own glyph — nothing is lost to the
    // collapse, which is why grouping is client-side and the wire stays flat.
    await waitFor(() => expect(events()).toHaveLength(3))
    expect(group()?.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(events()[0]?.textContent).toContain('commit number 1')
    expect(events()[2]?.textContent).toContain('commit number 3')
    expect(document.querySelectorAll('[data-slot="gh-commit-checks"]')).toHaveLength(3)
  })

  it('does not group a lone commit into a "1 commit" expander', async () => {
    stubFetch(thread('pr', 137, { available: true, comments: [], events: [EVT.committed] }))
    renderAt('/github/prs/137')

    await waitFor(() => expect(events()).toHaveLength(1))
    expect(document.querySelector('[data-slot="gh-commit-group"]')).toBeNull()
  })

  it('sends refresh=1 for the OPEN THREAD when the tab is manually refreshed', async () => {
    // Asserts the PROPERTY (fresh data is actually requested), not the mechanism (a request went
    // out). The first attempt at this fix only invalidated the query key, which made the client
    // re-request WITHOUT `refresh=1` — and the route only busts its 60 s commentsCache when that
    // param is present, so the user got the same stale object back and the test still passed.
    const threadRequests: string[] = []
    const sent = stubFetch({
      'GET /api/v1/github?refresh=1': () => jsonResponse(GITHUB),
    })
    const origFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.startsWith('/api/v1/github/comments/')) threadRequests.push(path)
      return (origFetch as typeof fetch)(input, init as RequestInit)
    })

    renderAt('/github/issues/142')
    await waitFor(() => expect(threadRequests.length).toBe(1))
    expect(threadRequests[0]).toBe('/api/v1/github/comments/issue/142') // initial load: no refresh

    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="gh-refresh"]')!)

    // The re-request MUST carry refresh=1, or the server hands back its cached thread.
    await waitFor(() =>
      expect(threadRequests.some((p) => p === '/api/v1/github/comments/issue/142?refresh=1')).toBe(true),
    )
    expect(sent.length).toBeGreaterThan(0)
  })

  it('shows a truncation row linking to GitHub when the thread was trimmed', async () => {
    stubFetch(thread('issue', 142, { available: true, comments: [COMMENT_TEXT], truncated: true }))
    renderAt('/github/issues/142')

    await waitFor(() => expect(threadSection()).not.toBeNull())
    const trunc = document.querySelector('[data-slot="gh-thread-truncated"]')
    expect(trunc?.textContent).toContain('thread truncated')
    expect(trunc?.getAttribute('href')).toBe(ISSUE_142.url)
  })
})

// ---- forge gating -----------------------------------------------------------------------------

describe('the unavailable forge state', () => {
  it('renders the server reason and the gh hint, and Try again refetches with refresh=1', async () => {
    const unavailable: GithubData = { available: false, reason: 'gh not installed', issues: [], prs: [] }
    const sent = stubFetch({
      'GET /api/v1/github?limit=1000': () => jsonResponse(unavailable),
      'GET /api/v1/github?limit=1000&refresh=1': () => jsonResponse(unavailable),
    })
    renderAt('/github')

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'GitHub is unavailable here' })).toBeTruthy(),
    )
    expect(screen.getByText('gh not installed')).toBeTruthy()
    // One fast fetch now (#664): the single limit=1000 load is what proved the forge unreachable.
    expect(sent.some((request) => request.path === '/api/v1/github?limit=1000')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() =>
      expect(sent.some((request) => request.path === '/api/v1/github?limit=1000&refresh=1')).toBe(true),
    )
  })
})

// ---- hand to agent ----------------------------------------------------------------------------

async function openDetail(entry = '/github/issues/142') {
  renderAt(entry)
  await waitFor(() => expect(document.querySelector('[data-slot="gh-hand"]')).not.toBeNull())
}

/** A typed health fixture — `HealthResponse`, so tsc catches the drift an `unknown` body hides
 *  (the pre-#471 shape silently rotted here until the merge fixed the inbox's copy). */
const health = (backends: readonly Runner[]): HealthResponse => ({
  version: '0.0.0-test',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  checks: backends.map((name) => ({ name, available: true })),
  defaultRunner: backends[0] ?? 'claude',
  forge: null,
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false },
})

/** More than one installed backend — the only state that shows the runner pill. */
const MULTI_BACKEND = () => jsonResponse(health(['claude', 'codex']))
/** Exactly one installed backend — a real single-backend host, not merely absent health. */
const SINGLE_BACKEND = () => jsonResponse(health(['claude']))

/** Open a pill's dropdown and choose an option by label (Radix opens on pointerDown). */
async function pickPill(slot: string, label: string) {
  fireEvent.pointerDown(document.querySelector(`[data-slot="${slot}"]`)!)
  const options = await screen.findAllByRole('menuitemradio')
  fireEvent.click(options.find((o) => o.textContent?.includes(label)) as HTMLElement)
}

const postedRun = (sent: readonly SentRequest[]) =>
  sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')?.body

const waitForAgentRunEnabled = () =>
  waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: /Run agent on this/ }).disabled,
    ).toBe(false),
  )

describe('the hand-to-agent backend pills (#401)', () => {
  it('a single-backend host hides the runner pill but still offers the model', async () => {
    // A real one-check health response — the default stub 404s /api/v1/health, which exercises
    // the no-data fallback instead and would pass for the wrong reason.
    stubFetch({ 'GET /api/v1/health': SINGLE_BACKEND })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="model-pill"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
  })

  it('an untouched cold-load panel posts the connected runner and no model', async () => {
    const sent = stubFetch()
    await openDetail()
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ workflow: 'quick-task' })
    expect((postedRun(sent) as { runner?: string }).runner).toBe('claude')
    expect((postedRun(sent) as { model?: string }).model).toBeUndefined()
  })

  it('sends the connected runner explicitly when provider status resolves before health', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': () => new Promise<Response>(() => {}),
    })
    await openDetail()
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ runner: 'claude' })
  })

  it('a runner + model pick rides the POST alongside the workflow routing', async () => {
    const sent = stubFetch({
      // Health describes the boot project; config describes the scoped GitHub project.
      'GET /api/v1/health': () => jsonResponse({ ...health(['claude', 'codex']), defaultRunner: 'codex' }),
      'GET /api/v1/config': () => jsonResponse({ defaultRunner: 'claude', defaultModels: {} }),
      'GET /api/v1/providers/status': () => jsonResponse(PROVIDERS_MULTI),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="runner-pill"]')).not.toBeNull())
    await pickPill('runner-pill', 'codex')
    await pickPill('model-pill', 'gpt-future')

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({
      workflow: 'quick-task',
      runner: 'codex',
      model: 'gpt-future',
    })
  })

  it('switching backend resets the model pick — the presets are per runner', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': MULTI_BACKEND,
      'GET /api/v1/providers/status': () => jsonResponse(PROVIDERS_MULTI),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="runner-pill"]')).not.toBeNull())
    // Pin a claude model, then move to codex: the claude id must not survive onto codex.
    await pickPill('model-pill', 'opus')
    await pickPill('runner-pill', 'codex')

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ runner: 'codex' })
    // Back to auto for the new runner, so no model at all.
    expect((postedRun(sent) as { model?: string }).model).toBeUndefined()
  })

  it('the pick survives switching to another issue (it is a way of working, not a property of one item)', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': MULTI_BACKEND,
      'GET /api/v1/providers/status': () => jsonResponse(PROVIDERS_MULTI),
    })
    await openDetail()

    await waitFor(() => expect(document.querySelector('[data-slot="runner-pill"]')).not.toBeNull())
    await pickPill('runner-pill', 'codex')

    // Hop to the other issue — HandToAgent remounts (key={item.url}), the pick must not.
    fireEvent.click(rows().find((row) => row.dataset.number === '139')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-hand"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-slot="runner-pill"]')?.textContent).toContain('codex')

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ runner: 'codex' })
  })

  it('disables click and shortcut starts with no connected provider while browsing and editing stay live', async () => {
    const sent = stubFetch({
      'GET /api/v1/providers/status': () => jsonResponse(PROVIDERS_NONE),
    })
    await openDetail('/p/acme/github/issues/142')

    const run = screen.getByRole<HTMLButtonElement>('button', {
      name: /Run agent on this issue/,
    })
    await waitFor(() => expect(run.disabled).toBe(true))
    expect(
      document.querySelector<HTMLButtonElement>('[data-slot="model-pill"]')?.disabled,
    ).toBe(true)
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/p/acme/settings/agents#providers',
    )

    fireEvent.change(promptField(), { target: { value: 'Keep this editable.' } })
    expect(promptValue()).toBe('Keep this editable.')
    fireEvent.click(rows().find((row) => row.dataset.number === '139')!)
    await waitFor(() => expect(promptField().value).toContain('#139'))

    // Force both entry points past their visual disabled state; neither may reach createRun.
    const currentRun = screen.getByRole<HTMLButtonElement>('button', {
      name: /Run agent on this issue/,
    })
    currentRun.removeAttribute('disabled')
    fireEvent.click(currentRun)
    fireEvent.keyDown(promptField(), { key: 'Enter', ctrlKey: true })
    await act(() => Promise.resolve())
    expect(postedRun(sent)).toBeUndefined()
  })

  it('describes provider route failure as failed verification and keeps setup available', async () => {
    stubFetch({
      'GET /api/v1/providers/status': () =>
        jsonResponse({ error: 'provider probe failed' }, 404),
    })
    await openDetail()

    expect(await screen.findByText('Provider authentication could not be verified.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('No agent provider is connected')
    expect(screen.getByRole('link', { name: 'Configure providers' })).toBeTruthy()
  })

  it('explicitly sends a connected fallback that differs from the server default', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': () => jsonResponse(health(['claude'])),
      'GET /api/v1/providers/status': () =>
        jsonResponse({
          providers: [
            { provider: 'claude', status: 'disconnected', enabled: true },
            { provider: 'codex', status: 'connected', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          ],
        } satisfies ProviderStatusResponse),
    })
    await openDetail()

    const run = screen.getByRole<HTMLButtonElement>('button', {
      name: /Run agent on this issue/,
    })
    await waitFor(() => expect(run.disabled).toBe(false))
    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
    fireEvent.click(run)

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ runner: 'codex', workflow: 'quick-task' })
  })

  it('excludes a connected disabled default runner and sends the enabled fallback', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': () => jsonResponse(health(['claude', 'codex'])),
      'GET /api/v1/providers/status': () =>
        jsonResponse({
          providers: [
            { provider: 'claude', status: 'connected', enabled: false },
            { provider: 'codex', status: 'connected', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          ],
        } satisfies ProviderStatusResponse),
    })
    await openDetail()

    const run = screen.getByRole<HTMLButtonElement>('button', {
      name: /Run agent on this issue/,
    })
    await waitFor(() => expect(run.disabled).toBe(false))
    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
    fireEvent.click(run)

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)).toMatchObject({ runner: 'codex', workflow: 'quick-task' })
  })
})

/**
 * Toggle a skill ON through its picker, robustly. cmdk re-renders the option list while the
 * popover opens, so an option `waitFor` just saw can be detached a tick later — clicking a node
 * from a prior poll then hits `null` (#413 flake). Query-and-click atomically on each poll, and
 * key completion on the skill's CHIP appearing so this multi-select toggle can never fire twice
 * and flip it back off. Opens the picker only when neither the option nor the chip is showing
 * yet (clicking the trigger while it is open would close it).
 */
async function selectSkill(name: string): Promise<void> {
  const chip = `[data-slot="gh-skill-chip"][data-skill="${name}"]`
  const opt = `[data-slot="gh-skill-option"][data-skill="${name}"]`
  if (!document.querySelector(chip) && !document.querySelector(opt)) {
    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
  }
  await waitFor(() => {
    if (document.querySelector(chip)) return
    const node = document.querySelector<HTMLElement>(opt)
    if (node) fireEvent.click(node)
    throw new Error(`skill "${name}" not selected yet`)
  })
}

describe('the hand-to-agent pickers (#385)', () => {
  it('the workflow dropdown lists, filters, selects — and re-selecting deselects', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-workflow-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-workflow-option"]')).toHaveLength(2),
    )

    // cmdk filtering: a query narrows the list.
    fireEvent.change(screen.getByPlaceholderText('search workflows…'), { target: { value: 'ship' } })
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-workflow-option"]')).toHaveLength(1),
    )

    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-workflow-trigger"]')?.textContent).toContain('ship-it'),
    )

    // Click the selected workflow again → deselected (legacy chip parity).
    fireEvent.click(document.querySelector('[data-slot="gh-workflow-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-workflow="ship-it"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-workflow-trigger"]')?.textContent).not.toContain('ship-it'),
    )
  })

  it('the skills dropdown is project-first with bold project rows (#377), and keeps selection visible as chips', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )

    // Server order was global-first; the menu reorders project skills first, emphasized.
    const options = [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-option"]')]
    expect(options.map((option) => option.dataset.skill)).toEqual(['om-fix', 'team-x', 'g-review'])
    expect(options[0]?.querySelector('.font-semibold')).not.toBeNull()
    expect(options[1]?.querySelector('.font-semibold')).not.toBeNull()
    expect(options[2]?.querySelector('.font-semibold')).toBeNull()

    // Multi-select: toggling keeps the menu open; the chip row mirrors the selection.
    fireEvent.click(options[0]!)
    fireEvent.click(document.querySelector('[data-slot="gh-skill-option"][data-skill="g-review"]')!)
    await waitFor(() =>
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-chip"]')].map(
          (chip) => chip.dataset.skill,
        ),
      ).toEqual(['om-fix', 'g-review']),
    )
    expect(document.querySelector('[data-slot="gh-skills-trigger"]')?.textContent).toContain('· 2')

    // The filter narrows the list but can never hide the selection — the chips live outside.
    fireEvent.change(screen.getByPlaceholderText('search skills…'), { target: { value: 'team' } })
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(1),
    )
    expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(2)

    // A chip's × deselects without the dropdown.
    fireEvent.click(document.querySelector('[data-slot="gh-skill-chip"][data-skill="om-fix"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(1),
    )
  })

  it('the eye opens the read-only skill preview (shared detail component) without toggling the row', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )

    fireEvent.click(
      document.querySelector('[data-slot="gh-skill-option"][data-skill="om-fix"] [data-slot="gh-skill-view"]')!,
    )
    // The Settings catalog's detail component, as a dialog — name, source tag, path.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="skill-preview"] [data-slot="skill-detail"]')).not.toBeNull(),
    )
    const preview = document.querySelector('[data-slot="skill-preview"]')!
    expect(preview.textContent).toContain('om-fix')
    expect(preview.textContent).toContain('project fixer')
    expect(preview.querySelector('[data-slot="skill-path"]')?.textContent).toContain('/p/om-fix.md')
    // Viewing is read-only: nothing got selected (no chip, no count on the trigger).
    expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(0)
    expect(document.querySelector('[data-slot="gh-skills-trigger"]')?.textContent).not.toContain('·')
    // The escape hatch into the browsable Skills catalog.
    expect(
      preview.querySelector('[data-slot="skill-preview-manage"]')?.getAttribute('href'),
    ).toBe('/skills?skill=om-fix')
  })

  it('multi-keyword search: "fix project" narrows the skills list to matches (#411)', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )

    // "fix project" should match om-fix (name splits "om","fix" + description "project fixer")
    fireEvent.change(screen.getByPlaceholderText('search skills…'), { target: { value: 'fix project' } })
    await waitFor(() => {
      const visible = [...document.querySelectorAll('[data-slot="gh-skill-option"]')]
      expect(visible).toHaveLength(1)
      expect(visible[0]?.getAttribute('data-skill')).toBe('om-fix')
    })
  })
})

describe('the hand-to-agent run (legacy three-way body)', () => {
  it('nothing selected → quick-task, and the queued affordance links the new run', async () => {
    const sent = stubFetch()
    await openDetail()
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())
    const posted = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')
    expect(posted?.body).toMatchObject({ workflow: 'quick-task' })
    expect((posted?.body as { task: string }).task).toContain('Fix GitHub issue #142')
    expect((posted?.body as { task: string }).task).toContain(ISSUE_142.url)

    expect(document.querySelector('[data-slot="gh-view-run"]')?.getAttribute('href')).toBe('/tasks/run-1')
    // The list row grows the queued flag.
    expect(document.querySelector('[data-slot="gh-queued-flag"]')).not.toBeNull()
  })

  it('confirms the hand-off with a toast — the inline affordance is off-screen on a phone', async () => {
    stubFetch()
    await openDetail()
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(screen.getByText('Added to the queue — issue #142')).toBeTruthy())
    expect(document.querySelector('[data-slot="toast"]')?.getAttribute('data-tone')).toBe('default')
  })

  it('a custom prompt is handed over WITH the item reference, not instead of it (#524)', async () => {
    const sent = stubFetch()
    await openDetail()

    // The exact prompt from the bug report: it names no number and no URL of its own.
    fireEvent.change(promptField(), {
      target: { value: 'Port this one to develop and close original PR' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())
    const posted = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')
    const { task } = posted?.body as { task: string }
    expect(task).toContain('Port this one to develop and close original PR')
    expect(task).toContain('#142')
    expect(task).toContain(ISSUE_142.url)
  })

  it('a selected workflow rides the POST, with toggled skills as a prompt hint', async () => {
    const sent = stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-workflow-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-workflow="ship-it"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)

    await selectSkill('om-fix')

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(true),
    )
    const posted = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')
    expect(posted?.body).toMatchObject({ workflow: 'ship-it' })
    expect((posted?.body as { task: string }).task).toContain('Use these skills where relevant: om-fix.')
  })

  it('skills without a workflow become the steps chain (spec 008)', async () => {
    const sent = stubFetch()
    await openDetail()

    await selectSkill('om-fix')
    fireEvent.click(document.querySelector('[data-slot="gh-skill-option"][data-skill="g-review"]')!)

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(true),
    )
    const body = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')
      ?.body as { workflow?: string; steps?: Array<{ id: string; skill: string; prompt: string }> }
    expect(body.workflow).toBeUndefined()
    expect(body.steps).toEqual([
      { id: 'om-fix', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' },
      { id: 'g-review', name: 'g-review', skill: 'g-review', prompt: '{{task}}' },
    ])
  })

  it('a server refusal surfaces as a danger toast and no queued flag', async () => {
    stubFetch({
      'POST /api/v1/runs': () => jsonResponse({ error: 'a task is already running' }, 409),
    })
    await openDetail()
    await waitForAgentRunEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() => expect(screen.getByText('a task is already running')).toBeTruthy())
    expect(document.querySelector('[data-slot="gh-queued"]')).toBeNull()
  })
})

// ---- #408: frequency sort ----------------------------------------------------------------------

describe('the skills dropdown frequency sort (#408 item 1, re-tiered by #519)', () => {
  it('promotes used skills into "Most used" ahead of locality, frequency descending', async () => {
    stubFetch({
      'GET /api/v1/ui-state': () => jsonResponse({ skillUsage: { 'team-x': 9, 'g-review': 1 } }),
    })
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )
    const options = [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-option"]')]
    // Most used leads (#519): team-x (9 picks) then g-review (1 pick), BOTH above the unused
    // project skill om-fix — usage now outranks locality instead of only reordering within it.
    expect(options.map((option) => option.dataset.skill)).toEqual(['team-x', 'g-review', 'om-fix'])
  })

  it('no usage stats at all falls back to the plain project-first order (#2)', async () => {
    stubFetch() // the default GET /api/v1/ui-state answers {}
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-option"]')).toHaveLength(3),
    )
    const options = [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-option"]')]
    expect(options.map((option) => option.dataset.skill)).toEqual(['om-fix', 'team-x', 'g-review'])
  })

  it('a successful hand-off run bumps skillUsage for every selected skill', async () => {
    const sent = stubFetch({
      'GET /api/v1/ui-state': () => jsonResponse({ skillUsage: { 'om-fix': 2 } }),
    })
    await openDetail()

    await selectSkill('om-fix')
    fireEvent.click(document.querySelector('[data-slot="gh-skill-option"][data-skill="g-review"]')!)

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')).toBe(
        true,
      ),
    )
    const put = sent.find((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')
    expect(put?.body).toMatchObject({ skillUsage: { 'om-fix': 3, 'g-review': 1 } })
  })

  it('a run started while ui-state is unavailable skips the bump rather than wiping the map', async () => {
    // The PUT merge is shallow, so a bump computed off an unresolved/errored ui-state query
    // would send a ONE-ENTRY map and replace every count the user has accumulated. The bump is
    // a convenience; the stored history is not — so the bump is what gives way.
    const sent = stubFetch({
      // 404, not a 5xx: the query client never retries a 4xx (query-client.ts), so the query
      // lands in its errored state immediately and the test stays deterministic.
      'GET /api/v1/ui-state': () => jsonResponse({ error: 'nope' }, 404),
    })
    await openDetail()

    await selectSkill('om-fix')

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    // The run itself still goes through — persistence is fire-and-forget.
    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())

    expect(sent.some((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')).toBe(
      false,
    )
  })

  it('picking a workflow only (no skills) never touches skillUsage', async () => {
    const sent = stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-workflow-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-workflow="ship-it"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())

    expect(sent.some((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')).toBe(
      false,
    )
  })
})

// ---- #408: remembered last selection -----------------------------------------------------------

describe('the remembered last selection (#408 item 3)', () => {
  it('a repeat hand-off pre-selects the previous workflow + skills on a fresh mount', async () => {
    stubFetch()
    await openDetail()

    fireEvent.click(document.querySelector('[data-slot="gh-workflow-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-workflow="ship-it"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-workflow="ship-it"]')!)

    await selectSkill('om-fix')
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(1),
    )

    // Simulate a full page reload: unmount everything and mount fresh — only localStorage (not
    // React state) can carry the pick across this boundary.
    cleanup()
    stubFetch()
    await openDetail()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-workflow-trigger"]')?.textContent).toContain(
        'ship-it',
      ),
    )
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-chip"]')].map(
        (chip) => chip.dataset.skill,
      ),
    ).toEqual(['om-fix'])
  })
})

// ---- #408: a remembered pick that no longer exists ----------------------------------------------

/**
 * Remembering the pick gave it a lifetime beyond the files that justify it. A workflow can be
 * renamed, a skill deleted — and because every cockpit shares one `localhost:<port>` origin
 * (`pickPort`, src/index.ts), a name can even arrive from a DIFFERENT repo's cockpit, where it
 * never existed here. What is restored must be checked against the catalog, or Run POSTs a name
 * the server 404s on, on every press and every reload.
 */
describe('a remembered pick the catalog no longer has (#408)', () => {
  const WITHOUT_SHIP_IT: WorkflowsResponse = {
    workflows: [{ name: 'quick-task', description: 'one step', steps: [], source: 'built-in' }],
    issues: [],
  }

  it('a workflow deleted since it was remembered is dropped from the trigger, the POST and storage', async () => {
    writeFollowupSelection({ workflow: 'ship-it', skills: [] })
    const sent = stubFetch({ 'GET /api/v1/workflows': () => jsonResponse(WITHOUT_SHIP_IT) })
    await openDetail()

    const trigger = () => document.querySelector('[data-slot="gh-workflow-trigger"]')
    await waitFor(() => expect(trigger()?.textContent).not.toContain('ship-it'))
    expect(trigger()?.textContent).toContain('workflow') // back to the unselected placeholder

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())
    // The run falls back to quick-task instead of 404-ing on a workflow that is gone.
    expect(sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')?.body)
      .toMatchObject({ workflow: 'quick-task' })
    // Dropped from storage too — otherwise the next reload restores it right back.
    expect(readFollowupSelection().workflow).toBeNull()
  })

  it('a remembered workflow that still exists survives — the guard only drops the unknown', async () => {
    writeFollowupSelection({ workflow: 'ship-it', skills: [] })
    const sent = stubFetch()
    await openDetail()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-workflow-trigger"]')?.textContent).toContain('ship-it'),
    )
    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(true),
    )
    expect(sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')?.body)
      .toMatchObject({ workflow: 'ship-it' })
  })

  it('a deleted skill is dropped from the chips, the counter AND the POST — never shown but unsent', async () => {
    writeFollowupSelection({ workflow: null, skills: ['om-fix', 'deleted-skill'] })
    const sent = stubFetch()
    await openDetail()

    await waitFor(() => expect(document.querySelectorAll('[data-slot="gh-skill-chip"]')).toHaveLength(1))
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-slot="gh-skill-chip"]')].map((chip) => chip.dataset.skill),
    ).toEqual(['om-fix'])
    // The counter must agree with the chips and the POST — not report the phantom.
    expect(document.querySelector('[data-slot="gh-skills-trigger"]')?.textContent).toContain('· 1')

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(true),
    )
    const body = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')?.body as {
      steps?: Array<{ skill: string }>
    }
    expect(body.steps?.map((step) => step.skill)).toEqual(['om-fix'])
  })
})

// ---- #408: draft persistence -------------------------------------------------------------------

describe('the follow-up prompt draft (#408 item 4)', () => {
  it('typed instructions persist when navigating away and back to the same item', async () => {
    stubFetch()
    await openDetail()

    fireEvent.change(promptField(), { target: { value: 'Also add a test.' } })
    await waitFor(() => expect(promptValue()).toBe('Also add a test.'))

    // Switch to a different item — HandToAgent remounts (key={item.url}); its OWN draft is empty.
    fireEvent.click(document.querySelector('[data-slot="gh-row"][data-number="139"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-detail-inner"]')?.textContent).toContain(
        'Add --json flag',
      ),
    )
    // Untouched means its OWN pre-filled reference (#524), never issue 142's text.
    expect(promptValue()).toBe(githubTaskRef(ISSUE_139))

    // Switch back — the first item's draft is restored.
    fireEvent.click(document.querySelector('[data-slot="gh-row"][data-number="142"]')!)
    await waitFor(() => expect(promptValue()).toBe('Also add a test.'))
  })

  it('an untouched box stores no draft — the pre-fill leaves no trace (#524)', async () => {
    stubFetch()
    await openDetail()

    await waitFor(() => expect(promptValue()).toBe(BASE))
    expect(readFollowupPrompt(ISSUE_142.url)).toBe('')
  })

  it('a page reload restores the draft too (localStorage, not just component state)', async () => {
    stubFetch()
    await openDetail()
    fireEvent.change(promptField(), { target: { value: 'do not lose me' } })
    await waitFor(() => expect(promptValue()).toBe('do not lose me'))

    cleanup()
    stubFetch()
    await openDetail()
    await waitFor(() => expect(promptValue()).toBe('do not lose me'))
  })

  it('a successful run spends that item’s draft', async () => {
    stubFetch()
    await openDetail()
    fireEvent.change(promptField(), { target: { value: 'spend me' } })
    await waitFor(() => expect(promptValue()).toBe('spend me'))

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())

    cleanup()
    stubFetch()
    await openDetail()
    // Spent → back to the untouched pre-fill, not to an empty box.
    expect(promptValue()).toBe(BASE)
  })

  it('spending the draft clears the textarea THERE AND THEN, not only on the next mount', async () => {
    stubFetch()
    await openDetail()
    fireEvent.change(promptField(), { target: { value: 'spend me' } })
    await waitFor(() => expect(promptValue()).toBe('spend me'))

    fireEvent.click(screen.getByRole('button', { name: /Run agent on this issue/ }))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-queued"]')).not.toBeNull())

    // Storage and UI must agree without a remount: leaving the text on screen while the entry is
    // gone from storage means it silently vanishes the next time you come back.
    await waitFor(() => expect(promptValue()).toBe(BASE))
    expect(readFollowupPrompt(ISSUE_142.url)).toBe('')
  })
})

// ---- #408: ⌘/Ctrl+Enter submit ------------------------------------------------------------------

describe('⌘/Ctrl+Enter submits the follow-up composer (#408 item 5)', () => {
  it('Ctrl+Enter runs the agent', async () => {
    const sent = stubFetch()
    await openDetail()
    await waitForAgentRunEnabled()

    const textarea = screen.getByLabelText('Custom prompt')
    fireEvent.change(textarea, { target: { value: 'go' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(
        true,
      ),
    )
  })

  it('⌘+Enter (metaKey) also runs the agent', async () => {
    const sent = stubFetch()
    await openDetail()
    await waitForAgentRunEnabled()

    const textarea = screen.getByLabelText('Custom prompt')
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })

    await waitFor(() =>
      expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(
        true,
      ),
    )
  })

  it('a bare Enter does NOT submit — it is a multi-line instructions box', async () => {
    const sent = stubFetch()
    await openDetail()

    const textarea = screen.getByLabelText('Custom prompt')
    fireEvent.keyDown(textarea, { key: 'Enter' })

    // Give any (wrongly) scheduled submit a tick to happen before asserting its absence.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(
      false,
    )
  })

  it('Shift+Ctrl+Enter does not submit — Shift wins, same rule as the thread composer', async () => {
    const sent = stubFetch()
    await openDetail()

    const textarea = screen.getByLabelText('Custom prompt')
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, shiftKey: true })

    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/runs')).toBe(
      false,
    )
  })
})

// ---- prompt templates (#413) --------------------------------------------------------------------

describe('the follow-up prompt template menu (#413)', () => {
  /** The menu is a Popover + cmdk (like the skills picker beside it), so it opens on click. */
  async function openTemplateMenu(): Promise<void> {
    fireEvent.click(document.querySelector('[data-slot="prompt-template-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="prompt-template-option"]')).not.toBeNull(),
    )
  }

  const option = (id: string) =>
    document.querySelector<HTMLElement>(`[data-slot="prompt-template-option"][data-template="${id}"]`)

  /**
   * Click a mounted template option until the select provably lands. A re-render (the
   * ui-state query resolving, a queries invalidation) can replace the option node between
   * querying it and clicking it — a click on the detached node is a silent no-op, the race
   * that made this suite flake (#413). Selecting closes the menu (`onSelect` →
   * `setOpen(false)`), so re-query a FRESH node each retry and stop only once the options
   * unmount: the insert has provably happened.
   */
  async function selectOption(id: string): Promise<void> {
    await waitFor(() => {
      const node = option(id)
      if (!node) return // menu closed — the select landed
      fireEvent.click(node)
      throw new Error(`template option "${id}" still mounted — select has not landed yet`)
    })
  }

  /**
   * Open the menu and click a specific template. Waits for *that* option to
   * mount before clicking it, so a stale option from the previous (closing)
   * popover can never satisfy the wait while the wanted one is still absent —
   * the race that made this suite flake in CI (#413).
   */
  async function chooseTemplate(id: string): Promise<void> {
    const textarea = () => screen.getByLabelText('Custom prompt') as HTMLTextAreaElement
    const before = textarea().value
    fireEvent.click(document.querySelector('[data-slot="prompt-template-trigger"]')!)
    await waitFor(() => {
      if (!option(id)) throw new Error(`template option "${id}" not mounted yet`)
    })
    await selectOption(id)
  }

  it('an untouched ui-state shows the built-in templates, and inserting one fills the custom prompt', async () => {
    stubFetch()
    await openDetail()

    await openTemplateMenu()
    expect(document.querySelectorAll('[data-slot="prompt-template-option"]').length).toBeGreaterThan(1)
    expect(option('add-tests')).not.toBeNull()

    await selectOption('add-tests')
    await waitFor(() =>
      expect(screen.getByLabelText('Custom prompt')).toHaveProperty(
        'value',
        baseWith('Also add or update tests covering this change.'),
      ),
    )
  })

  it('a user-edited ui-state templates list replaces the built-ins in the menu', async () => {
    stubFetch({
      'GET /api/v1/ui-state': () =>
        jsonResponse({ promptTemplates: [{ id: 'custom-1', label: 'My snippet', text: 'Custom instructions.' }] }),
    })
    await openDetail()

    await openTemplateMenu()
    expect(document.querySelectorAll('[data-slot="prompt-template-option"]')).toHaveLength(1)
    expect(option('custom-1')?.textContent).toContain('My snippet')

    await selectOption('custom-1')
    await waitFor(() =>
      expect(screen.getByLabelText('Custom prompt')).toHaveProperty(
        'value',
        baseWith('Custom instructions.'),
      ),
    )
  })

  it('inserting a second template stacks it below the first, separated by a blank line', async () => {
    stubFetch()
    await openDetail()

    await chooseTemplate('add-tests')
    await waitFor(() =>
      expect(screen.getByLabelText('Custom prompt')).toHaveProperty(
        'value',
        baseWith('Also add or update tests covering this change.'),
      ),
    )

    await chooseTemplate('update-docs')

    await waitFor(() =>
      expect(screen.getByLabelText('Custom prompt')).toHaveProperty(
        'value',
        baseWith(
          'Also add or update tests covering this change.\n\nAlso update any relevant documentation or comments.',
        ),
      ),
    )
  })

  it('an EDITED box honours the caret — a template lands mid-text, not appended (#524)', async () => {
    // The pre-fill (#524) means an untouched box must append rather than splice above the
    // reference, but that must not cost `insertTemplate`'s documented mid-text case: the user
    // clicked back into the box to fix a typo, then picked a template.
    stubFetch()
    await openDetail()

    fireEvent.change(promptField(), { target: { value: 'ALPHA OMEGA' } })
    await waitFor(() => expect(promptValue()).toBe('ALPHA OMEGA'))
    promptField().setSelectionRange(5, 5)

    await chooseTemplate('add-tests')
    await waitFor(() =>
      expect(promptValue()).toBe(
        'ALPHA\n\nAlso add or update tests covering this change.\n\nOMEGA',
      ),
    )
  })

  it('the menu is searchable — typing narrows it to the matching template', async () => {
    stubFetch()
    await openDetail()

    await openTemplateMenu()
    const all = document.querySelectorAll('[data-slot="prompt-template-option"]').length
    expect(all).toBeGreaterThan(1)

    fireEvent.change(screen.getByPlaceholderText('search templates…'), { target: { value: 'docs' } })
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="prompt-template-option"]')).toHaveLength(1),
    )
    expect(option('update-docs')).not.toBeNull()
  })

  it('search matches a template by its TEXT, not just the label someone gave it', async () => {
    stubFetch()
    await openDetail()

    await openTemplateMenu()
    // "unrelated refactors" appears only in the body of the keep-minimal template.
    fireEvent.change(screen.getByPlaceholderText('search templates…'), {
      target: { value: 'unrelated refactors' },
    })
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="prompt-template-option"]')).toHaveLength(1),
    )
    expect(option('keep-minimal')).not.toBeNull()
  })
})

// ---- auto-apply on skill selection (#413 follow-up) ---------------------------------------------

describe('templates assigned to a skill auto-apply when a skill is picked', () => {
  const ASSIGNED = {
    'GET /api/v1/ui-state': () =>
      jsonResponse({
        promptTemplates: [
          { id: 'assigned', label: 'Fix rules', text: 'Follow the fix rules.', skills: ['om-fix'] },
          { id: 'manual', label: 'Manual', text: 'Never auto.' },
        ],
      }),
  }

  /** Toggle a skill. The picker is multi-select and STAYS open after a toggle, so only open it
   *  when it is not already showing — clicking the trigger again would close it instead. */
  const pickSkill = async (name: string) => {
    const selector = `[data-slot="gh-skill-option"][data-skill="${name}"]`
    if (document.querySelector(selector) === null) {
      fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
      await waitFor(() => expect(document.querySelector(selector)).not.toBeNull())
    }
    fireEvent.click(document.querySelector(selector)!)
  }

  it('fills an untouched prompt box with the assigned template, and only that one', async () => {
    stubFetch(ASSIGNED)
    await openDetail()

    await pickSkill('om-fix')
    // Stacked BELOW the pre-filled reference (#524) — auto-apply adds to the item context, it
    // never replaces it, the same rule the composed task text follows.
    await waitFor(() =>
      expect(screen.getByLabelText('Custom prompt')).toHaveProperty(
        'value',
        baseWith('Follow the fix rules.'),
      ),
    )
  })

  it('deselecting the skill takes the auto-applied text back out again, leaving the reference', async () => {
    stubFetch(ASSIGNED)
    await openDetail()

    await pickSkill('om-fix')
    await waitFor(() =>
      expect(screen.getByLabelText('Custom prompt')).toHaveProperty(
        'value',
        baseWith('Follow the fix rules.'),
      ),
    )

    await pickSkill('om-fix')
    // Back to the pre-fill, NOT to empty: deselecting a skill must not strip the item context.
    await waitFor(() => expect(screen.getByLabelText('Custom prompt')).toHaveProperty('value', BASE))
  })

  it('NEVER overwrites a prompt the user already typed in', async () => {
    stubFetch(ASSIGNED)
    await openDetail()

    fireEvent.change(screen.getByLabelText('Custom prompt'), { target: { value: 'my own words' } })
    await pickSkill('om-fix')

    // Give the effect every chance to misbehave before asserting it did not.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-skill-chip"][data-skill="om-fix"]')).not.toBeNull(),
    )
    expect(screen.getByLabelText('Custom prompt')).toHaveProperty('value', 'my own words')
  })

  it('a skill with no template assigned to it leaves the box alone', async () => {
    stubFetch(ASSIGNED)
    await openDetail()

    await pickSkill('g-review')
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-skill-chip"][data-skill="g-review"]')).not.toBeNull(),
    )
    expect(screen.getByLabelText('Custom prompt')).toHaveProperty('value', BASE)
  })
})

/** The commit-run grouping helper (#525 Phase 2) — pure, so it is tested directly rather than
 *  only through the rendered thread. Grouping is deliberately client-side: the wire stays a flat
 *  list where each commit keeps its own message and CI glyph, so nothing is lost to a collapse
 *  and the heuristic can change without a backward-compatibility conversation. */
describe('groupCommitRuns', () => {
  const commit = (id: string, actor: string): ThreadRow => ({
    row: 'event',
    event: { id, kind: 'committed', actor, createdAt: '2026-01-01T00:00:00Z', sha: 'a'.repeat(40) },
  })
  const label = (id: string): ThreadRow => ({
    row: 'event',
    event: { id, kind: 'labeled', actor: 'octocat', createdAt: '2026-01-01T00:00:00Z' },
  })
  const comment = (id: number): ThreadRow => ({
    row: 'comment',
    comment: { id, author: 'maya', createdAt: '2026-01-01T00:00:00Z', body: 'hi', kind: 'comment', url: 'u' },
  })

  it('groups consecutive commits by the same author', () => {
    const out = groupCommitRuns([commit('a', 'Ada'), commit('b', 'Ada'), commit('c', 'Ada')])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ group: 'commits' })
    expect((out[0] as { commits: unknown[] }).commits).toHaveLength(3)
  })

  it('ends a run at an author change', () => {
    const out = groupCommitRuns([commit('a', 'Ada'), commit('b', 'Ada'), commit('c', 'Grace'), commit('d', 'Grace')])
    expect(out).toHaveLength(2)
    expect(out.every((g) => g.group === 'commits')).toBe(true)
  })

  it('ends a run at any non-commit row', () => {
    const out = groupCommitRuns([commit('a', 'Ada'), commit('b', 'Ada'), label('l'), commit('c', 'Ada'), commit('d', 'Ada')])
    expect(out.map((g) => g.group)).toEqual(['commits', 'single', 'commits'])
  })

  it('does not group a single commit', () => {
    const out = groupCommitRuns([commit('a', 'Ada')])
    expect(out).toEqual([{ group: 'single', entry: commit('a', 'Ada') }])
  })

  it('leaves a comment-only thread completely untouched', () => {
    const entries = [comment(1), comment(2)]
    expect(groupCommitRuns(entries)).toEqual(entries.map((entry) => ({ group: 'single', entry })))
  })

  it('handles an empty list', () => {
    expect(groupCommitRuns([])).toEqual([])
  })
})
