import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunStatus, StepState } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { RunHeader, type RunTab } from './run-header'
import { fixChecksPrompt, resolveConflictsPrompt, updateBranchPrompt } from './run-actions'

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
  tab?: RunTab,
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
                tab={tab}
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

const actionBar = () => within(document.querySelector('[data-slot="run-actions"]') as HTMLElement)
/** The title row's task-management icons (Pin · Archive · Delete · ⋯). */
const itemActions = () => within(document.querySelector('[data-slot="task-item-actions"]') as HTMLElement)
const buttonNames = (scope: ReturnType<typeof within>) =>
  scope.queryAllByRole('button').map((el: HTMLElement) => el.getAttribute('aria-label') ?? el.textContent?.trim())
/** The header as a tab with no composer renders it — Continue and Stop live in the header there. */
const renderGitTab = (record: ApiRun) => renderHeader(record, undefined, undefined, undefined, 'changes')
/** An icon-only button's tooltip text — shown on keyboard focus as well as hover. */
async function tooltipOf(trigger: HTMLElement): Promise<string | null> {
  fireEvent.focus(trigger)
  return (await screen.findByRole('tooltip')).textContent
}
function cleanupTooltip(trigger: HTMLElement): void {
  fireEvent.blur(trigger)
}
/** Open the PR `+N` and return the chips it lists — every PR, the visible one included. */
async function overflowChips(): Promise<Element[]> {
  fireEvent.click(document.querySelector('[data-slot="run-meta"] [data-slot="reference-overflow"]')!)
  const list = await screen.findByText('References')
  return [...(list.parentElement as HTMLElement).querySelectorAll('[data-slot="pr-chip"]')]
}
async function openMore(): Promise<ReturnType<typeof within>> {
  fireEvent.pointerDown(itemActions().getByRole('button', { name: 'More actions' }))
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
  // On the Session tab the composer owns Continue (its send button) and Stop. The icons are always
  // there; Terminal folded into the Open in… menu, which shows whenever the session can be resumed.
  const icons = ['Pin', 'Archive', 'Delete']
  const sessionMatrix: Array<{ status: RunStatus; visible: string[] }> = [
    { status: 'queued', visible: icons },
    { status: 'running', visible: icons },
    // No Finish in the header: the waiting hint over the composer carries End session, and a
    // review is accepted from the review panel.
    { status: 'waiting', visible: icons },
    { status: 'review', visible: [...icons, 'Open in…'] },
    { status: 'done', visible: [...icons, 'Open in…'] },
    { status: 'failed', visible: [...icons, 'Open in…'] },
    { status: 'cancelled', visible: [...icons, 'Open in…'] },
  ]

  it.each(sessionMatrix)('session tab: $status → $visible', ({ status, visible }) => {
    stubFetch()
    renderHeader(run(status))
    expect(buttonNames(actionBar())).toEqual(visible)
  })

  it.each<RunTab>(['session', 'changes', 'commits', 'files', 'notes'])(
    'the %s tab offers no header Continue — the chat box’s send is Continue',
    async (tab) => {
      stubFetch()
      renderHeader(run('done'), undefined, undefined, undefined, tab)
      expect(actionBar().queryByRole('button', { name: 'Continue' })).toBeNull()
      // …nor in the phone kebab.
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Run actions' }))
      const menu = within(await screen.findByRole('menu'))
      expect(menu.queryByRole('menuitem', { name: 'Continue' })).toBeNull()
    },
  )

  it('the action icons sit next to the tabs, after the labelled Open in…; the title row has none', () => {
    stubFetch()
    renderHeader(run('done'))
    const openIn = actionBar().getByRole('button', { name: 'Open in…' })
    expect(openIn.textContent).toContain('Open in…')
    expect(actionBar().getByRole('button', { name: 'Pin' })).not.toBeNull()
    const titleRow = document.querySelector('[data-slot="run-identity"]')?.parentElement as HTMLElement
    expect(titleRow.querySelector('[data-slot="task-item-actions"]')).toBeNull()
  })

  // The action icons: the same three in the same places for every status — unavailable ones
  // are greyed with their reason, never removed, so the row never shifts under the pointer.
  it.each(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'] as RunStatus[])(
    'icons for %s: Pin · Archive · Delete, always in place',
    (status) => {
      stubFetch()
      renderHeader(run(status))
      expect(buttonNames(itemActions()).slice(0, 3)).toEqual(['Pin', 'Archive', 'Delete'])
    },
  )

  it.each(['queued', 'running', 'waiting'] as RunStatus[])(
    'a live (%s) run greys Archive and Delete out, saying why',
    async (status) => {
      stubFetch()
      renderHeader(run(status))
      for (const name of ['Archive', 'Delete']) {
        const button = itemActions().getByRole('button', { name })
        expect(button.getAttribute('aria-disabled')).toBe('true')
        expect(await tooltipOf(button)).toBe('Stop the task first')
        cleanupTooltip(button)
      }
      expect(itemActions().getByRole('button', { name: 'Pin' }).getAttribute('aria-disabled')).toBeNull()
    },
  )

  it('a greyed-out Archive sends nothing when clicked', async () => {
    const sent = stubFetch()
    renderHeader(run('running'))
    fireEvent.click(itemActions().getByRole('button', { name: 'Archive' }))
    fireEvent.click(itemActions().getByRole('button', { name: 'Delete' }))
    await act(() => Promise.resolve())
    expect(sent.some((r) => r.path === '/api/v1/runs/r1/archive')).toBe(false)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('an archived run offers Unarchive instead of Archive', () => {
    stubFetch()
    renderHeader(run('done', { archived: true }))
    expect(itemActions().queryByRole('button', { name: 'Archive' })).toBeNull()
    expect(itemActions().getByRole('button', { name: 'Unarchive' })).not.toBeNull()
  })

  it('the status sits top right, just before the git button; progress follows the title', async () => {
    stubFetch({
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 2, unpushed: null }),
      '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
    })
    renderHeader(run('done', { worktreePath: '/tmp/wt/r1', branch: 'cez/r1' }), undefined, { done: 1, total: 3 })
    const identity = document.querySelector('[data-slot="run-identity"]') as HTMLElement
    expect(identity.querySelector('[data-slot="pill"]')).toBeNull()
    expect(identity.lastElementChild?.getAttribute('data-slot')).toBe('plan-mirror')
    const pills = document.querySelectorAll('[data-slot="pill"]')
    expect(pills).toHaveLength(1)
    const pill = pills[0] as HTMLElement
    expect(pill.parentElement?.className).toContain('ml-auto')
    const gitButton = await waitFor(() => {
      const el = document.querySelector('[data-slot="git-button"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(pill.compareDocumentPosition(gitButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('the details row reads workflow · branch · diff · PR', () => {
    stubFetch()
    renderHeader(
      run('done', {
        branch: 'cez/r1',
        diffStat: { adds: 0, dels: 0, files: 0 },
        pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/1311',
      }),
    )
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    const diff = meta.querySelector('[data-slot="diff-stat"]') as HTMLElement
    const pr = meta.querySelector('[data-slot="pr-chip"]') as HTMLElement
    expect(diff.compareDocumentPosition(pr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('tokens, cost and the agent badge sit on the tabs line on desktop', () => {
    stubFetch()
    renderHeader(run('done', { costUsd: 12, inputTokens: 152, outputTokens: 37_300 }))
    const desktop = document.querySelector('[data-slot="run-tabs"] [data-slot="run-usage"]') as HTMLElement
    expect(desktop.className).toContain('hidden')
    expect(desktop.className).toContain('md:flex')
    expect(desktop.textContent).toContain('$12')
    expect(desktop.querySelector('[data-slot="agent-badge"]')).not.toBeNull()
    // Phones read it in the collapsible details row instead.
    const phone = document.querySelector('[data-slot="run-meta"] [data-slot="run-usage"]') as HTMLElement
    expect(phone.className).toContain('md:hidden')
  })

  it('the git button sits top right; the other actions close the details row', async () => {
    stubFetch({
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 0, unpushed: 1 }),
      '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
      '/api/v1/repo': () => jsonResponse({ info: { remote: 'git@github.com:open-mercato/cezar.git' } }),
    })
    renderHeader(
      run('done', {
        worktreePath: '/tmp/wt/r1',
        branch: 'cez/r1',
        pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/1311',
      }),
    )
    const bar = document.querySelector('[data-slot="run-actions"]') as HTMLElement
    expect(bar.closest('[data-slot="run-meta"]')).not.toBeNull()
    expect(bar.querySelector('[data-slot="git-button"]')).toBeNull()
    // A PR behind its branch: the one git step is Push.
    const button = await waitFor(() => {
      const el = document.querySelector('[data-slot="git-button"]')
      expect(el).not.toBeNull()
      expect(el!.querySelector('[data-action="push"]')).not.toBeNull()
      return el as HTMLElement
    })
    expect(button.closest('[data-slot="run-meta"]')).toBeNull()
    expect(button.closest('[data-slot="run-identity"]')).toBeNull()
  })

  it.each([
    ['conflicting', { prs: { 1311: 'ready' }, conflicts: [1311] }, 'Resolve conflicts', resolveConflictsPrompt(1311)],
    ['failing CI', { prs: { 1311: 'checks-failing' }, conflicts: [] }, 'Fix errors', fixChecksPrompt(1311)],
  ] as const)('a %s PR turns the git button into its fix, sent to the task’s own agent', async (_name, forge, label, prompt) => {
    const sent = stubFetch({
      '/api/v1/health': () => jsonResponse({ bootProject: 'acme', forge: { kind: 'github', available: true } }),
      '/api/v1/p/acme/github/ref-status?prs=1311': () =>
        jsonResponse({ available: true, issues: {}, recheckAfterMs: null, ...forge }),
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 0, unpushed: 0 }),
    })
    renderHeader(
      run('running', {
        worktreePath: '/tmp/wt/r1',
        branch: 'cez/r1',
        pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/1311',
      }),
    )
    const button = await waitFor(() => {
      const el = document.querySelector('[data-slot="git-button"] button') as HTMLButtonElement | null
      expect(el?.textContent).toBe(label)
      return el!
    })
    fireEvent.click(button)
    const message = await waitFor(() => {
      const found = sent.find((r) => r.method === 'POST' && r.path.endsWith('/messages'))
      if (!found) throw new Error('nothing was sent')
      return found
    })
    expect(message.body).toMatchObject({ text: prompt })
  })

  it('a branch behind its base offers Update branch instead of Create PR, sent to the task’s agent', async () => {
    const sent = stubFetch({
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 0, unpushed: null, behind: 4 }),
      '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
    })
    renderHeader(run('running', { worktreePath: '/tmp/wt/r1', branch: 'cez/r1', baseBranch: 'origin/main' }))
    const button = await waitFor(() => {
      const el = document.querySelector('[data-slot="git-button"] button') as HTMLButtonElement | null
      expect(el?.textContent).toBe('Update branch')
      return el!
    })
    expect(document.querySelector('[data-action="create-pr"]')).toBeNull()
    fireEvent.click(button)
    const message = await waitFor(() => {
      const found = sent.find((r) => r.method === 'POST' && r.path.endsWith('/messages'))
      if (!found) throw new Error('nothing was sent')
      return found
    })
    expect(message.body).toMatchObject({ text: updateBranchPrompt('origin/main') })
    expect((message.body as { text: string }).text).toContain('origin/main')
  })

  it('a merged PR leaves nothing to commit or push — the git button goes, the PR chip stays', async () => {
    stubFetch({
      '/api/v1/health': () => jsonResponse({ bootProject: 'acme', forge: { kind: 'github', available: true } }),
      '/api/v1/p/acme/github/ref-status?prs=1283': () =>
        jsonResponse({ available: true, prs: { 1283: 'merged' }, issues: {}, conflicts: [], recheckAfterMs: null }),
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 1, unpushed: 1 }),
    })
    renderHeader(
      run('done', {
        worktreePath: '/tmp/wt/r1',
        branch: 'cez/r1',
        pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/1283',
      }),
    )
    await waitFor(() => expect(document.querySelector('[data-slot="run-meta"] [data-slot="pr-chip"]')).not.toBeNull())
    await waitFor(() => expect(document.querySelector('[data-slot="git-button"]')).toBeNull())
  })

  it('a task working on a declared PR is never offered Create PR', async () => {
    stubFetch({
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 2, unpushed: 0 }),
      '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
    })
    renderHeader(
      run('done', {
        worktreePath: '/tmp/wt/r1',
        branch: 'cez/r1',
        // Declared by the agent (`CEZ:PR`) — the task's own subject.
        markerRefs: { pr: 534 },
        prRefs: [{ number: 534, origin: 'marker', at: '2026-07-14T12:00:00.000Z' }],
      }),
    )
    await waitFor(() => expect(document.querySelector('[data-slot="git-button"] [data-action="commit"]')).not.toBeNull())
    expect(document.querySelector('[data-action="create-pr"]')).toBeNull()
  })

  it('a PR only scraped from the transcript is not the task’s PR — Create PR is still offered', async () => {
    // A link the agent merely READ (a file, a log) must never stand in for the task's own PR:
    // that hid Create PR, and offered "Resolve conflicts" against somebody else's pull request.
    stubFetch({
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 2, unpushed: null }),
      '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
    })
    renderHeader(
      run('done', {
        worktreePath: '/tmp/wt/r1',
        branch: 'cez/r1',
        referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/534',
        prRefs: [
          { number: 534, url: 'https://github.com/open-mercato/cezar/pull/534', origin: 'legacy', at: '2026-07-14T12:00:00.000Z' },
        ],
      }),
    )
    await waitFor(() => expect(document.querySelector('[data-slot="git-button"] [data-action="create-pr"]')).not.toBeNull())
  })

  it('the title row reserves the git button’s height, so the header does not jump without it', () => {
    stubFetch()
    renderHeader(run('done'))
    expect(document.querySelector('[data-slot="git-button"]')).toBeNull()
    const row = document.querySelector('[data-slot="run-title-row"]') as HTMLElement
    // The same 30px as the button (`size="sm"`) — present with or without the button.
    expect(row.className).toContain('min-h-[30px]')
  })

  it('a run with no worktree shows no git button at all', () => {
    stubFetch()
    renderHeader(run('done'))
    expect(document.querySelector('[data-slot="git-button"]')).toBeNull()
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

  it('offers the control for a read, finished run — an icon of its own, ahead of Pin', async () => {
    stubFetch()
    renderHeader(readDone())
    // Leftmost: it comes and goes, and in a right-aligned row that moves nothing to its right.
    expect(buttonNames(itemActions())).toEqual(['Mark unread', 'Pin', 'Archive', 'Delete'])
    const button = itemActions().getByRole('button', { name: 'Mark unread' })
    // It explains itself on hover — no badge dot, which read as a notification.
    expect(button.querySelector('.bg-violet')).toBeNull()
    expect(await tooltipOf(button)).toBe('Mark unread — put it back in your unread list')
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
    expect(itemActions().queryByRole('button', { name: 'Mark unread' })).toBeNull()
  })

  it('Mark unread → POST /unread, bodyless like its read twin', async () => {
    const sent = stubFetch()
    renderHeader(readDone())
    fireEvent.click(itemActions().getByRole('button', { name: 'Mark unread' }))
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
    fireEvent.click(itemActions().getByRole('button', { name: 'Mark unread' }))
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
    fireEvent.click(itemActions().getByRole('button', { name: 'Mark unread' }))
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

describe('the state toggles share one ON pattern (violet, filled, aria-pressed)', () => {
  const FINISHED_AT = '2026-07-14T13:00:00.000Z'
  const isOn = (button: HTMLElement) =>
    button.getAttribute('aria-pressed') === 'true' &&
    button.className.includes('text-violet') &&
    button.className.includes('[&_svg]:fill-violet/25')

  it.each([
    ['pinned', { pinned: true, pinnedAt: FINISHED_AT }, 'Unpin'],
    ['archived', { archived: true }, 'Unarchive'],
    ['unread', { finishedAt: FINISHED_AT }, 'Mark read'],
  ] as const)('%s → its toggle is ON', (_state, extra, name) => {
    stubFetch()
    renderHeader(run('done', extra))
    expect(isOn(itemActions().getByRole('button', { name }))).toBe(true)
  })

  it.each([
    ['Pin', {}],
    ['Archive', {}],
    ['Mark unread', { finishedAt: FINISHED_AT, seenAt: '2026-07-14T13:05:00.000Z' }],
  ] as const)('%s off → no ON styling, aria-pressed false', (name, extra) => {
    stubFetch()
    renderHeader(run('done', extra))
    const button = itemActions().getByRole('button', { name })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.className).not.toContain('text-violet')
  })

  it('read/unread is ONE envelope that flips state, not two different icons', () => {
    stubFetch()
    renderHeader(run('done', { finishedAt: FINISHED_AT }))
    expect(itemActions().queryByRole('button', { name: 'Mark unread' })).toBeNull()
    expect(document.querySelectorAll('[data-slot="unread-toggle"]')).toHaveLength(1)
  })
})

describe('the phone action menu mirrors the desktop rows', () => {
  const openKebab = async () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Run actions' }))
    return screen.findByRole('menu')
  }

  it('leads with the git step — Create PR and its draft alternative', async () => {
    stubFetch({
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 2, unpushed: null }),
      '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
    })
    renderHeader(run('done', { worktreePath: '/tmp/wt/r1', branch: 'cez/r1' }))
    // Wait for the step to resolve (the desktop button paints it too) before opening the menu.
    await waitFor(() => expect(document.querySelector('[data-slot="git-button"]')).not.toBeNull())
    const menu = await openKebab()
    const items = [...menu.querySelectorAll('[role="menuitem"]')]
    expect(items[0]?.getAttribute('data-action')).toBe('create-pr')
    expect(items[1]?.getAttribute('data-action')).toBe('create-draft-pr')
  })

  it('the state toggles keep one icon each and turn violet when ON', async () => {
    stubFetch()
    renderHeader(run('done', { pinned: true, pinnedAt: '2026-08-29T10:00:00.000Z', finishedAt: '2026-07-14T13:00:00.000Z' }))
    const menu = within(await openKebab())
    const unread = menu.getByRole('menuitem', { name: 'Mark read' })
    expect(unread.getAttribute('aria-pressed')).toBe('true')
    expect(unread.querySelector('svg')?.getAttribute('class')).toContain('fill-violet/25')
    const pin = menu.getByRole('menuitem', { name: 'Unpin' })
    expect(pin.querySelector('svg')?.getAttribute('class')).toContain('text-violet')
    expect(menu.getByRole('menuitem', { name: 'Archive' }).querySelector('svg')?.getAttribute('class')).not.toContain('text-violet')
  })

  it('leaves Stop to the composer on the Session tab, and offers it elsewhere', async () => {
    stubFetch()
    renderHeader(run('running'))
    expect(within(await openKebab()).queryByRole('menuitem', { name: 'Stop' })).toBeNull()

    cleanup()
    stubFetch()
    renderGitTab(run('running'))
    expect(within(await openKebab()).getByRole('menuitem', { name: 'Stop' })).not.toBeNull()
  })
})

