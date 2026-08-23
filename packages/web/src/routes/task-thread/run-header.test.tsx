import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunStatus, StepState } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { RunHeader, RunMetaFooter, TakeOverButton } from './run-header'
import { resolveConflictsPrompt } from './run-actions'

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
          <Route
            path="/tasks/:id"
            element={
              <>
                <RunHeader run={record} onMarkedUnread={onMarkedUnread} />
                {/* Cost/Agent/Mode/Tokens moved to the meta footer (mounted under the composer in
                    production); render it here so the meta assertions still have a home. */}
                <RunMetaFooter run={record} />
              </>
            }
          />
          <Route path="/" element={<div data-slot="home-probe" />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const actionBar = () => within(document.querySelector('[data-slot="run-actions"]') as HTMLElement)

/** Accessible name of each inline action (the icon-only "More actions" trigger reads its label). */
const inlineActionNames = () =>
  actionBar()
    .getAllByRole('button')
    .map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim())

/** Open the desktop overflow (#765) and return a scope over its folded secondary actions. */
const openOverflow = async () => {
  fireEvent.pointerDown(actionBar().getByRole('button', { name: 'More actions' }))
  return within(await screen.findByRole('menu'))
}

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

const openRename = async () => {
  const menu = await openOverflow()
  fireEvent.click(menu.getByRole('menuitem', { name: 'Rename' }))
  // The input mounts a tick later: the row opens itself in an effect.
  return (await screen.findByLabelText('Task title')) as HTMLInputElement
}

describe('editable title (#389)', () => {
  it('Rename in the overflow opens the input; Enter PATCHes the trimmed title exactly once', async () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))

    const input = await openRename()
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
    const input = await openRename()
    fireEvent.change(input, { target: { value: 'Renamed on blur' } })
    fireEvent.blur(input)
    await waitFor(() => {
      expect(sent.find((r) => r.method === 'PATCH')?.body).toEqual({ title: 'Renamed on blur' })
    })
  })

  it('Escape abandons the draft — no PATCH, the old title stays', async () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))
    const input = await openRename()
    fireEvent.change(input, { target: { value: 'Never sent' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Do the thing')
    expect(sent.some((r) => r.method === 'PATCH')).toBe(false)
  })

  it('an unchanged or emptied draft is not worth a request', async () => {
    const sent = stubFetch()
    renderHeader(run('waiting'))
    for (const value of ['Do the thing', '   ']) {
      const input = await openRename()
      fireEvent.change(input, { target: { value } })
      fireEvent.keyDown(input, { key: 'Enter' })
    }
    expect(sent.some((r) => r.method === 'PATCH')).toBe(false)
  })
})

