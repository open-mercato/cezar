import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunStatus, StepState } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { RunHeader } from './run-header'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
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
          ],
        })
      }
      return jsonResponse({})
    }),
  )
  return sent
}

function renderHeader(record: ApiRun, onMarkedUnread?: () => void) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/tasks/${record.id}`]}>
        <Routes>
          <Route path="/tasks/:id" element={<RunHeader run={record} onMarkedUnread={onMarkedUnread} />} />
          <Route path="/" element={<div data-slot="home-probe" />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const actionBar = () => within(document.querySelector('[data-slot="run-actions"]') as HTMLElement)

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
  const matrix: Array<{ status: RunStatus; visible: string[] }> = [
    { status: 'queued', visible: ['Notes', 'Cancel'] },
    { status: 'running', visible: ['Notes', 'Cancel'] },
    { status: 'waiting', visible: ['Finish', 'Notes', 'Cancel'] },
    // Terminal folded into the Open in… menu — it shows whenever the session can be resumed.
    { status: 'review', visible: ['Finish', 'Continue', 'Open in…', 'Notes', 'Archive', 'Delete'] },
    { status: 'done', visible: ['Continue', 'Open in…', 'Notes', 'Archive', 'Delete'] },
    { status: 'failed', visible: ['Continue', 'Open in…', 'Notes', 'Archive', 'Delete'] },
    { status: 'cancelled', visible: ['Continue', 'Open in…', 'Notes', 'Archive', 'Delete'] },
  ]

  it.each(matrix)('$status → $visible', ({ status, visible }) => {
    stubFetch()
    renderHeader(run(status))
    const names = within(document.querySelector('[data-slot="run-actions"]') as HTMLElement)
      .getAllByRole('button')
      .map((el) => el.textContent?.trim())
    expect(names).toEqual(visible)
  })

  it('an archived run offers Unarchive instead of Archive', () => {
    stubFetch()
    renderHeader(run('done', { archived: true }))
    expect(actionBar().queryByRole('button', { name: 'Archive' })).toBeNull()
    expect(actionBar().getByRole('button', { name: 'Unarchive' })).not.toBeNull()
  })

  it('VS Code is absent everywhere — the open-in-editor endpoint does not exist yet (R5)', () => {
    stubFetch()
    renderHeader(run('done'))
    expect(screen.queryByRole('button', { name: /vs code/i })).toBeNull()
  })

  it('the mobile kebab is there for every status, holding the same actions', () => {
    stubFetch()
    renderHeader(run('running'))
    expect(screen.getByRole('button', { name: 'Run actions' })).not.toBeNull()
  })
})

describe('Mark unread (#775)', () => {
  const FINISHED_AT = '2026-07-14T13:00:00.000Z'
  const SEEN_AT = '2026-07-14T13:05:00.000Z'
  /** A finished run that has already been read — the one state the action is offered in. */
  const readDone = (extra: Partial<ApiRun> = {}) =>
    run('done', { finishedAt: FINISHED_AT, seenAt: SEEN_AT, ...extra })

  it('offers the control for a read, finished run — next to Archive', () => {
    stubFetch()
    renderHeader(readDone())
    const names = actionBar()
      .getAllByRole('button')
      .map((el) => el.textContent?.trim())
    expect(names).toEqual(['Continue', 'Open in…', 'Notes', 'Mark unread', 'Archive', 'Delete'])
  })

  it.each([
    ['an already-unread run', run('done', { finishedAt: FINISHED_AT })],
    ['an archived run', readDone({ archived: true })],
    ['a cancelled run', run('cancelled', { finishedAt: FINISHED_AT, seenAt: SEEN_AT })],
    ['a still-running run', run('running', { seenAt: SEEN_AT })],
    ['a done run caught with no finishedAt', run('done', { seenAt: SEEN_AT })],
  ] as Array<[string, ApiRun]>)('hides the control for %s', (_name, record) => {
    stubFetch()
    renderHeader(record)
    expect(actionBar().queryByRole('button', { name: 'Mark unread' })).toBeNull()
  })

  it('Mark unread → POST /unread, bodyless like its read twin', async () => {
    const sent = stubFetch()
    renderHeader(readDone())
    fireEvent.click(actionBar().getByRole('button', { name: 'Mark unread' }))
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
    fireEvent.click(actionBar().getByRole('button', { name: 'Mark unread' }))
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
    fireEvent.click(actionBar().getByRole('button', { name: 'Mark unread' }))
    await waitFor(() => expect(screen.getByText('not found')).not.toBeNull())
  })

  it('is in the mobile kebab too, under the same rule', async () => {
    stubFetch()
    renderHeader(readDone())
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Run actions' }))
    const menu = within(await screen.findByRole('menu'))
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

  it('disables desktop Continue and its mutation guard blocks a forced click without a provider', async () => {
    const sent = stubFetch({
      '/api/v1/providers/status': () =>
        jsonResponse({
          providers: [
            { provider: 'claude', status: 'disconnected', enabled: true },
            { provider: 'codex', status: 'unknown', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
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

  it('disables mobile Continue and does not post when its menu item is selected', async () => {
    const sent = stubFetch({
      '/api/v1/providers/status': () =>
        jsonResponse({
          providers: [
            { provider: 'claude', status: 'disconnected', enabled: true },
            { provider: 'codex', status: 'unknown', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          ],
        }),
    })
    renderHeader(run('done', { runner: 'claude' }))

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Run actions' }))
    const item = await screen.findByRole('menuitem', { name: 'Continue' })
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
    fireEvent.click(actionBar().getByRole('button', { name: 'Unarchive' }))
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/archive')?.body).toEqual({ archived: false })
    })
  })

  it('Cancel asks first — the POST fires only after the confirm dialog', async () => {
    const sent = stubFetch()
    renderHeader(run('running'))
    fireEvent.click(actionBar().getByRole('button', { name: 'Cancel' }))

    // Nothing sent yet; the AlertDialog (never a native confirm) is up instead.
    expect(sent.some((r) => r.path === '/api/v1/runs/r1/cancel')).toBe(false)
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel the run' }))
    await waitFor(() => {
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/cancel')).toBe(true)
    })
  })

  it('Delete confirms, DELETEs, and navigates home', async () => {
    const sent = stubFetch()
    renderHeader(run('failed'))
    fireEvent.click(actionBar().getByRole('button', { name: 'Delete' }))

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
    fireEvent.click(actionBar().getByRole('button', { name: 'Delete' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('button', { name: 'Delete' })).not.toBeNull()
    expect(within(dialog).getByText(longTitle)).not.toBeNull()
  })

  it('dismissing the confirm keeps the run', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    fireEvent.click(actionBar().getByRole('button', { name: 'Delete' }))
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
    const item = await screen.findByRole('status')
    expect(item.textContent).toBe('no agent session to resume')
    expect(item.getAttribute('data-tone')).toBe('danger')
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
    expect((await screen.findByRole('status')).textContent).toBe(
      'No terminal found — command copied to clipboard.',
    )
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

    expect((await screen.findByRole('status')).textContent).toBe(`Run manually: ${command}`)
  })

  it('a 409 without a command is an ordinary error toast', async () => {
    stubFetch({
      '/api/v1/runs/r1/open-in-cli': () => jsonResponse({ error: 'no agent session to resume' }, 409),
    })
    renderHeader(run('done'))
    await clickTerminalResume()
    expect((await screen.findByRole('status')).textContent).toBe('no agent session to resume')
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
    stubFetch({
      '/api/v1/runs/r1/handoff': () =>
        new Response('# Handoff notes\n\nStill **todo**: the composer.', {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
    })
    renderHeader(run('done'))

    fireEvent.click(actionBar().getByRole('button', { name: 'Notes' }))
    await waitFor(() => {
      expect(document.querySelector('[data-slot="notes-panel"]')).not.toBeNull()
    })
    await screen.findByText('Handoff notes')
    // Rendered markdown, not echoed source.
    expect(document.querySelector('[data-slot="notes-panel"]')?.textContent).not.toContain('#')

    fireEvent.click(actionBar().getByRole('button', { name: 'Notes' }))
    expect(document.querySelector('[data-slot="notes-panel"]')).toBeNull()
  })

  it('an unseeded handoff file reads as an honest empty state', async () => {
    stubFetch({
      '/api/v1/runs/r1/handoff': () => new Response('', { status: 200 }),
    })
    renderHeader(run('running'))
    fireEvent.click(actionBar().getByRole('button', { name: 'Notes' }))
    await screen.findByText('No notes yet — the handoff file is seeded when the task starts.')
  })
})

describe('meta line, tabs, pill and resume hint', () => {
  it('meta shows workflow · branch chip · ± · input/output · cost, with the agent summary in the badge', () => {
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
    // are not separate chips beside the workflow. But an icon ALONE made "which agent, account and
    // model produced this?" unanswerable without knowing to click it, which is the one question the
    // badge exists for. So they read as one quiet string ON the badge, and the menu keeps the
    // labelled breakdown.
    const badge = within(meta).getByRole('button', { name: /Agent: codex, model gpt-5.2-codex/ })
    expect(badge.querySelector('[data-slot="agent-badge-summary"]')?.textContent)
      .toBe('codex · gpt-5.2-codex')
    // Still not loose text: everything runner/model-shaped is inside the badge, nowhere else.
    expect(meta.textContent?.replace(badge.textContent ?? '', '')).not.toContain('codex')
    expect(within(meta).getByText('cez/r1').getAttribute('data-slot')).toBe('branch-chip')
    expect(meta.querySelector('[data-slot="diff-stat"]')?.textContent).toBe('+42 −7')
    expect(meta.textContent).toContain('IN 24.6k · OUT 2.4k')
    expect(meta.textContent).toContain('$0.04')
    // No context gauge: RunRecord carries no context-window data to draw one from.
    expect(meta.querySelector('[data-slot="context-gauge"]')).toBeNull()

    expect(badge.getAttribute('data-slot')).toBe('agent-badge')
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
    await waitFor(() => {
      expect(meta.textContent).not.toContain('IN 24.6k')
      expect(meta.textContent).not.toContain('$0.04')
    })
    expect(within(meta).getByRole('button', { name: /Agent:/ })).not.toBeNull()
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
      expect(branch?.nextElementSibling?.nextElementSibling).toBe(prChip)
    }
    if (issueChip) {
      expect(issueChip.getAttribute('href')).toBe('https://github.com/open-mercato/cezar/issues/544')
      expect(issueChip.textContent).toContain('Issue #544')
    }
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
    fireEvent.pointerDown(within(meta).getByRole('button', { name: /Agent: opencode/ }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('runner: opencode')).not.toBeNull()
    expect(within(menu).getByText('model: auto')).not.toBeNull()
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
    const badge = await within(meta).findByRole('button', { name: /Agent: codex, model auto/ })
    expect(badge.getAttribute('data-slot')).toBe('agent-badge')
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

    it('names the account the step recorded, by its label — visibly, not only on click', async () => {
      withAccounts()
      renderHeader(run('done', {
        runner: 'claude',
        model: 'opus',
        steps: [step({ sessionId: 'sess-1', profileId: 'klaudiusz' })],
      }))
      const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
      const badge = await within(meta).findByRole('button', { name: /Agent: claude, account Klaudiusz, model opus/ })
      // The regression this guards: it read as a bare bot icon, so the answer was there but nobody
      // could find it without knowing to open a menu.
      await waitFor(() => expect(
        badge.querySelector('[data-slot="agent-badge-summary"]')?.textContent,
      ).toBe('claude · Klaudiusz · opus'))
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
      await within(meta).findByRole('button', { name: /Agent: claude, model auto/ })
      expect(meta.querySelector('[data-slot="agent-badge-account"]')).toBeNull()
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
    /** Opens the agent badge's menu — `DropdownMenuContent` is not in the DOM until it does. */
    const openAgentMenu = async () => {
      const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
      const badge = within(meta).getByRole('button', { name: /^Agent:/ })
      fireEvent.pointerDown(badge, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      await waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
      return document.querySelector('[role="menu"]') as HTMLElement
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
        .toBe('identity: anthropic/claude-opus-4-8')
      // It ADDS to the asked-for model rather than replacing it — `model` is still the free-text
      // the caller typed, and losing that would make the badge answer a different question.
      expect(menu.textContent).toContain('model: opus')
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
      expect(menu.textContent).toContain('model: anthropic/claude-opus-4-8')
    })
  })

  it('a claude run still gets an agent badge — Claude is the default, not a hidden runner', () => {
    stubFetch()
    renderHeader(run('done', { runner: 'claude' }))
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    const badge = within(meta).getByRole('button', { name: /Agent: claude, model auto/ })
    // Named on the badge like any other agent — claude being the default is not a reason to leave
    // "what produced this?" unanswered.
    expect(badge.querySelector('[data-slot="agent-badge-summary"]')?.textContent).toBe('claude · auto')
  })

  it('tabs: Session is current; Changes and Files link to the routed surfaces', () => {
    stubFetch()
    renderHeader(run('done'))
    const tabs = within(document.querySelector('[data-slot="run-tabs"]') as HTMLElement)
    expect(tabs.getByRole('link', { name: 'Session' }).getAttribute('aria-current')).toBe('page')
    expect(tabs.getByRole('link', { name: 'Changes' }).getAttribute('href')).toBe('/tasks/r1/changes')
    expect(tabs.getByRole('link', { name: 'Files' }).getAttribute('href')).toBe('/tasks/r1/files')
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
      expect(document.querySelector('[data-slot="pill"]')?.textContent).toBe('queued #2')
    })
  })

  it('a closed run with a session shows the copyable per-backend resume hint', async () => {
    stubFetch()
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderHeader(run('failed', { runner: 'opencode', worktreePath: '/tmp/wt' }))

    const hint = document.querySelector('[data-slot="resume-hint"]') as HTMLElement
    expect(hint.textContent).toContain('cd /tmp/wt && opencode --session sess-1')
    fireEvent.click(hint)
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('cd /tmp/wt && opencode --session sess-1')
    })
  })

  it('an active run has no resume hint — the engine still owns the session', () => {
    stubFetch()
    renderHeader(run('running'))
    expect(document.querySelector('[data-slot="resume-hint"]')).toBeNull()
  })
})
