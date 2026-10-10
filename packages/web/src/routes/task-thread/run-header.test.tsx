import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunStatus, StepState } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { RunHeader } from './run-header'
import { resolveConflictsPrompt } from './run-actions'

beforeEach(() => {
  // Radix's tooltip arrow measures itself with a ResizeObserver; jsdom has no layout observer.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

const run = (status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'do the thing plz',
  titleSummary: 'Do the thing',
  workflow: 'quick-task',
  task: 'Summarize what this project does.',
  status,
  createdAt: '2026-07-14T12:00:00.000Z',
  tokensUsed: 27_000,
  inputTokens: 24_600,
  outputTokens: 2_400,
  archived: false,
  steps: [step({ sessionId: 'sess-1' })],
  ...extra,
})

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Stubs fetch, records every request, and lets a test override specific paths. Defaults:
 *  the runs list is empty, every mutation succeeds with `{}`. */
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
      const override = overrides[path]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/runs') return jsonResponse([])
      if (method === 'GET' && path === '/api/v1/providers/status') {
        return jsonResponse({
          providers: [
            { provider: 'claude', status: 'connected', enabled: true },
            { provider: 'codex', status: 'not-installed', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          { provider: 'cursor', status: 'not-installed', enabled: true },
          ],
        })
      }
      return jsonResponse({})
    }),
  )
  return sent
}