describe('actions hit their endpoints', () => {
  it('End session (a waiting run, off the Session tab) → POST /finish, from the ⋯ menu', async () => {
    const sent = stubFetch()
    renderGitTab(run('waiting'))
    fireEvent.click((await openMore()).getByRole('menuitem', { name: 'End session' }))
    await waitFor(() => {
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/finish')).toBe(true)
    })
  })

  it('the Session tab leaves End session to the hint over the composer; a review offers none', async () => {
    stubFetch()
    renderHeader(run('waiting'))
    expect(itemActions().queryByRole('button', { name: 'More actions' })).toBeNull()
    cleanup()
    stubFetch()
    renderGitTab(run('review'))
    expect(itemActions().queryByRole('button', { name: 'More actions' })).toBeNull()
  })

  it('Archive → POST /archive with the flipped flag', async () => {
    const sent = stubFetch()
    renderHeader(run('done', { archived: true }))
    fireEvent.click(itemActions().getByRole('button', { name: 'Unarchive' }))
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/archive')?.body).toEqual({ archived: false })
    })
  })

  it('Pin → POST /pin with the flipped flag, and reads Unpin once pinned (#935)', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    fireEvent.click(itemActions().getByRole('button', { name: 'Pin' }))
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/pin')?.body).toEqual({ pinned: true })
    })

    cleanup()
    const unpinning = stubFetch()
    renderHeader(run('done', { pinned: true, pinnedAt: '2026-08-29T10:00:00.000Z' }))
    const unpin = itemActions().getByRole('button', { name: 'Unpin' })
    expect(unpin.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(unpin)
    await waitFor(() => {
      expect(unpinning.find((r) => r.path === '/api/v1/runs/r1/pin')?.body).toEqual({ pinned: false })
    })
  })

  it('an archived run cannot be pinned — archiving retires it (#935)', async () => {
    const sent = stubFetch()
    renderHeader(run('done', { archived: true }))
    const pin = itemActions().getByRole('button', { name: 'Pin' })
    expect(pin.getAttribute('aria-disabled')).toBe('true')
    expect(await tooltipOf(pin)).toBe('Archived tasks can’t be pinned')
    fireEvent.click(pin)
    await act(() => Promise.resolve())
    expect(sent.some((r) => r.path === '/api/v1/runs/r1/pin')).toBe(false)
  })

  it('Pin is in the mobile kebab too', async () => {
    stubFetch()
    renderHeader(run('running'))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Run actions' }))
    const menu = within(await screen.findByRole('menu'))
    expect(menu.getByRole('menuitem', { name: 'Pin' })).not.toBeNull()
  })

  it('the Session tab leaves Stop to the composer; other tabs offer it in ⋯', async () => {
    stubFetch()
    renderHeader(run('running'))
    expect(itemActions().queryByRole('button', { name: 'More actions' })).toBeNull()

    cleanup()
    stubFetch()
    renderGitTab(run('running'))
    const menu = await openMore()
    expect(menu.getByRole('menuitem', { name: 'Stop' })).not.toBeNull()
  })

  it('Stop asks first — the POST fires only after the confirm dialog', async () => {
    const sent = stubFetch()
    renderGitTab(run('running'))
    fireEvent.click((await openMore()).getByRole('menuitem', { name: 'Stop' }))

    // Nothing sent yet; the AlertDialog (never a native confirm) is up instead.
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
    fireEvent.click(itemActions().getByRole('button', { name: 'Delete' }))

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
    fireEvent.click(itemActions().getByRole('button', { name: 'Delete' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('button', { name: 'Delete' })).not.toBeNull()
    expect(within(dialog).getByText(longTitle)).not.toBeNull()
  })

  it('dismissing the confirm keeps the run', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    fireEvent.click(itemActions().getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect(sent.some((r) => r.method === 'DELETE')).toBe(false)
  })

  it('a refused action surfaces the server message as a danger toast and refetches the record', async () => {
    // Every 409 here means the record the bar was drawn from is not the run the server has, so
    // the header refetches it instead of offering the same refused action again.
    const sent = stubFetch({
      '/api/v1/runs/r1/archive': () => jsonResponse({ error: 'run is still active' }, 409),
    })
    renderHeader(run('done'))
    const listReadsBefore = sent.filter((r) => r.method === 'GET' && r.path === '/api/v1/runs').length
    fireEvent.click(itemActions().getByRole('button', { name: 'Archive' }))
    const item = await screen.findByRole('status')
    expect(item.textContent).toBe('run is still active')
    expect(item.getAttribute('data-tone')).toBe('danger')
    await waitFor(() =>
      expect(sent.filter((r) => r.method === 'GET' && r.path === '/api/v1/runs').length).toBeGreaterThan(
        listReadsBefore,
      ),
    )
  })
})

