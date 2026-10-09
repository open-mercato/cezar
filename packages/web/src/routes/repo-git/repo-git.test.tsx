import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type {
  ChangesPayload,
  GithubData,
  HealthResponse,
  RepoCommitPayload,
  RepoResponse,
  RepoTree,
  WorktreeEntry,
} from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { RepoGitRoute } from './repo-git'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const REPO: RepoResponse = {
  info: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  status: [],
  log: [
    { hash: 'abc1234', subject: 'feat: add the thing', author: 'Ada', when: '2 hours ago' },
    { hash: 'def5678', subject: 'fix: stop the bug', author: 'Linus', when: '3 days ago' },
  ],
  branches: ['feature', 'main'],
  baseBranch: null,
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
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, dispatch: false },
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

/** The repository path index behind the Files sub-tab (#1279) — a compactable chain, a sibling
 *  folder, a root dotfile and a markdown file, which is every tree case the tests need. */
const TREE: RepoTree = {
  paths: [
    '.gitignore',
    'README.md',
    'docs/guide.md',
    'packages/web/src/app.tsx',
    'packages/web/src/lib/x.ts',
  ],
  truncated: false,
}

const COMMIT: RepoCommitPayload = {
  sha: 'abc1234def5678abc1234def5678abc1234def56',
  subject: 'feat: add the thing',
  author: 'Ada',
  when: '2 hours ago',
  files: [CHANGES.files[0]!],
  stat: { adds: 2, dels: 0, files: 1 },
}

const GITHUB: GithubData = {
  available: true,
  repo: 'acme/demo',
  issues: [],
  prs: [
    {
      kind: 'pr',
      number: 7,
      title: 'Improve everything',
      author: 'ada',
      createdAt: '2026-07-15T08:00:00.000Z',
      labels: [],
      body: '',
      url: 'https://github.com/acme/demo/pull/7',
      comments: 0,
      checks: 'passing',
    },
  ],
}

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (task-changes.test.tsx): records requests, serves the repo
 *  fixtures, and lets a test override specific `METHOD path` keys. */
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
      if (method === 'GET' && path === '/api/v1/repo') return jsonResponse(REPO)
      if (method === 'GET' && path === '/api/v1/repo/changes') return jsonResponse(CHANGES)
      if (method === 'GET' && path === '/api/v1/repo/tree') return jsonResponse(TREE)
      if (method === 'GET' && path === '/api/v1/repo/commit/abc1234?structured=1') return jsonResponse(COMMIT)
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(HEALTH)
      if (method === 'GET' && path === '/api/v1/github?limit=20') return jsonResponse(GITHUB)
      return jsonResponse({})
    }),
  )
  return sent
}