function renderHeader(
  record: ApiRun,
  onMarkedUnread?: () => void,
  planTally?: { done: number; total: number },
  continuationEngine?: ReactNode,
) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/tasks/${record.id}`]}>
        <Routes>
          <Route
            path="/tasks/:id"
            element={
              <RunHeader
                run={record}
                onMarkedUnread={onMarkedUnread}
                planTally={planTally}
                continuationEngine={continuationEngine}
              />
            }
          />
          <Route path="/" element={<div data-slot="home-probe" />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The button row: the run's ONE primary action, plus Open in… and (beside Continue) Finish. */
const actionBar = () => within(document.querySelector('[data-slot="run-actions"]') as HTMLElement)

/** "More actions" — every action that is not the run's primary button lives in this one menu,
 *  at every width (Radix opens on pointerdown). */
async function openMoreMenu() {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }))
  return within(await screen.findByRole('menu'))
}
const itemNames = (menu: Awaited<ReturnType<typeof openMoreMenu>>) =>
  menu.getAllByRole('menuitem').map((el) => el.textContent?.trim())

/** The toast on screen (shadcn Sonner): its words, and whether it is the danger one. */
const toastText = () => document.querySelector('[data-sonner-toast] [data-title]')?.textContent
const toastTone = () =>
  document.querySelector('[data-sonner-toast]')?.getAttribute('data-type') === 'error' ? 'danger' : 'default'

/** The "Details" trigger in the meta line — runner, account, model, tokens, cost, take-over. */
const detailsBadge = () => document.querySelector('[data-slot="agent-badge"]') as HTMLElement
/** Opens the Details popover and hands back its labelled grid. */
function openDetails(): HTMLElement {
  fireEvent.click(detailsBadge())
  return document.querySelector('[data-slot="run-details"]') as HTMLElement
}
/** One row of that grid, by its label: the `<dd>` beside the `<dt>`. */
const detail = (details: HTMLElement, label: string) =>
  [...details.querySelectorAll('dt')].find((dt) => dt.textContent === label)?.nextElementSibling ?? null

describe('monitoring schedule', () => {
  it('shows the exact persisted deadline in a time element', () => {
    stubFetch()
    renderHeader(run('running', { activity: 'monitoring', monitoringWakeAt: '2026-07-25T10:15:00.000Z' }))
    const time = screen.getByText(/2026/).closest('time')
    expect(time?.getAttribute('datetime')).toBe('2026-07-25T10:15:00.000Z')
    expect(screen.getByText(/Next automatic check/)).not.toBeNull()
  })

  it('shows parked copy for absent or malformed deadlines', () => {
    stubFetch()
    renderHeader(run('running', { activity: 'monitoring', monitoringWakeAt: 'not-a-date' }))
    expect(screen.getByText('Parked — no automatic check scheduled')).not.toBeNull()
    expect(screen.queryByText(/Invalid Date/)).toBeNull()
  })

  it('distinguishes a capped monitoring epoch from an ordinary parked session', () => {
    stubFetch()
    renderHeader(run('running', { activity: 'monitoring', monitoringWakeCapReached: true }))
    expect(screen.getByText('Automatic checks paused — 40/40 reached')).not.toBeNull()
    expect(screen.queryByText('Parked — no automatic check scheduled')).toBeNull()
  })
})

describe('editable title (#389)', () => {
  it('pencil flips the h1 into an input; Enter PATCHes the trimmed title exactly once', async () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))

    fireEvent.click(screen.getByRole('button', { name: 'Rename task' }))
    const input = screen.getByLabelText('Task title') as HTMLInputElement
    expect(input.value).toBe('Do the thing') // seeded with the displayed title, not the raw one

    fireEvent.change(input, { target: { value: '  New name  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Enter is typically followed by the blur of the unmounting input — one PATCH, not two.
    fireEvent.blur(input)

    await waitFor(() => {
      expect(sent.filter((r) => r.method === 'PATCH')).toHaveLength(1)
    })
    expect(sent.find((r) => r.method === 'PATCH')).toMatchObject({
      path: '/api/v1/runs/r1',
      body: { title: 'New name' },
    })
    // Back to the heading immediately — the edit UI does not wait for the server.
    expect(screen.getByRole('heading', { level: 1 })).not.toBeNull()
  })

  it('blur commits like Enter', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    fireEvent.click(screen.getByRole('button', { name: 'Rename task' }))
    const input = screen.getByLabelText('Task title')
    fireEvent.change(input, { target: { value: 'Renamed on blur' } })
    fireEvent.blur(input)
    await waitFor(() => {
      expect(sent.find((r) => r.method === 'PATCH')?.body).toEqual({ title: 'Renamed on blur' })
    })
  })

  it('Escape abandons the draft — no PATCH, the old title stays', () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))
    fireEvent.click(screen.getByRole('button', { name: 'Rename task' }))
    const input = screen.getByLabelText('Task title')
    fireEvent.change(input, { target: { value: 'Never sent' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Do the thing')
    expect(sent.some((r) => r.method === 'PATCH')).toBe(false)
  })

  /** #939 — this editor commits on blur, but a route change unmounts it without one, so a
   *  half-typed rename is exactly the kind of text that used to vanish. */
  it('re-opens holding a half-typed rename that was never committed', async () => {
    stubFetch({
      '/api/v1/runs/r1/drafts': () =>
        jsonResponse({
          surfaces: {
            title: { text: 'Half a new na', images: [], updatedAt: '2026-08-30T00:00:00.000Z' },
          },
        }),
    })
    renderHeader(run('waiting'))

    const input = (await screen.findByLabelText('Task title')) as HTMLInputElement
    expect(input.value).toBe('Half a new na')
    // No pencil click was needed — an editor whose text is restored but stays closed is state
    // the user cannot see.
  })

  it('a restored rename is not applied by the next stray click — only by Enter', async () => {
    const sent = stubFetch({
      '/api/v1/runs/r1/drafts': () =>
        jsonResponse({
          surfaces: {
            title: { text: 'Half a new na', images: [], updatedAt: '2026-08-30T00:00:00.000Z' },
          },
        }),
    })
    renderHeader(run('waiting'))
    const input = (await screen.findByLabelText('Task title')) as HTMLInputElement

    // The user comes back an hour later and clicks somewhere in the thread. Blur commits for an
    // editor they opened; this one opened itself, and committing here would silently rename the
    // task to text they walked away from.
    fireEvent.blur(input)
    expect(sent.some((r) => r.method === 'PATCH')).toBe(false)
    expect((screen.getByLabelText('Task title') as HTMLInputElement).value).toBe('Half a new na')

    // Once they touch it, it is an ordinary rename again.
    fireEvent.change(input, { target: { value: 'Half a new name' } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(sent.find((r) => r.method === 'PATCH')?.body).toEqual({ title: 'Half a new name' }),
    )
  })

  it('typing a rename writes it to the draft store, and committing clears it', async () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))

    fireEvent.click(screen.getByRole('button', { name: 'Rename task' }))
    const input = screen.getByLabelText('Task title')
    fireEvent.change(input, { target: { value: 'A better name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(sent.find((r) => r.method === 'PUT' && r.path === '/api/v1/runs/r1/drafts/title')).toMatchObject(
        { body: { text: '', images: [] } },
      ),
    )
  })

  it('Escape clears the stored rename too — the user resolved it', async () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))

    fireEvent.click(screen.getByRole('button', { name: 'Rename task' }))
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Never mind' } })
    fireEvent.keyDown(screen.getByLabelText('Task title'), { key: 'Escape' })

    await waitFor(() =>
      expect(sent.find((r) => r.method === 'PUT' && r.path === '/api/v1/runs/r1/drafts/title')).toMatchObject(
        { body: { text: '', images: [] } },
      ),
    )
    expect(sent.some((r) => r.method === 'PATCH')).toBe(false)
  })

  it('an unchanged or emptied draft is not worth a request', () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))
    for (const value of ['Do the thing', '   ']) {
      fireEvent.click(screen.getByRole('button', { name: 'Rename task' }))
      const input = screen.getByLabelText('Task title')
      fireEvent.change(input, { target: { value } })
      fireEvent.keyDown(input, { key: 'Enter' })
    }
    expect(sent.some((r) => r.method === 'PATCH')).toBe(false)
  })
})

describe('action bar visibility per status (the legacy rules, rendered)', () => {
  // Pin (#935) is in every row: unlike every other action here it asks nothing of the engine,
  // so it is offered whatever the run is doing — only archiving takes it away.
  //
  // The same rules, on the redesigned surface: `bar` is the button row — ONE primary action picked
  // by the run's state (Continue, else Finish, else Stop), with Open in… and a quieter Finish beside
  // a primary Continue — and `menu` is "More actions", which holds every action at every width (the
  // strip drops the row whenever it runs out of room). Cancel reads "Stop" now.
  const closed = ['Continue', 'Resume in terminal', 'Notes', 'Pin', 'Archive', 'Copy take-over command', 'Delete']
  const matrix: Array<{ status: RunStatus; bar: string[]; menu: string[] }> = [
    { status: 'queued', bar: ['Stop'], menu: ['Notes', 'Pin', 'Stop'] },
    { status: 'running', bar: ['Stop'], menu: ['Notes', 'Pin', 'Stop'] },
    { status: 'waiting', bar: ['Finish'], menu: ['Finish', 'Notes', 'Pin', 'Stop'] },
    // Terminal folded into the Open in… menu — it shows whenever the session can be resumed.
    { status: 'review', bar: ['Open in…', 'Finish', 'Continue'], menu: ['Finish', ...closed] },
    { status: 'done', bar: ['Open in…', 'Continue'], menu: closed },
    { status: 'failed', bar: ['Open in…', 'Continue'], menu: closed },
    { status: 'cancelled', bar: ['Open in…', 'Continue'], menu: closed },
  ]

  it.each(matrix)('$status → bar $bar, menu $menu', async ({ status, bar, menu }) => {
    stubFetch()
    renderHeader(run(status))
    const names = actionBar()
      .getAllByRole('button')
      .map((el) => el.textContent?.trim())
    expect(names).toEqual(bar)
    expect(itemNames(await openMoreMenu())).toEqual(menu)
  })

  it('an archived run offers Unarchive instead of Archive', async () => {
    stubFetch()
    renderHeader(run('done', { archived: true }))
    const menu = await openMoreMenu()
    expect(menu.queryByRole('menuitem', { name: 'Archive' })).toBeNull()
    expect(menu.getByRole('menuitem', { name: 'Unarchive' })).not.toBeNull()
  })

  it('VS Code is absent everywhere — the open-in-editor endpoint does not exist yet (R5)', () => {
    stubFetch()
    renderHeader(run('done'))
    expect(screen.queryByRole('button', { name: /vs code/i })).toBeNull()
  })

  it('the More menu is there for every status, holding the same actions', async () => {
    stubFetch()
    renderHeader(run('running'))
    expect(screen.getByRole('button', { name: 'More actions' })).not.toBeNull()
    // The bar's primary Stop is repeated in the menu for the widths that drop the bar.
    const stop = (await openMoreMenu()).getByRole('menuitem', { name: 'Stop' })
    expect(stop.className).toContain('md:hidden')
  })
})

describe('Mark unread (#775)', () => {
  const FINISHED_AT = '2026-07-14T13:00:00.000Z'
  const SEEN_AT = '2026-07-14T13:05:00.000Z'
  /** A finished run that has already been read — the one state the action is offered in. */
  const readDone = (extra: Partial<ApiRun> = {}) =>
    run('done', { finishedAt: FINISHED_AT, seenAt: SEEN_AT, ...extra })

  it('offers the control for a read, finished run — next to Archive', async () => {
    stubFetch()
    renderHeader(readDone())
    expect(itemNames(await openMoreMenu())).toEqual([
      'Continue',
      'Resume in terminal',
      'Notes',
      'Mark unread',
      'Pin',
      'Archive',
      'Copy take-over command',
      'Delete',
    ])
  })

  it.each([
    ['an already-unread run', run('done', { finishedAt: FINISHED_AT })],
    ['an archived run', readDone({ archived: true })],
    ['a cancelled run', run('cancelled', { finishedAt: FINISHED_AT, seenAt: SEEN_AT })],
    ['a still-running run', run('running', { seenAt: SEEN_AT })],
    ['a done run caught with no finishedAt', run('done', { seenAt: SEEN_AT })],
  ] as Array<[string, ApiRun]>)('hides the control for %s', async (_name, record) => {
    stubFetch()
    renderHeader(record)
    const menu = await openMoreMenu()
    expect(menu.getByRole('menuitem', { name: 'Notes' })).not.toBeNull() // the menu really is open
    expect(menu.queryByRole('menuitem', { name: 'Mark unread' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark unread' })).toBeNull()
  })

  it('Mark unread → POST /unread, bodyless like its read twin', async () => {
    const sent = stubFetch()
    renderHeader(readDone())
    fireEvent.click((await openMoreMenu()).getByRole('menuitem', { name: 'Mark unread' }))
    await waitFor(() => {
      const request = sent.find((r) => r.path === '/api/v1/runs/r1/unread')
      expect(request?.method).toBe('POST')
      expect(request?.body).toBeUndefined()
    })
  })

  it('notifies the host BEFORE the request goes out, so the thread can suppress its auto-read', async () => {
    // Ordering is the whole contract: the optimistic cache write re-renders the open thread and
    // re-runs its auto-mark-read effect, which would re-stamp the receipt if it were not already
    // suppressed by the time that happens.
    const sent = stubFetch()
    const onMarkedUnread = vi.fn(() => {
      expect(sent.some((r) => r.path === '/api/v1/runs/r1/unread')).toBe(false)
    })
    renderHeader(readDone(), onMarkedUnread)
    fireEvent.click((await openMoreMenu()).getByRole('menuitem', { name: 'Mark unread' }))
    expect(onMarkedUnread).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(sent.some((r) => r.path === '/api/v1/runs/r1/unread')).toBe(true))
  })

  it('surfaces a server refusal as a danger toast and leaves the run read', async () => {
    // The mixed-version failure mode (#769): an older server has no such route. The guarded
    // rollback in `useMarkRunUnseen` means the cockpit says so rather than showing a marker
    // the server does not agree with.
    stubFetch({
      '/api/v1/runs/r1/unread': () => jsonResponse({ error: 'not found' }, 404),
    })
    renderHeader(readDone())
    fireEvent.click((await openMoreMenu()).getByRole('menuitem', { name: 'Mark unread' }))
    await waitFor(() => expect(toastText()).toBe('not found'))
    expect(toastTone()).toBe('danger')
  })

  it('lives in the More menu only — never a button on the bar', async () => {
    stubFetch()
    renderHeader(readDone())
    expect(actionBar().queryByRole('button', { name: 'Mark unread' })).toBeNull()
    const menu = await openMoreMenu()
    expect(menu.getByRole('menuitem', { name: 'Mark unread' })).not.toBeNull()
  })
})

describe('actions hit their endpoints', () => {
  it('Finish → POST /finish', async () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))
    fireEvent.click(actionBar().getByRole('button', { name: 'Finish' }))
    await waitFor(() => {
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/finish')).toBe(true)
    })
  })

  it('Continue → POST /continue', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    const button = actionBar().getByRole<HTMLButtonElement>('button', { name: 'Continue' })
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => {
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/continue')).toBe(true)
    })
  })

  it('a refused Continue refetches the record it was drawn from', async () => {
    // The drift case: the record says `done`, the run is running again (a lost workspace-stream
    // frame — run-reconcile.ts). Nothing else refetches a run record here, so without this the bar
    // would keep offering a Continue the server keeps refusing.
    const sent = stubFetch({
      '/api/v1/runs/r1/continue': () => jsonResponse({ error: 'run is still active' }, 409),
    })
    renderHeader(run('done'))
    const button = actionBar().getByRole<HTMLButtonElement>('button', { name: 'Continue' })
    await waitFor(() => expect(button.disabled).toBe(false))
    const listReadsBefore = sent.filter((r) => r.method === 'GET' && r.path === '/api/v1/runs').length

    fireEvent.click(button)

    await waitFor(() => expect(screen.getByText('run is still active')).not.toBeNull())
    await waitFor(() =>
      expect(sent.filter((r) => r.method === 'GET' && r.path === '/api/v1/runs').length).toBeGreaterThan(
        listReadsBefore,
      ),
    )
  })

  it('disables desktop Continue and its mutation guard blocks a forced click without a provider', async () => {
    const sent = stubFetch({
      '/api/v1/providers/status': () =>
        jsonResponse({
          providers: [
            { provider: 'claude', status: 'disconnected', enabled: true },
            { provider: 'codex', status: 'unknown', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          { provider: 'cursor', status: 'not-installed', enabled: true },
          ],
        }),
    })
    renderHeader(run('done', { runner: 'claude' }))

    const button = actionBar().getByRole<HTMLButtonElement>('button', { name: 'Continue' })
    await waitFor(() => expect(button.disabled).toBe(true))
    button.removeAttribute('disabled')
    fireEvent.click(button)
    await act(() => Promise.resolve())

    expect(sent.some((request) => request.path === '/api/v1/runs/r1/continue')).toBe(false)
  })

  it('disables the menu Continue and does not post when its menu item is selected', async () => {
    const sent = stubFetch({
      '/api/v1/providers/status': () =>
        jsonResponse({
          providers: [
            { provider: 'claude', status: 'disconnected', enabled: true },
            { provider: 'codex', status: 'unknown', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          { provider: 'cursor', status: 'not-installed', enabled: true },
          ],
        }),
    })
    renderHeader(run('done', { runner: 'claude' }))

    const item = (await openMoreMenu()).getByRole('menuitem', { name: 'Continue' })
    await waitFor(() => expect(item.getAttribute('data-disabled')).not.toBeNull())
    fireEvent.click(item)
    await act(() => Promise.resolve())

    expect(sent.some((request) => request.path === '/api/v1/runs/r1/continue')).toBe(false)
  })

  it('sends a connected fallback runner when the run provider is disconnected', async () => {
    const sent = stubFetch({
      '/api/v1/providers/status': () =>
        jsonResponse({
          providers: [
            { provider: 'claude', status: 'disconnected', enabled: true },
            { provider: 'codex', status: 'connected', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          { provider: 'cursor', status: 'not-installed', enabled: true },
          ],
        }),
    })
    renderHeader(run('done', { runner: 'claude' }))

    const button = actionBar().getByRole<HTMLButtonElement>('button', { name: 'Continue' })
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)

    await waitFor(() =>
      expect(sent.find((request) => request.path === '/api/v1/runs/r1/continue')?.body).toEqual({
        runner: 'codex',
      }),
    )
  })

  it('Archive → POST /archive with the flipped flag', async () => {
    const sent = stubFetch()
    renderHeader(run('done', { archived: true }))
    fireEvent.click((await openMoreMenu()).getByRole('menuitem', { name: 'Unarchive' }))
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/archive')?.body).toEqual({ archived: false })
    })
  })

  it('Pin → POST /pin with the flipped flag, and reads Unpin once pinned (#935)', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    const pinItem = (await openMoreMenu()).getByRole('menuitem', { name: 'Pin' })
    // A toggle announces its state in every spelling.
    expect(pinItem.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pinItem)
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/pin')?.body).toEqual({ pinned: true })
    })

    cleanup()
    const unpinning = stubFetch()
    renderHeader(run('done', { pinned: true, pinnedAt: '2026-08-29T10:00:00.000Z' }))
    const unpinItem = (await openMoreMenu()).getByRole('menuitem', { name: 'Unpin' })
    expect(unpinItem.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(unpinItem)
    await waitFor(() => {
      expect(unpinning.find((r) => r.path === '/api/v1/runs/r1/pin')?.body).toEqual({ pinned: false })
    })
  })

  it('an archived run offers no pin at all — archiving retires it (#935)', async () => {
    stubFetch()
    renderHeader(run('done', { archived: true }))
    const menu = await openMoreMenu()
    expect(menu.getByRole('menuitem', { name: 'Unarchive' })).not.toBeNull() // the menu really is open
    expect(menu.queryByRole('menuitem', { name: 'Pin' })).toBeNull()
    expect(menu.queryByRole('menuitem', { name: 'Unpin' })).toBeNull()
  })

  it('Pin is offered while the run is still working too', async () => {
    stubFetch()
    renderHeader(run('running'))
    const menu = await openMoreMenu()
    expect(menu.getByRole('menuitem', { name: 'Pin' })).not.toBeNull()
  })

  it('Stop asks first — the POST fires only after the confirm dialog', async () => {
    const sent = stubFetch()
    renderHeader(run('running'))
    fireEvent.click(actionBar().getByRole('button', { name: 'Stop' }))

    // Nothing sent yet; the AlertDialog (never a native confirm) is up instead.
    expect(sent.some((r) => r.path === '/api/v1/runs/r1/cancel')).toBe(false)
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop the run' }))
    await waitFor(() => {
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/cancel')).toBe(true)
    })
  })

  it('Stop from the More menu asks the same question (a run whose primary action is not Stop)', async () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))
    fireEvent.click((await openMoreMenu()).getByRole('menuitem', { name: 'Stop' }))

    expect(sent.some((r) => r.path === '/api/v1/runs/r1/cancel')).toBe(false)
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop the run' }))
    await waitFor(() => {
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/cancel')).toBe(true)
    })
  })

  it('Delete confirms, DELETEs, and navigates home', async () => {
    const sent = stubFetch()
    renderHeader(run('failed'))
    fireEvent.click((await openMoreMenu()).getByRole('menuitem', { name: 'Delete' }))

    expect(sent.some((r) => r.method === 'DELETE')).toBe(false)
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => {
      expect(sent.some((r) => r.method === 'DELETE' && r.path === '/api/v1/runs/r1')).toBe(true)
    })
    // The run is gone — the header sent us home rather than leaving a dead page up.
    await waitFor(() => {
      expect(document.querySelector('[data-slot="home-probe"]')).not.toBeNull()
    })
  })

  it('the delete confirm button stays "Delete" even for a long task name, which appears in the description instead (#403)', async () => {
    const longTitle = 'create a github issue for saving unsuccessfully finished tasks automatically'
    renderHeader(run('failed', { titleSummary: longTitle }))
    fireEvent.click((await openMoreMenu()).getByRole('menuitem', { name: 'Delete' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('button', { name: 'Delete' })).not.toBeNull()
    expect(within(dialog).getByText(longTitle)).not.toBeNull()
  })

  it('dismissing the confirm keeps the run', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    fireEvent.click((await openMoreMenu()).getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect(sent.some((r) => r.method === 'DELETE')).toBe(false)
  })

  it('a mutation failure surfaces the server message as a danger toast', async () => {
    stubFetch({
      '/api/v1/runs/r1/continue': () => jsonResponse({ error: 'no agent session to resume' }, 409),
    })
    renderHeader(run('done'))
    const button = actionBar().getByRole<HTMLButtonElement>('button', { name: 'Continue' })
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(toastText()).toBe('no agent session to resume'))
    expect(toastTone()).toBe('danger')
  })
})

/** Terminal now lives inside the Open in… menu: open it (Radix opens on pointerdown) and click
 *  the resume item. */
async function clickTerminalResume(): Promise<void> {
  fireEvent.pointerDown(actionBar().getByRole('button', { name: 'Open in…' }))
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitem', { name: /Terminal \(resume session\)/ }))
}

describe('Terminal — the copy-command 409 fallback', () => {
  it('copies the server-sent command to the clipboard and says so', async () => {
    const command = "cd '/tmp/wt' && claude --resume sess-1"
    stubFetch({
      '/api/v1/runs/r1/open-in-cli': () =>
        jsonResponse({ error: 'no terminal emulator found', command }, 409),
    })
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    renderHeader(run('done'))
    await clickTerminalResume()

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command))
    await waitFor(() => expect(toastText()).toBe('No terminal found — command copied to clipboard.'))
    expect(toastTone()).toBe('default')
  })

  it('with no clipboard access the toast carries the command itself', async () => {
    const command = "cd '/tmp/wt' && claude --resume sess-1"
    stubFetch({
      '/api/v1/runs/r1/open-in-cli': () =>
        jsonResponse({ error: 'no terminal emulator found', command }, 409),
    })
    vi.stubGlobal('navigator', {}) // http, denied permission — no clipboard at all

    renderHeader(run('done'))
    await clickTerminalResume()

    await waitFor(() => expect(toastText()).toBe(`Run manually: ${command}`))
  })

  it('a 409 without a command is an ordinary error toast', async () => {
    stubFetch({
      '/api/v1/runs/r1/open-in-cli': () => jsonResponse({ error: 'no agent session to resume' }, 409),
    })
    renderHeader(run('done'))
    await clickTerminalResume()
    await waitFor(() => expect(toastText()).toBe('no agent session to resume'))
    expect(toastTone()).toBe('danger')
  })

  it('the More menu offers the same resume, through the same endpoint', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    fireEvent.click((await openMoreMenu()).getByRole('menuitem', { name: 'Resume in terminal' }))
    await waitFor(() => {
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/open-in-cli')).toBe(true)
    })
  })
})

describe('Open in… menu — agent CLI resume labeling (#402)', () => {
  const CLI_LABELS: Record<string, string> = {
    'cli:claude': 'Claude CLI',
    'cli:codex': 'Codex CLI',
    'cli:opencode': 'OpenCode',
  }
  const openTargets = (ids: string[]) => ({
    targets: ids.map((id) => ({ id, label: CLI_LABELS[id] ?? id })),
  })

  async function openMenu(): Promise<HTMLElement> {
    // Without a resumable Terminal item, the button itself only appears once the async
    // worktreeTargets query resolves (empty-until-loaded) — findByRole waits it in.
    const trigger = await actionBar().findByRole('button', { name: 'Open in…' })
    fireEvent.pointerDown(trigger)
    return screen.findByRole('menu')
  }

  it('labels the CLI matching the run\'s own runner "(resume)"; a foreign CLI stays plain', async () => {
    stubFetch({
      '/api/v1/open-targets': () => jsonResponse(openTargets(['cli:claude', 'cli:codex'])),
      '/api/v1/providers/status': () => jsonResponse({
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        { provider: 'cursor', status: 'not-installed', enabled: true },
        ],
      }),
    })
    renderHeader(run('done', { runner: 'claude', worktreePath: '/tmp/wt' }))
    const menu = await openMenu()
    // The CLI targets load async (useOpenTargets) — findByRole waits them in, unlike the
    // static Terminal/Copy items already asserted synchronously elsewhere in this file.
    expect(await within(menu).findByRole('menuitem', { name: 'Claude CLI (resume)' })).not.toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'Codex CLI' })).not.toBeNull()
  })

  it('a run with no session yet: not even the matching CLI claims to resume', async () => {
    stubFetch({ '/api/v1/open-targets': () => jsonResponse(openTargets(['cli:claude'])) })
    renderHeader(run('done', { runner: 'claude', worktreePath: '/tmp/wt', steps: [step()] }))
    const menu = await openMenu()
    expect(await within(menu).findByRole('menuitem', { name: 'Claude CLI' })).not.toBeNull()
  })

  it('picking a CLI target POSTs /open-in with that target id, resuming or not', async () => {
    const sent = stubFetch({
      '/api/v1/open-targets': () => jsonResponse(openTargets(['cli:codex'])),
      '/api/v1/providers/status': () => jsonResponse({
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        { provider: 'cursor', status: 'not-installed', enabled: true },
        ],
      }),
    })
    renderHeader(run('done', { runner: 'claude', worktreePath: '/tmp/wt' }))
    const menu = await openMenu()
    // Cross-runner (this run is Claude): Codex opens fresh, not "(resume)".
    fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Codex CLI' }))
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/open-in')?.body).toEqual({ target: 'cli:codex' })
    })
  })

  it.each([
    ['disabled', { provider: 'codex', status: 'connected', enabled: false }],
    ['disconnected', { provider: 'codex', status: 'disconnected', enabled: true }],
  ] as const)('keeps non-agent targets while hiding %s Codex handoff targets', async (_case, codex) => {
    stubFetch({
      '/api/v1/open-targets': () => jsonResponse({
        targets: [
          { id: 'cli:codex', label: 'Codex CLI' },
          { id: 'idea', label: 'IntelliJ IDEA', icon: 'idea' },
        ],
      }),
      '/api/v1/providers/status': () => jsonResponse({
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          codex,
          { provider: 'opencode', status: 'not-installed', enabled: true },
        { provider: 'cursor', status: 'not-installed', enabled: true },
        ],
      }),
    })
    renderHeader(run('done', { runner: 'codex', worktreePath: '/tmp/wt' }))
    const menu = await openMenu()

    expect(await within(menu).findByRole('menuitem', { name: 'IntelliJ IDEA' })).not.toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: /Terminal \(resume session\)/ })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: /Codex CLI/ })).toBeNull()
  })
})

describe('Open in… menu per-target icons (#361)', () => {
  it('renders a known target with its mapped icon, falls back for an unrecognized icon key, and POSTs the clicked id', async () => {
    const sent = stubFetch({
      '/api/v1/open-targets': () =>
        jsonResponse({
          targets: [
            { id: 'idea', label: 'IntelliJ IDEA', icon: 'idea' },
            { id: 'mystery-app', label: 'Mystery App', icon: 'not-a-real-icon' },
            { id: 'no-icon-app', label: 'No Icon App' },
          ],
        }),
    })
    renderHeader(run('done', { worktreePath: '/tmp/wt' }))
    fireEvent.pointerDown(actionBar().getByRole('button', { name: 'Open in…' }))
    const menu = await screen.findByRole('menu')

    // The menu opens immediately; the worktree targets only appear once useOpenTargets resolves.
    const ideaItem = await within(menu).findByRole('menuitem', { name: 'IntelliJ IDEA' })
    expect(ideaItem.querySelector('svg')).not.toBeNull()
    // Unknown/missing icon keys still render the generic fallback glyph — never bare text only.
    expect(within(menu).getByRole('menuitem', { name: 'Mystery App' }).querySelector('svg')).not.toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'No Icon App' }).querySelector('svg')).not.toBeNull()

    fireEvent.click(ideaItem)
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/open-in')?.body).toEqual({ target: 'idea' })
    })
  })
})

describe('notes panel', () => {
  it('toggles open, fetches the handoff and renders it as markdown', async () => {
    const sent = stubFetch({
      '/api/v1/runs/r1/handoff': () =>
        new Response('# Handoff notes\n\nStill **todo**: the composer.', {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
    })
    renderHeader(run('done'))
    // Fetched only while open — a closed sheet costs no request.
    expect(sent.some((r) => r.path === '/api/v1/runs/r1/handoff')).toBe(false)

    fireEvent.click((await openMoreMenu()).getByRole('menuitem', { name: 'Notes' }))
    // A side sheet now, not an inline panel under the header.
    const sheet = await screen.findByRole('dialog', { name: 'Notes' })
    await waitFor(() => {
      expect(sheet.querySelector('[data-slot="notes-panel"]')).not.toBeNull()
    })
    await screen.findByText('Handoff notes')
    // Rendered markdown, not echoed source.
    expect(document.querySelector('[data-slot="notes-panel"]')?.textContent).not.toContain('#')

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(document.querySelector('[data-slot="notes-panel"]')).toBeNull())
  })

  it('an unseeded handoff file reads as an honest empty state', async () => {
    stubFetch({
      '/api/v1/runs/r1/handoff': () => new Response('', { status: 200 }),
    })
    renderHeader(run('running'))
    fireEvent.click((await openMoreMenu()).getByRole('menuitem', { name: 'Notes' }))
    await screen.findByText('No notes yet — the handoff file is seeded when the task starts.')
  })
})

/** A run id no other test has touched, so nothing one of these tests opens can reach the shared
 *  `r1` fixture every other test in this file renders. */
let detailsRunSeq = 0
const freshRunId = () => `details-r${++detailsRunSeq}`

describe('dense run details (#765)', () => {
  it('keeps the HOW of a run behind one Details trigger, at every width', () => {
    stubFetch()
    renderHeader(
      run('done', {
        id: freshRunId(),
        branch: 'cez/r1',
        diffStat: { adds: 42, dels: 7, files: 3 },
        costUsd: 0.04,
      }),
    )

    // Closed: the grid is not in the document at all, and the trigger says so.
    expect(document.querySelector('[data-slot="run-details"]')).toBeNull()
    const trigger = detailsBadge()
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    // What a reader wants at a glance stays on the line itself, unopened.
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    expect(meta.contains(trigger)).toBe(true)
    expect(meta.querySelector('[data-slot="branch-chip"]')?.textContent).toContain('cez/r1')
    expect(meta.querySelector('[data-slot="diff-stat"]')?.textContent).toBe('+42 −7')

    const details = openDetails()

    // A real disclosure relationship, not a visual-only one.
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(details.id).not.toBe('')
    expect(trigger.getAttribute('aria-controls')).toBe(details.id)
    expect(detail(details, 'Branch')?.textContent).toBe('cez/r1')
    expect(detail(details, 'Tokens')?.textContent).toBe('IN 24.6k · OUT 2.4k')
    expect(detail(details, 'Cost')?.textContent).toBe('$0.04')
  })

  it('keeps the monitoring schedule out of the disclosure — a self-resuming run is status', () => {
    stubFetch()
    renderHeader(
      run('running', {
        id: freshRunId(),
        activity: 'monitoring',
        monitoringWakeAt: '2026-07-25T10:15:00.000Z',
      }),
    )

    // On the page before anything is opened…
    const schedule = document.querySelector('[data-slot="monitoring-schedule"]')
    expect(schedule).not.toBeNull()
    expect(document.querySelector('[data-slot="run-details"]')).toBeNull()
    // …and still outside the details once they are.
    const details = openDetails()
    expect(details).not.toBeNull()
    expect(details.contains(schedule)).toBe(false)
  })

  it('drops the plan mirror at phone width — the dock it mirrors is already on screen there', () => {
    stubFetch()
    renderHeader(run('running', { id: freshRunId() }), undefined, { done: 1, total: 3 })

    const mirror = document.querySelector('[data-slot="plan-mirror"]') as HTMLElement
    expect(mirror.textContent).toBe('Plan 1/3')
    expect(mirror.className).toContain('hidden')
    expect(mirror.className).toContain('md:inline')
  })
})

describe('meta line, tabs, pill and resume hint', () => {
  it('scrolls the run header on phones but restores sticky context on desktop', () => {
    stubFetch()
    renderHeader(run('done'))

    const header = document.querySelector('[data-slot="run-header"]') as HTMLElement
    const classes = header.className.split(/\s+/)
    expect(classes).toContain('relative')
    expect(classes).not.toContain('sticky')
    expect(classes).not.toContain('top-0')
    expect(classes).toContain('md:sticky')
    expect(classes).toContain('md:top-0')
    expect(classes).toContain('px-4')
    expect(classes).toContain('sm:px-6')
  })

  // The plan mirror hides on phones so the title row keeps its space for the status pill and
  // the kebab. It switches at `md`, the same breakpoint as the sticky header, the tabs, the
  // composer and the dock — an `sm:` here would reveal it between 640-768px in a header that
  // is still not sticky, a state the responsive pass never designed for.
  it('hides the plan mirror on phones and reveals it at the same md breakpoint as the rest of the header', () => {
    stubFetch()
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Routes>
            <Route
              path="/tasks/:id"
              element={<RunHeader run={run('running')} planTally={{ done: 2, total: 5 }} />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const mirror = document.querySelector('[data-slot="plan-mirror"]') as HTMLElement
    expect(mirror.textContent).toContain('Plan 2/5')
    const classes = mirror.className.split(/\s+/)
    expect(classes).toContain('hidden')
    expect(classes).toContain('md:inline')
    expect(classes).not.toContain('sm:inline')
  })

  it('meta shows workflow · branch chip · ±, with the agent on the Details badge and input/output · cost behind it', () => {
    stubFetch()
    renderHeader(
      run('done', {
        runner: 'codex',
        model: 'gpt-5.2-codex',
        branch: 'cez/r1',
        diffStat: { adds: 42, dels: 7, files: 3 },
        costUsd: 0.04,
      }),
    )
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    expect(meta.textContent).toContain('quick-task')
    // #416 pulled runner/model out of the loose dot-list to cut noise, and that still holds — they
    // are not separate chips beside the workflow. But an icon ALONE made "which agent produced
    // this?" unanswerable without knowing to click it, so the runner is named ON the badge; the
    // whole runner · account · model string is its tooltip and accessible name, and the popover
    // keeps the labelled breakdown.
    const badge = within(meta).getByRole('button', { name: /agent: codex, model gpt-5.2-codex/ })
    expect(badge.querySelector('[data-slot="agent-badge-summary"]')?.textContent).toBe('codex')
    expect(badge.getAttribute('title')).toBe('codex · gpt-5.2-codex')
    // Still not loose text: everything runner/model-shaped is inside the badge, nowhere else.
    expect(meta.textContent?.replace(badge.textContent ?? '', '')).not.toContain('codex')
    expect(within(meta).getByText('cez/r1').closest('[data-slot="branch-chip"]')).not.toBeNull()
    expect(meta.querySelector('[data-slot="diff-stat"]')?.textContent).toBe('+42 −7')
    // Tokens and cost left the line: they are rows of the Details grid now.
    expect(meta.textContent).not.toContain('IN 24.6k')
    expect(meta.textContent).not.toContain('$0.04')
    // No context gauge: RunRecord carries no context-window data to draw one from.
    expect(meta.querySelector('[data-slot="context-gauge"]')).toBeNull()

    expect(badge.getAttribute('data-slot')).toBe('agent-badge')

    const details = openDetails()
    expect(detail(details, 'Workflow')?.textContent).toBe('quick-task')
    expect(detail(details, 'Runner')?.textContent).toBe('codex')
    expect(detail(details, 'Model')?.textContent).toBe('gpt-5.2-codex')
    expect(detail(details, 'Tokens')?.textContent).toBe('IN 24.6k · OUT 2.4k')
    expect(detail(details, 'Cost')?.textContent).toBe('$0.04')
  })

  // #801: automation provenance is history — a run launched while automations were on keeps it
  // forever — so the chip stays, but it only LINKS while the capability is on. Following it with
  // automations off would land on the disabled `/automations` state, which says nothing about
  // this task.
  const automated = () => run('done', {
    automation: {
      automationId: 'a-1',
      automationRevision: 1,
      receiptId: 'r-1',
      event: 'issue.opened',
      githubUrl: 'https://github.com/open-mercato/cezar/issues/801',
    },
  })

  it('links the automation chip to its log while automations are on', async () => {
    stubFetch({
      '/api/v1/health': () =>
        jsonResponse({
          capabilities: {
            localHandoff: true, followups: false, singleProject: false, automations: true,
            tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true,
          },
        }),
    })
    renderHeader(automated())

    const link = await screen.findByRole('link', { name: 'Automation' })
    expect(link.getAttribute('href')).toBe('/automations/a-1/log')
  })

  it('degrades the automation chip to plain text while automations are off', async () => {
    stubFetch({
      '/api/v1/health': () =>
        jsonResponse({
          capabilities: {
            localHandoff: true, followups: false, singleProject: false, automations: false,
            tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true,
          },
        }),
    })
    renderHeader(automated())

    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    await waitFor(() =>
      expect(meta.querySelector('[data-slot="automation-origin"]')).not.toBeNull(),
    )
    expect(meta.textContent).toContain('Automation')
    expect(screen.queryByRole('link', { name: 'Automation' })).toBeNull()
  })

  it('omits token and cost text when health disables token metrics', async () => {
    stubFetch({
      '/api/v1/health': () =>
        jsonResponse({
          capabilities: {
            localHandoff: true,
            followups: false,
            singleProject: false,
            tokenMetrics: false,
          },
        }),
    })
    renderHeader(run('done', { costUsd: 0.04 }))

    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    const details = openDetails()
    await waitFor(() => {
      expect(detail(details, 'Tokens')).toBeNull()
      expect(detail(details, 'Cost')).toBeNull()
    })
    expect(details.textContent).not.toContain('IN 24.6k')
    expect(details.textContent).not.toContain('$0.04')
    // The rest of the grid is untouched — only the metered rows go.
    expect(detail(details, 'Runner')).not.toBeNull()
    expect(within(meta).getByRole('button', { name: /agent:/ })).not.toBeNull()
  })

  it.each([
    {
      name: 'both',
      refs: {
        referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/534',
        referencedIssueUrl: 'https://github.com/open-mercato/cezar/issues/544',
      },
      pr: true,
      issue: true,
    },
    {
      name: 'PR only',
      refs: { referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/534' },
      pr: true,
      issue: false,
    },
    {
      name: 'issue only',
      refs: { referencedIssueUrl: 'https://github.com/open-mercato/cezar/issues/544' },
      pr: false,
      issue: true,
    },
    { name: 'neither', refs: {}, pr: false, issue: false },
  ])('shows discovered tracker chips next to the branch ($name)', ({ refs, pr, issue }) => {
    stubFetch()
    renderHeader(run('done', { branch: 'cez/r1', ...refs }))
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    const branch = meta.querySelector('[data-slot="branch-chip"]')
    const prChip = meta.querySelector('[data-slot="pr-chip"]')
    const issueChip = meta.querySelector('[data-slot="issue-chip"]')

    expect(Boolean(prChip)).toBe(pr)
    expect(Boolean(issueChip)).toBe(issue)
    if (prChip) {
      expect(prChip.getAttribute('href')).toBe('https://github.com/open-mercato/cezar/pull/534')
      expect(prChip.textContent).toContain('#534')
      // Right beside the branch: the line no longer puts a separator between its parts.
      expect(branch?.nextElementSibling).toBe(prChip)
    }
    if (issueChip) {
      expect(issueChip.getAttribute('href')).toBe('https://github.com/open-mercato/cezar/issues/544')
      expect(issueChip.textContent).toContain('Issue #544')
    }
  })

  // The conflict chip's one-click prompt, end to end: the forge says a PR will not merge, the
  // chip goes orange, and the panel it opens can send the agent the fix — into the very
  // conversation under this header, which is what makes the button unambiguous here and nowhere
  // else in the cockpit.
  it('sends the resolve-conflicts prompt into this task’s own conversation', async () => {
    const sent = stubFetch({
      '/api/v1/health': () => jsonResponse({ bootProject: 'acme' }),
      '/api/v1/p/acme/github/ref-status?prs=534': () =>
        jsonResponse({ available: true, prs: { 534: 'ready' }, issues: {}, conflicts: [534], recheckAfterMs: null }),
    })
    renderHeader(
      run('running', {
        branch: 'cez/r1',
        referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/534',
      }),
    )

    const chip = await waitFor(() => {
      const found = document.querySelector('[data-slot="pr-chip"][data-conflicting="true"]')
      if (!found) throw new Error('the chip has not learned about the conflict yet')
      return found as HTMLElement
    })
    fireEvent.focus(chip)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Resolve conflicts' })))

    const message = await waitFor(() => {
      const found = sent.find((request) => request.method === 'POST' && request.path.endsWith('/messages'))
      if (!found) throw new Error('nothing was sent')
      return found
    })
    expect(message.body).toMatchObject({ text: resolveConflictsPrompt(534) })
  })

  // A task opened on someone else's PR that pushes a follow-up of its own is about BOTH,
  // and its own page is the last place that should have to pick one. Order is `taskReferences`
  // order — the PR it created, then the PR it is about — the same order the global Tasks table
  // paints.
  it('shows every PR the task points at, not only the strongest one', () => {
    stubFetch()
    renderHeader(
      run('done', {
        branch: 'cez/r1',
        pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/5366',
        referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/4326',
        markerRefs: { pr: 5366 },
      }),
    )
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    const chips = [...meta.querySelectorAll('[data-slot="pr-chip"]')]
    expect(chips.map((chip) => chip.getAttribute('href'))).toEqual([
      'https://github.com/open-mercato/cezar/pull/5366',
      'https://github.com/open-mercato/cezar/pull/4326',
    ])
    expect(chips.map((chip) => chip.textContent)).toEqual([
      expect.stringContaining('#5366'),
      expect.stringContaining('#4326'),
    ])
  })

  // The registry knows every project's own repo, so a number-only chip is a real link here just
  // as it is on All tasks — the two pages must not disagree about the same reference.
  it('links a PR known only by number, using the project registry repo', async () => {
    stubFetch({
      '/api/v1/health': () => jsonResponse({ bootProject: 'boot-id', repo: {} }),
      '/api/v1/projects': () =>
        jsonResponse({
          projects: [
            { id: 'boot-id', name: 'cezar', root: '/home/me/cezar', repoUrl: 'https://github.com/open-mercato/cezar' },
          ],
        }),
    })
    renderHeader(run('done', { branch: 'cez/r1', prNumber: 901, markerRefs: { pr: 901 } }))
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    await waitFor(() => {
      const chip = meta.querySelector('[data-slot="pr-chip"]')
      expect(chip?.getAttribute('href')).toBe('https://github.com/open-mercato/cezar/pull/901')
    })
  })

  // A PR URL whose last segment is not a number never becomes a `taskReferences` entry, so it is
  // painted from `taskPrUrl` — and must still be painted when a number-only chip exists beside it
  // (#847: a forge whose PR URLs are not `…/pull/N`).
  it('keeps a non-numeric PR link beside a chip known only by number', () => {
    stubFetch({ '/api/v1/health': () => jsonResponse({ repo: {} }) })
    renderHeader(
      run('done', {
        branch: 'cez/r1',
        pullRequestUrl: 'https://forge.example.com/o/r/merge_requests/spec-fix',
        prNumber: 42,
      }),
    )
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    const chips = [...meta.querySelectorAll('[data-slot="pr-chip"]')]
    expect(chips).toHaveLength(2)
    expect(chips.map((chip) => chip.getAttribute('href'))).toContain(
      'https://forge.example.com/o/r/merge_requests/spec-fix',
    )
  })

  it('shows a PR known only by number, with no repository to link it to', () => {
    stubFetch({ '/api/v1/health': () => jsonResponse({ repo: {} }) })
    renderHeader(
      run('done', {
        branch: 'cez/r1',
        pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/5366',
        prNumber: 901,
      }),
    )
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    const chips = [...meta.querySelectorAll('[data-slot="pr-chip"]')]
    expect(chips.map((chip) => chip.textContent)).toEqual([
      expect.stringContaining('#5366'),
      expect.stringContaining('#901'),
    ])
    expect(chips[1]?.tagName).toBe('SPAN') // inert: nothing to link to
  })

  it('the agent badge reveals runner and model on click, reading "auto" when the model is unset', async () => {
    stubFetch()
    renderHeader(run('done', { runner: 'opencode' }))
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    expect(within(meta).getByRole('button', { name: /agent: opencode/ })).toBe(detailsBadge())
    const details = openDetails()
    expect(detail(details, 'Runner')?.textContent).toBe('opencode')
    expect(detail(details, 'Model')?.textContent).toBe('auto')
  })

  it('offers the next-continuation engine picker inside the existing agent badge', async () => {
    stubFetch()
    renderHeader(
      run('done', { runner: 'claude', model: 'sonnet' }),
      undefined,
      undefined,
      <button type="button" aria-label="Model">sonnet</button>,
    )

    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    expect(within(meta).getByRole('button', { name: /agent: claude/ })).toBe(detailsBadge())
    const details = openDetails()
    expect(within(details).getByText('Next continuation')).not.toBeNull()
    const picker = details.querySelector('[data-slot="agent-badge-engine-picker"]') as HTMLElement
    expect(within(picker).getByRole('button', { name: 'Model' }).textContent).toBe('sonnet')
  })

  it('keeps the historical badge read-only when no continuation picker is owned by the view', async () => {
    stubFetch()
    renderHeader(run('running', { runner: 'claude', model: 'sonnet' }))
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    expect(within(meta).getByRole('button', { name: /agent: claude/ })).toBe(detailsBadge())
    const details = openDetails()
    expect(detail(details, 'Model')?.textContent).toBe('sonnet') // the grid really is open
    expect(within(details).queryByText('Next continuation')).toBeNull()
    expect(details.querySelector('[data-slot="agent-badge-engine-picker"]')).toBeNull()
  })

  // #416: the record persists only the runner the caller ASKED for (`src/runs/store.ts`), while
  // the run executes as `input.runner ?? config.defaultRunner` (`src/workflows/run.ts`). So a
  // record without a runner must name the repo's DEFAULT agent — hardcoding 'claude' here would
  // confidently name the wrong agent on a codex/opencode repo, which is the exact question the
  // badge exists to answer.
  it('a run with no explicit runner names the active project config default, not boot health', async () => {
    stubFetch({
      '/api/v1/health': () => jsonResponse({ defaultRunner: 'claude' }),
      '/api/v1/config': () => jsonResponse({ defaultRunner: 'codex', defaultModels: {} }),
    })
    renderHeader(run('done', { runner: undefined }))
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    const badge = await within(meta).findByRole('button', { name: /agent: codex, model auto/ })
    expect(badge.getAttribute('data-slot')).toBe('agent-badge')
    expect(badge.querySelector('[data-slot="agent-badge-summary"]')?.textContent).toBe('codex')
  })

  /**
   * Which ACCOUNT a task ran under (spec 2026-07-29-agent-profiles). Read from the step that
   * actually spawned, never from the run's composer override or the project's current selection:
   * the override is absent whenever the run simply followed the project, and the selection can have
   * changed since — either would name an account this run may never have touched.
   */
  describe('the account a task ran under', () => {
    const withAccounts = (extra: Record<string, () => Response> = {}) => stubFetch({
      '/api/v1/workspace/agent-profiles': () => jsonResponse({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        defaults: {},
        profiles: [
          { id: 'default', provider: 'claude', label: 'Default', configDir: '~/.claude', path: '/home/u/.claude', exists: true, looksValid: true, isDefault: true, files: [] },
          { id: 'klaudiusz', provider: 'claude', label: 'Klaudiusz', configDir: '~/.claude-klaudiusz', path: '/home/u/.claude-klaudiusz', exists: true, looksValid: true, isDefault: false, files: [] },
        ],
      }),
      ...extra,
    })

    it('names the account the step recorded, by its label — on the badge itself and in its grid', async () => {
      withAccounts()
      renderHeader(run('done', {
        runner: 'claude',
        model: 'opus',
        steps: [step({ sessionId: 'sess-1', profileId: 'klaudiusz' })],
      }))
      const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
      const badge = await within(meta).findByRole('button', { name: /agent: claude, account Klaudiusz, model opus/ })
      // The regression this guards: it read as a bare bot icon, so the answer was there but nobody
      // could find it without knowing to open a menu. The badge now names the runner in words, and
      // carries the whole runner · account · model string as its tooltip.
      expect(badge.querySelector('[data-slot="agent-badge-summary"]')?.textContent).toBe('claude')
      await waitFor(() => expect(badge.getAttribute('title')).toBe('claude · Klaudiusz · opus'))
      const details = openDetails()
      expect(detail(details, 'Account')?.textContent).toBe('Klaudiusz')
      expect(detail(details, 'Account')?.getAttribute('data-slot')).toBe('agent-badge-account')
    })

    it('prefers what RAN over what the composer asked for', async () => {
      // A resumed run reattaches to the account that owns the session, whatever the run record's
      // override says — so the badge must report the step, or it would name the wrong subscription.
      withAccounts()
      renderHeader(run('done', {
        runner: 'claude',
        agentProfile: 'default',
        steps: [step({ sessionId: 'sess-1', profileId: 'klaudiusz' })],
      }))
      const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
      await within(meta).findByRole('button', { name: /account Klaudiusz/ })
    })

    it('says nothing at all for a run from before accounts existed', async () => {
      // Nothing wrote it down, so claiming the discovered account would be an invention.
      withAccounts()
      renderHeader(run('done', { runner: 'claude', steps: [step({ sessionId: 'sess-1' })] }))
      const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
      const badge = await within(meta).findByRole('button', { name: /agent: claude, model auto/ })
      expect(badge.getAttribute('title')).toBe('claude · auto')
      const details = openDetails()
      expect(detail(details, 'Runner')?.textContent).toBe('claude') // the grid really is open
      expect(detail(details, 'Account')).toBeNull()
      expect(document.querySelector('[data-slot="agent-badge-account"]')).toBeNull()
    })

    it('still names an account that has since been removed', async () => {
      // The id is the only remaining pointer to the folder this run's sessions live in.
      withAccounts()
      renderHeader(run('done', {
        runner: 'claude',
        steps: [step({ sessionId: 'sess-1', profileId: 'deleted-one' })],
      }))
      const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
      await within(meta).findByRole('button', { name: /account deleted-one \(removed\)/ })
    })
  })

  describe('the canonical model identity (#546)', () => {
    /** Opens the Details popover — its grid is not in the DOM until it does. */
    const openAgentMenu = async () => {
      const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
      expect(within(meta).getByRole('button', { name: /agent:/ })).toBe(detailsBadge())
      const details = openDetails()
      await waitFor(() => expect(detail(details, 'Model')).not.toBeNull())
      return details
    }

    it('shows the provider/model the run actually resolved to', async () => {
      // The reader `modelIdentity` was missing (#546): #405 persisted it for cost attribution and
      // replay and nothing read it, so the field could rot without anyone noticing.
      stubFetch()
      renderHeader(run('done', {
        runner: 'claude',
        model: 'opus',
        modelIdentity: 'anthropic/claude-opus-4-8',
      }))
      const menu = await openAgentMenu()
      expect(menu.querySelector('[data-slot="agent-badge-identity"]')?.textContent)
        .toBe('anthropic/claude-opus-4-8')
      expect(detail(menu, 'Identity')).toBe(menu.querySelector('[data-slot="agent-badge-identity"]'))
      // It ADDS to the asked-for model rather than replacing it — `model` is still the free-text
      // the caller typed, and losing that would make the badge answer a different question.
      expect(detail(menu, 'Model')?.textContent).toBe('opus')
    })

    it('says nothing for a run from before the identity was recorded', async () => {
      // Same omitted-not-guessed rule as the account line: resolving it now would attribute a
      // provider to a run that never wrote one down.
      stubFetch()
      renderHeader(run('done', { runner: 'claude', model: 'opus' }))
      const menu = await openAgentMenu()
      expect(menu.querySelector('[data-slot="agent-badge-identity"]')).toBeNull()
    })

    it('omits the line when it would only repeat the model', async () => {
      // A gateway id is already in provider/model form, so echoing it would be noise in a menu
      // whose whole value is that every line answers something.
      stubFetch()
      renderHeader(run('done', {
        runner: 'claude',
        model: 'anthropic/claude-opus-4-8',
        modelIdentity: 'anthropic/claude-opus-4-8',
      }))
      const menu = await openAgentMenu()
      expect(menu.querySelector('[data-slot="agent-badge-identity"]')).toBeNull()
      expect(detail(menu, 'Identity')).toBeNull()
      expect(detail(menu, 'Model')?.textContent).toBe('anthropic/claude-opus-4-8')
    })
  })

  it('a claude run still gets an agent badge — Claude is the default, not a hidden runner', () => {
    stubFetch()
    renderHeader(run('done', { runner: 'claude' }))
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    const badge = within(meta).getByRole('button', { name: /agent: claude, model auto/ })
    // Named on the badge like any other agent — claude being the default is not a reason to leave
    // "what produced this?" unanswered.
    expect(badge.querySelector('[data-slot="agent-badge-summary"]')?.textContent).toBe('claude')
    expect(badge.getAttribute('title')).toBe('claude · auto')
  })

  it('tabs: Chat (the session) is current; Changes, Commits and Files link to the routed surfaces', () => {
    stubFetch()
    renderHeader(run('done'))
    const tabs = within(document.querySelector('[data-slot="run-tabs"]') as HTMLElement)
    expect(tabs.getByRole('link', { name: 'Chat' }).getAttribute('aria-current')).toBe('page')
    expect(tabs.getByRole('link', { name: 'Chat' }).getAttribute('href')).toBe('/tasks/r1')
    expect(tabs.getByRole('link', { name: 'Commits' }).getAttribute('href')).toBe('/tasks/r1/commits')
    expect(tabs.getByRole('link', { name: 'Changes' }).getAttribute('href')).toBe('/tasks/r1/changes')
    expect(tabs.getByRole('link', { name: 'Code' }).getAttribute('href')).toBe('/tasks/r1/files')
  })

  it('tabs: Graph appears for a run with a workflow definition (a step list opens as its graph)', () => {
    stubFetch()
    const { unmount } = renderHeader(run('done'))
    expect(within(document.querySelector('[data-slot="run-tabs"]') as HTMLElement).queryByRole('link', { name: 'Graph' })).toBeNull()
    unmount()
    renderHeader(
      run('running', {
        workflowDef: {
          name: 'g',
          source: 'file',
          steps: [],
          graph: { nodes: [{ id: 'start', type: 'start' }], edges: [] },
        },
      }),
    )
    const tabs = within(document.querySelector('[data-slot="run-tabs"]') as HTMLElement)
    expect(tabs.getByRole('link', { name: 'Graph' }).getAttribute('href')).toBe('/tasks/r1/graph')
  })

  it('copies the branch name from its header chip and confirms it in the tooltip', async () => {
    stubFetch()
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderHeader(run('done', { branch: 'cez/feature-branch' }))

    fireEvent.click(screen.getByRole('button', { name: 'Copy branch name cez/feature-branch' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('cez/feature-branch')
      expect(screen.getAllByText('Copied').length).toBeGreaterThan(0)
      expect(screen.getByRole('status').textContent).toBe('Branch name copied')
    })
  })

  it('keeps the full confirmation window after a rapid second copy', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderHeader(run('done', { branch: 'cez/feature-branch' }))
    const chip = screen.getByRole('button', { name: 'Copy branch name cez/feature-branch' })

    fireEvent.click(chip)
    await act(async () => {})
    act(() => vi.advanceTimersByTime(1_000))
    fireEvent.click(chip)
    await act(async () => {})
    act(() => vi.advanceTimersByTime(500))

    expect(writeText).toHaveBeenCalledTimes(2)
    expect(screen.getAllByText('Copied').length).toBeGreaterThan(0)
    vi.useRealTimers()
  })

  it.each([
    ['has no Clipboard API', {}],
    ['is denied clipboard access', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } }],
  ])('shows the branch itself when the browser %s', async (_case, navigatorStub) => {
    stubFetch()
    vi.stubGlobal('navigator', navigatorStub)
    renderHeader(run('done', { branch: 'cez/feature-branch' }))

    fireEvent.click(screen.getByRole('button', { name: 'Copy branch name cez/feature-branch' }))

    expect(await screen.findByText('Branch: cez/feature-branch')).not.toBeNull()
  })

  it('clears the pending copy confirmation when the header unmounts', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: () => Promise.resolve() } })
    const view = renderHeader(run('done', { branch: 'cez/feature-branch' }))

    fireEvent.click(screen.getByRole('button', { name: 'Copy branch name cez/feature-branch' }))
    await act(async () => {})
    const dismissCall = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 1_500)
    expect(dismissCall).toBeGreaterThanOrEqual(0)
    const dismissTimer = setTimeoutSpy.mock.results[dismissCall]?.value
    view.unmount()
    expect(clearTimeoutSpy).toHaveBeenCalledWith(dismissTimer)
    vi.useRealTimers()
  })

  it('a queued run shows its position in the pill, from the shared runs list', async () => {
    stubFetch({
      '/api/v1/runs': () =>
        jsonResponse([
          run('queued', { id: 'earlier', createdAt: '2026-07-14T11:00:00.000Z' }),
          run('queued'),
        ]),
    })
    renderHeader(run('queued'))
    await waitFor(() => {
      expect(document.querySelector('[data-slot="run-status"]')?.textContent).toBe('queued #2')
    })
  })

  it('a closed run with a session shows the copyable per-backend resume hint', async () => {
    stubFetch()
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderHeader(run('failed', { runner: 'opencode', worktreePath: '/tmp/wt' }))

    // It is a row of the Details grid now: the command, and a copy button beside it.
    const details = openDetails()
    expect(detail(details, 'Take over')?.textContent).toContain('cd /tmp/wt && opencode --session sess-1')
    const hint = details.querySelector('[data-slot="resume-hint"]') as HTMLElement
    expect(hint.getAttribute('aria-label')).toBe('Copy the take-over command')
    fireEvent.click(hint)
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('cd /tmp/wt && opencode --session sess-1')
    })
    await waitFor(() => expect(toastText()).toBe('Command copied to clipboard.'))
  })

  it('the More menu copies the same take-over command', async () => {
    stubFetch()
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderHeader(run('failed', { runner: 'opencode', worktreePath: '/tmp/wt' }))

    fireEvent.click((await openMoreMenu()).getByRole('menuitem', { name: 'Copy take-over command' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('cd /tmp/wt && opencode --session sess-1')
    })
  })

  it('an active run has no resume hint — the engine still owns the session', async () => {
    stubFetch()
    renderHeader(run('running'))
    const details = openDetails()
    expect(detail(details, 'Runner')).not.toBeNull() // the grid really is open
    expect(detail(details, 'Take over')).toBeNull()
    expect(document.querySelector('[data-slot="resume-hint"]')).toBeNull()
    expect((await openMoreMenu()).queryByRole('menuitem', { name: 'Copy take-over command' })).toBeNull()
  })
})

/**
 * Provenance in the thread header (spec `.ai/specs/2026-09-10-dispatch.md`): a dispatched task
 * links back to the task that ordered it, and a task that dispatched work names what it started.
 * Both are read from the run list this page already holds, so neither costs a request.
 */
describe('dispatch lines', () => {
  const parentLine = () => document.querySelector('[data-slot="dispatch-parent-line"]')
  const parentLink = () => document.querySelector('[data-slot="dispatch-parent"]')
  const childrenLine = () => document.querySelector('[data-slot="dispatch-children"]')
  const childLinks = () => [...document.querySelectorAll('[data-slot="dispatch-child"]')]

  it('says nothing at all for a plain task', async () => {
    stubFetch()
    renderHeader(run('done'))
    await waitFor(() => expect(document.querySelector('[data-slot="run-actions"]')).not.toBeNull())
    expect(parentLine()).toBeNull()
    expect(childrenLine()).toBeNull()
  })

  it('links a child back to its parent, titled from the run list', async () => {
    stubFetch({
      '/api/v1/runs': () =>
        jsonResponse([run('done', { id: 'p1', title: 'Ship the release', titleSummary: 'Ship the release' })]),
    })
    renderHeader(run('running', { id: 'c1', dispatch: { rootRunId: 'p1', parentRunId: 'p1' } }))
    // The title arrives with the run list; the link itself is painted from `run.dispatch` alone.
    await waitFor(() => expect(parentLink()?.textContent).toContain('Ship the release'))
    expect(parentLine()?.textContent).toContain('Dispatched by')
    expect(parentLink()?.getAttribute('href')).toBe('/tasks/p1')
  })

  // A parent outside the list (another project, pruned) still gets its link: dropping the line
  // would leave a thread that cannot say who ordered it.
  it('falls back to the parent’s id when the list does not carry it', async () => {
    stubFetch()
    renderHeader(run('running', { id: 'c1', dispatch: { rootRunId: 'gone', parentRunId: 'gone' } }))
    await waitFor(() => expect(parentLink()).not.toBeNull())
    expect(parentLink()?.textContent).toContain('gone')
  })

  it('names the subtasks a parent dispatched, each linking into its own thread', async () => {
    stubFetch({
      '/api/v1/runs': () =>
        jsonResponse([
          run('done', { id: 'k1', titleSummary: 'Review PR #1', dispatch: { rootRunId: 'r1', parentRunId: 'r1' } }),
          run('running', { id: 'k2', titleSummary: 'Review PR #2', dispatch: { rootRunId: 'r1', parentRunId: 'r1' } }),
          run('done', { id: 'other', titleSummary: 'Unrelated' }),
        ]),
    })
    renderHeader(run('running', { id: 'r1', dispatch: { rootRunId: 'r1' } }))
    await waitFor(() => expect(childLinks()).toHaveLength(2))
    expect(childrenLine()?.textContent).toContain('Subtasks')
    expect(childLinks().map((a) => a.getAttribute('href'))).toEqual(['/tasks/k1', '/tasks/k2'])
  })

  // The role chip is gone with the ranks it named — nothing in the header may reintroduce it.
  it('wears no rank chip', async () => {
    stubFetch()
    renderHeader(run('running', { dispatch: { rootRunId: 'r1' } }))
    await waitFor(() => expect(document.querySelector('[data-slot="run-actions"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="unit-role"]')).toBeNull()
  })
})
