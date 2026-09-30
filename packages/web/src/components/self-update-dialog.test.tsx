import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SelfUpdateDevelopment, SelfUpdateStatus } from '@open-mercato/cezar-api-client'
import { workspaceQueryKeys } from '@/api/queries'
import { SelfUpdateDialog } from '@/components/self-update-dialog'

const applySelfUpdate = vi.hoisted(() => vi.fn())
const setSelfUpdateChannel = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  applySelfUpdate,
  setSelfUpdateChannel,
}))

const status: SelfUpdateStatus = {
  version: '0.12.0',
  installKind: 'managed',
  entry: '/home/u/.cezar/versions/current/node_modules/@open-mercato/cezar/dist/index.js',
  canSelfUpdate: true,
  channel: 'stable',
  restartMode: 'reexec',
  latest: { stable: '0.12.0', nightly: '0.12.0-nightly.20260927.60' },
  updateAvailable: null,
  checkedAt: '2026-09-28T08:04:09.000Z',
  installed: [
    { id: '0.12.0+local', version: '0.12.0', source: 'local', installedAt: '2026-09-28T08:00:00.000Z', active: true },
    { id: '0.11.1', version: '0.11.1', source: 'registry', installedAt: '2026-09-25T14:03:47.000Z', active: false },
  ],
  available: [
    { version: '0.12.0', channel: 'stable', publishedAt: '2026-09-27T10:00:00.000Z', installed: false },
    { version: '0.11.1', channel: 'stable', publishedAt: '2026-09-21T11:33:05.050Z', installed: true },
    { version: '0.12.0-nightly.20260927.60', channel: 'nightly', publishedAt: '2026-09-27T03:17:00.000Z', installed: false },
  ],
  job: null,
  activeRuns: 0,
}

const development: SelfUpdateDevelopment = {
  checkouts: [
    {
      id: '0.13.0+cez-abc',
      branch: 'cez/abc',
      version: '0.13.0',
      worktree: '/r/wt/abc',
      built: true,
      linked: true,
      commit: { sha: 'a1b2c3d', subject: 'fix(self-update): label worktrees', at: '2026-09-29T08:00:00.000Z' },
      builtAt: '2026-09-29T08:05:00.000Z',
      stale: false,
      task: { id: 'abc', title: 'Switch the desktop app to a worktree', status: 'review' },
      pr: 1170,
    },
    {
      id: '0.13.0+cez-def',
      branch: 'cez/def',
      version: '0.13.0',
      worktree: '/r/wt/def',
      built: true,
      linked: false,
      commit: { sha: 'd4e5f6a', subject: 'feat: landing check', at: '2026-09-29T07:00:00.000Z' },
      builtAt: '2026-09-29T06:00:00.000Z',
      stale: true,
      task: { id: 'def', title: 'Landing check core', status: 'done' },
      pr: null,
    },
    {
      id: '0.13.0+cez-ghi',
      branch: 'cez/ghi',
      version: '0.13.0',
      worktree: '/r/wt/ghi',
      built: false,
      linked: false,
      commit: null,
      builtAt: null,
      stale: false,
      task: null,
      pr: null,
    },
  ],
  pulls: {
    available: true,
    repo: 'open-mercato/cezar',
    items: [
      {
        number: 1169,
        title: 'feat(web): surface the landing-check verdict',
        author: 'michal-codes',
        branch: 'feat/landing-check-ui',
        draft: false,
        updatedAt: '2026-09-29T13:42:23Z',
        url: 'https://github.com/open-mercato/cezar/pull/1169',
        version: '0.13.0-pr1169.1300',
        publishedAt: '2026-09-29T13:50:00Z',
        installed: false,
      },
      {
        number: 1160,
        title: 'docs(adr): outbound PII guard',
        author: 'marcinorocz',
        branch: 'feat/outbound-pii-guard',
        draft: true,
        updatedAt: '2026-09-29T08:33:23Z',
        url: 'https://github.com/open-mercato/cezar/pull/1160',
        version: null,
        publishedAt: null,
        installed: false,
      },
    ],
  },
}