/** Cold-load the repo view at a URL, with the same route map routes.tsx registers. */
function renderAt(entry: string) {
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/git" element={<RepoGitRoute tab="changes" />} />
          <Route path="/git/commits" element={<RepoGitRoute tab="commits" />} />
          <Route path="/git/commits/:sha" element={<RepoGitRoute tab="commits" />} />
          <Route path="/git/branches" element={<RepoGitRoute tab="branches" />} />
          <Route path="/git/files" element={<RepoGitRoute tab="files" />} />
          <Route path="/git/files/*" element={<RepoGitRoute tab="files" />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

// ---- changes ----------------------------------------------------------------------------------

describe('the repo view Changes segment', () => {
  it('renders the header, the segment tabs and the working-tree diff from /api/v1/repo/changes', async () => {
    stubFetch()
    renderAt('/git')

    await waitFor(() => expect(document.querySelector('[data-slot="repo-header"]')).not.toBeNull())
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Git')
    expect(document.querySelector('[data-slot="branch-chip"]')?.textContent).toContain('main')

    const tabs = [...document.querySelectorAll('[data-slot="repo-tabs"] a')].map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
      current: a.getAttribute('aria-current'),
    }))
    expect(tabs).toEqual([
      { text: 'Changes', href: '/git', current: 'page' },
      { text: 'Commits', href: '/git/commits', current: null },
      { text: 'Branches', href: '/git/branches', current: null },
      { text: 'Files', href: '/git/files', current: null },
    ])

    // The SAME tree + facade the task Changes tab uses: compacted folder, per-file ±.
    await waitFor(() => expect(document.querySelector('[data-slot="changes-tree"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="tree-dir"]')?.textContent).toContain('src/util')
    // …including its own bounded scroller, so a long list never drags the diff down with it.
    await waitFor(() => expect(document.querySelector('[data-slot="changes-tree-pane"]')).not.toBeNull())
    const pane = document.querySelector('[data-slot="changes-tree-pane"]') as HTMLElement
    expect(pane.className).toContain('overflow-y-auto')
    expect(pane.className).toContain('overscroll-contain')
    // …beside the diff's own scroller (the split layout: no height math, see task-changes.tsx).
    const diffPane = document.querySelector('[data-slot="diff-pane"]') as HTMLElement
    expect(diffPane.hasAttribute('data-diff-scroller')).toBe(true)
    expect(diffPane.className).toContain('md:overflow-y-auto')
    expect(document.querySelector('[data-route="repo-git"]')?.className).toContain('md:h-full')
    // Below md the diff scrolls in `main` under the repo header, which stays sticky at every
    // width, so its file headers must still park below that header there (and only there).
    expect(pane.parentElement?.className).toContain('max-md:[--diff-sticky-top:7rem]')
    expect(pane.parentElement?.className).not.toMatch(/(^|\s)(md:)?\[--diff-sticky-top/)
    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(2))
    expect(document.querySelector('[data-slot="changes-stat"]')?.textContent).toContain('+5')
    // The view toggles are the shared control, wired to the facade's mode.
    fireEvent.click(document.querySelector('[data-slot="diff-mode-toggle"] [data-mode="split"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="diff"]')?.getAttribute('data-mode')).toBe('split'),
    )
  })

  it('a clean tree renders the honest empty state', async () => {
    stubFetch({
      'GET /api/v1/repo/changes': () => jsonResponse({ files: [], stat: { adds: 0, dels: 0, files: 0 } }),
    })
    renderAt('/git')
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Working tree clean' })).toBeTruthy(),
    )
  })

  it('a 409 from /changes renders the server reason, not an error explosion', async () => {
    stubFetch({
      'GET /api/v1/repo/changes': () => jsonResponse({ error: 'not a git repository' }, 409),
    })
    renderAt('/git')
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'No changes to show' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="repo-changes"]')?.textContent).toContain('not a git repository')
  })

  it('below md the diff forces unified even when the toggle says split', async () => {
    // A non-desktop matchMedia: the forced-mobile rule must win over the local toggle state.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    stubFetch()
    renderAt('/git')
    await waitFor(() => expect(document.querySelector('[data-slot="diff"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-slot="diff-mode-toggle"] [data-mode="split"]')!)
    // Still unified: phones render one readable column, wrap on.
    expect(document.querySelector('[data-slot="diff"]')?.getAttribute('data-mode')).toBe('unified')
  })

  it('outside a git repository the whole view degrades honestly', async () => {
    stubFetch({
      'GET /api/v1/repo': () =>
        jsonResponse({ info: null, status: [], log: [], branches: [], baseBranch: null }),
    })
    renderAt('/git')
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Not a git repository' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="repo-tabs"]')).toBeNull()
  })
})

// ---- commits ----------------------------------------------------------------------------------

