import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  ApiRun,
  ChangedFile,
  ChangesPayload,
  GithubReviewComment,
  GithubReviewCommentsData,
  HealthResponse,
} from '@open-mercato/cezar-api-client'

import { groupReviewThreads, placeReviewThreads } from './github-review-comments'
import { TaskChangesRoute } from './task-changes'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const NOTES: ChangedFile = {
  path: 'notes.md',
  status: 'added',
  adds: 2,
  dels: 0,
  binary: false,
  patch: 'diff --git a/notes.md b/notes.md\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+one\n+two\n',
}
const UTIL: ChangedFile = {
  path: 'src/a.ts',
  status: 'modified',
  adds: 2,
  dels: 1,
  binary: false,
  patch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n context\n-gone\n+one\n+two\n',
}
const FILES = [NOTES, UTIL]

let nextId = 100
const comment = (over: Partial<GithubReviewComment>): GithubReviewComment => {
  const id = over.id ?? nextId++
  return {
    id,
    author: 'ada',
    createdAt: '2026-11-01T00:00:00Z',
    body: 'a note',
    url: `https://github.com/acme/demo/pull/9#discussion_r${id}`,
    path: 'notes.md',
    side: 'new',
    line: 1,
    outdated: false,
    subjectType: 'line',
    ...over,
  }
}

describe('groupReviewThreads', () => {
  it('nests replies under their root and keeps an orphan reply as its own thread', () => {
    const threads = groupReviewThreads([
      comment({ id: 1 }),
      comment({ id: 2, inReplyTo: 1 }),
      comment({ id: 3, inReplyTo: 404 }),
    ])
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([[1, [2]], [3, []]])
  })
})

describe('placeReviewThreads', () => {
  const place = (comments: GithubReviewComment[]) => placeReviewThreads(groupReviewThreads(comments), FILES)

  it('anchors RIGHT on the new line and LEFT on the removed line', () => {
    const placed = place([comment({ id: 1, line: 2 }), comment({ id: 2, path: 'src/a.ts', side: 'old', line: 2 })])
    expect(placed.anchored.get('gh-1')?.anchor).toMatchObject({ path: 'notes.md', side: 'new', line: 2 })
    expect(placed.anchored.get('gh-2')?.anchor).toMatchObject({ path: 'src/a.ts', side: 'old', line: 2 })
    expect(placed.offDiff).toEqual([])
  })

  it('maps an old-side comment on a context line to the row the diff draws', () => {
    const placed = place([comment({ id: 1, path: 'src/a.ts', side: 'old', line: 1 })])
    expect(placed.anchored.get('gh-1')?.anchor).toMatchObject({ side: 'new', line: 1 })
  })

  it('carries the start of a range', () => {
    const placed = place([comment({ id: 1, line: 2, startLine: 1, startSide: 'new' })])
    expect(placed.anchored.get('gh-1')?.anchor.start).toEqual({ side: 'new', line: 1 })
  })

  it('lists outdated, file-level and off-hunk threads instead of dropping them', () => {
    const placed = place([
      comment({ id: 1, line: undefined, originalLine: 3, outdated: true }),
      comment({ id: 2, subjectType: 'file', line: undefined }),
      comment({ id: 3, line: 40 }),
      comment({ id: 4, path: 'elsewhere.ts', line: 1 }),
    ])
    expect(placed.anchored.size).toBe(0)
    expect(placed.offDiff.map((o) => [o.thread.root.id, o.reason])).toEqual([
      [1, 'outdated'],
      [2, 'file'],
      [3, 'not-in-diff'],
      [4, 'not-in-diff'],
    ])
  })
})

// ---- the Changes tab -------------------------------------------------------------------------

const RUN: ApiRun = {
  id: 'r1',
  title: 'with a PR',
  workflow: 'quick-task',
  task: 'x',
  status: 'review',
  createdAt: '2026-07-15T08:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  worktreePath: '/tmp/wt/r1',
  branch: 'cez/abc12345',
  baseBranch: 'main',
  pullRequestUrl: 'https://github.com/acme/demo/pull/9',
  steps: [],
}
const HEALTH: HealthResponse = {
  version: '0.0.0-test',
  runtimeId: '00000000-0000-4000-8000-000000000001',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  checks: [],
  defaultRunner: 'claude',
  forge: { kind: 'github', available: true },
  capabilities: { localHandoff: true, terminal: false, designMode: false, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, phonePairing: false, singleProject: false, automations: false, webhooks: false, dispatch: false },
}
const CHANGES: ChangesPayload = { files: FILES, stat: { adds: 4, dels: 1, files: 2 } }