function renderDialog(
  overrides: Partial<SelfUpdateStatus> = {},
  props: { autoApply?: string; onOpenChange?: (open: boolean) => void; development?: SelfUpdateDevelopment } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(workspaceQueryKeys.selfUpdate, { ...status, ...overrides })
  queryClient.setQueryData(workspaceQueryKeys.selfUpdateDevelopment, props.development ?? development)
  return render(
    <QueryClientProvider client={queryClient}>
      <SelfUpdateDialog open onOpenChange={props.onOpenChange ?? (() => {})} autoApply={props.autoApply} />
    </QueryClientProvider>,
  )
}

// jsdom has no element scrolling; the job log scrolls itself to its last line.
Element.prototype.scrollTo = () => {}

describe('SelfUpdateDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // The dialog is opened to READ a version. Radix's default — focus the first focusable element —
  // lands on the close button and rings it; the panel takes the initial focus instead, which
  // keeps the focus trap (and Escape) working without highlighting any control.
  it('does not put the initial focus on the close button', async () => {
    renderDialog()
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    expect(document.activeElement).toBe(dialog)
    expect(document.activeElement?.tagName).not.toBe('BUTTON')
    // The close button is still there and reachable — only not pre-focused.
    expect(screen.getByRole('button', { name: /close/i })).toBeTruthy()
  })

  it('heads the dialog with the version and marks a local build', async () => {
    renderDialog()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('cezar v0.12.0')
    expect(dialog.textContent).toContain('local build')
    expect(screen.getByRole('radio', { name: 'Stable' }).getAttribute('aria-checked')).toBe('true')
  })

  // The title strip's one-click update. A restart interrupts running tasks, so the shortcut is
  // only a shortcut when there is nothing to interrupt.
  describe('autoApply', () => {
    const running = { status: 'running' as const, target: '0.12.1', startedAt: '2026-09-28T09:00:00.000Z', finishedAt: null, log: [] }

    it('starts the install at once when no task is running', async () => {
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
      applySelfUpdate.mockResolvedValue({ ...status, job: running })
      renderDialog({ activeRuns: 0 }, { autoApply: '0.12.1' })
      await waitFor(() => expect(applySelfUpdate).toHaveBeenCalledTimes(1))
      expect(applySelfUpdate.mock.calls[0]?.[0]).toBe('0.12.1')
    })

    it('waits for the button when tasks are running, with the warning on screen', async () => {
      applySelfUpdate.mockClear()
      renderDialog({ activeRuns: 2 }, { autoApply: '0.12.1' })
      const dialog = await screen.findByRole('dialog')
      expect(dialog.textContent).toContain('2 tasks are running')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(applySelfUpdate).not.toHaveBeenCalled()
    })
  })

  it('offers three channels, and development in place of the release picker', async () => {
    renderDialog({ channel: 'development' })
    const dialog = await screen.findByRole('dialog')
    expect(screen.getByRole('radio', { name: 'Development' }).getAttribute('aria-checked')).toBe('true')
    expect(dialog.querySelector('[data-slot="self-update-development"]')).toBeTruthy()
    expect(dialog.querySelector('[data-slot="self-update-picker"]')).toBeNull()
    // Development follows no tag: never "newest", never an update button.
    expect(dialog.textContent).not.toContain('newest')
    expect(screen.queryByRole('button', { name: /Update & restart/ })).toBeNull()
  })

  // Forty `cez/<id8>` branches are indistinguishable by name: each row leads with the task.
  it('tells worktrees apart by task, commit, PR and build state', async () => {
    renderDialog({
      channel: 'development',
      installed: [
        { id: '0.13.0+cez-abc', version: '0.13.0', source: 'link', branch: 'cez/abc', installedAt: '2026-09-29T08:00:00.000Z', active: true },
      ],
    })
    const list = await screen.findByRole('listbox', { name: 'Worktrees' })
    const rows = within(list).getAllByRole('option')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain('Switch the desktop app to a worktree')
    expect(rows[0]!.textContent).toContain('#1170')
    expect(rows[0]!.textContent).toContain('current')
    expect(rows[1]!.textContent).toContain('needs rebuild')
    expect(rows[1]!.textContent).toContain('d4e5f6a')
    expect(rows[2]!.textContent).toContain('not built')
    // Not built is pickable: the switch builds it first.
    expect(rows[2]!.getAttribute('aria-disabled')).toBe('false')
    expect(screen.getByText('worktree · cez/abc')).toBeTruthy()
  })

  it('builds an unbuilt worktree before switching, and rebuilds the running one on request', async () => {
    applySelfUpdate.mockClear()
    applySelfUpdate.mockReturnValue(new Promise(() => {}))
    renderDialog({
      channel: 'development',
      installed: [
        { id: '0.13.0+cez-def', version: '0.13.0', source: 'link', branch: 'cez/def', installedAt: '2026-09-29T08:00:00.000Z', active: true },
      ],
    })
    const rows = within(await screen.findByRole('listbox', { name: 'Worktrees' })).getAllByRole('option')
    fireEvent.click(rows[1]!)
    expect(screen.getByRole('button', { name: 'Rebuild & restart' })).toBeTruthy()
    fireEvent.click(rows[2]!)
    expect(screen.getByText(/Not built yet — runs npm run build in \/r\/wt\/ghi first/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Build & switch' }))
    await waitFor(() => expect(applySelfUpdate).toHaveBeenCalledTimes(1))
    expect(applySelfUpdate.mock.calls[0]?.[0]).toBe('0.13.0+cez-ghi')
  })

  it('filters worktrees by task title and switches to the picked one', async () => {
    applySelfUpdate.mockClear()
    applySelfUpdate.mockReturnValue(new Promise(() => {}))
    renderDialog({ channel: 'development' })
    fireEvent.change(await screen.findByRole('textbox', { name: 'Filter' }), { target: { value: 'landing' } })
    const rows = within(screen.getByRole('listbox', { name: 'Worktrees' })).getAllByRole('option')
    expect(rows).toHaveLength(1)
    fireEvent.click(rows[0]!)
    // Built before its last commit: the switch rebuilds it.
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild & switch' }))
    await waitFor(() => expect(applySelfUpdate).toHaveBeenCalledTimes(1))
    expect(applySelfUpdate.mock.calls[0]?.[0]).toBe('0.13.0+cez-def')
  })

  it('installs an open pull request\'s preview build, and lists one without a build as unpickable', async () => {
    applySelfUpdate.mockClear()
    applySelfUpdate.mockReturnValue(new Promise(() => {}))
    renderDialog({ channel: 'development' })
    fireEvent.click(await screen.findByRole('tab', { name: /Pull requests/ }))
    const list = screen.getByRole('listbox', { name: 'Pull requests' })
    // A PR without a build is hidden until asked for.
    expect(within(list).getAllByRole('option')).toHaveLength(1)
    fireEvent.click(within(list).getByRole('button', { name: /1 more without a preview build/ }))
    const rows = within(list).getAllByRole('option')
    expect(rows[1]!.textContent).toContain('no build')
    expect(rows[1]!.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(rows[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Install & restart' }))
    await waitFor(() => expect(applySelfUpdate).toHaveBeenCalledTimes(1))
    expect(applySelfUpdate.mock.calls[0]?.[0]).toBe('0.13.0-pr1169.1300')
  })

  // A user with no cezar clone registered has nothing to pick from locally.
  it('hides the Worktrees tab when no cezar worktree exists, and lists pull requests', async () => {
    renderDialog({ channel: 'development' }, { development: { ...development, checkouts: [] } })
    expect(await screen.findByRole('listbox', { name: 'Pull requests' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /Worktrees/ })).toBeNull()
    expect(screen.getByRole('tab', { name: /Pull requests/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('names a running PR build in the header and the card', async () => {
    renderDialog({
      version: '0.13.0-pr1169.1300',
      installed: [
        { id: '0.13.0-pr1169.1300', version: '0.13.0-pr1169.1300', source: 'registry', installedAt: '2026-09-29T14:00:00.000Z', active: true },
      ],
    })
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('PR #1169 build')
    expect(dialog.querySelector('[data-slot="self-update-latest"]')!.textContent).toContain('preview build of PR #1169, not a release.')
  })

  // A worktree shares its version number with the release it forked from; calling it "the
  // newest stable version" would vouch for code cezar never shipped.
  it('does not call a running worktree the newest release, and offers the way back', async () => {
    applySelfUpdate.mockClear()
    applySelfUpdate.mockReturnValue(new Promise(() => {}))
    renderDialog({
      version: '0.13.0',
      latest: { stable: '0.13.0', nightly: null },
      installed: [
        { id: '0.13.0+cez-abc', version: '0.13.0', source: 'link', branch: 'cez/abc', installedAt: '2026-09-29T08:00:00.000Z', active: true },
        { id: '0.13.0', version: '0.13.0', source: 'registry', installedAt: '2026-09-29T07:00:00.000Z', active: false },
      ],
    })
    const card = (await screen.findByRole('dialog')).querySelector('[data-slot="self-update-latest"]')!
    expect(card.textContent).not.toContain('newest stable version')
    expect(card.textContent).toContain('Running worktree cez/abc, not a release.')
    expect(card.textContent).toContain('Newest stable: v0.13.0')
    fireEvent.click(screen.getByRole('button', { name: 'Back to v0.13.0' }))
    await waitFor(() => expect(applySelfUpdate).toHaveBeenCalledTimes(1))
    expect(applySelfUpdate.mock.calls[0]?.[0]).toBe('0.13.0')
  })

  // "Back to" promises a version already on disk; a nightly never installed is a download.
  it('offers to install the newest release when it is not on disk', async () => {
    applySelfUpdate.mockClear()
    applySelfUpdate.mockReturnValue(new Promise(() => {}))
    renderDialog({
      version: '0.13.0',
      channel: 'nightly',
      latest: { stable: '0.13.0', nightly: '0.13.0-nightly.20260929.55' },
      installed: [
        { id: '0.13.0+cez-abc', version: '0.13.0', source: 'link', branch: 'cez/abc', installedAt: '2026-09-29T08:00:00.000Z', active: true },
        { id: '0.13.0', version: '0.13.0', source: 'registry', installedAt: '2026-09-29T07:00:00.000Z', active: false },
      ],
    })
    await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: /^Back to/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Install v0.13.0-nightly.20260929.55 & restart' }))
    await waitFor(() => expect(applySelfUpdate).toHaveBeenCalledTimes(1))
    expect(applySelfUpdate.mock.calls[0]?.[0]).toBe('0.13.0-nightly.20260929.55')
  })

  // A server started before the development channel existed answers 400 — say so, and why.
  it('shows why switching to development failed', async () => {
    setSelfUpdateChannel.mockRejectedValue(new Error('body must be { channel: "stable" | "nightly" }'))
    renderDialog()
    fireEvent.click(await screen.findByRole('radio', { name: 'Development' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.textContent).toContain('Could not switch the channel'))
    expect(dialog.textContent).toContain('restart cezar')
  })

  it('shows no development panel on a release channel', async () => {
    renderDialog()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('[data-slot="self-update-development"]')).toBeNull()
  })

  it('stays open while an install is running', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const onOpenChange = vi.fn()
    renderDialog(
      { job: { status: 'running', target: '0.12.1', startedAt: '2026-09-28T09:00:00.000Z', finishedAt: null, log: [] } },
      { onOpenChange },
    )
    fireEvent.click(await screen.findByRole('button', { name: /close/i }))
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