describe('the repo view Commits segment', () => {
  it('lists the recent commits from /api/v1/repo, each row deep-linking to its diff', async () => {
    stubFetch()
    renderAt('/git/commits')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-commits"]')).not.toBeNull())

    const rows = [...document.querySelectorAll('[data-slot="commit-row"]')].map((row) => ({
      href: row.getAttribute('href'),
      text: row.textContent,
    }))
    expect(rows).toHaveLength(2)
    expect(rows[0]?.href).toBe('/git/commits/abc1234')
    expect(rows[0]?.text).toContain('abc1234')
    expect(rows[0]?.text).toContain('feat: add the thing')
    expect(rows[0]?.text).toContain('Ada')
    expect(rows[1]?.href).toBe('/git/commits/def5678')
  })

  it('clicking a commit routes to /git/commits/:sha and renders the structured diff', async () => {
    stubFetch()
    renderAt('/git/commits')
    await waitFor(() => expect(document.querySelector('[data-slot="commit-row"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-slot="commit-row"][data-sha="abc1234"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="commit-meta"]')).not.toBeNull())

    // The commit's metadata and its full sha, from ?structured=1.
    const meta = document.querySelector('[data-slot="commit-meta"]')
    expect(meta?.textContent).toContain('feat: add the thing')
    expect(meta?.textContent).toContain('Ada')
    expect(meta?.textContent).toContain(COMMIT.sha)
    // The same <Diff> facade renders the commit's file.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="diff-file"][data-path="notes.md"]')).not.toBeNull(),
    )
    // And the way back is a link, not a dead end.
    expect(document.querySelector('[data-slot="commit-back"]')?.getAttribute('href')).toBe('/git/commits')
  })

  it('an unknown sha is a neutral "Commit not found" with the server reason', async () => {
    stubFetch({
      'GET /api/v1/repo/commit/nope999?structured=1': () =>
        jsonResponse({ error: 'unknown commit: nope999' }, 409),
    })
    renderAt('/git/commits/nope999')
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Commit not found' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="repo-commit"]')?.textContent).toContain('unknown commit: nope999')
  })

  it('a merge commit (zero files) says so instead of faking a diff', async () => {
    stubFetch({
      'GET /api/v1/repo/commit/abc1234?structured=1': () =>
        jsonResponse({ ...COMMIT, files: [], stat: { adds: 0, dels: 0, files: 0 } }),
    })
    renderAt('/git/commits/abc1234')
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'No file changes' })).toBeTruthy(),
    )
  })
})

// ---- branches ----------------------------------------------------------------------------------