describe('action bar visibility per status (#765: primaries inline, the rest folded)', () => {
  // Inline = Finish (when flagged), then the ONE stateful primary CTA (its label follows the
  // lifecycle — design review), then Open in… and the "More actions" disclosure; the secondary
  // actions live in that overflow menu.
  const matrix: Array<{ status: RunStatus; inline: string[]; overflow: string[] }> = [
    { status: 'queued', inline: ['Stop'], overflow: ['Rename', 'Notes', 'Cancel'] },
    { status: 'running', inline: ['Stop'], overflow: ['Rename', 'Notes', 'Cancel'] },
    { status: 'waiting', inline: ['Finish', 'Reply'], overflow: ['Rename', 'Notes', 'Cancel'] },
    { status: 'review', inline: ['Finish', 'Review changes', 'Open in'], overflow: ['Rename', 'Notes', 'Archive', 'Delete'] },
    { status: 'done', inline: ['Reopen', 'Open in'], overflow: ['Rename', 'Notes', 'Archive', 'Delete'] },
    { status: 'failed', inline: ['Retry', 'Open in'], overflow: ['Rename', 'Notes', 'Archive', 'Delete'] },
    { status: 'cancelled', inline: ['Reopen', 'Open in'], overflow: ['Rename', 'Notes', 'Archive', 'Delete'] },
  ]

  it.each(matrix)('$status → inline $inline, overflow $overflow', async ({ status, inline, overflow }) => {
    stubFetch()
    renderHeader(run(status))
    expect(inlineActionNames()).toEqual([...inline, 'More actions'])
    const menu = await openOverflow()
    expect(menu.getAllByRole('menuitem').map((el) => el.textContent?.trim())).toEqual(overflow)
  })

  it('an archived run offers Unarchive instead of Archive', async () => {
    stubFetch()
    renderHeader(run('done', { archived: true }))
    const menu = await openOverflow()
    expect(menu.queryByRole('menuitem', { name: 'Archive' })).toBeNull()
    expect(menu.getByRole('menuitem', { name: 'Unarchive' })).not.toBeNull()
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

  it('offers the control for a read, finished run — in the overflow, before Archive', async () => {
    stubFetch()
    renderHeader(readDone())
    const menu = await openOverflow()
    expect(menu.getAllByRole('menuitem').map((el) => el.textContent?.trim())).toEqual([
      'Rename',
      'Notes',
      'Mark unread',
      'Archive',
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
    const menu = await openOverflow()
    expect(menu.queryByRole('menuitem', { name: 'Mark unread' })).toBeNull()
  })

  it('Mark unread → POST /unread, bodyless like its read twin', async () => {
    const sent = stubFetch()
    renderHeader(readDone())
    fireEvent.click((await openOverflow()).getByRole('menuitem', { name: 'Mark unread' }))
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
    fireEvent.click((await openOverflow()).getByRole('menuitem', { name: 'Mark unread' }))
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
    fireEvent.click((await openOverflow()).getByRole('menuitem', { name: 'Mark unread' }))
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
    const button = actionBar().getByRole<HTMLButtonElement>('button', { name: 'Reopen' })
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

    const button = actionBar().getByRole<HTMLButtonElement>('button', { name: 'Reopen' })
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

    const button = actionBar().getByRole<HTMLButtonElement>('button', { name: 'Reopen' })
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
    fireEvent.click((await openOverflow()).getByRole('menuitem', { name: 'Unarchive' }))
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/archive')?.body).toEqual({ archived: false })
    })
  })

  it('Cancel asks first — the POST fires only after the confirm dialog', async () => {
    const sent = stubFetch()
    renderHeader(run('running'))
    fireEvent.click((await openOverflow()).getByRole('menuitem', { name: 'Cancel' }))

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
    fireEvent.click((await openOverflow()).getByRole('menuitem', { name: 'Delete' }))

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
    fireEvent.click((await openOverflow()).getByRole('menuitem', { name: 'Delete' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('button', { name: 'Delete' })).not.toBeNull()
    expect(within(dialog).getByText(longTitle)).not.toBeNull()
  })

  it('dismissing the confirm keeps the run', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    fireEvent.click((await openOverflow()).getByRole('menuitem', { name: 'Delete' }))
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
    const button = actionBar().getByRole<HTMLButtonElement>('button', { name: 'Reopen' })
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
  fireEvent.pointerDown(actionBar().getByRole('button', { name: 'Open in' }))
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
    const trigger = await actionBar().findByRole('button', { name: 'Open in' })
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
    fireEvent.pointerDown(actionBar().getByRole('button', { name: 'Open in' }))
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

    fireEvent.click((await openOverflow()).getByRole('menuitem', { name: 'Notes' }))
    await waitFor(() => {
      expect(document.querySelector('[data-slot="notes-panel"]')).not.toBeNull()
    })
    await screen.findByText('Handoff notes')
    // Rendered markdown, not echoed source.
    expect(document.querySelector('[data-slot="notes-panel"]')?.textContent).not.toContain('#')

    // Notes toggles: reopen the overflow and pick it again to close the panel.
    fireEvent.click((await openOverflow()).getByRole('menuitem', { name: 'Notes' }))
    expect(document.querySelector('[data-slot="notes-panel"]')).toBeNull()
  })

  it('an unseeded handoff file reads as an honest empty state', async () => {
    stubFetch({
      '/api/v1/runs/r1/handoff': () => new Response('', { status: 200 }),
    })
    renderHeader(run('running'))
    fireEvent.click((await openOverflow()).getByRole('menuitem', { name: 'Notes' }))
    await screen.findByText('No notes yet — the handoff file is seeded when the task starts.')
  })
})

describe('meta line, tabs, pill and resume hint', () => {
  it('meta shows the branch chip, the diffstat on its tab, and the agent summary in the badge', () => {
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
    const footer = document.querySelector('[data-slot="run-meta-footer"]') as HTMLElement
    // The workflow chip left the header (it lives under the composer) and the diffstat rides
    // the Changes tab now — the meta strip holds references and the branch only (UX pass).
    expect(meta.textContent).not.toContain('quick-task')
    expect(within(meta).getByText('cez/r1').getAttribute('data-slot')).toBe('branch-chip')
    expect(meta.querySelector('[data-slot="diff-stat"]')).toBeNull()
    const changesTab = screen.getByRole('link', { name: /Changes/ })
    expect(changesTab.querySelector('[data-slot="diff-stat"]')?.textContent).toBe('+42 −7')
    // The meta footer: the Agent stat names the runner (icon + name), a button that opens the
    // runner/account/model breakdown; the Mode stat carries the model; Tokens and Cost their own.
    const badge = within(footer).getByRole('button', { name: /Agent: codex, model gpt-5.2-codex/ })
    expect(badge.getAttribute('data-slot')).toBe('agent-badge')
    expect(badge.textContent).toContain('codex')
    expect(footer.textContent).toContain('gpt-5.2-codex')
    expect(footer.textContent).toContain('IN 24.6k / OUT 2.4k')
    expect(footer.textContent).toContain('$0.04')
    // No context gauge: RunRecord carries no context-window data to draw one from.
    expect(footer.querySelector('[data-slot="context-gauge"]')).toBeNull()
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

    // Two chip strips by design now: the bar portal's (desktop) and the tab row's (mobile).
    const links = await screen.findAllByRole('link', { name: 'Automation' })
    for (const link of links) expect(link.getAttribute('href')).toBe('/automations/a-1/log')
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

    const footer = document.querySelector('[data-slot="run-meta-footer"]') as HTMLElement
    await waitFor(() => {
      expect(footer.textContent).not.toContain('IN 24.6k')
      expect(footer.textContent).not.toContain('$0.04')
    })
    expect(within(footer).getByRole('button', { name: /Agent:/ })).not.toBeNull()
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
      // Chips sit adjacent now — no middot separator between them (house rule).
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
    const footer = document.querySelector('[data-slot="run-meta-footer"]') as HTMLElement
    fireEvent.pointerDown(within(footer).getByRole('button', { name: /Agent: opencode/ }))
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
    const footer = document.querySelector('[data-slot="run-meta-footer"]') as HTMLElement
    const badge = await within(footer).findByRole('button', { name: /Agent: codex, model auto/ })
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

    it('names the account the step recorded, by its label — on the Agent tile and its menu', async () => {
      withAccounts()
      renderHeader(run('done', {
        runner: 'claude',
        model: 'opus',
        steps: [step({ sessionId: 'sess-1', profileId: 'klaudiusz' })],
      }))
      const footer = document.querySelector('[data-slot="run-meta-footer"]') as HTMLElement
      // The accessible name carries the account; the menu spells it out (its only home — the strip
      // shows runner + model, the account rides the click-through).
      const badge = await within(footer).findByRole('button', { name: /Agent: claude, account Klaudiusz, model opus/ })
      fireEvent.pointerDown(badge)
      const menu = within(await screen.findByRole('menu'))
      expect(menu.getByText('account: Klaudiusz')).not.toBeNull()
      expect(menu.getByText('model: opus')).not.toBeNull()
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
      const footer = document.querySelector('[data-slot="run-meta-footer"]') as HTMLElement
      await within(footer).findByRole('button', { name: /account Klaudiusz/ })
    })

    it('says nothing at all for a run from before accounts existed', async () => {
      // Nothing wrote it down, so claiming the discovered account would be an invention.
      withAccounts()
      renderHeader(run('done', { runner: 'claude', steps: [step({ sessionId: 'sess-1' })] }))
      const footer = document.querySelector('[data-slot="run-meta-footer"]') as HTMLElement
      await within(footer).findByRole('button', { name: /Agent: claude, model auto/ })
      expect(footer.querySelector('[data-slot="agent-badge-account"]')).toBeNull()
    })

    it('still names an account that has since been removed', async () => {
      // The id is the only remaining pointer to the folder this run's sessions live in.
      withAccounts()
      renderHeader(run('done', {
        runner: 'claude',
        steps: [step({ sessionId: 'sess-1', profileId: 'deleted-one' })],
      }))
      const footer = document.querySelector('[data-slot="run-meta-footer"]') as HTMLElement
      await within(footer).findByRole('button', { name: /account deleted-one \(removed\)/ })
    })
  })

  describe('the canonical model identity (#546)', () => {
    /** Opens the agent badge's menu — `DropdownMenuContent` is not in the DOM until it does.
     *  The badge lives on the meta FOOTER (under the composer), not the header's chip row. */
    const openAgentMenu = async () => {
      const meta = document.querySelector('[data-slot="run-meta-footer"]') as HTMLElement
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
    const footer = document.querySelector('[data-slot="run-meta-footer"]') as HTMLElement
    const badge = within(footer).getByRole('button', { name: /Agent: claude, model auto/ })
    // Named on the Agent tile like any other agent — claude being the default is not a reason to
    // leave "what produced this?" unanswered.
    expect(badge.textContent).toContain('claude')
  })

  it('tabs: Session is current; Changes and Files link to the routed surfaces', () => {
    stubFetch()
    renderHeader(run('done'))
    const tabs = within(document.querySelector('[data-slot="run-tabs"]') as HTMLElement)
    expect(tabs.getByRole('link', { name: 'Session' }).getAttribute('aria-current')).toBe('page')
    expect(tabs.getByRole('link', { name: 'Changes' }).getAttribute('href')).toBe('/tasks/r1/changes')
    expect(tabs.getByRole('link', { name: 'Files' }).getAttribute('href')).toBe('/tasks/r1/files')
  })

  // The Status stat left the header (it duplicated the paused/attention hint), so a queued run no
  // longer shows its position here — the QueuedPlaceholder empty state carries it instead.

  // The take-over line is now a compact button UNDER the composer (TakeOverButton) — it no longer
  // prints the raw command; clicking it copies the per-backend resume command.
  it('a closed run with a session shows a take-over button that copies the resume command', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<TakeOverButton run={run('failed', { runner: 'opencode', worktreePath: '/tmp/wt' })} />)

    const btn = document.querySelector('[data-slot="resume-hint"]') as HTMLElement
    expect(btn).not.toBeNull()
    expect(btn.getAttribute('title')).toContain('cd /tmp/wt && opencode --session sess-1')
    fireEvent.click(btn)
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('cd /tmp/wt && opencode --session sess-1')
    })
  })

  it('an active run has no take-over button — the engine still owns the session', () => {
    render(<TakeOverButton run={run('running')} />)
    expect(document.querySelector('[data-slot="resume-hint"]')).toBeNull()
  })
})
