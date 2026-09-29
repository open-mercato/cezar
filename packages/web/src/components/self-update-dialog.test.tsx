import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SelfUpdateStatus } from '@open-mercato/cezar-api-client'
import { workspaceQueryKeys } from '@/api/queries'
import { SelfUpdateDialog } from '@/components/self-update-dialog'

const applySelfUpdate = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), applySelfUpdate }))

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

function renderDialog(overrides: Partial<SelfUpdateStatus> = {}, props: { autoApply?: string; onOpenChange?: (open: boolean) => void } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(workspaceQueryKeys.selfUpdate, { ...status, ...overrides })
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

  // Developing cezar: the worktrees of a registered cezar repo are one pick away, and the one
  // running is named in the header by its branch.
  it('offers cezar worktrees and names a linked one by its branch', async () => {
    renderDialog({
      installed: [
        { id: '0.13.0+cez-abc', version: '0.13.0', source: 'link', branch: 'cez/abc', installedAt: '2026-09-29T08:00:00.000Z', active: true },
      ],
      checkouts: [
        { id: '0.13.0+cez-abc', branch: 'cez/abc', version: '0.13.0', worktree: '/r/wt/abc', built: true, linked: true },
        { id: '0.13.0+cez-def', branch: 'cez/def', version: '0.13.0', worktree: '/r/wt/def', built: false, linked: false },
      ],
    })
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('worktree · cez/abc')
    expect(dialog.querySelector('[data-slot="self-update-checkouts"]')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Worktree' })).toBeTruthy()
  })

  it('shows no worktree section when there are none', async () => {
    renderDialog()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('[data-slot="self-update-checkouts"]')).toBeNull()
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
