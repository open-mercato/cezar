import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunStatus } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { AcceptCelebration, ReviewPanel } from './review-panel'
import { ThreadView } from './task-thread'
import { reduceThread } from './thread-state'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const run = (status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun =>
  ({
    id: 'r1',
    title: 'do the thing plz',
    titleSummary: 'Do the thing',
    workflow: 'quick-task',
    task: 'Summarize what this project does.',
    status,
    createdAt: '2026-07-14T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 'sess-1' }],
    ...extra,
  }) as ApiRun

const DIFF = [
  'diff --git a/notes.md b/notes.md',
  'index 1111111..2222222 100644',
  '--- a/notes.md',
  '+++ b/notes.md',
  '@@ -1,2 +1,3 @@',
  ' # notes',
  '-old line',
  '+new line',
  '+another line',
  '',
].join('\n')

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Stubs fetch, records every request, and lets a test override specific `METHOD path` keys.
 *  Defaults: the diff answers `DIFF`, the runs list is empty, every mutation succeeds. */
function stubFetch(overrides: Record<string, () => Response> = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({
        path,
        method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/runs/r1/diff') return new Response(DIFF, { status: 200 })
      if (method === 'GET' && path === '/api/v1/runs') return jsonResponse([])
      if (method === 'GET' && path === '/api/v1/providers/status') {
        return jsonResponse({
          providers: [
            { provider: 'claude', status: 'connected', enabled: true },
            { provider: 'codex', status: 'not-installed', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          ],
        })
      }
      return jsonResponse({})
    }),
  )
  return sent
}

function renderWithProviders(ui: ReactElement) {
  const client = createQueryClient()
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {ui}
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return {
    ...view,
    rerenderWithProviders: (next: ReactElement) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            {next}
            <Toaster />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
  }
}

const diffFetches = (sent: SentRequest[]) =>
  sent.filter((r) => r.method === 'GET' && r.path === '/api/v1/runs/r1/diff').length

describe('the review gate on the thread', () => {
  it('renders the violet banner + panel ONLY while the run rests at review', () => {
    stubFetch()
    const { rerenderWithProviders } = renderWithProviders(
      <ThreadView run={run('review')} thread={reduceThread([])} />,
    )
    expect(document.querySelector('[data-slot="review-banner"]')?.textContent).toContain(
      'Review the changes before anything lands',
    )
    expect(document.querySelector('[data-slot="review-panel"]')).not.toBeNull()

    rerenderWithProviders(<ThreadView run={run('waiting')} thread={reduceThread([])} />)
    expect(document.querySelector('[data-slot="review-panel"]')).toBeNull()
  })

  it('shows the working spinner ONLY while the run is running (the live heartbeat)', () => {
    stubFetch()
    const { rerenderWithProviders } = renderWithProviders(
      <ThreadView run={run('running')} thread={reduceThread([])} />,
    )
    const working = () => document.querySelector('[data-slot="working-indicator"]')
    expect(working()).not.toBeNull()
    expect(working()?.textContent).toContain('Working')
    expect(screen.getByRole('status', { name: 'Working' })).toBeTruthy()

    // waiting hands off to the dock's reply hint, queued to the placeholder, closed states to
    // the footer — none of them should keep the spinner up.
    for (const status of ['waiting', 'queued', 'done', 'review', 'failed'] as const) {
      rerenderWithProviders(<ThreadView run={run(status)} thread={reduceThread([])} />)
      expect(working(), `no spinner for ${status}`).toBeNull()
    }
  })

  it('renders the diff as per-file sections: path, ± counts, tinted add/del lines', async () => {
    stubFetch()
    renderWithProviders(<ReviewPanel run={run('review')} />)

    await waitFor(() => {
      expect(document.querySelector('[data-slot="diff-file"]')).not.toBeNull()
    })
    expect(document.querySelector('[data-slot="diff-file-path"]')?.textContent).toBe('notes.md')
    // The summary line and the per-file counts agree with the hunk.
    expect(document.querySelector('[data-slot="run-diff"]')?.textContent).toContain('1 file changed')
    expect(document.querySelector('[data-slot="diff-file"]')?.textContent).toContain('+2')
    expect(document.querySelector('[data-slot="diff-file"]')?.textContent).toContain('−1')
    // Line tinting comes from the --diff-* tokens.
    const body = document.querySelector('[data-slot="diff-file-body"]') as HTMLElement
    expect(body.querySelectorAll('.bg-diff-add')).toHaveLength(2)
    expect(body.querySelectorAll('.bg-diff-del')).toHaveLength(1)
  })

  it('a non-diff server answer ("(no worktree — …)") renders as its own words', async () => {
    stubFetch({
      'GET /api/v1/runs/r1/diff': () =>
        new Response('(no worktree — this task ran directly in the repo working tree)', { status: 200 }),
    })
    renderWithProviders(<ReviewPanel run={run('review')} />)
    await waitFor(() => {
      expect(document.querySelector('[data-slot="run-diff-empty"]')?.textContent).toContain(
        'no worktree',
      )
    })
  })

  it('refetches the diff on every re-entry into review (legacy parity)', async () => {
    const sent = stubFetch()
    const { rerenderWithProviders } = renderWithProviders(
      <ThreadView run={run('review')} thread={reduceThread([])} />,
    )
    await waitFor(() => expect(document.querySelector('[data-slot="diff-file"]')).not.toBeNull())
    const afterFirstEntry = diffFetches(sent)
    expect(afterFirstEntry).toBeGreaterThanOrEqual(1)

    // Send-back path: the run leaves review (panel unmounts), works, and gates again.
    rerenderWithProviders(<ThreadView run={run('waiting')} thread={reduceThread([])} />)
    expect(document.querySelector('[data-slot="review-panel"]')).toBeNull()
    rerenderWithProviders(<ThreadView run={run('review')} thread={reduceThread([])} />)

    // Re-entry must hit the server again — never show the pre-send-back diff from cache.
    await waitFor(() => expect(diffFetches(sent)).toBeGreaterThan(afterFirstEntry))
  })

  it('↩ Send back delivers the notes as legacy continue semantics and clears the box', async () => {
    const sent = stubFetch()
    renderWithProviders(<ReviewPanel run={run('review')} />)

    const notes = screen.getByLabelText('Notes for the agent') as HTMLTextAreaElement
    fireEvent.change(notes, { target: { value: 'fix the port handling' } })
    const sendBack = screen.getByRole<HTMLButtonElement>('button', { name: /Send back/ })
    await waitFor(() => expect(sendBack.disabled).toBe(false))
    fireEvent.click(sendBack)

    await waitFor(() => {
      expect(sent.find((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/continue')).toMatchObject({
        body: { text: 'Review feedback:\nfix the port handling' },
      })
    })
    await waitFor(() => expect(notes.value).toBe(''))
  })

  it('⌘↵ in the notes box submits; plain Enter stays a newline', async () => {
    const sent = stubFetch()
    renderWithProviders(<ReviewPanel run={run('review')} />)

    const notes = screen.getByLabelText('Notes for the agent') as HTMLTextAreaElement
    const sendBack = screen.getByRole<HTMLButtonElement>('button', { name: /Send back/ })
    await waitFor(() => expect(sendBack.disabled).toBe(false))
    fireEvent.change(notes, { target: { value: 'more tests' } })
    fireEvent.keyDown(notes, { key: 'Enter' })
    expect(sent.filter((r) => r.path === '/api/v1/runs/r1/continue')).toHaveLength(0)

    fireEvent.keyDown(notes, { key: 'Enter', metaKey: true })
    await waitFor(() => {
      expect(sent.filter((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/continue')).toHaveLength(1)
    })
  })

  it('provider loss disables Send back and blocks forced click and keyboard submissions', async () => {
    const sent = stubFetch({
      'GET /api/v1/providers/status': () =>
        jsonResponse({
          providers: [
            { provider: 'claude', status: 'disconnected', enabled: true },
            { provider: 'codex', status: 'unknown', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          ],
        }),
    })
    renderWithProviders(<ReviewPanel run={run('review', { runner: 'claude' })} />)

    const notes = screen.getByLabelText('Notes for the agent') as HTMLTextAreaElement
    fireEvent.change(notes, { target: { value: 'more tests' } })
    const sendBack = screen.getByRole<HTMLButtonElement>('button', { name: /Send back/ })
    await waitFor(() => expect(sendBack.disabled).toBe(true))
    expect(await screen.findByRole('link', { name: 'Configure providers' })).toBeTruthy()

    sendBack.removeAttribute('disabled')
    fireEvent.click(sendBack)
    fireEvent.keyDown(notes, { key: 'Enter', ctrlKey: true })
    await act(() => Promise.resolve())
    expect(sent.filter((request) => request.path === '/api/v1/runs/r1/continue')).toHaveLength(0)
  })

  it('Send back explicitly selects a connected fallback for a disconnected run provider', async () => {
    const sent = stubFetch({
      'GET /api/v1/providers/status': () =>
        jsonResponse({
          providers: [
            { provider: 'claude', status: 'disconnected', enabled: true },
            { provider: 'codex', status: 'connected', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          ],
        }),
    })
    renderWithProviders(<ReviewPanel run={run('review', { runner: 'claude' })} />)

    const notes = screen.getByLabelText('Notes for the agent')
    fireEvent.change(notes, { target: { value: 'use the available provider' } })
    const sendBack = screen.getByRole<HTMLButtonElement>('button', { name: /Send back/ })
    await waitFor(() => expect(sendBack.disabled).toBe(false))
    fireEvent.click(sendBack)

    await waitFor(() =>
      expect(sent.find((request) => request.path === '/api/v1/runs/r1/continue')?.body).toEqual({
        text: 'Review feedback:\nuse the available provider',
        runner: 'codex',
      }),
    )
  })

  it('empty notes: no POST, the legacy nudge as a toast, focus back on the box', async () => {
    const sent = stubFetch()
    renderWithProviders(<ReviewPanel run={run('review')} />)

    const sendBack = screen.getByRole<HTMLButtonElement>('button', { name: /Send back/ })
    await waitFor(() => expect(sendBack.disabled).toBe(false))
    fireEvent.click(sendBack)
    expect(sent.filter((r) => r.method === 'POST')).toHaveLength(0)
    expect(document.querySelector('[data-slot="toast"]')?.textContent).toBe('Write what to change first.')
    expect(document.activeElement).toBe(screen.getByLabelText('Notes for the agent'))
  })

  it('Draft PR success: POSTs /pr and the toast carries the returned URL', async () => {
    const sent = stubFetch({
      'POST /api/v1/runs/r1/pr': () => jsonResponse({ url: 'https://github.com/x/y/pull/7', dryRun: true }, 201),
    })
    renderWithProviders(<ReviewPanel run={run('review')} />)

    fireEvent.click(screen.getByRole('button', { name: /Draft PR/ }))
    await waitFor(() => {
      expect(document.querySelector('[data-slot="toast"]')?.textContent).toBe(
        'Draft PR created — https://github.com/x/y/pull/7',
      )
    })
    expect(sent.filter((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/pr')).toHaveLength(1)
  })

  it('Draft PR 409: the server message as a danger toast + the copyable manual merge line', async () => {
    stubFetch({
      'POST /api/v1/runs/r1/pr': () =>
        jsonResponse({ error: 'gh pr create failed: not logged in', manual: 'git merge cez/r1' }, 409),
    })
    renderWithProviders(<ReviewPanel run={run('review')} />)

    fireEvent.click(screen.getByRole('button', { name: /Draft PR/ }))
    await waitFor(() => {
      expect(document.querySelector('[data-slot="review-manual"]')?.textContent).toContain(
        'manual path: git merge cez/r1',
      )
    })
    const toastEl = document.querySelector('[data-slot="toast"]')
    expect(toastEl?.textContent).toBe('gh pr create failed: not logged in')
    expect(toastEl?.getAttribute('data-tone')).toBe('danger')
    // The button stays usable — the user may fix gh auth and retry.
    expect((screen.getByRole('button', { name: /Draft PR/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('an already-open PR replaces Draft PR with the PR ↗ link (no duplicate PRs)', () => {
    stubFetch()
    renderWithProviders(
      <ReviewPanel run={run('review', { pullRequestUrl: 'https://github.com/x/y/pull/9' })} />,
    )
    const link = document.querySelector('[data-slot="pr-link"]') as HTMLAnchorElement
    expect(link.href).toBe('https://github.com/x/y/pull/9')
    expect(screen.queryByRole('button', { name: /Draft PR/ })).toBeNull()
  })

  it('✓ Accept POSTs the one shared finish action (review-accept semantics)', async () => {
    const sent = stubFetch()
    renderWithProviders(<ReviewPanel run={run('review')} />)

    fireEvent.click(screen.getByRole('button', { name: /Accept/ }))
    await waitFor(() => {
      expect(sent.filter((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/finish')).toHaveLength(1)
    })
  })
})

describe('the accept celebration', () => {
  it('review → done shows the one-shot twinkle overlay and clears it after ~1.5s', () => {
    vi.useFakeTimers()
    stubFetch()
    const { rerenderWithProviders } = renderWithProviders(<AcceptCelebration status="review" />)
    expect(document.querySelector('[data-slot="accept-celebration"]')).toBeNull()

    rerenderWithProviders(<AcceptCelebration status="done" />)
    const overlay = document.querySelector('[data-slot="accept-celebration"]')
    expect(overlay).not.toBeNull()
    expect(overlay?.querySelector('[data-slot="twinkle-backdrop"]')).not.toBeNull()
    expect(overlay?.getAttribute('aria-hidden')).toBe('true')

    act(() => vi.advanceTimersByTime(1600))
    expect(document.querySelector('[data-slot="accept-celebration"]')).toBeNull()
  })

  it('does NOT celebrate transitions that are not review → done', () => {
    stubFetch()
    const { rerenderWithProviders } = renderWithProviders(<AcceptCelebration status="waiting" />)
    rerenderWithProviders(<AcceptCelebration status="done" />)
    expect(document.querySelector('[data-slot="accept-celebration"]')).toBeNull()
  })

  it('prefers-reduced-motion: reduce → no overlay at all', () => {
    stubFetch()
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' })),
    )
    const { rerenderWithProviders } = renderWithProviders(<AcceptCelebration status="review" />)
    rerenderWithProviders(<AcceptCelebration status="done" />)
    expect(document.querySelector('[data-slot="accept-celebration"]')).toBeNull()
  })
})
