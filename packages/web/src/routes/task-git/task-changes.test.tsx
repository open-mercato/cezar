import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, ChangesPayload, HealthResponse, RepoResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import type { GitActionBar } from '@/lib/git-actions'

import { GitToolbar } from './git-toolbar'
import { TaskChangesRoute } from './task-changes'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const RUN: ApiRun = {
  id: 'r1',
  title: 'do the thing plz',
  titleSummary: 'Do the thing',
  workflow: 'quick-task',
  task: 'Summarize what this project does.',
  status: 'review',
  createdAt: '2026-07-15T08:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  worktreePath: '/tmp/wt/r1',
  branch: 'cez/abc12345',
  baseBranch: 'main',
  steps: [
    { id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's-1' },
  ],
}

const HEALTH: HealthResponse = {
  version: '0.0.0-test',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  checks: [],
  defaultRunner: 'claude',
  forge: { kind: 'github', available: true },
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false },
}

/** The PROJECT-scoped `/repo` answer. The remote that gates Push is read from here rather than
 *  from `health.repo`, which describes the boot folder only (#791). */
const REPO: RepoResponse = {
  info: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  status: [],
  log: [],
  branches: ['main'],
  baseBranch: null,
}

const CHANGES: ChangesPayload = {
  files: [
    {
      path: 'notes.md',
      status: 'added',
      adds: 2,
      dels: 0,
      binary: false,
      patch: 'diff --git a/notes.md b/notes.md\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    },
    {
      path: 'src/util/a.ts',
      status: 'modified',
      adds: 3,
      dels: 1,
      binary: false,
      patch:
        'diff --git a/src/util/a.ts b/src/util/a.ts\n--- a/src/util/a.ts\n+++ b/src/util/a.ts\n@@ -1,2 +1,4 @@\n context\n-gone\n+one\n+two\n+three\n',
    },
  ],
  stat: { adds: 5, dels: 1, files: 2 },
}

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (review-panel.test.tsx): records requests, serves the run,
 *  health and changes fixtures, and lets a test override specific `METHOD path` keys. */
function stubFetch(overrides: Record<string, () => Response> = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/runs/r1') return jsonResponse(RUN)
      if (method === 'GET' && path === '/api/v1/runs/r1/changes') return jsonResponse(CHANGES)
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(HEALTH)
      if (method === 'GET' && path === '/api/v1/repo') return jsonResponse(REPO)
      if (method === 'GET' && path === '/api/v1/runs') return jsonResponse([])
      return jsonResponse({})
    }),
  )
  return sent
}