describe('the repo view Branches segment', () => {
  it('lists branches with the checkout marked current and the rest switchable', async () => {
    stubFetch()
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-branch-list"]')).not.toBeNull())

    const current = document.querySelector('[data-slot="branch-row"][data-branch="main"]')
    expect(current?.querySelector('[data-slot="branch-current"]')).not.toBeNull()
    expect(current?.querySelector('[data-action="switch-branch"]')).toBeNull()

    const other = document.querySelector('[data-slot="branch-row"][data-branch="feature"]')
    expect(other?.querySelector('[data-slot="branch-current"]')).toBeNull()
    expect(other?.querySelector('[data-action="switch-branch"]')).not.toBeNull()
  })

  it('Switch POSTs /api/v1/repo/branch and toasts the outcome', async () => {
    const sent = stubFetch({
      'POST /api/v1/repo/branch': () => jsonResponse({ branch: 'feature', created: false }),
    })
    const client = renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-action="switch-branch"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-action="switch-branch"]')!)
    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST' && r.path === '/api/v1/repo/branch')
      expect(post?.body).toEqual({ name: 'feature' })
    })
    await waitFor(() => expect(document.body.textContent).toContain('Switched to feature'))
    await waitFor(() => expect(document.querySelector('[data-slot="branch-chip"]')?.textContent).toBe('feature'))
    await waitFor(() => expect(client.getQueryData<HealthResponse>(queryKeys.health)?.repo?.branch).toBe('feature'))
  })

  it('filters branch rows without narrowing the base-branch picker', async () => {
    stubFetch()
    renderAt('/git/branches')
    const filter = await screen.findByLabelText('Filter branches')
    const picker = (await screen.findByLabelText('Agents’ base branch')) as HTMLSelectElement

    fireEvent.change(filter, { target: { value: 'FEAT' } })
    expect(document.querySelector('[data-slot="branch-row"][data-branch="feature"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="branch-row"][data-branch="main"]')).toBeNull()
    expect([...picker.options].map((option) => option.value)).toEqual(['', 'feature', 'main'])

    fireEvent.change(filter, { target: { value: 'missing' } })
    expect(document.querySelector('[data-slot="branch-empty"]')?.textContent).toContain(
      'No branches match “missing”.',
    )
  })

  it('a switch 409 surfaces git’s own reason as a danger toast', async () => {
    stubFetch({
      'POST /api/v1/repo/branch': () =>
        jsonResponse({ error: 'Your local changes to the following files would be overwritten by checkout' }, 409),
    })
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-action="switch-branch"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-action="switch-branch"]')!)
    await waitFor(() =>
      expect(document.body.textContent).toContain('Your local changes to the following files'),
    )
  })

  it('the create form POSTs the new name and clears on success', async () => {
    const sent = stubFetch({
      'POST /api/v1/repo/branch': () => jsonResponse({ branch: 'fresh-idea', created: true }),
    })
    renderAt('/git/branches')
    const input = (await screen.findByLabelText('New branch name')) as HTMLInputElement

    // Empty name → the button stays disabled; nothing fires.
    expect((document.querySelector('[data-action="create-branch"]') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'fresh-idea' } })
    fireEvent.click(document.querySelector('[data-action="create-branch"]')!)
    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST' && r.path === '/api/v1/repo/branch')
      expect(post?.body).toEqual({ name: 'fresh-idea' })
    })
    await waitFor(() => expect(document.body.textContent).toContain('Created and switched to fresh-idea'))
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('the base-branch picker PUTs /api/v1/config with the chosen branch (and null to clear)', async () => {
    const sent = stubFetch({
      'PUT /api/v1/config': () => jsonResponse({ baseBranch: 'feature', defaultRunner: 'claude' }),
    })
    renderAt('/git/branches')
    const picker = (await screen.findByLabelText('Agents’ base branch')) as HTMLSelectElement
    expect(picker.value).toBe('') // baseBranch: null = follow checked-out branch

    fireEvent.change(picker, { target: { value: 'feature' } })
    await waitFor(() => {
      const put = sent.find((r) => r.method === 'PUT' && r.path === '/api/v1/config')
      expect(put?.body).toEqual({ baseBranch: 'feature' })
    })
    await waitFor(() => expect(document.body.textContent).toContain('Agents now branch from feature'))
  })

  it('forge available: the PR rows render with links and checks badges', async () => {
    stubFetch()
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-prs"]')).not.toBeNull())

    await waitFor(() => expect(document.querySelector('[data-slot="pr-row"]')).not.toBeNull())
    const link = document.querySelector('[data-slot="pr-row"] a')
    expect(link?.getAttribute('href')).toBe('https://github.com/acme/demo/pull/7')
    expect(link?.textContent).toContain('#7')
    expect(link?.textContent).toContain('Improve everything')
    const badge = document.querySelector('[data-slot="pr-checks"]')
    expect(badge?.getAttribute('data-checks')).toBe('passing')
  })

  it('no forge driver: the PR section does not render and /api/v1/github is never fetched', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': () => jsonResponse({ ...HEALTH, forge: null }),
    })
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-branch-list"]')).not.toBeNull())
    // Give the health query time to settle, then assert the honest absence.
    await waitFor(() => expect(sent.some((r) => r.path === '/api/v1/health')).toBe(true))
    expect(document.querySelector('[data-slot="repo-prs"]')).toBeNull()
    expect(sent.some((r) => r.path.startsWith('/api/v1/github'))).toBe(false)
  })

  it('forge detected but unreachable: the section renders the reason instead of rows', async () => {
    stubFetch({
      'GET /api/v1/health': () =>
        jsonResponse({ ...HEALTH, forge: { kind: 'github', available: false, reason: 'gh not logged in' } }),
    })
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-branch-list"]')).not.toBeNull())
    // available:false gates the section off entirely — PR links would all be dead ends.
    expect(document.querySelector('[data-slot="repo-prs"]')).toBeNull()
  })
})

// ---- files (#1279) -----------------------------------------------------------------------------

/** One file entry from `GET /api/v1/repo/files`. */
const fileEntry = (path: string, content: string): WorktreeEntry => ({
  type: 'file',
  path,
  size: content.length,
  binary: false,
  tooLarge: false,
  content,
})

const filePath = (path: string) => `/api/v1/repo/files?path=${encodeURIComponent(path)}`

