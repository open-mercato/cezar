import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ApiRun, HealthResponse, RepoCommitPayload, RunCommitsResponse } from '@open-mercato/cezar-api-client'

import { TaskCommitsRoute } from './task-commits'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const RUN: ApiRun = {
  id: 'r1',
  title: 'do the thing plz',
  workflow: 'quick-task',
  task: 'Summarize what this project does.',
  status: 'review',
  createdAt: '2026-07-15T08:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  worktreePath: '/tmp/wt/r1',
  branch: 'cez/abc12345',
  baseBranch: 'main',
  steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }],
}

const HEALTH: HealthResponse = {
  version: '0.0.0-test',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, dispatch: false },
}

const COMMITS: RunCommitsResponse = {
  commits: [
    { sha: 'aaaa1111', subject: 'first change', author: 'Ada', when: '2 hours ago' },
    { sha: 'bbbb2222', subject: 'second change', author: 'Ada', when: '1 hour ago' },
  ],
}

const commit = (sha: string, subject: string): RepoCommitPayload => ({
  sha,
  subject,
  author: 'Ada',
  when: '1 hour ago',
  files: [
    {
      path: `notes-${sha}.md`,
      status: 'added',
      adds: 2,
      dels: 0,
      binary: false,
      patch: `diff --git a/notes-${sha}.md b/notes-${sha}.md\n--- /dev/null\n+++ b/notes-${sha}.md\n@@ -0,0 +1,2 @@\n+one\n+two\n`,
    },
  ],
  stat: { adds: 2, dels: 0, files: 1 },
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/runs/r1') return jsonResponse(RUN)
      if (path === '/api/v1/runs/r1/commits') return jsonResponse(COMMITS)
      if (path === '/api/v1/runs/r1/commit/aaaa1111') return jsonResponse(commit('aaaa1111', 'first change'))
      if (path === '/api/v1/runs/r1/commit/bbbb2222') return jsonResponse(commit('bbbb2222', 'second change'))
      if (path === '/api/v1/health') return jsonResponse(HEALTH)
      if (path === '/api/v1/runs') return jsonResponse([])
      return jsonResponse({})
    }),
  )
}

function renderCommitsRoute(entry: string, client = createQueryClient(), extra: React.ReactNode = null) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/tasks/:id/commits" element={<TaskCommitsRoute />} />
          <Route path="/tasks/:id/commits/:sha" element={<TaskCommitsRoute />} />
        </Routes>
        {extra}
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// ---- the route -------------------------------------------------------------------------------

describe('the Commits tab route', () => {
  // One commit's diff scrolls in a column of its own under the run header (the md-and-up split
  // layout shared with the Changes tab), so a header of any height can never cover a file header
  // stuck to the top. jsdom lays nothing out: the classes and the marker are what this can check.
  it("gives one commit's diff its own scroll column", async () => {
    stubFetch()
    renderCommitsRoute('/tasks/r1/commits/aaaa1111')

    await screen.findByText('notes-aaaa1111.md')
    // The route fills `main`, so the column below the header has a height to scroll within.
    expect(document.querySelector('[data-route="task-commits"]')?.className).toContain('md:h-full')
    const pane = document.querySelector('[data-slot="diff-pane"]') as HTMLElement
    // The diff finds this column through the marker (jsdom counts as desktop).
    expect(pane.hasAttribute('data-diff-scroller')).toBe(true)
    expect(pane.className).toContain('md:min-h-0')
    expect(pane.className).toContain('md:flex-1')
    expect(pane.className).toContain('md:overflow-y-auto')
    // Vertical padding sits on the Diff, not on the scroller: sticky offsets count from the
    // scroller's padding edge, so padding there would park a stuck header below the top.
    expect(pane.className).not.toMatch(/(^|\s)(md:)?py-/)
    // No hard-coded offset under the run header any more.
    expect(pane.className).not.toContain('--diff-sticky-top')
  })

  it('leaves the commit LIST scrolling with the page', async () => {
    stubFetch()
    renderCommitsRoute('/tasks/r1/commits')

    await screen.findByText('first change')
    // Only an open commit fills `main`: the list is one long column and keeps the page scroller,
    // and with it the run header's sticky behaviour.
    expect(document.querySelector('[data-route="task-commits"]')?.className).not.toContain('md:h-full')
    expect(document.querySelector('[data-diff-scroller]')).toBeNull()
  })

  // The diff column is outside the shell's per-pathname reset of `main`, so another commit must
  // start in a fresh column at the top, even when its data is already cached and nothing on the
  // way unmounts.
  it('opens another commit in a fresh scroll column', async () => {
    stubFetch()
    const client = createQueryClient()
    client.setQueryData(queryKeys.runs.commit('r1', 'bbbb2222'), commit('bbbb2222', 'second change'))
    function GoToSecond() {
      const navigate = useNavigate()
      return <button type="button" data-testid="go-second" onClick={() => navigate('/tasks/r1/commits/bbbb2222')} />
    }
    renderCommitsRoute('/tasks/r1/commits/aaaa1111', client, <GoToSecond />)

    await screen.findByText('notes-aaaa1111.md')
    const before = document.querySelector('[data-slot="diff-pane"]')

    fireEvent.click(screen.getByTestId('go-second'))
    await screen.findByText('notes-bbbb2222.md')
    expect(document.querySelector('[data-slot="diff-pane"]')).not.toBe(before)
  })
})
