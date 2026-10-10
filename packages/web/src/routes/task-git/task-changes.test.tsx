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
  capabilities: { localHandoff: true, terminal: true, preview: true, designMode: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, dispatch: false },
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

function renderChangesRoute(entry = '/tasks/r1/changes') {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
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
      // The transcript's tab is "Chat" now (it read "Session").
      { text: 'Chat', href: '/tasks/r1', current: null },
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
    // An OPEN folder is just its name: its files carry their own ±, so a total would repeat them.
    expect(dir.textContent).toBe('src/util')
    const fileRows = [...document.querySelectorAll('[data-slot="tree-file"]')].map((el) => el.textContent)
    expect(fileRows.some((t) => t?.includes('a.ts'))).toBe(true)
    expect(fileRows.some((t) => t?.includes('notes.md'))).toBe(true)
    const nested = document.querySelector('[data-slot="tree-file"][data-path="src/util/a.ts"]') as HTMLElement
    expect(nested.textContent).toContain('+3')
    expect(nested.textContent).toContain('−1')
    expect(nested.querySelector('[data-slot="tree-status"]')?.getAttribute('data-status')).toBe('modified')

    // The facade renders both files (the engine chunk is lazy — wait for it).
    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(2))
    // The aggregate animated stat shows the payload's totals.
    expect(document.querySelector('[data-slot="changes-stat"]')?.textContent).toContain('+5')
    expect(document.querySelector('[data-slot="changes-stat"]')?.textContent).toContain('−1')
    // Collapsing a folder folds its rows — and the folder row then says what it holds.
    fireEvent.click(dir)
    expect(document.querySelectorAll('[data-slot="tree-file"]')).toHaveLength(1)
    expect(dir.textContent).toContain('+3')
    expect(dir.textContent).toContain('−1')
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
    // The floating composer dock sits OVER the pane, so the list pads its end by the dock's height
    // (0 while no dock shows) — its last files can still be scrolled up above the box.
    expect(pane.className).toContain('pb-[var(--changes-dock,0px)]')
    expect(pane.parentElement?.style.getPropertyValue('--changes-dock')).toBe('0px')
    expect(pane.className).toContain('overflow-y-auto')
    // …and a wheel that bottoms out inside the tree must not chain into the diff.
    expect(pane.className).toContain('overscroll-contain')
    // The cap is measured from the offset the pane is actually pinned at (`top-40` = 10rem).
    expect(pane.className).toContain('sticky top-40')
    expect(pane.parentElement?.className).toContain('[--diff-sticky-top:0px]')
    expect(pane.parentElement?.className).toContain('md:[--diff-sticky-top:10rem]')
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

  it('hosted mode (localHandoff: false, terminal: false) hides the overflow menu entirely', async () => {
    stubFetch({
      'GET /api/v1/health': () =>
        jsonResponse({ ...HEALTH, capabilities: { localHandoff: false, terminal: false } }),
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

// ---- line comments (self-review) ------------------------------------------------------------

/** A drafts listing holding `stored` as the run's diff comments. */
const diffCommentsDraft = (stored: unknown[]) =>
  jsonResponse({
    surfaces: {
      'diff-comments': { text: JSON.stringify(stored), images: [], updatedAt: '2026-10-02T00:00:00.000Z' },
    },
  })

describe('the Changes tab line comments', () => {
  /**
   * The draft hook seeds only a PRISTINE input, so a comment added before the stored list arrived
   * would mark it dirty, skip the seed, and write a one-item list over every stored comment.
   */
  it('offers "+" only once the stored comments have loaded, and adding keeps them', async () => {
    const stored = [{ id: 'old', path: 'notes.md', side: 'new', line: 1, body: 'keep me', excerpt: 'one' }]
    let release: () => void = () => {}
    const draftsLoaded = new Promise<void>((resolve) => (release = resolve))
    const sent = stubFetch({
      'GET /api/v1/runs/r1/drafts': (() =>
        draftsLoaded.then(() =>
          diffCommentsDraft(stored),
        )) as unknown as () => Response,
    })
    renderChangesRoute()

    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(2))
    expect(document.querySelector('[data-slot="diff-add-comment"]')).toBeNull()

    release()
    await screen.findByText('keep me')
    fireEvent.click(document.querySelector('[data-slot="diff-add-comment"]')!)
    const editor = screen.getByPlaceholderText('Add a comment for the AI')
    fireEvent.change(editor, { target: { value: 'and this' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => {
      const put = sent.filter((r) => r.method === 'PUT' && r.path === '/api/v1/runs/r1/drafts/diff-comments').at(-1)
      expect(put).toBeDefined()
      const written = JSON.parse((put!.body as { text: string }).text) as { body: string }[]
      expect(written.map((c) => c.body)).toEqual(['keep me', 'and this'])
    })
  })

  it('edits a drafted comment in place', async () => {
    const stored = [{ id: 'c1', path: 'notes.md', side: 'new', line: 1, body: 'remove this', excerpt: 'one' }]
    const sent = stubFetch({
      'GET /api/v1/runs/r1/drafts': () =>
        diffCommentsDraft(stored),
    })
    renderChangesRoute()

    await screen.findByText('remove this')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = screen.getByDisplayValue('remove this')
    fireEvent.change(editor, { target: { value: 'remove this import' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText('remove this import')
    await waitFor(() => {
      const put = sent.filter((r) => r.method === 'PUT' && r.path === '/api/v1/runs/r1/drafts/diff-comments').at(-1)
      expect(JSON.parse((put!.body as { text: string }).text)).toEqual([{ ...stored[0], body: 'remove this import' }])
    })
  })

  it('offers no "+" when the stored comments could not be read — there is no list to add to', async () => {
    stubFetch({ 'GET /api/v1/runs/r1/drafts': () => jsonResponse({ error: 'boom' }, 500) })
    renderChangesRoute()

    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(2))
    // Give the failed read time to settle, then make sure it did not open the gate.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.querySelector('[data-slot="diff-add-comment"]')).toBeNull()
  })

  it('accepts comments while the stored list fits, and refuses the one that crosses the cap — loudly, editor kept', async () => {
    // 27 × 3.5 kB serializes to 96 624 characters: UNDER DRAFT_TEXT_MAX (100 000), so the list
    // itself is a state the server really holds — it is the next big comment that crosses it.
    const stored = Array.from({ length: 27 }, (_, i) => ({
      id: `c${i}`,
      path: 'notes.md',
      side: 'new',
      line: 2,
      body: 'x'.repeat(3500),
      excerpt: 'two',
    }))
    expect(JSON.stringify(stored).length).toBeLessThan(100_000)
    const sent = stubFetch({ 'GET /api/v1/runs/r1/drafts': () => diffCommentsDraft(stored) })
    renderChangesRoute()
    const puts = () => sent.filter((r) => r.method === 'PUT' && r.path === '/api/v1/runs/r1/drafts/diff-comments')
    const commentOnLine1 = (text: string) => {
      const notes = [...document.querySelectorAll<HTMLElement>('[data-slot="diff-file"]')].find(
        (card) => card.dataset.path === 'notes.md',
      )!
      fireEvent.click(notes.querySelector('[aria-label="Comment on notes.md line 1"]')!)
      const editor = screen.getByPlaceholderText('Add a comment for the AI')
      fireEvent.change(editor, { target: { value: text } })
      fireEvent.keyDown(editor, { key: 'Enter' })
    }

    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-line-comment"]')).toHaveLength(27))

    // A small one still fits: kept, written, editor closed.
    commentOnLine1('short note')
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(document.querySelectorAll('[data-slot="diff-line-comment"]')).toHaveLength(28)
    expect(screen.queryByPlaceholderText('Add a comment for the AI')).toBeNull()

    // A big one would cross the cap: refused out loud, the editor keeps the text, nothing written.
    commentOnLine1('y'.repeat(3500))
    await screen.findByText(/Too many comments to keep as a draft/)
    expect((screen.getByPlaceholderText('Add a comment for the AI') as HTMLTextAreaElement).value).toHaveLength(3500)
    await new Promise((resolve) => setTimeout(resolve, 600)) // past the draft debounce
    expect(puts()).toHaveLength(1)
    expect(document.querySelectorAll('[data-slot="diff-line-comment"]')).toHaveLength(28)
  })

  it('shows how many comments each file holds in the sidebar, summed on a collapsed folder', async () => {
    const stored = [
      { id: 'a', path: 'src/util/a.ts', side: 'new', line: 2, body: 'one', excerpt: 'one' },
      { id: 'b', path: 'src/util/a.ts', side: 'new', line: 4, start: { side: 'new', line: 2 }, body: 'two', excerpt: '' },
      { id: 'c', path: 'notes.md', side: 'new', line: 1, body: 'three', excerpt: 'one' },
    ]
    stubFetch({ 'GET /api/v1/runs/r1/drafts': () => diffCommentsDraft(stored) })
    renderChangesRoute()

    const countOf = (selector: string) =>
      document.querySelector(`${selector} [data-slot="comment-count"]`)?.textContent ?? null
    await waitFor(() => expect(countOf('[data-slot="tree-file"][data-path="src/util/a.ts"]')).toBe('2'))
    expect(countOf('[data-slot="tree-file"][data-path="notes.md"]')).toBe('1')
    // An open folder adds nothing — its files already say it. Collapsed, it carries their total.
    expect(countOf('[data-slot="tree-dir"]')).toBeNull()
    fireEvent.click(document.querySelector('[data-slot="tree-dir"]')!)
    expect(countOf('[data-slot="tree-dir"]')).toBe('2')
    fireEvent.click(document.querySelector('[data-slot="tree-dir"]')!)
    expect(countOf('[data-slot="tree-dir"]')).toBeNull()
    expect(document.querySelector('[data-slot="tree-file"][data-path="notes.md"] [data-slot="comment-count"]')?.getAttribute('aria-label')).toBe('1 comment')
  })

})

// ---- the floating composer (self-review from the Changes tab) --------------------------------

describe('the Changes tab composer dock', () => {
  const PROVIDERS = () =>
    jsonResponse({ providers: [{ provider: 'claude', status: 'connected', enabled: true }] })
  const STORED = [{ id: 'c1', path: 'notes.md', side: 'new', line: 1, body: 'tighten this', excerpt: 'one' }]

  it('floats no composer while nothing is drafted — and loads nothing a composer would need', async () => {
    const sent = stubFetch({ 'GET /api/v1/providers/status': PROVIDERS })
    renderChangesRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(2))
    expect(document.querySelector('[data-slot="thread-dock"]')).toBeNull()
    // The continue engine (runner models, accounts, provider status) mounts with the dock only.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent.some((r) => r.path.startsWith('/api/v1/models'))).toBe(false)
  })

  it('reserves dock clearance on diff targets without applying it to the composer caret', async () => {
    // jsdom cannot reproduce Chromium's caret scrolling. Pin the layout contract here;
    // the browser regression is typing at a nonzero main.scrollTop with the dock visible.
    const main = document.createElement('main')
    main.dataset.slot = 'main'
    document.body.append(main)
    let resize: (() => void) | undefined
    let height = 150
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe(element: HTMLElement) {
        Object.defineProperty(element, 'offsetHeight', { get: () => height })
      }
      disconnect() {}
    })
    try {
      stubFetch({
        'GET /api/v1/providers/status': PROVIDERS,
        'GET /api/v1/runs/r1/drafts': () => diffCommentsDraft(STORED),
      })
      renderChangesRoute()
      await screen.findByText('notes.md +1')
      act(() => resize?.())
      const pane = document.querySelector<HTMLElement>('[data-slot="changes-tree-pane"]')!
      expect(pane.parentElement?.style.getPropertyValue('--changes-dock')).toBe('150px')
      expect(main.style.scrollPaddingBottom).toBe('')
      const diff = document.querySelector<HTMLElement>('[data-slot="diff"]')!
      expect(diff.className).toContain('[&_[data-slot=diff-comment-editor]]:scroll-mb-[var(--changes-dock,0px)]')
      const composer = document.querySelector<HTMLTextAreaElement>('[data-slot="thread-dock"] textarea')!
      fireEvent.change(composer, { target: { value: 'first line\nsecond line' } })
      height = 220
      act(() => resize?.())
      expect(pane.parentElement?.style.getPropertyValue('--changes-dock')).toBe('220px')
      expect(main.style.scrollPaddingBottom).toBe('')
    } finally {
      main.remove()
    }
  })

  it('loads the continue engine once the dock shows', async () => {
    const sent = stubFetch({
      'GET /api/v1/providers/status': PROVIDERS,
      'GET /api/v1/runs/r1/drafts': () => diffCommentsDraft(STORED),
    })
    renderChangesRoute()
    await screen.findByText('notes.md +1')
    await waitFor(() => expect(sent.some((r) => r.path.startsWith('/api/v1/models'))).toBe(true))
  })

  /** The whole loop without leaving the diff: the chips sit in the docked composer, a message can
   *  be written beside them, and one send carries both — then the comments are gone. */
  it('docks the session composer with the drafted comments, and sends them from here', async () => {
    const sent = stubFetch({
      'GET /api/v1/providers/status': PROVIDERS,
      'GET /api/v1/runs/r1/drafts': () => diffCommentsDraft(STORED),
    })
    renderChangesRoute()

    const chip = await screen.findByText('notes.md +1')
    const dock = chip.closest<HTMLElement>('[data-slot="thread-dock"]')!
    expect(dock).not.toBeNull()
    // Floating over the diff and the tree, not on a band of its own — clicks pass through around it.
    expect(dock.dataset.floating).toBe('true')
    expect(dock.className).toContain('pointer-events-none')
    expect(dock.className).not.toContain('bg-background')
    // The same composer the Session tab docks: same grammar, same placeholder family.
    const composer = dock.querySelector<HTMLTextAreaElement>('textarea')!
    fireEvent.change(composer, { target: { value: 'and run the tests' } })
    // RUN is at `review` with a resumable session — the send is a Continue.
    const send = dock.querySelector<HTMLButtonElement>('button[aria-label="Continue"]')!
    await waitFor(() => expect(send.disabled).toBe(false))
    fireEvent.click(send)

    await waitFor(() =>
      expect(sent.find((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/continue')?.body).toMatchObject({
        text: expect.stringMatching(/^and run the tests\n\nReview comments on the diff:\n\n- `notes.md` line 1:/),
      }),
    )
    await waitFor(() =>
      expect(
        sent.some(
          (r) =>
            r.method === 'PUT' &&
            r.path === '/api/v1/runs/r1/drafts/diff-comments' &&
            (r.body as { text?: string }).text === '',
        ),
      ).toBe(true),
    )
  })

  it('keeps the dock while a typed message is unsent, even after the last comment goes', async () => {
    stubFetch({
      'GET /api/v1/providers/status': PROVIDERS,
      'GET /api/v1/runs/r1/drafts': () => diffCommentsDraft(STORED),
    })
    renderChangesRoute()

    await screen.findByText('notes.md +1')
    const composer = document.querySelector<HTMLTextAreaElement>('[data-slot="thread-dock"] textarea')!
    fireEvent.change(composer, { target: { value: 'half-written' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment on notes.md line 1' }))

    expect(screen.queryByText('notes.md +1')).toBeNull()
    expect(document.querySelector<HTMLTextAreaElement>('[data-slot="thread-dock"] textarea')?.value).toBe('half-written')
  })

  it('keeps the dock through a text-only send, and back on failure', async () => {
    let fail: () => void = () => {}
    stubFetch({
      'GET /api/v1/providers/status': PROVIDERS,
      'GET /api/v1/runs/r1/drafts': () => diffCommentsDraft(STORED),
      'POST /api/v1/runs/r1/continue': (() =>
        new Promise<Response>((resolve) => (fail = () => resolve(jsonResponse({ error: 'nope' }, 500))))) as unknown as () => Response,
    })
    renderChangesRoute()
    await screen.findByText('notes.md +1')
    const composer = () => document.querySelector<HTMLTextAreaElement>('[data-slot="thread-dock"] textarea')
    fireEvent.change(composer()!, { target: { value: 'only words' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment on notes.md line 1' }))
    const send = document.querySelector<HTMLButtonElement>('[data-slot="thread-dock"] button[aria-label="Continue"]')!
    await waitFor(() => expect(send.disabled).toBe(false))
    fireEvent.click(send)

    // In flight: the composer cleared optimistically, but the dock stays to show the outcome.
    await waitFor(() => expect(composer()?.value).toBe(''))
    expect(document.querySelector('[data-slot="thread-dock"]')).not.toBeNull()
    act(() => fail())
    await waitFor(() => expect(composer()?.value).toBe('only words'))
  })

  it('never clears the typed message on an Alt quick reply', async () => {
    const sent = stubFetch({
      'GET /api/v1/providers/status': PROVIDERS,
      'GET /api/v1/runs/r1/drafts': () => diffCommentsDraft(STORED),
    })
    renderChangesRoute()
    await screen.findByText('notes.md +1')
    const composer = document.querySelector<HTMLTextAreaElement>('[data-slot="thread-dock"] textarea')!
    fireEvent.change(composer, { target: { value: 'still writing this' } })
    composer.blur()

    fireEvent.keyDown(window, { code: 'KeyC', key: 'c', altKey: true })

    await waitFor(() =>
      expect(sent.find((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/continue')?.body).toMatchObject({
        text: 'Continue.',
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(composer.value).toBe('still writing this')
    expect(screen.getByText('notes.md +1')).not.toBeNull()
  })

  it('does not pull the dock over the toolbar while the diff is still loading', async () => {
    stubFetch({
      'GET /api/v1/providers/status': PROVIDERS,
      'GET /api/v1/runs/r1/drafts': () => diffCommentsDraft(STORED),
      'GET /api/v1/runs/r1/changes': (() => new Promise<Response>(() => {})) as unknown as () => Response,
    })
    renderChangesRoute()
    const chip = await screen.findByText('notes.md +1')
    const dock = chip.closest<HTMLElement>('[data-slot="thread-dock"]')!
    expect(document.querySelector('[data-slot="changes-loading"]')).not.toBeNull()
    expect(dock.style.marginTop).toBe('')
  })

  it('a chip here jumps to its file rather than linking to the tab it is already on', async () => {
    stubFetch({
      'GET /api/v1/providers/status': PROVIDERS,
      'GET /api/v1/runs/r1/drafts': () => diffCommentsDraft(STORED),
    })
    renderChangesRoute()
    await screen.findByText('notes.md +1')
    // jsdom has no scrolling; record the jump instead.
    const scrolled = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrolled
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Show comment on notes.md line 1' }))
      expect(document.querySelector('[data-slot="tree-file"][data-path="notes.md"]')?.getAttribute('aria-current')).toBe('true')
      expect(scrolled).toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})

// ---- jumping to the exact comment or line ----------------------------------------------------

describe('the Changes tab reveals the exact spot', () => {
  const PROVIDERS = () =>
    jsonResponse({ providers: [{ provider: 'claude', status: 'connected', enabled: true }] })

  const flashed = () => [...document.querySelectorAll<HTMLElement>('[data-flash="true"]')]

  it('arriving from a link to a line, flashes that very line — not the top of its file', async () => {
    stubFetch({ 'GET /api/v1/providers/status': PROVIDERS })
    renderChangesRoute('/tasks/r1/changes?file=src%2Futil%2Fa.ts&side=new&line=3')

    await waitFor(() => expect(flashed()).toHaveLength(1), { timeout: 3000 })
    const row = flashed()[0]!
    expect(row.closest<HTMLElement>('[data-slot="diff-file"]')?.dataset.path).toBe('src/util/a.ts')
    expect(row.dataset.newLine).toBe('3')
    expect(row.textContent).toContain('two')
  })

  it('a chip in the docked composer flashes its own comment, not the first one in the file', async () => {
    const stored = [
      { id: 'first', path: 'src/util/a.ts', side: 'new', line: 2, body: 'the first one', excerpt: 'one' },
      { id: 'second', path: 'src/util/a.ts', side: 'new', line: 4, body: 'the second one', excerpt: 'three' },
    ]
    stubFetch({ 'GET /api/v1/providers/status': PROVIDERS, 'GET /api/v1/runs/r1/drafts': () => diffCommentsDraft(stored) })
    renderChangesRoute()
    await screen.findByText('the second one')

    fireEvent.click(screen.getByRole('button', { name: 'Show comment on src/util/a.ts line 4' }))

    await waitFor(() => expect(flashed()).toHaveLength(1))
    expect(flashed()[0]!.dataset.commentId).toBe('second')
  })
})

describe('the Changes tab composer dock and a Session draft', () => {
  it('does not float the composer just because a message is half-typed on the Session tab', async () => {
    stubFetch({
      'GET /api/v1/runs/r1/drafts': () =>
        jsonResponse({ surfaces: { composer: { text: 'half a reply', images: [], updatedAt: '2026-10-05T00:00:00.000Z' } } }),
    })
    renderChangesRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.querySelector('[data-slot="thread-dock"]')).toBeNull()
  })
})