function renderChangesRoute() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/tasks/r1/changes']}>
        <Routes>
          <Route path="/tasks/:id/changes" element={<TaskChangesRoute />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const toolbarAction = (id: string) =>
  document.querySelector(`[data-slot="git-toolbar"] [data-action="${id}"]`) as HTMLButtonElement | null

// ---- the route -------------------------------------------------------------------------------

describe('the Changes tab route', () => {
  it('renders the run header with the Changes tab active and all tabs deep-linkable', async () => {
    stubFetch()
    renderChangesRoute()
    await waitFor(() => expect(document.querySelector('[data-slot="run-header"]')).not.toBeNull())

    const tabs = [...document.querySelectorAll('[data-slot="run-tabs"] a')].map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
      current: a.getAttribute('aria-current'),
    }))
    expect(tabs).toEqual([
      { text: 'Session', href: '/tasks/r1', current: null },
      { text: 'Changes', href: '/tasks/r1/changes', current: 'page' },
      { text: 'Commits', href: '/tasks/r1/commits', current: null },
      { text: 'Files', href: '/tasks/r1/files', current: null },
    ])
  })

  it('builds the tree (compacted folders, per-file ±) and renders the diff beside it', async () => {
    stubFetch()
    renderChangesRoute()

    await waitFor(() => expect(document.querySelector('[data-slot="changes-tree"]')).not.toBeNull())
    // src/util is a pure chain → one compacted row.
    const dir = document.querySelector('[data-slot="tree-dir"]') as HTMLElement
    expect(dir.textContent).toContain('src/util')
    expect(dir.textContent).toContain('+3')
    expect(dir.textContent).toContain('−1')
    const fileRows = [...document.querySelectorAll('[data-slot="tree-file"]')].map((el) => el.textContent)
    expect(fileRows.some((t) => t?.includes('a.ts'))).toBe(true)
    expect(fileRows.some((t) => t?.includes('notes.md'))).toBe(true)

    // The facade renders both files (the engine chunk is lazy — wait for it).
    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(2))
    // The aggregate animated stat shows the payload's totals.
    expect(document.querySelector('[data-slot="changes-stat"]')?.textContent).toContain('+5')
    expect(document.querySelector('[data-slot="changes-stat"]')?.textContent).toContain('−1')
    // Collapsing a folder folds its rows.
    fireEvent.click(dir)
    expect(document.querySelectorAll('[data-slot="tree-file"]')).toHaveLength(1)
  })

  // The tree column is its OWN scroller. Sticky alone left a tree taller than the viewport
  // growing the PAGE, so reaching its last file meant dragging the shared `main` scroller — and
  // the diff with it — all the way down. jsdom lays nothing out, so the classes are all this can
  // check; the real-layout proof (the pane overflows, and scrolling it leaves `main` where it
  // was) lives in `e2e/diff-scroll.e2e.ts`.
  it('gives the tree column its own bounded scroller, not the page’s', async () => {
    stubFetch()
    renderChangesRoute()

    await waitFor(() => expect(document.querySelector('[data-slot="changes-tree-pane"]')).not.toBeNull())
    const pane = document.querySelector('[data-slot="changes-tree-pane"]') as HTMLElement
    // Bounded by the room left under the sticky chrome — an unbounded pane cannot scroll at all.
    expect(pane.className).toContain('max-h-[calc(100dvh_-_var(--diff-sticky-top)_-_1rem)]')
    expect(pane.className).toContain('overflow-y-auto')
    // …and a wheel that bottoms out inside the tree must not chain into the diff.
    expect(pane.className).toContain('overscroll-contain')
    // The cap is measured from the offset the pane is actually pinned at (`top-40` = 10rem).
    expect(pane.className).toContain('sticky top-40')
    expect(pane.parentElement?.className).toContain('[--diff-sticky-top:10rem]')
  })

  it('shows the empty state when the worktree is clean', async () => {
    stubFetch({
      'GET /api/v1/runs/r1/changes': () => jsonResponse({ files: [], stat: { adds: 0, dels: 0, files: 0 } }),
    })
    renderChangesRoute()
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'No changes yet' })).toBeTruthy(),
    )
    // Commit has nothing to do — disabled, and it says why.
    expect(toolbarAction('commit')?.disabled).toBe(true)
    expect(toolbarAction('commit')?.title).toContain('no changes to commit')
  })

  it('explains what a repointed review worktree is showing', async () => {
    stubFetch({
      'GET /api/v1/runs/r1/changes': () =>
        jsonResponse({
          files: [],
          stat: { adds: 0, dels: 0, files: 0 },
          repointedHead: { headBranch: 'review/pr-42', taskBranch: 'cez/abc12345' },
        }),
    })
    renderChangesRoute()

    await waitFor(() => expect(document.querySelector('[data-slot="repointed-head-note"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="repointed-head-note"]')?.textContent).toContain(
      "HEAD is on review/pr-42, not this task's branch cez/abc12345 — showing only what this task changed there.",
    )
  })

  it('a 409 ("no worktree") renders the server reason and disables the git actions', async () => {
    stubFetch({
      'GET /api/v1/runs/r1/changes': () =>
        jsonResponse({ error: 'no worktree — this task ran directly in the repo working tree' }, 409),
    })
    renderChangesRoute()
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'No changes to show' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="centered-state"]')?.textContent).toContain('no worktree')
    expect(toolbarAction('commit')?.disabled).toBe(true)
    expect(toolbarAction('push')?.disabled).toBe(true)
    expect(toolbarAction('create-pr')?.disabled).toBe(true)
  })

  it('commit flow: dialog prefilled with the auto-summary, POSTs the edited message, toasts the sha', async () => {
    const sent = stubFetch({
      'POST /api/v1/runs/r1/git/commit': () => jsonResponse({ committed: true, sha: 'abc1234def5678' }),
    })
    renderChangesRoute()
    await waitFor(() => expect(toolbarAction('commit')?.disabled).toBe(false))

    fireEvent.click(toolbarAction('commit')!)
    const box = (await screen.findByLabelText('Commit message')) as HTMLTextAreaElement
    // Prefilled from the run's display title (titleSummary wins over the raw title).
    expect(box.value).toBe('Do the thing')

    fireEvent.change(box, { target: { value: 'feat: polished commit message' } })
    fireEvent.click(document.querySelector('[data-slot="commit-confirm"]')!)

    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/git/commit')
      expect(post?.body).toEqual({ message: 'feat: polished commit message' })
    })
    await waitFor(() => expect(document.body.textContent).toContain('Committed abc1234'))
    await waitFor(() => expect(screen.queryByLabelText('Commit message')).toBeNull())
  })

  it('a commit 409 surfaces git’s own words as a danger toast and keeps the dialog open', async () => {
    stubFetch({
      'POST /api/v1/runs/r1/git/commit': () =>
        jsonResponse({ error: 'nothing to commit — the working tree is clean' }, 409),
    })
    renderChangesRoute()
    await waitFor(() => expect(toolbarAction('commit')?.disabled).toBe(false))

    fireEvent.click(toolbarAction('commit')!)
    await screen.findByLabelText('Commit message')
    fireEvent.click(document.querySelector('[data-slot="commit-confirm"]')!)

    await waitFor(() =>
      expect(document.body.textContent).toContain('nothing to commit — the working tree is clean'),
    )
    expect(screen.queryByLabelText('Commit message')).not.toBeNull()
  })

  it('push clicks through to POST git/push and toasts the destination', async () => {
    const sent = stubFetch({
      'POST /api/v1/runs/r1/git/push': () =>
        jsonResponse({ pushed: true, branch: 'cez/abc12345', remote: 'origin', upstreamSet: true }),
    })
    renderChangesRoute()
    await waitFor(() => expect(toolbarAction('push')?.disabled).toBe(false))
    fireEvent.click(toolbarAction('push')!)
    await waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/git/push')).toBe(true),
    )
    await waitFor(() =>
      expect(document.body.textContent).toContain('Pushed cez/abc12345 to origin (upstream set)'),
    )
  })

  // #791: `/api/v1/health` reports the boot folder, so a cezar booted outside a git repo answered
  // `repo: null` and Push went dark for every project. The remote must come from the
  // project-scoped `/repo` instead.
  it('offers Push from the project remote even when the boot folder has no git repo', async () => {
    stubFetch({
      'GET /api/v1/health': () => jsonResponse({ ...HEALTH, repo: null }),
    })
    renderChangesRoute()
    await waitFor(() => expect(toolbarAction('push')?.disabled).toBe(false))
  })

  it('Create PR uses the existing /pr flow and flips to View PR once the record carries the URL', async () => {
    let record: ApiRun = RUN
    const sent = stubFetch({
      'POST /api/v1/runs/r1/pr': () => {
        // The server completes the run with the PR badge; the invalidated refetch sees it.
        record = { ...RUN, status: 'done', pullRequestUrl: 'https://github.com/acme/demo/pull/9' }
        return jsonResponse({ url: 'https://github.com/acme/demo/pull/9', dryRun: true }, 201)
      },
      'GET /api/v1/runs/r1': () => jsonResponse(record),
    })
    renderChangesRoute()
    await waitFor(() => expect(toolbarAction('create-pr')?.disabled).toBe(false))

    fireEvent.click(toolbarAction('create-pr')!)
    await waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/pr')).toBe(true),
    )
    await waitFor(() => {
      const link = document.querySelector('[data-slot="git-toolbar"] a[data-action="view-pr"]')
      expect(link?.getAttribute('href')).toBe('https://github.com/acme/demo/pull/9')
    })
    expect(toolbarAction('create-pr')).toBeNull()
  })

  it('hosted mode (localHandoff: false) hides the overflow menu entirely', async () => {
    stubFetch({
      'GET /api/v1/health': () =>
        jsonResponse({ ...HEALTH, capabilities: { localHandoff: false } }),
    })
    renderChangesRoute()
    await waitFor(() => expect(document.querySelector('[data-slot="git-toolbar"]')).not.toBeNull())
    await waitFor(() => expect(toolbarAction('commit')?.disabled).toBe(false))
    expect(document.querySelector('[aria-label="More git actions"]')).toBeNull()
  })

  it('local mode offers the terminal handoff in the overflow menu', async () => {
    stubFetch()
    renderChangesRoute()
    await waitFor(() =>
      expect(document.querySelector('[aria-label="More git actions"]')).not.toBeNull(),
    )
  })
})