async function clickTerminalResume(): Promise<void> {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Open in…' }))
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
    const trigger = await screen.findByRole('button', { name: 'Open in…' })
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
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open in…' }))
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

describe('notes tab', () => {
  it('Notes is a tab, deep-linkable like the others — no longer a toggle in the action row', () => {
    stubFetch()
    renderHeader(run('done'))
    const tabs = within(document.querySelector('[data-slot="run-tabs"]') as HTMLElement)
    expect(tabs.getByRole('link', { name: 'Notes' }).getAttribute('href')).toBe('/tasks/r1/notes')
    expect(actionBar().queryByRole('button', { name: 'Notes' })).toBeNull()
  })
})

/** A run id no other test has touched. The expand memory is a module-level map keyed by run id
 *  (the same shape `WorkflowSteps` keeps), so a test that toggles it must not poison the shared
 *  `r1` fixture every other test in this file renders. */
let detailsRunSeq = 0
const freshRunId = () => `details-r${++detailsRunSeq}`

describe('dense run details (#765)', () => {
  it('collapses the meta row at phone width, and leaves the desktop header as it was', () => {
    stubFetch()
    renderHeader(
      run('done', {
        id: freshRunId(),
        branch: 'cez/r1',
        diffStat: { adds: 42, dels: 7, files: 3 },
        costUsd: 0.04,
      }),
    )

    const details = document.querySelector('[data-slot="run-details"]') as HTMLElement
    const toggle = screen.getByRole('button', { name: 'Show run details' })
    expect(details.className).toContain('hidden')
    // The point of the fix: `md:block` means a desktop reader still sees branch, diff, tokens and
    // cost at a glance, and the control that would ask them to click for it is `md:hidden`.
    expect(details.className).toContain('md:block')
    expect(toggle.className).toContain('md:hidden')
    // A real disclosure relationship, not a visual-only one.
    expect(details.id).not.toBe('')
    expect(toggle.getAttribute('aria-controls')).toBe(details.id)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)

    expect(details.className).not.toContain('hidden')
    expect(screen.getByRole('button', { name: 'Hide run details' }).getAttribute('aria-expanded')).toBe('true')
    expect(details.textContent).toContain('cez/r1')
    expect(details.textContent).toContain('IN 24.6k · OUT 2.4k')
  })

  it('remembers the expand for that run across a tab switch, and does not leak it to another run', () => {
    stubFetch()
    const id = freshRunId()
    const first = renderHeader(run('done', { id }))
    fireEvent.click(screen.getByRole('button', { name: 'Show run details' }))
    first.unmount()

    // Same run, remounted by another task route's header: still expanded, because re-opening it on
    // every Session → Changes hop is the chore this map exists to avoid.
    const second = renderHeader(run('done', { id }))
    expect(screen.queryByRole('button', { name: 'Hide run details' })).not.toBeNull()
    second.unmount()

    renderHeader(run('done', { id: freshRunId() }))
    expect(screen.queryByRole('button', { name: 'Show run details' })).not.toBeNull()
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

    const schedule = document.querySelector('[data-slot="monitoring-schedule"]')
    const details = document.querySelector('[data-slot="run-details"]') as HTMLElement
    expect(schedule).not.toBeNull()
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
    expect(classes).toContain('px-3')
    expect(classes).toContain('md:px-6')
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

  it('meta shows workflow · branch chip · ± · input/output · cost, with the agent summary in the badge', () => {
    stubFetch()
    // A tab with no chat box — on the Session tab the composer's pills carry the summary instead.
    renderGitTab(
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
    // Icon only — the chat box's engine pills carry the words.
    expect(badge.textContent).toBe('')
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
      expect(branch?.nextElementSibling?.nextElementSibling).toBe(prChip.closest('[data-slot="run-pr-refs"]'))
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
  it('shows every PR the task points at — the strongest on the row, all of them behind +N', async () => {
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
    // The strongest PR on the row, the rest behind a `+N` — the All tasks table's cell.
    const visible = [...meta.querySelectorAll('[data-slot="run-pr-refs"] > [data-slot="pr-chip"]')]
    expect(visible.map((chip) => chip.getAttribute('href'))).toEqual(['https://github.com/open-mercato/cezar/pull/5366'])
    expect(meta.querySelector('[data-slot="reference-overflow"]')?.textContent).toBe('+1')
    const chips = await overflowChips()
    expect(chips.map((chip) => chip.getAttribute('href'))).toEqual([
      'https://github.com/open-mercato/cezar/pull/5366',
      'https://github.com/open-mercato/cezar/pull/4326',
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
    await waitFor(() => {
      const chip = document.querySelector('[data-slot="run-meta"] [data-slot="pr-chip"]')
      expect(chip?.getAttribute('href')).toBe('https://github.com/open-mercato/cezar/pull/901')
    })
  })

  // A PR URL whose last segment is not a number never becomes a `taskReferences` entry, so it is
  // painted from `taskPrUrl` — and must still be painted when a number-only chip exists beside it
  // (#847: a forge whose PR URLs are not `…/pull/N`).
  it('keeps a non-numeric PR link beside a chip known only by number', async () => {
    stubFetch({ '/api/v1/health': () => jsonResponse({ repo: {} }) })
    renderHeader(
      run('done', {
        branch: 'cez/r1',
        pullRequestUrl: 'https://forge.example.com/o/r/merge_requests/spec-fix',
        prNumber: 42,
      }),
    )
    const chips = await overflowChips()
    expect(chips).toHaveLength(2)
    expect(chips.map((chip) => chip.getAttribute('href'))).toContain(
      'https://forge.example.com/o/r/merge_requests/spec-fix',
    )
  })

  it('shows a PR known only by number, with no repository to link it to', async () => {
    stubFetch({ '/api/v1/health': () => jsonResponse({ repo: {} }) })
    renderHeader(
      run('done', {
        branch: 'cez/r1',
        pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/5366',
        prNumber: 901,
      }),
    )
    const chips = await overflowChips()
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

  it('offers the next-continuation engine picker inside the existing agent badge', async () => {
    stubFetch()
    renderHeader(
      run('done', { runner: 'claude', model: 'sonnet' }),
      undefined,
      undefined,
      <button type="button" aria-label="Model">sonnet</button>,
    )

    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    fireEvent.pointerDown(within(meta).getByRole('button', { name: /Agent: claude/ }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Next continuation')).not.toBeNull()
    expect(within(menu).getByRole('button', { name: 'Model' }).textContent).toBe('sonnet')
  })

  it('keeps the historical badge read-only when no continuation picker is owned by the view', async () => {
    stubFetch()
    renderHeader(run('running', { runner: 'claude', model: 'sonnet' }))
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    fireEvent.pointerDown(within(meta).getByRole('button', { name: /Agent: claude/ }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).queryByText('Next continuation')).toBeNull()
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
      renderGitTab(run('done', {
        runner: 'claude',
        model: 'opus',
        steps: [step({ sessionId: 'sess-1', profileId: 'klaudiusz' })],
      }))
      const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
      const badge = await within(meta).findByRole('button', { name: /Agent: claude, account Klaudiusz, model opus/ })
      // Icon only; the tooltip still names it in full.
      expect(await tooltipOf(badge)).toBe('claude · Klaudiusz · opus')
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

  it.each(['session', 'changes', 'notes'] as RunTab[])(
    'the %s tab shows the badge as an icon, with the engine in its tooltip',
    async (tab) => {
      stubFetch()
      renderHeader(run('running', { runner: 'claude', model: 'opus' }), undefined, undefined, undefined, tab)
      const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
      const badge = within(meta).getByRole('button', { name: /Agent: claude, model opus/ })
      expect(badge.textContent).toBe('')
      expect(await tooltipOf(badge)).toBe('claude · opus')
    },
  )

  it('a claude run still gets an agent badge — Claude is the default, not a hidden runner', () => {
    stubFetch()
    renderGitTab(run('done', { runner: 'claude' }))
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    const badge = within(meta).getByRole('button', { name: /Agent: claude, model auto/ })
    // Named like any other agent — claude being the default is not a reason to leave "what
    // produced this?" unanswered.
    expect(badge.getAttribute('aria-label')).toBe('Agent: claude, model auto')
  })

  it('tabs: Session is current; Changes and Files link to the routed surfaces', () => {
    stubFetch()
    renderHeader(run('done'))
    const tabs = within(document.querySelector('[data-slot="run-tabs"]') as HTMLElement)
    expect(tabs.getByRole('link', { name: 'Session' }).getAttribute('aria-current')).toBe('page')
    expect(tabs.getByRole('link', { name: 'Changes' }).getAttribute('href')).toBe('/tasks/r1/changes')
    expect(tabs.getByRole('link', { name: 'Files' }).getAttribute('href')).toBe('/tasks/r1/files')
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

  /**
   * A gauntlet parent dispatches a hundred children and the wrapped list owned the whole
   * viewport. Each id below is its own parent run, because the open/closed choice lives in a
   * module-level map keyed by run id (same shape as the phone meta disclosure) and would
   * otherwise leak from one test into the next.
   */
  const toggle = () => document.querySelector('[data-slot="dispatch-children-toggle"]') as HTMLElement
  const childList = () => document.querySelector('[data-slot="dispatch-children-list"]')
  const kids = (parentId: string, count: number, status: RunStatus = 'running') =>
    Array.from({ length: count }, (_, index) =>
      run(status, {
        id: `${parentId}-k${index}`,
        titleSummary: `Subtask ${index}`,
        dispatch: { rootRunId: parentId, parentRunId: parentId },
      }),
    )

  it('keeps a handful of subtasks open, in a bounded scroller rather than an unbounded list', async () => {
    stubFetch({ '/api/v1/runs': () => jsonResponse(kids('few', 3)) })
    renderHeader(run('running', { id: 'few', dispatch: { rootRunId: 'few' } }))
    await waitFor(() => expect(childLinks()).toHaveLength(3))
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    // The cap is what stops any list — opened by default or by hand — from pushing the transcript.
    expect(childList()?.className).toContain('max-h-28')
    expect(childList()?.className).toContain('overflow-y-auto')
  })

  it('starts a large fan-out collapsed, and says how it is going without opening it', async () => {
    stubFetch({
      '/api/v1/runs': () =>
        jsonResponse([
          ...kids('many', 8, 'done'),
          ...kids('many-run', 2), // a different parent: not this run's children, not in the tally
          run('waiting', { id: 'many-ask', titleSummary: 'Asks', dispatch: { rootRunId: 'many', parentRunId: 'many' } }),
        ]),
    })
    renderHeader(run('running', { id: 'many', dispatch: { rootRunId: 'many' } }))
    await waitFor(() => expect(toggle()).not.toBeNull())
    // Collapsed: the links are OUT of the DOM, not merely invisible — no ghosts in the tab order.
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(childLinks()).toHaveLength(0)
    expect(childList()).toBeNull()
    const summary = toggle().textContent ?? ''
    expect(summary).toContain('9')
    // Attention order: the child that stopped to ask is read before the done pile.
    expect(summary.indexOf('needs you')).toBeGreaterThan(-1)
    expect(summary.indexOf('needs you')).toBeLessThan(summary.indexOf('done'))
    expect(summary).toContain('8')
  })

  it('opens a collapsed fan-out on click, and closes it again', async () => {
    stubFetch({ '/api/v1/runs': () => jsonResponse(kids('big', 6)) })
    renderHeader(run('running', { id: 'big', dispatch: { rootRunId: 'big' } }))
    await waitFor(() => expect(toggle()).not.toBeNull())
    expect(childLinks()).toHaveLength(0)

    fireEvent.click(toggle())
    await waitFor(() => expect(childLinks()).toHaveLength(6))
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(toggle().getAttribute('aria-controls')).toBe(childList()?.getAttribute('id'))

    fireEvent.click(toggle())
    await waitFor(() => expect(childLinks()).toHaveLength(0))
  })

  // The role chip is gone with the ranks it named — nothing in the header may reintroduce it.
  it('wears no rank chip', async () => {
    stubFetch()
    renderHeader(run('running', { dispatch: { rootRunId: 'r1' } }))
    await waitFor(() => expect(document.querySelector('[data-slot="run-actions"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="unit-role"]')).toBeNull()
  })
})