describe('the repo view Files segment', () => {
  it('builds the tree from one /api/v1/repo/tree read, folders closed, chains compacted', async () => {
    const sent = stubFetch()
    renderAt('/git/files')

    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())

    const dirs = [...document.querySelectorAll('[data-slot="repo-files-dir"]')].map((el) => ({
      path: el.getAttribute('data-path'),
      text: el.textContent,
      state: el.getAttribute('data-state'),
    }))
    // `packages/web/src` is a single-child chain — one row, not three indent levels.
    expect(dirs).toEqual([
      { path: 'docs', text: 'docs', state: 'closed' },
      { path: 'packages/web/src', text: 'packages/web/src', state: 'closed' },
    ])
    // Root files render; nothing inside a closed folder does.
    expect([...document.querySelectorAll('[data-slot="repo-files-file"]')].map((el) => el.getAttribute('data-path')))
      .toEqual(['.gitignore', 'README.md'])

    // ONE tree request backs the whole view — no per-folder fetch.
    expect(sent.filter((r) => r.path === '/api/v1/repo/tree')).toHaveLength(1)
    expect(document.querySelector('[data-slot="repo-files-truncated"]')).toBeNull()
  })

  it('expanding a folder costs no request and reveals its children', async () => {
    const sent = stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())
    const before = sent.length

    fireEvent.click(document.querySelector('[data-slot="repo-files-dir"][data-path="docs"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="repo-files-file"][data-path="docs/guide.md"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-slot="repo-files-dir"][data-path="docs"]')?.getAttribute('data-state')).toBe('open')
    expect(sent.length).toBe(before)
  })

  it('selecting a file puts it in the URL and previews its highlighted content', async () => {
    stubFetch({
      [`GET ${filePath('README.md')}`]: () => jsonResponse(fileEntry('README.md', 'const x = 1\n')),
    })
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-slot="repo-files-file"][data-path="README.md"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-head"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="file-preview-head"]')?.textContent).toContain('README.md')
  })

  it('a deep link selects the file and expands its ancestors', async () => {
    stubFetch({
      [`GET ${filePath('packages/web/src/lib/x.ts')}`]: () =>
        jsonResponse(fileEntry('packages/web/src/lib/x.ts', 'export const x = 1\n')),
    })
    renderAt('/git/files/packages/web/src/lib/x.ts')

    await waitFor(() =>
      expect(document.querySelector('[data-slot="repo-files-file"][data-path="packages/web/src/lib/x.ts"]')).not.toBeNull(),
    )
    const chain = document.querySelector('[data-slot="repo-files-dir"][data-path="packages/web/src"]')
    expect(chain?.getAttribute('data-state')).toBe('open')
    expect(document.querySelector('[data-slot="repo-files-dir"][data-path="packages/web/src/lib"]')?.getAttribute('data-state'))
      .toBe('open')
    expect(
      document.querySelector('[data-slot="repo-files-file"][data-path="packages/web/src/lib/x.ts"]')
        ?.getAttribute('aria-current'),
    ).toBe('true')
    // The closed sibling stays closed — only the selection's ancestors open.
    expect(document.querySelector('[data-slot="repo-files-dir"][data-path="docs"]')?.getAttribute('data-state')).toBe('closed')
  })

  it("the server's 409 for a non-indexed path is shown as an answer, not an outage", async () => {
    stubFetch({
      [`GET ${filePath('README.md')}`]: () =>
        jsonResponse({ error: 'path is not in the repository index: README.md' }, 409),
    })
    renderAt('/git/files/README.md')
    await waitFor(() => expect(screen.getByText('Cannot preview this file')).not.toBeNull())
    expect(screen.getByText('path is not in the repository index: README.md')).not.toBeNull()
  })

  it('renders a .md file as markdown by default, with a toggle to the source', async () => {
    stubFetch({
      [`GET ${filePath('docs/guide.md')}`]: () =>
        jsonResponse(fileEntry('docs/guide.md', '# Heading\n\n- one\n- two\n')),
    })
    renderAt('/git/files/docs/guide.md')

    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-markdown"]')).not.toBeNull())
    // Real elements, not the raw text: the heading and the list are parsed.
    expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).not.toBeNull()
    expect(document.querySelectorAll('[data-slot="file-preview-markdown"] li')).toHaveLength(2)

    fireEvent.click(document.querySelector('[data-slot="markdown-view-toggle"] [data-mode="source"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-code"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="file-preview-code"]')?.textContent).toContain('# Heading')

    // …and back, so the toggle is a real two-way control.
    fireEvent.click(document.querySelector('[data-slot="markdown-view-toggle"] [data-mode="rendered"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-markdown"]')).not.toBeNull())
  })

  it('a non-markdown file gets no view toggle at all', async () => {
    stubFetch({
      [`GET ${filePath('packages/web/src/app.tsx')}`]: () =>
        jsonResponse(fileEntry('packages/web/src/app.tsx', 'export const App = () => null\n')),
    })
    renderAt('/git/files/packages/web/src/app.tsx')
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-code"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="markdown-view-toggle"]')).toBeNull()
  })

  it('a truncated index says so above the tree', async () => {
    stubFetch({
      'GET /api/v1/repo/tree': () => jsonResponse({ paths: TREE.paths, truncated: true }),
    })
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-truncated"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="repo-files-truncated"]')?.textContent).toContain('has more')
  })

  it('an empty index is an honest empty state, not a blank pane', async () => {
    stubFetch({ 'GET /api/v1/repo/tree': () => jsonResponse({ paths: [], truncated: false }) })
    renderAt('/git/files')
    await waitFor(() => expect(screen.getByText('No files yet')).not.toBeNull())
    expect(document.querySelector('[data-slot="repo-files-tree"]')).toBeNull()
  })

  it('a 409 from /repo/tree is the view-level answer, same stance as the Changes tab', async () => {
    stubFetch({
      'GET /api/v1/repo/tree': () => jsonResponse({ error: 'not a git repository' }, 409),
    })
    renderAt('/git/files')
    await waitFor(() => expect(screen.getByText('No files to browse')).not.toBeNull())
  })
})