const REVIEW: GithubReviewCommentsData = {
  available: true,
  comments: [
    comment({ id: 1, author: 'ada', line: 2, body: 'Use **bold** here', resolved: false }),
    comment({ id: 2, author: 'lin', inReplyTo: 1, line: 2, body: 'Agreed' }),
    comment({ id: 3, path: 'src/a.ts', side: 'old', line: 2, body: 'why removed?' }),
    comment({ id: 4, line: undefined, originalLine: 7, outdated: true, body: 'stale', diffHunk: '@@ -0,0 +1 @@\n+old' }),
    comment({ id: 5, path: 'other.ts', line: 3, body: 'not here' }),
  ],
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubFetch(run: ApiRun, review: GithubReviewCommentsData = REVIEW): string[] {
  const paths: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      paths.push(path)
      if (path.includes('/review-comments')) return json(review)
      if (path === '/api/v1/runs/r1') return json(run)
      if (path === '/api/v1/runs/r1/changes') return json(CHANGES)
      if (path === '/api/v1/health') return json(HEALTH)
      if (path === '/api/v1/runs') return json([])
      return json({})
    }),
  )
  return paths
}

function renderRoute() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/tasks/r1/changes']}>
        <Routes>
          <Route path="/tasks/:id/changes" element={<TaskChangesRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const rowThread = (path: string, attr: 'data-new-line' | 'data-old-line', line: number) => {
  const row = document.querySelector(`[data-slot="diff-file"][data-path="${path}"] [data-slot="diff-line"][${attr}="${line}"]`)
  return row?.nextElementSibling ?? null
}

describe('GitHub review comments on the Changes tab', () => {
  it('draws a thread under its line with its reply, read-only and linked to GitHub', async () => {
    const paths = stubFetch(RUN)
    renderRoute()
    await waitFor(() => expect(rowThread('notes.md', 'data-new-line', 2)?.querySelector('[data-slot="gh-review-thread"]')).toBeTruthy())
    const thread = rowThread('notes.md', 'data-new-line', 2)!.querySelector('[data-slot="gh-review-thread"]')!
    await waitFor(() => expect(thread.querySelector('[data-slot="gh-review-body"]')?.textContent).toContain('Use bold here'))
    expect(thread.querySelectorAll('[data-slot="gh-review-replies"] [data-slot="gh-review-comment"]')).toHaveLength(1)
    expect(thread.querySelector('a[href="https://github.com/acme/demo/pull/9#discussion_r1"]')).not.toBeNull()
    expect(thread.querySelector('button')).toBeNull()
    // Nothing on line 1, and the GitHub thread is not one of the user's own comments.
    expect(rowThread('notes.md', 'data-new-line', 1)?.querySelector('[data-slot="gh-review-thread"]') ?? null).toBeNull()
    expect(document.querySelector('[data-slot="diff-line-comment"]')).toBeNull()
    expect(document.querySelector('[data-slot="diff-line"][data-new-line="2"]')?.getAttribute('data-mark')).toBe('external')
    expect(paths.some((p) => p.includes('/github/prs/9/review-comments'))).toBe(true)
  })

  it('places a LEFT comment under the removed line', async () => {
    stubFetch(RUN)
    renderRoute()
    await waitFor(() =>
      expect(rowThread('src/a.ts', 'data-old-line', 2)?.querySelector('[data-slot="gh-review-thread"]')).not.toBeNull(),
    )
  })

  it('lists outdated and off-diff threads in their own group, with the original line and a link', async () => {
    stubFetch(RUN)
    renderRoute()
    const group = await waitFor(() => {
      const el = document.querySelector('[data-slot="gh-review-off-diff"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(group.querySelector('summary')?.textContent).toContain('2 GitHub comments not on this diff')
    const notes = group.querySelector('[data-slot="gh-review-off-diff-file"][data-path="notes.md"]')!
    expect(notes.textContent).toContain('originally line 7')
    expect(notes.querySelector('[data-slot="gh-review-hunk"]')?.textContent).toContain('+old')
    expect(notes.querySelector('a[href="https://github.com/acme/demo/pull/9#discussion_r4"]')).not.toBeNull()
    expect(group.querySelector('[data-slot="gh-review-off-diff-file"][data-path="other.ts"]')).not.toBeNull()
  })

  it('collapses a resolved thread to its summary', async () => {
    stubFetch(RUN, { available: true, comments: [comment({ id: 1, line: 1, resolved: true })] })
    renderRoute()
    const thread = await waitFor(() => {
      const el = rowThread('notes.md', 'data-new-line', 1)?.querySelector('[data-slot="gh-review-thread"]')
      expect(el).toBeTruthy()
      return el as HTMLDetailsElement
    })
    expect(thread.open).toBe(false)
    expect(thread.querySelector('summary')?.textContent).toContain('Resolved')
  })

  it('says so quietly when GitHub is unavailable', async () => {
    stubFetch(RUN, { available: false, reason: 'gh CLI not found', comments: [] })
    renderRoute()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-review-unavailable"]')?.textContent).toContain('gh CLI not found'),
    )
  })

  it('asks for nothing when the task has no PR', async () => {
    const paths = stubFetch({ ...RUN, pullRequestUrl: undefined })
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(2))
    expect(paths.some((p) => p.includes('review-comments'))).toBe(false)
    expect(document.querySelector('[data-slot="gh-review-thread"]')).toBeNull()
  })
})