// ---- the toolbar as a pure projector of policy fixtures ---------------------------------------

describe('GitToolbar renders policy fixtures verbatim', () => {
  const noop = () => {}
  const renderToolbar = (bar: GitActionBar) =>
    render(
      <GitToolbar
        bar={bar}
        branch="cez/abc12345"
        stat={{ adds: 12, dels: 3, files: 2 }}
        mode="unified"
        wrap={false}
        onModeChange={noop}
        onWrapChange={noop}
        onAction={noop}
      />,
    )

  it('disabled entries render disabled with the policy reason as the tooltip', () => {
    renderToolbar({
      primary: { id: 'commit', label: 'Commit', enabled: false, reason: 'Commit unavailable — no changes to commit' },
      secondary: [
        { id: 'push', label: 'Push', enabled: false, reason: 'Push unavailable — no remote configured' },
      ],
      menu: [],
    })
    const commit = toolbarAction('commit')!
    expect(commit.disabled).toBe(true)
    expect(commit.title).toBe('Commit unavailable — no changes to commit')
    const push = toolbarAction('push')!
    expect(push.disabled).toBe(true)
    expect(push.title).toBe('Push unavailable — no remote configured')
    // No menu entries → no kebab at all.
    expect(document.querySelector('[aria-label="More git actions"]')).toBeNull()
  })

  it('view-pr renders as a real external link carrying the policy href', () => {
    renderToolbar({
      primary: { id: 'view-pr', label: 'View PR', enabled: true, href: 'https://github.com/acme/demo/pull/7' },
      secondary: [{ id: 'commit', label: 'Commit', enabled: true }],
      menu: [],
    })
    const link = document.querySelector('a[data-action="view-pr"]')!
    expect(link.getAttribute('href')).toBe('https://github.com/acme/demo/pull/7')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('view-pr with a non-http href renders disabled, not as a clickable no-op (#431)', () => {
    const onAction = vi.fn()
    render(
      <GitToolbar
        bar={{
          primary: { id: 'view-pr', label: 'View PR', enabled: true, href: 'javascript:void(0)' },
          secondary: [],
          menu: [],
        }}
        mode="unified"
        wrap={false}
        onModeChange={noop}
        onWrapChange={noop}
        onAction={onAction}
      />,
    )
    // No link at all — and the fallback button is inert, with the reason as its tooltip.
    expect(document.querySelector('a[data-action="view-pr"]')).toBeNull()
    const button = toolbarAction('view-pr')!
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('View PR unavailable')
    fireEvent.click(button)
    expect(onAction).not.toHaveBeenCalled()
  })

  it('shows the branch chip and the aggregate ± stat', () => {
    renderToolbar({ primary: { id: 'commit', label: 'Commit', enabled: true }, secondary: [], menu: [] })
    expect(document.querySelector('[data-slot="branch-chip"]')?.textContent).toContain('cez/abc12345')
    const stat = document.querySelector('[data-slot="changes-stat"]')?.textContent
    expect(stat).toContain('+12')
    expect(stat).toContain('−3')
  })

  it('the unified/split and wrap toggles reflect and report their state', () => {
    const onModeChange = vi.fn()
    const onWrapChange = vi.fn()
    render(
      <GitToolbar
        bar={{ primary: { id: 'commit', label: 'Commit', enabled: true }, secondary: [], menu: [] }}
        mode="unified"
        wrap={false}
        onModeChange={onModeChange}
        onWrapChange={onWrapChange}
        onAction={noop}
      />,
    )
    const split = document.querySelector('[data-slot="diff-mode-toggle"] [data-mode="split"]')!
    expect(split.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(split)
    expect(onModeChange).toHaveBeenCalledWith('split')
    fireEvent.click(document.querySelector('[data-slot="wrap-toggle"]')!)
    expect(onWrapChange).toHaveBeenCalledWith(true)
  })
})