// ---- the filter box and keyboard access (#1279 Phase 2) ----------------------------------------

const filterInput = () => document.querySelector('[data-slot="repo-files-filter"]') as HTMLInputElement
const rowPaths = () =>
  [...document.querySelectorAll('[data-slot="repo-files-file"], [data-slot="repo-files-dir"]')].map((el) =>
    el.getAttribute('data-path'),
  )

describe('the repo Files filter', () => {
  it('flattens to full paths as you type, and Escape restores the tree', async () => {
    stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-filter"]')).not.toBeNull())

    // A subsequence spanning three directories — the case that justifies subsequence matching.
    fireEvent.change(filterInput(), { target: { value: 'weblibx' } })
    await waitFor(() =>
      expect(document.querySelector('[data-slot="repo-files-tree"]')?.getAttribute('data-filtering')).toBe('true'),
    )
    // A result list of FULL paths — not a filtered hierarchy that hides the match behind a
    // collapsed ancestor — and no folder rows at all.
    expect(rowPaths()).toEqual(['packages/web/src/lib/x.ts'])
    expect(document.querySelector('[data-slot="repo-files-file"]')?.textContent).toBe('packages/web/src/lib/x.ts')

    fireEvent.keyDown(filterInput(), { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-dir"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="repo-files-tree"]')?.getAttribute('data-filtering')).toBeNull()
  })

  it('selecting a filtered result opens the file', async () => {
    stubFetch({
      [`GET ${filePath('docs/guide.md')}`]: () => jsonResponse(fileEntry('docs/guide.md', '# G\n')),
    })
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-filter"]')).not.toBeNull())

    fireEvent.change(filterInput(), { target: { value: 'guide' } })
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-file"][data-path="docs/guide.md"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-slot="repo-files-file"][data-path="docs/guide.md"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-head"]')?.textContent).toContain('docs/guide.md'))
  })

  it('caps the rendered matches and says how many more there are', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `src/file-${String(i).padStart(3, '0')}.ts`)
    stubFetch({ 'GET /api/v1/repo/tree': () => jsonResponse({ paths: many, truncated: false }) })
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-filter"]')).not.toBeNull())

    fireEvent.change(filterInput(), { target: { value: 'file' } })
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-more"]')).not.toBeNull())
    expect(document.querySelectorAll('[data-slot="repo-files-file"]')).toHaveLength(200)
    expect(document.querySelector('[data-slot="repo-files-more"]')?.textContent).toContain('50 more')
  })

  it('no match says so, naming the query, instead of an empty pane', async () => {
    stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-filter"]')).not.toBeNull())

    fireEvent.change(filterInput(), { target: { value: 'zzzzzzz' } })
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-no-match"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="repo-files-no-match"]')?.textContent).toContain('zzzzzzz')
    expect(document.querySelector('[data-slot="repo-files-tree"]')).toBeNull()
  })

  it('announces the result count in a polite live region', async () => {
    stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-count"]')).not.toBeNull())
    const count = document.querySelector('[data-slot="repo-files-count"]')!
    expect(count.getAttribute('aria-live')).toBe('polite')
    expect(count.textContent).toBe('5 files')

    fireEvent.change(filterInput(), { target: { value: 'md' } })
    await waitFor(() => expect(count.textContent).toContain('match md'))
  })

  it('`/` focuses the filter from the tree, and does not hijack typing inside it', async () => {
    stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())

    fireEvent.keyDown(document.querySelector('[data-slot="repo-files-tree"]')!, { key: '/' })
    await waitFor(() => expect(document.activeElement).toBe(filterInput()))
    // Already inside the input, `/` is just a character — the handler must not preventDefault it.
    expect(fireEvent.keyDown(filterInput(), { key: '/' })).toBe(true)
  })
})

