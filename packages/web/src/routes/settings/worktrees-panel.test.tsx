import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { WorktreesResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { WorktreesPanel } from './worktrees-panel'

/**
 * Settings → Resources: the worktrees management panel (#483). Renders rows,
 * per-row Delete and "Reclaim now" call their routes (behind a confirm), and the
 * empty state shows when there is nothing on disk.
 */

let requests: Array<{ method: string; url: string }> = []

function serve(data: WorktreesResponse) {
  requests = []
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ method, url })
      if (url === '/api/v1/worktrees' && method === 'GET') return json(data)
      if (url === '/api/v1/worktrees/reclaim' && method === 'POST') return json({ reclaimed: ['r1'] })
      if (/\/api\/v1\/runs\/.+\/remove-worktree$/.test(url) && method === 'POST') return json({ removed: true })
      return new Promise<never>(() => {})
    }),
  )
}

function renderPanel() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <WorktreesPanel />
      <Toaster />
    </QueryClientProvider>,
  )
}

const rows = () => document.querySelectorAll('[data-slot="worktree-row"]')
const posts = (match: RegExp) => requests.filter((r) => r.method === 'POST' && match.test(r.url))
const confirmButton = () => document.querySelector<HTMLButtonElement>('[data-action="worktrees-confirm"]')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const sample: WorktreesResponse = {
  worktrees: [
    {
      runId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      title: 'fix the login bug',
      status: 'done',
      branch: 'cez/aaaaaaaa',
      sizeBytes: 5 * 1024 * 1024,
      finishedAt: '2026-07-01T00:00:00Z',
      reclaimable: true,
    },
    {
      runId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      title: 'review dialog',
      status: 'review',
      branch: 'cez/bbbbbbbb',
      sizeBytes: null,
      finishedAt: null,
      reclaimable: false,
    },
  ],
  totalBytes: null,
  keep: 10,
}

describe('Settings → Resources: worktrees panel (#483)', () => {
  it('renders a row per worktree with size (or — when unavailable) and the keep footer', async () => {
    serve(sample)
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(document.body.textContent).toContain('fix the login bug')
    expect(document.body.textContent).toContain('5 MB')
    // Null size degrades to an em dash; null total degrades the footer.
    expect(document.querySelector('[data-slot="worktrees-footer"]')?.textContent).toContain('keeping the last 10')
    expect(document.querySelector('[data-slot="worktrees-footer"]')?.textContent).toContain('size unavailable')
  })

  it('Delete calls the per-run remove-worktree route (after confirming the dialog)', async () => {
    serve(sample)
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    fireEvent.click(document.querySelector('[data-action="worktree-delete"]')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    fireEvent.click(confirmButton()!)
    await waitFor(() => expect(posts(/\/remove-worktree$/)).toHaveLength(1))
  })

  it('Reclaim now calls the reclaim route (after confirming the dialog)', async () => {
    serve(sample)
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    fireEvent.click(document.querySelector('[data-action="worktrees-reclaim-now"]')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    fireEvent.click(confirmButton()!)
    await waitFor(() => expect(posts(/\/api\/v1\/worktrees\/reclaim$/)).toHaveLength(1))
  })

  it('does not call the route when the confirm dialog is dismissed', async () => {
    serve(sample)
    renderPanel()
    await waitFor(() => expect(rows()).toHaveLength(2))
    fireEvent.click(document.querySelector('[data-action="worktrees-reclaim-now"]')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    // "Keep it" (AlertDialogCancel) closes without acting.
    fireEvent.click(document.querySelector('[data-slot="alert-dialog-cancel"]')!)
    await waitFor(() => expect(confirmButton()).toBeNull())
    expect(posts(/reclaim$|remove-worktree$/)).toHaveLength(0)
  })

  it('shows the empty state when nothing is on disk', async () => {
    serve({ worktrees: [], totalBytes: 0, keep: 0 })
    renderPanel()
    await waitFor(() => expect(document.querySelector('[data-slot="worktrees-empty"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="worktrees-footer"]')?.textContent).toContain('unlimited')
  })
})
