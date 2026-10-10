import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type { ChangesPayload, GithubData, HealthResponse, RepoCommitPayload, RepoResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { ShellWithSidebar } from '@/test/shell-with-sidebar'

import { RepoGitRoute } from './repo-git'

beforeEach(() => {
  // Radix menus, popovers and the Select in jsdom: floating-ui wants a ResizeObserver, and the
  // Select scrolls its chosen item into view on open.
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

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
  capabilities: { localHandoff: true, terminal: true, preview: true, designMode: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, dispatch: false },
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
      if (method === 'GET' && path === '/api/v1/repo/commit/abc1234?structured=1') return jsonResponse(COMMIT)
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(HEALTH)
      if (method === 'GET' && path === '/api/v1/github?limit=20') return jsonResponse(GITHUB)
      return jsonResponse({})
    }),
  )
  return sent
}

/** Cold-load the repo view at a URL, with the same route map routes.tsx registers — inside a
 *  shell with a mounted contextual sidebar, which is where the section switch and each section's
 *  list (the changed-files tree, the commit log, the branches) live. */
function renderAt(entry: string) {
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <ShellWithSidebar>
        <Routes>
          <Route path="/git" element={<RepoGitRoute tab="changes" />} />
          <Route path="/git/commits" element={<RepoGitRoute tab="commits" />} />
          <Route path="/git/commits/:sha" element={<RepoGitRoute tab="commits" />} />
          <Route path="/git/branches" element={<RepoGitRoute tab="branches" />} />
        </Routes>
        </ShellWithSidebar>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const sidebar = () => document.querySelector<HTMLElement>('[data-slot="context-sidebar-body"]')!
/** The titles of the empty/error states on screen (shadcn `Empty`: a title, not a heading). */
const emptyTitles = () =>
  [...document.querySelectorAll('[data-slot="centered-state"] [data-slot="empty-title"]')].map((el) => el.textContent)

// ---- changes ----------------------------------------------------------------------------------

describe('the repo view Changes segment', () => {
  it('renders the header, the segment tabs and the working-tree diff from /api/v1/repo/changes', async () => {
    stubFetch()
    renderAt('/git')

    await waitFor(() => expect(document.querySelector('[data-slot="repo-header"]')).not.toBeNull())
    // The header — title, checked-out branch, section switch — leads the contextual sidebar; the
    // page's own heading names the section.
    expect(sidebar().querySelector('[data-slot="repo-header"]')).not.toBeNull()
    expect(within(sidebar()).getByRole('heading', { level: 2 }).textContent).toBe('Git')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Uncommitted changes')
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
    ])

    // The SAME tree + facade the task Changes tab uses: compacted folder, per-file ±.
    await waitFor(() => expect(document.querySelector('[data-slot="changes-tree"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="tree-dir"]')?.textContent).toContain('src/util')
    // …in a scroller of its own, so a long list never drags the diff down with it. That used
    // to be a bounded pane beside the diff; it is the sidebar's content area now, which scrolls
    // independently of main by construction.
    await waitFor(() => expect(document.querySelector('[data-slot="changes-tree-pane"]')).not.toBeNull())
    const pane = document.querySelector('[data-slot="changes-tree-pane"]') as HTMLElement
    expect(sidebar().contains(pane)).toBe(true)
    expect(pane.querySelector('[data-slot="changes-tree"]')).not.toBeNull()
    const scroller = pane.closest('[data-slot="sidebar-content"]') as HTMLElement
    expect(scroller.className).toContain('overflow-auto')
    expect(scroller.className).toContain('min-h-0')
    expect(scroller.contains(document.querySelector('[data-slot="diff"]'))).toBe(false)
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
      expect(emptyTitles()).toContain('Working tree clean'),
    )
  })

  it('a 409 from /changes renders the server reason, not an error explosion', async () => {
    stubFetch({
      'GET /api/v1/repo/changes': () => jsonResponse({ error: 'not a git repository' }, 409),
    })
    renderAt('/git')
    await waitFor(() =>
      expect(emptyTitles()).toContain('No changes to show'),
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
      expect(emptyTitles()).toEqual(['Not a git repository']),
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

    // The log is the sidebar's list. (Main repeats it for phones, where the sidebar is a closed
    // sheet, so the rows are counted where a desktop user reads them.)
    const log = document.querySelector('[data-slot="repo-commits"]') as HTMLElement
    expect(sidebar().contains(log)).toBe(true)
    expect(document.querySelector('[data-slot="commit-pick"]')?.textContent).toContain('Pick a commit')
    const rows = [...log.querySelectorAll('[data-slot="commit-row"]')].map((row) => ({
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
      expect(emptyTitles()).toContain('Commit not found'),
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
      expect(emptyTitles()).toContain('No file changes'),
    )
  })
})

// ---- branches ----------------------------------------------------------------------------------

describe('the repo view Branches segment', () => {
  /** A branch's actions sit behind its row's "…" menu (Radix opens it on pointerDown). */
  async function openBranchActions(branch: string) {
    await waitFor(() => expect(document.querySelector('[data-slot="repo-branch-list"]')).not.toBeNull())
    fireEvent.pointerDown(screen.getByRole('button', { name: `Actions for ${branch}` }))
    await screen.findByRole('menu')
    return document.querySelector<HTMLElement>('[data-action="switch-branch"]')!
  }
  async function closeMenu() {
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  }
  /** Open the "New branch" popover and hand back its name field. */
  async function openCreate() {
    fireEvent.click(await screen.findByRole('button', { name: 'New branch' }))
    return (await screen.findByLabelText('New branch name')) as HTMLInputElement
  }
  const basePicker = () => screen.findByRole('combobox', { name: 'Agents’ base branch' })

  it('lists branches with the checkout marked current and the rest switchable', async () => {
    stubFetch()
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-branch-list"]')).not.toBeNull())

    const current = document.querySelector('[data-slot="branch-row"][data-branch="main"]')
    expect(current?.querySelector('[data-slot="branch-current"]')).not.toBeNull()
    const other = document.querySelector('[data-slot="branch-row"][data-branch="feature"]')
    expect(other?.querySelector('[data-slot="branch-current"]')).toBeNull()

    // Every row carries the same actions menu; "Switch" is disabled on the checkout itself.
    const onCurrent = await openBranchActions('main')
    expect(onCurrent.textContent).toBe('Switch to this branch')
    expect(onCurrent.getAttribute('aria-disabled')).toBe('true')
    await closeMenu()
    const onOther = await openBranchActions('feature')
    expect(onOther.getAttribute('aria-disabled')).not.toBe('true')
    await closeMenu()

    // The sidebar's list marks the checkout too.
    const menu = sidebar().querySelector('[data-slot="repo-branch-menu"]') as HTMLElement
    expect([...menu.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['feature', 'mainCurrent'])
  })

  it('Switch POSTs /api/v1/repo/branch and toasts the outcome', async () => {
    const sent = stubFetch({
      'POST /api/v1/repo/branch': () => jsonResponse({ branch: 'feature', created: false }),
    })
    const client = renderAt('/git/branches')

    fireEvent.click(await openBranchActions('feature'))
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
    // The filter is the sidebar's; the toolbar repeats it for phones, and both are one state.
    const filter = await waitFor(() => within(sidebar()).getByLabelText('Filter branches'))
    const picker = await basePicker()

    fireEvent.change(filter, { target: { value: 'FEAT' } })
    expect(document.querySelector('[data-slot="branch-row"][data-branch="feature"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="branch-row"][data-branch="main"]')).toBeNull()
    expect(screen.getAllByLabelText<HTMLInputElement>('Filter branches').map((input) => input.value)).toEqual(['FEAT', 'FEAT'])
    expect([...sidebar().querySelectorAll('[data-slot="repo-branch-menu"] li')].map((li) => li.textContent)).toEqual(['feature'])
    // A shadcn Select: its options exist only while it is open (keyboard — jsdom has no pointer).
    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Follow checked-out branch (default)',
      'feature',
      'main',
    ])
    fireEvent.keyDown(listbox, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())

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

    fireEvent.click(await openBranchActions('feature'))
    const refusal = await screen.findByText(/Your local changes to the following files/)
    // The danger toast, in git's own words.
    expect(refusal.closest('[data-sonner-toast]')?.getAttribute('data-type')).toBe('error')
  })

  it('the create form POSTs the new name and clears on success', async () => {
    const sent = stubFetch({
      'POST /api/v1/repo/branch': () => jsonResponse({ branch: 'fresh-idea', created: true }),
    })
    renderAt('/git/branches')
    const input = await openCreate()

    // Empty name → the button stays disabled; nothing fires.
    expect((document.querySelector('[data-action="create-branch"]') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'fresh-idea' } })
    fireEvent.click(document.querySelector('[data-action="create-branch"]')!)
    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST' && r.path === '/api/v1/repo/branch')
      expect(post?.body).toEqual({ name: 'fresh-idea' })
    })
    await waitFor(() => expect(document.body.textContent).toContain('Created and switched to fresh-idea'))
    // Success closes the popover, and the field is empty the next time it opens.
    await waitFor(() => expect(document.querySelector('[data-slot="branch-create"]')).toBeNull())
    expect((await openCreate()).value).toBe('')
  })

  it('the base-branch picker PUTs /api/v1/config with the chosen branch (and null to clear)', async () => {
    // A config route that remembers what it was told, so the repo refetch each write triggers
    // reads the new base back — the picker is controlled by the payload, not by the click.
    let baseBranch: string | null = null
    const sent: SentRequest[] = stubFetch({
      'PUT /api/v1/config': () => {
        baseBranch = (sent.at(-1)?.body as { baseBranch: string | null }).baseBranch
        return jsonResponse({ baseBranch, defaultRunner: 'claude' })
      },
      'GET /api/v1/repo': () => jsonResponse({ ...REPO, baseBranch }),
    })
    renderAt('/git/branches')
    const picker = await basePicker()
    // baseBranch: null = follow checked-out branch
    expect(picker.textContent).toContain('Follow checked-out branch (default)')

    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'feature' }))
    const puts = () => sent.filter((r) => r.method === 'PUT' && r.path === '/api/v1/config')
    await waitFor(() => expect(puts().map((put) => put.body)).toEqual([{ baseBranch: 'feature' }]))
    await waitFor(() => expect(document.body.textContent).toContain('Agents now branch from feature'))

    // …and "follow the checked-out branch" clears it with an explicit null.
    await waitFor(() => expect(picker.textContent).toContain('feature'))
    expect(document.querySelector('[data-branch="feature"] [data-slot="branch-base"]')).not.toBeNull()
    fireEvent.keyDown(await basePicker(), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Follow checked-out branch (default)' }))
    await waitFor(() => expect(puts().map((put) => put.body)).toEqual([{ baseBranch: 'feature' }, { baseBranch: null }]))
    await waitFor(() => expect(document.body.textContent).toContain('Agents now fork from the checked-out branch'))
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