describe('the repo Files tree keyboard access', () => {
  const tree = () => document.querySelector('[data-slot="repo-files-tree"]')!

  it('is a role=tree of treeitems with levels, aria-expanded and a roving tabindex', async () => {
    stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())

    expect(tree().getAttribute('role')).toBe('tree')
    expect(tree().getAttribute('aria-label')).toBe('Repository files')
    const dir = document.querySelector('[data-slot="repo-files-dir"][data-path="docs"]')!
    expect(dir.getAttribute('role')).toBe('treeitem')
    expect(dir.getAttribute('aria-expanded')).toBe('false')
    expect(dir.getAttribute('aria-level')).toBe('1')
    // Exactly one row is tabbable — the rest are reachable by arrow key.
    const tabbable = [...document.querySelectorAll('[role="treeitem"]')].filter((el) => el.getAttribute('tabindex') === '0')
    expect(tabbable).toHaveLength(1)
    expect(tree().getAttribute('aria-activedescendant')).toBe(tabbable[0]!.getAttribute('id'))
  })

  it('↓/↑ move the active row, →/← expand and collapse, Enter opens a file', async () => {
    stubFetch({
      [`GET ${filePath('.gitignore')}`]: () => jsonResponse(fileEntry('.gitignore', 'node_modules\n')),
    })
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())
    const activePath = () =>
      document.querySelector('[role="treeitem"][tabindex="0"]')?.getAttribute('data-path')

    // Rows: docs, packages/web/src, .gitignore, README.md.
    expect(activePath()).toBe('docs')
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    await waitFor(() => expect(activePath()).toBe('packages/web/src'))
    fireEvent.keyDown(tree(), { key: 'ArrowUp' })
    await waitFor(() => expect(activePath()).toBe('docs'))

    // → opens the folder, → again steps into it, ← comes back out to the parent.
    fireEvent.keyDown(tree(), { key: 'ArrowRight' })
    await waitFor(() => expect(document.querySelector('[data-path="docs"]')?.getAttribute('data-state')).toBe('open'))
    fireEvent.keyDown(tree(), { key: 'ArrowRight' })
    await waitFor(() => expect(activePath()).toBe('docs/guide.md'))
    fireEvent.keyDown(tree(), { key: 'ArrowLeft' })
    await waitFor(() => expect(activePath()).toBe('docs'))
    fireEvent.keyDown(tree(), { key: 'ArrowLeft' })
    await waitFor(() => expect(document.querySelector('[data-path="docs"]')?.getAttribute('data-state')).toBe('closed'))

    // Enter on a file selects it.
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    await waitFor(() => expect(activePath()).toBe('.gitignore'))
    fireEvent.keyDown(tree(), { key: 'Enter' })
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-head"]')?.textContent).toContain('.gitignore'))
  })

  it('↑ at the top and ↓ at the bottom stay put rather than wrapping or crashing', async () => {
    stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())
    const activePath = () =>
      document.querySelector('[role="treeitem"][tabindex="0"]')?.getAttribute('data-path')

    fireEvent.keyDown(tree(), { key: 'ArrowUp' })
    await waitFor(() => expect(activePath()).toBe('docs'))
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    await waitFor(() => expect(activePath()).toBe('README.md'))
  })
})
