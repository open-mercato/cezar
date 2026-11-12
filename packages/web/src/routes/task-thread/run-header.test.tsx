import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunStatus, StepState } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { publishTaskWorkspace, resetTaskWorkspaceBridge, type TaskWorkspaceBridge } from '@/lib/task-workspace-bridge'

import { RunHeader, statusChipLabel, type RunTab } from './run-header'
import {
  commitPrompt,
  createPrPrompt,
  fixChecksPrompt,
  primaryRunAction,
  pushPrompt,
  resolveConflictsPrompt,
  secondaryRunAction,
  updateBranchPrompt,
} from './run-actions'
import { __resetGitStepFlights } from '../task-git/run-git-step'

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
  __resetGitStepFlights()
  resetTaskWorkspaceBridge()
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

const gitButtonText = () => document.querySelector('[data-slot="git-button"] button')?.textContent
/** The title row's right side: the primary action, its companion and Open in…. */
const primaryRow = () => within(document.querySelector('[data-slot="run-primary-actions"]') as HTMLElement)
/** The primary button's label — a state action, or the git step the policy chose. */
const primaryLabel = () =>
  document.querySelector('[data-slot="run-primary"]')?.textContent?.trim() ??
  document.querySelector('[data-slot="run-primary-actions"] [data-slot="git-button"] [data-variant="primary"]')?.textContent?.trim() ??
  null
const secondaryLabel = () =>
  document.querySelector('[data-slot="run-secondary"]')?.textContent?.trim() ??
  document.querySelector('[data-slot="run-primary-actions"] [data-slot="git-button"] [data-variant="outline"]')?.textContent?.trim() ??
  null
/** The header as the Changes tab renders it — "Review changes" steps aside there. */
const renderGitTab = (record: ApiRun) => renderHeader(record, undefined, undefined, undefined, 'changes')
/** The ⋯ menu — the palette's actions — opened. */
async function openMenu(): Promise<ReturnType<typeof within>> {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }))
  return within(await screen.findByRole('menu'))
}
const menuLabels = (menu: ReturnType<typeof within>) =>
  menu.getAllByRole('menuitem').map((item: HTMLElement) => item.querySelector('[data-slot="menu-label"]')?.textContent)
const closeMenu = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
const bridge = (overrides: Partial<TaskWorkspaceBridge> = {}): TaskWorkspaceBridge => ({
  runId: 'r1',
  views: ['session', 'changes', 'commits', 'files'],
  activeView: 'session',
  openView: vi.fn(),
  openViewBeside: vi.fn(),
  layouts: [],
  selectLayout: vi.fn(),
  maximized: false,
  toggleMaximized: vi.fn(),
  splitView: null,
  terminal: { allowed: false, open: false, inColumn: false, toggle: vi.fn(), openInColumn: vi.fn() },
  focusComposer: vi.fn(),
  openFile: vi.fn(),
  markedUnread: vi.fn(),
  ...overrides,
})
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

describe('collapse header — the minimalist view short of full screen', () => {
  const details = () => document.querySelector('[data-slot="run-header-details"]') as HTMLElement

  afterEach(() => localStorage.removeItem('cez:run-header-collapsed'))

  it('folds the meta row away on desktop, keeps the title and tabs, and remembers it in this browser', () => {
    stubFetch()
    renderHeader(run('done'))
    const toggle = screen.getByRole('button', { name: 'Collapse header' })
    // Desktop only: a phone has its own disclosure for these lines.
    expect(toggle.className).toContain('md:inline-flex')
    expect(toggle.className).toContain('hidden')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(details().className).not.toContain('md:hidden')
    expect(details().querySelector('[data-slot="run-meta"]')).not.toBeNull()

    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Expand header' }).getAttribute('aria-expanded')).toBe('false')
    expect(details().className).toContain('md:hidden')
    // The title row and the view tabs stay.
    expect(document.querySelector('[data-slot="run-title-row"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="run-tabs"]')).not.toBeNull()
    expect(localStorage.getItem('cez:run-header-collapsed')).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: 'Expand header' }))
    expect(details().className).not.toContain('md:hidden')
    expect(localStorage.getItem('cez:run-header-collapsed')).toBeNull()
  })

  it('opens folded when this browser folded it last time', () => {
    localStorage.setItem('cez:run-header-collapsed', '1')
    stubFetch()
    renderHeader(run('done'))
    expect(screen.getByRole('button', { name: 'Expand header' })).toBeTruthy()
    expect(details().className).toContain('md:hidden')
  })
})

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

describe('the primary action follows the state (design 2026-11, Proposal 3)', () => {
  const git = (id: 'create-pr' | 'push', label: string) => ({ id, label, enabled: true }) as const

  it.each([
    ['queued', run('queued'), { primary: 'stop', secondary: null }],
    ['running', run('running'), { primary: 'stop', secondary: null }],
    ['waiting', run('waiting'), { primary: 'answer', secondary: 'stop' }],
    ['a closed, unanswered question', run('failed', { awaitingAnswerSince: '2026-07-14T13:00:00.000Z' }), { primary: 'answer', secondary: null }],
    ['review', run('review'), { primary: 'review', secondary: 'continue' }],
    ['done', run('done'), { primary: null, secondary: 'continue' }],
    ['failed', run('failed'), { primary: 'retry', secondary: null }],
    ['cancelled', run('cancelled'), { primary: null, secondary: 'continue' }],
    ['idle-closed', run('failed', { idleClosedAt: '2026-07-14T13:00:00.000Z' }), { primary: null, secondary: 'continue' }],
    ['failed with no session', run('failed', { steps: [step()] }), { primary: null, secondary: null }],
  ] as const)('%s', (_name, record, expected) => {
    const primary = primaryRunAction(record, { git: null, changesShowing: false })
    expect(primary?.kind ?? null).toBe(expected.primary)
    expect(secondaryRunAction(record, primary)?.kind ?? null).toBe(expected.secondary)
  })

  it('review: "Review changes" only while no Changes view shows; the git step takes over there', () => {
    expect(primaryRunAction(run('review'), { git: git('create-pr', 'Create PR'), changesShowing: false })).toEqual({ kind: 'review' })
    expect(primaryRunAction(run('review'), { git: git('create-pr', 'Create PR'), changesShowing: true })).toMatchObject({ kind: 'git' })
    expect(primaryRunAction(run('review'), { git: null, changesShowing: true })).toBeNull()
  })

  it('the git step outranks Open PR and Stop; Open PR only for an http link', () => {
    expect(primaryRunAction(run('running'), { git: git('push', 'Push'), changesShowing: false })).toMatchObject({ kind: 'git' })
    expect(primaryRunAction(run('done'), { git: null, prUrl: 'https://x.test/pull/1', changesShowing: false })).toEqual({ kind: 'open-pr', url: 'https://x.test/pull/1' })
    expect(primaryRunAction(run('done'), { git: null, prUrl: '#12', changesShowing: false })).toBeNull()
  })

  it('the git step never leaves the header: beside a state action it is the companion', () => {
    const push = git('push', 'Push')
    const answer = primaryRunAction(run('waiting'), { git: push, changesShowing: false })
    expect(answer).toEqual({ kind: 'answer' })
    expect(secondaryRunAction(run('waiting'), answer, push)).toEqual({ kind: 'git', action: push })
    // Primary and companion are never the same step.
    const primary = primaryRunAction(run('done'), { git: push, changesShowing: false })
    expect(secondaryRunAction(run('done'), primary, push)).toEqual({ kind: 'continue' })
  })

  it('a worktree operation owns the task: no header action until it is resolved', () => {
    const gated = run('waiting', { worktreeLifecycle: { worktreeId: 'w', generation: 1, activeOperationId: 'op', phase: 'setup', state: 'needs_attention', needsAttention: true } })
    expect(primaryRunAction(gated, { git: git('push', 'Push'), changesShowing: false })).toBeNull()
    expect(secondaryRunAction(gated, null, git('push', 'Push'))).toBeNull()
  })

  it.each([
    ['review', run('review'), 'Review changes', 'Continue'],
    ['waiting', run('waiting'), 'Answer', 'Stop'],
    ['failed', run('failed'), 'Retry', null],
    ['running', run('running'), 'Stop', null],
    ['done', run('done'), null, 'Continue'],
  ] as const)('renders %s as one primary and one companion, with no icon-only task actions', (_name, record, primary, secondary) => {
    stubFetch()
    renderHeader(record)
    expect(primaryLabel()).toBe(primary)
    expect(secondaryLabel()).toBe(secondary)
    // The six icons (read, pin, archive, delete, ⋯, open in) are gone from the row: the menu lists them.
    for (const name of ['Pin', 'Archive', 'Delete', 'Mark unread']) expect(screen.queryByRole('button', { name })).toBeNull()
  })

  it('"Review changes" opens the Changes view of the workspace on screen', () => {
    stubFetch()
    const workspace = bridge()
    publishTaskWorkspace(workspace)
    renderHeader(run('review'))
    fireEvent.click(primaryRow().getByRole('button', { name: 'Review changes' }))
    expect(workspace.openView).toHaveBeenCalledWith('changes')
  })

  it('"Answer" and "Continue" go to the composer the workspace shows', () => {
    stubFetch()
    const workspace = bridge()
    publishTaskWorkspace(workspace)
    renderHeader(run('waiting'))
    fireEvent.click(primaryRow().getByRole('button', { name: 'Answer' }))
    expect(workspace.focusComposer).toHaveBeenCalledTimes(1)
    cleanup()
    stubFetch()
    renderHeader(run('done'))
    fireEvent.click(primaryRow().getByRole('button', { name: 'Continue' }))
    expect(workspace.focusComposer).toHaveBeenCalledTimes(2)
  })

  it('"Open PR" is the primary once the PR exists and nothing is left to push', async () => {
    stubFetch({
      '/api/v1/health': () => jsonResponse({ bootProject: 'acme', forge: { kind: 'github', available: true } }),
      '/api/v1/p/acme/github/ref-status?prs=1311': () =>
        jsonResponse({ available: true, issues: {}, recheckAfterMs: null, prs: { 1311: 'merged' }, conflicts: [] }),
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 0, unpushed: 0 }),
    })
    const open = vi.fn()
    vi.stubGlobal('open', open)
    renderHeader(run('done', { worktreePath: '/tmp/wt/r1', branch: 'cez/r1', pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/1311' }))
    const button = await waitFor(() => primaryRow().getByRole('button', { name: 'Open PR' }))
    fireEvent.click(button)
    expect(open).toHaveBeenCalledWith('https://github.com/open-mercato/cezar/pull/1311', '_blank', 'noopener,noreferrer')
  })

  it('the primary row is desktop only; the ⋯ carries everything on a phone', () => {
    stubFetch()
    renderHeader(run('review'))
    const row = document.querySelector('[data-slot="run-primary-actions"]') as HTMLElement
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'md:flex']))
    expect(screen.getByRole('button', { name: 'More actions' }).className).not.toContain('md:hidden')
  })
})

describe('the ⋯ menu is the palette\'s command list', () => {
  it('lists the actions, the git steps and the task group under their headings, labels verbatim', async () => {
    stubFetch({
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 0, unpushed: null, behind: 4, ahead: 1 }),
      '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
    })
    renderHeader(run('done', { worktreePath: '/tmp/wt/r1', branch: 'cez/r1', baseBranch: 'origin/main', finishedAt: '2026-07-14T13:00:00.000Z', seenAt: '2026-07-14T13:05:00.000Z' }))
    await waitFor(() => expect(document.querySelector('[data-slot="git-button"] [data-action="create-pr"]')).not.toBeNull())
    const menu = await openMenu()
    const headings = [...document.querySelectorAll('[data-slot="run-actions-menu"] [data-slot="dropdown-menu-label"]')].map((el) => el.textContent)
    expect(headings).toEqual(['Actions', 'Git', 'Task'])
    expect(menuLabels(menu)).toEqual([
      'Mark unread', 'Pin', 'Rename…', 'Take over in terminal',
      'Create PR', 'Create draft PR', 'Update branch', 'Remove worktree…',
      'Archive', 'Delete…',
    ])
    // The git rows keep the step id the policy gave them.
    expect(menu.getByRole('menuitem', { name: /Update branch/ }).getAttribute('data-action')).toBe('update-branch')
  })

  it('"Write to the agent" appears with its / shortcut once the workspace shows a composer', async () => {
    stubFetch()
    publishTaskWorkspace(bridge())
    renderHeader(run('done'))
    const menu = await openMenu()
    const row = menu.getByRole('menuitem', { name: /Write to the agent/ })
    expect(row.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent).toBe('/')
  })

  it('keeps an unavailable row, greyed out with its reason', async () => {
    stubFetch()
    renderHeader(run('running'))
    const menu = await openMenu()
    const archive = menu.getByRole('menuitem', { name: 'Archive' })
    expect(archive.getAttribute('data-disabled')).not.toBeNull()
    expect(archive.getAttribute('title')).toBe('Stop the task first')
    expect(menu.getByRole('menuitem', { name: 'Delete…' }).getAttribute('data-disabled')).not.toBeNull()
  })

  it('Rename… opens the title\'s own editor', async () => {
    stubFetch()
    renderHeader(run('done'))
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Rename…' }))
    expect(await screen.findByLabelText('Task title')).not.toBeNull()
  })
})

describe('the takeover command lives behind "Take over in terminal"', () => {
  it('is no longer printed in the header; the menu copies it, same text as before', async () => {
    stubFetch()
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderHeader(run('failed', { runner: 'opencode', worktreePath: '/tmp/wt' }))
    expect(document.querySelector('[data-slot="resume-hint"]')).toBeNull()
    expect(document.querySelector('[data-slot="run-header"]')?.textContent).not.toContain('opencode --session')
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Take over in terminal' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('cd /tmp/wt && opencode --session sess-1'))
    expect((await screen.findByRole('status')).textContent).toBe('Resume command copied')
  })

  it('an active run offers no takeover — the engine still owns the session', async () => {
    stubFetch()
    renderHeader(run('running'))
    expect((await openMenu()).queryByRole('menuitem', { name: 'Take over in terminal' })).toBeNull()
  })
})

describe('the status word (Proposal 7): open states only', () => {
  it.each([
    ['review', run('review'), 'Needs review'],
    ['waiting', run('waiting'), 'Asked'],
    ['a closed, unanswered question', run('failed', { awaitingAnswerSince: '2026-07-14T13:00:00.000Z' }), 'Asked'],
    ['budget stop', run('waiting', { costUsd: 12, dispatch: { rootRunId: 'p', parentRunId: 'p', budgetUsd: 10, overBudget: true } }), 'Budget reached'],
    ['running, one step', run('running'), 'Running'],
    ['running, several steps', run('running', { steps: [step({ id: 'a', name: 'Plan', status: 'done' }), step({ id: 'b', name: 'Verify', status: 'running' })] }), 'Running · Verify'],
    ['monitoring', run('running', { activity: 'monitoring' }), 'Monitoring'],
    ['queued', run('queued'), 'Queued'],
    ['switching agent', run('queued', { fallbackEpisode: { pending: true } as ApiRun['fallbackEpisode'] }), 'Switching agent'],
    ['failed', run('failed'), 'Failed'],
    ['scheduled', run('failed', { autoResumeAt: '2026-07-14T14:00:00.000Z' }), 'Scheduled'],
    ['done', run('done'), null],
    ['cancelled', run('cancelled'), null],
    ['idle-closed', run('failed', { idleClosedAt: '2026-07-14T13:00:00.000Z' }), null],
  ] as const)('%s', (_name, record, label) => {
    expect(statusChipLabel(record)).toBe(label)
  })

  it('a done task reads calm: the dot alone, no word', () => {
    stubFetch()
    renderHeader(run('done'))
    expect(document.querySelector('[data-slot="pill"]')).toBeNull()
    expect(document.querySelector('[data-slot="run-status-dot"]')?.getAttribute('aria-label')).toBe('done')
  })

  it('an open state wears its word beside the title, and again on the phone\'s chip line', () => {
    stubFetch()
    renderHeader(run('review'))
    const chips = [...document.querySelectorAll('[data-slot="pill"]')]
    expect(chips.map((chip) => chip.textContent)).toEqual(['Needs review', 'Needs review'])
    expect(chips[0]?.closest('[data-slot="run-title-row"]')).not.toBeNull()
    expect(chips[0]?.className).toContain('max-md:hidden')
    expect(chips[1]?.closest('[data-slot="run-meta"]')).not.toBeNull()
    expect(chips[1]?.className).toContain('md:hidden')
  })
})

describe('the workflow rail folds into "k of n done"', () => {
  it('a one-step workflow that ran clean is a tally on line 2, with no rail', () => {
    stubFetch()
    renderHeader(run('done'))
    expect(document.querySelector('[data-slot="step-tally"]')?.textContent).toBe('1 of 1 done')
    expect(document.querySelector('[data-slot="workflow-steps"]')).toBeNull()
  })

  it('keeps the rail, collapsed, for several steps — live progress stays visible', () => {
    stubFetch()
    renderHeader(run('running', { steps: [step({ id: 'a', name: 'Plan', status: 'done' }), step({ id: 'b', name: 'Verify', status: 'running' })] }))
    expect(document.querySelector('[data-slot="step-tally"]')?.textContent).toBe('1 of 2 done')
    const rail = document.querySelector('[data-slot="workflow-steps"]') as HTMLElement
    expect(rail.getAttribute('data-state')).toBe('closed')
    expect(rail.textContent).toContain('step 2 of 2')
    fireEvent.click(within(rail).getByRole('button'))
    expect(document.querySelector('[data-slot="step-rail"]')).not.toBeNull()
  })

  it.each([
    ['running', step({ status: 'running' })],
    ['failed', step({ status: 'failed' })],
  ] as const)('keeps the rail for a single %s step', (_name, only) => {
    stubFetch()
    renderHeader(run('running', { steps: [only] }))
    expect(document.querySelector('[data-slot="workflow-steps"]')).not.toBeNull()
  })
})

describe('the usage chip', () => {
  it('reads time · in · out · cost, and opens the exact numbers and the agent', async () => {
    stubFetch()
    renderHeader(run('done', { runner: 'codex', model: 'gpt-5.2-codex', startedAt: '2026-07-14T12:00:00.000Z', finishedAt: '2026-07-14T12:06:13.000Z', costUsd: 0.83 }))
    const chip = screen.getByRole('button', { name: 'Agent: codex, model gpt-5.2-codex' })
    expect(chip.querySelector('[data-slot="usage-summary"]')?.textContent).toBe('6m 13s · 24.6k in · 2.4k out · $0.83')
    fireEvent.click(chip)
    const details = within(await screen.findByRole('dialog'))
    expect(details.getByText('Duration').nextElementSibling?.textContent).toBe('6m 13s')
    expect(details.getByText('Input tokens').nextElementSibling?.textContent).toBe('24,600')
    expect(details.getByText('Output tokens').nextElementSibling?.textContent).toBe('2,400')
    expect(details.getByText('Cost').nextElementSibling?.textContent).toBe('$0.83')
    expect(details.getByText('Runner').nextElementSibling?.textContent).toBe('codex')
    expect(details.getByText('Model').nextElementSibling?.textContent).toBe('gpt-5.2-codex')
  })

  it('says only what the record carries', () => {
    stubFetch()
    renderHeader(run('done', { inputTokens: undefined, outputTokens: undefined }))
    expect(document.querySelector('[data-slot="usage-summary"]')?.textContent).toBe('claude · auto')
  })
})

describe('the facts line', () => {
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

  it('tokens, cost and the agent badge sit once in the meta row, leaving the tabs line to navigation', () => {
    stubFetch()
    renderHeader(run('done', { costUsd: 12, inputTokens: 152, outputTokens: 37_300 }))
    expect(document.querySelector('[data-slot="run-tabs"] [data-slot="run-usage"]')).toBeNull()
    const usage = document.querySelectorAll('[data-slot="run-meta"] [data-slot="run-usage"]')
    expect(usage).toHaveLength(1)
    expect(usage[0]!.textContent).toContain('$12')
    expect(usage[0]!.querySelector('[data-slot="agent-badge"]')).not.toBeNull()
  })

  it('the git step is the title row\'s primary action, in the primary colour', async () => {
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
    // A PR behind its branch: the one git step is Push.
    const button = await waitFor(() => {
      const el = document.querySelector('[data-slot="git-button"] [data-action="push"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(button.closest('[data-slot="run-primary-actions"]')).not.toBeNull()
    expect(button.getAttribute('data-variant')).toBe('primary')
    expect(secondaryLabel()).toBe('Continue')
    expect(button.closest('[data-slot="run-meta"]')).toBeNull()
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

  it('no PR yet but behind: Create PR stays the button, Update branch is under its chevron', async () => {
    const sent = stubFetch({
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 0, unpushed: null, behind: 4, ahead: 1 }),
      '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
    })
    renderHeader(run('waiting', { worktreePath: '/tmp/wt/r1', branch: 'cez/r1', baseBranch: 'origin/main' }))
    await waitFor(() =>
      expect((document.querySelector('[data-slot="git-button"] [data-action="create-pr"]') as HTMLButtonElement | null)?.disabled).toBe(false),
    )
    fireEvent.pointerDown(document.querySelector('[data-slot="git-button"] [aria-label="More ways to create pr"]')!)
    const menu = await screen.findByRole('menu')
    fireEvent.click(menu.querySelector('[data-action="update-branch"]')!)
    const message = await waitFor(() => {
      const found = sent.find((r) => r.method === 'POST' && r.path.endsWith('/messages'))
      if (!found) throw new Error('nothing was sent')
      return found
    })
    expect(message.body).toMatchObject({ text: 'Update branch from main' })
    // Busy under the in-flight step's label, whichever button is showing.
    await waitFor(() => expect(document.querySelector('[data-slot="git-button"] button')?.textContent).toBe('Updating branch…'))
  })

  it('every git step says just its name to the agent — no cezar playbook in the thread', () => {
    expect(createPrPrompt(false)).toBe('Create PR')
    expect(createPrPrompt(true)).toBe('Create draft PR')
    expect(updateBranchPrompt()).toBe('Update branch')
    // The base rides along, so a task whose base is not the repo default (a dispatch child, a
    // feature-branch task) is never opened against or merged from `main` by mistake.
    expect(createPrPrompt(false, 'origin/main')).toBe('Create PR against main')
    expect(createPrPrompt(true, 'cez/1a2b3c4d')).toBe('Create draft PR against cez/1a2b3c4d')
    expect(updateBranchPrompt('origin/release/2.x')).toBe('Update branch from release/2.x')
    // A raw sha (detached fork point) is not a branch to target.
    expect(createPrPrompt(false, '0a1b2c3d4e5f')).toBe('Create PR')
    expect(commitPrompt(false)).toBe('Commit')
    expect(commitPrompt(true)).toBe('Commit and push')
    expect(pushPrompt()).toBe('Push')
    expect(resolveConflictsPrompt(1311)).toBe('Resolve conflicts in PR 1311')
    expect(fixChecksPrompt(1311)).toBe('Fix failing checks in PR 1311')
    expect(fixChecksPrompt()).toBe('Fix failing checks')
  })

  describe('the agent runs the git step itself; the server only stands in without one', () => {
    const textSent = (sent: SentRequest[], text: string) =>
      sent.find((r) => r.method === 'POST' && (r.body as { text?: string } | undefined)?.text === text)
    const prRun = (status: RunStatus, extra: Partial<ApiRun> = {}) =>
      run(status, {
        worktreePath: '/tmp/wt/r1',
        branch: 'cez/r1',
        pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/1311',
        ...extra,
      })
    const unpushed = (extra: Record<string, () => Response> = {}) =>
      stubFetch({
        '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 0, unpushed: 2, behind: 0, ahead: 2 }),
        '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
        '/api/v1/repo': () => jsonResponse({ info: { remote: 'git@github.com:open-mercato/cezar.git' } }),
        ...extra,
      })
    async function enabled(action: string) {
      return waitFor(() => {
        const el = document.querySelector(`[data-slot="git-button"] [data-action="${action}"]`) as HTMLButtonElement | null
        expect(el?.disabled).toBe(false)
        // Blocked by the policy is aria-disabled, not disabled — usable means neither.
        expect(el?.getAttribute('aria-disabled')).toBeNull()
        return el!
      })
    }

    it('Push: the agent is asked to push — cezar does not push itself', async () => {
      const sent = unpushed()
      renderHeader(prRun('waiting'))
      fireEvent.click(await enabled('push'))
      await waitFor(() => {
        if (!textSent(sent, pushPrompt())) throw new Error('the agent was not asked')
      })
      expect(sent.some((r) => r.path.endsWith('/git/push'))).toBe(false)
      await waitFor(() => expect(gitButtonText()).toBe('Pushing…'))
      // The busy button is the feedback — no "Sent to the task" / "Task reopened" toast on top.
      expect(screen.queryByText(/Sent to the task|Task reopened/)).toBeNull()
    })

    it('Push works mid-turn too: the agent takes it after the turn it is on', async () => {
      unpushed()
      renderHeader(prRun('running'))
      expect((await enabled('push')).disabled).toBe(false)
    })

    it('Create PR on a "needs you" session: the agent gets just "Create PR"', async () => {
      const sent = stubFetch({
        '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 0, unpushed: null, behind: 0, ahead: 1 }),
        '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
      })
      renderHeader(run('waiting', { worktreePath: '/tmp/wt/r1', branch: 'cez/r1', baseBranch: 'origin/main' }))
      fireEvent.click(await enabled('create-pr'))
      await waitFor(() => {
        if (!textSent(sent, 'Create PR against main')) throw new Error('the agent was not asked')
      })
      expect(sent.some((r) => r.path.endsWith('/pr'))).toBe(false)
    })

    it('Commit and push: the agent commits with its own message — no commit dialog', async () => {
      const sent = stubFetch({
        '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 3, unpushed: 0, behind: 0, ahead: 1 }),
        '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
        '/api/v1/repo': () => jsonResponse({ info: { remote: 'git@github.com:open-mercato/cezar.git' } }),
      })
      renderHeader(prRun('waiting'))
      fireEvent.click(await enabled('commit-push'))
      await waitFor(() => {
        if (!textSent(sent, commitPrompt(true))) throw new Error('the agent was not asked')
      })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(sent.some((r) => r.path.endsWith('/git/commit'))).toBe(false)
    })

    it('no agent session to reach: Push falls back to cezar pushing', async () => {
      const sent = unpushed({
        '/api/v1/runs/r1/git/push': () =>
          jsonResponse({ pushed: true, branch: 'cez/r1', remote: 'origin', upstreamSet: false }),
      })
      // No session id on any step: nothing to resume, so the agent cannot be asked.
      renderHeader(prRun('done', { steps: [step()] }))
      fireEvent.click(await enabled('push'))
      await waitFor(() => expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/git/push'))).toBe(true))
      expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/messages'))).toBe(false)
    })

    it('no agent session to reach: Commit and push falls back to the commit dialog — nothing sent to an agent', async () => {
      const sent = stubFetch({
        '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 3, unpushed: 0, behind: 0, ahead: 1 }),
        '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
        '/api/v1/repo': () => jsonResponse({ info: { remote: 'git@github.com:open-mercato/cezar.git' } }),
      })
      renderHeader(prRun('done', { steps: [step()] }))
      fireEvent.click(await enabled('commit-push'))
      await waitFor(() => expect(document.querySelector('[data-slot="commit-message"]')).not.toBeNull())
      expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/messages'))).toBe(false)
      expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/continue'))).toBe(false)
    })

    it('one in-flight step per task, shared by every surface: a step sent from one blocks the other', async () => {
      const sent = unpushed()
      // Two surfaces for the same task (the header and, say, the palette), one query client.
      const client = createQueryClient()
      const surface = (
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Routes>
            <Route path="/tasks/:id" element={<RunHeader run={prRun('waiting')} />} />
          </Routes>
        </MemoryRouter>
      )
      render(
        <QueryClientProvider client={client}>
          {surface}
          {surface}
        </QueryClientProvider>,
      )
      const buttons = await waitFor(() => {
        const all = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="git-button"] [data-action="push"]')]
        expect(all).toHaveLength(2)
        expect(all.every((el) => !el.disabled)).toBe(true)
        return all
      })
      fireEvent.click(buttons[0]!)
      await waitFor(() => expect(buttons[1]!.textContent).toBe('Pushing…'))
      expect(buttons[1]!.disabled).toBe(true)
      fireEvent.click(buttons[1]!)
      expect(sent.filter((r) => r.method === 'POST' && r.path.endsWith('/messages'))).toHaveLength(1)
    })
  })

  describe('an agent step stays busy for the turn it started — not the session', () => {
    const behind = () =>
      stubFetch({
        '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 0, unpushed: null, behind: 4, ahead: 1 }),
        '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
      })
    // With a PR, a branch that is behind shows Update branch as the button itself.
    const live = (status: RunStatus, withPr = true) =>
      run(status, {
        worktreePath: '/tmp/wt/r1',
        branch: 'cez/r1',
        baseBranch: 'origin/main',
        ...(withPr ? { pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/1311' } : {}),
      })
    const gitButton = () => document.querySelector('[data-slot="git-button"] button') as HTMLButtonElement | null
    /** One query client across rerenders, so only the run record changes between them. */
    function renderLive(status: RunStatus, withPr = true) {
      const client = createQueryClient()
      const tree = (record: ApiRun) => (
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/tasks/r1']}>
            <Routes>
              <Route path="/tasks/:id" element={<RunHeader run={record} />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      )
      const view = render(tree(live(status, withPr)))
      return (next: RunStatus) => view.rerender(tree(live(next, withPr)))
    }
    async function clickUpdateBranch(sent: SentRequest[]) {
      const button = await waitFor(() => {
        expect(gitButton()?.textContent).toBe('Update branch')
        return gitButton()!
      })
      fireEvent.click(button)
      await waitFor(() => expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/messages'))).toBe(true))
      await waitFor(() => expect(gitButton()?.textContent).toBe('Updating branch…'))
    }

    it('a "needs you" session: busy through the turn, back once it returns to waiting', async () => {
      const sent = behind()
      const setStatus = renderLive('waiting')
      await clickUpdateBranch(sent)
      setStatus('running')
      expect(gitButton()?.textContent).toBe('Updating branch…')
      expect(gitButton()?.disabled).toBe(true)
      // The turn ends; the session stays open. The step must not stay busy for the session's life.
      setStatus('waiting')
      await waitFor(() => expect(gitButton()?.textContent).toBe('Update branch'))
      expect(gitButton()?.disabled).toBe(false)
    })

    it('after a Create PR turn, the PR the agent opened is looked up by branch and recorded', async () => {
      const sent = stubFetch({
        '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 0, unpushed: null, behind: 0, ahead: 1 }),
        '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
        '/api/v1/runs/r1/pr/adopt': () => jsonResponse({ found: true, url: 'https://github.com/o/r/pull/9' }),
      })
      const setStatus = renderLive('waiting', false)
      const button = await waitFor(() => {
        const el = document.querySelector('[data-slot="git-button"] [data-action="create-pr"]') as HTMLButtonElement | null
        expect(el?.disabled).toBe(false)
        return el!
      })
      fireEvent.click(button)
      await waitFor(() => expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/messages'))).toBe(true))
      // Not while the agent is still at it — only once its turn ends.
      setStatus('running')
      expect(sent.some((r) => r.path.endsWith('/pr/adopt'))).toBe(false)
      setStatus('waiting')
      await waitFor(() => expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/pr/adopt'))).toBe(true))
    })

    it('mid-turn the button turns into the next step (Push) — busy, and a click sends nothing more', async () => {
      let gitStatus = { uncommitted: 3, unpushed: 0, behind: 0, ahead: 1 }
      const sent = stubFetch({
        '/api/v1/runs/r1/git/status': () => jsonResponse(gitStatus),
        '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
        '/api/v1/repo': () => jsonResponse({ info: { remote: 'git@github.com:open-mercato/cezar.git' } }),
      })
      const client = createQueryClient()
      const tree = (status: RunStatus) => (
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/tasks/r1']}>
            <Routes>
              <Route
                path="/tasks/:id"
                element={
                  <RunHeader
                    run={run(status, {
                      worktreePath: '/tmp/wt/r1',
                      branch: 'cez/r1',
                      pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/1311',
                    })}
                  />
                }
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      )
      const view = render(tree('waiting'))
      const commitPush = await waitFor(() => {
        const el = document.querySelector('[data-slot="git-button"] [data-action="commit-push"]') as HTMLButtonElement | null
        expect(el?.disabled).toBe(false)
        return el!
      })
      fireEvent.click(commitPush)
      const messages = () => sent.filter((r) => r.method === 'POST' && r.path.endsWith('/messages'))
      await waitFor(() => expect(messages()).toHaveLength(1))
      view.rerender(tree('running'))
      // The agent's commit lands; the push has not happened yet.
      gitStatus = { uncommitted: 0, unpushed: 2, behind: 0, ahead: 2 }
      await act(() => client.invalidateQueries({ queryKey: queryKeys.runs.gitStatus('r1') }))
      const push = await waitFor(() => {
        const el = document.querySelector('[data-slot="git-button"] [data-action="push"]') as HTMLButtonElement | null
        expect(el).not.toBeNull()
        return el!
      })
      expect(push.disabled).toBe(true)
      expect(push.textContent).toBe('Committing and pushing…')
      fireEvent.click(push)
      expect(messages()).toHaveLength(1)
    })

    it('sent mid-turn: the turn already running is not the step’s — busy until its own turn ends, adoption only then', async () => {
      const sent = stubFetch({
        '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 0, unpushed: null, behind: 0, ahead: 1 }),
        '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
        '/api/v1/runs/r1/pr/adopt': () => jsonResponse({ found: true, url: 'https://github.com/o/r/pull/9' }),
      })
      const setStatus = renderLive('running', false)
      const button = await waitFor(() => {
        const el = document.querySelector('[data-slot="git-button"] [data-action="create-pr"]') as HTMLButtonElement | null
        expect(el?.disabled).toBe(false)
        return el!
      })
      fireEvent.click(button)
      await waitFor(() => expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/messages'))).toBe(true))
      const adopted = () => sent.some((r) => r.method === 'POST' && r.path.endsWith('/pr/adopt'))
      // The turn that was running at the click ends — the agent has not reached the message yet.
      setStatus('waiting')
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
      expect(gitButton()?.textContent).toBe('Creating PR…')
      expect(adopted()).toBe(false)
      // Its own turn runs and ends: now the step is done and the PR is looked up.
      setStatus('running')
      setStatus('waiting')
      await waitFor(() => expect(adopted()).toBe(true))
      await waitFor(() => expect(gitButton()?.textContent).not.toBe('Creating PR…'))
    })

    it('a turn that never shows up releases the step after the grace period', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const sent = behind()
      renderLive('waiting')
      await clickUpdateBranch(sent)
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      await waitFor(() => expect(gitButton()?.textContent).toBe('Update branch'))
    })
  })

  it('no PR and nothing changed: no git button at all — there is nothing to open a PR from', async () => {
    const sent = stubFetch({
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 0, unpushed: null, behind: 0, ahead: 0 }),
      '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
    })
    renderHeader(run('running', { worktreePath: '/tmp/wt/r1', branch: 'cez/r1', baseBranch: 'main' }))
    await waitFor(() => expect(sent.some((r) => r.path === '/api/v1/runs/r1/git/status')).toBe(true))
    await act(async () => {})
    expect(document.querySelector('[data-slot="git-button"]')).toBeNull()
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

  // #1410: health's forge is the BOOT folder's. A task in a cloned GitHub project, served from a
  // non-repo boot (`forge: null`), must still be offered Create PR — the gate is its project's.
  it('offers Create PR in a non-boot GitHub project even when the boot folder has no forge', async () => {
    const status = () => jsonResponse({ uncommitted: 2, unpushed: null })
    stubFetch({
      '/api/v1/health': () =>
        jsonResponse({ bootProject: 'home', forge: null, checks: [{ name: 'gh', available: true }] }),
      '/api/v1/projects': () =>
        jsonResponse({
          bootProject: 'home',
          projectsDir: '/repos',
          projects: [{ id: 'shop', name: 'shop', root: '/repos/shop', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok', forge: 'github' }],
        }),
      '/api/v1/repo': () => jsonResponse({ info: { root: '/repos/shop', branch: 'main', remote: 'origin' } }),
      '/api/v1/p/shop/repo': () => jsonResponse({ info: { root: '/repos/shop', branch: 'main', remote: 'origin' } }),
      '/api/v1/runs/r1/git/status': status,
      '/api/v1/p/shop/runs/r1/git/status': status,
      '/api/v1/p/shop/runs': () => jsonResponse([]),
    })
    const record = run('done', { worktreePath: '/tmp/wt/r1', branch: 'cez/r1' })
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[`/tasks/${record.id}`]}>
          <ProjectScopeProvider projectId="shop">
            <Routes>
              <Route path="/tasks/:id" element={<RunHeader run={record} />} />
            </Routes>
          </ProjectScopeProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(document.querySelector('[data-slot="git-button"] [data-action="create-pr"]')).not.toBeNull())
  })

  // #1410 for trunk-based projects (#1597): the Commit-to-base step's Create PR alternative names
  // a missing forge, so it too must ask the task's project, not the boot folder.
  it('a trunk task in a non-boot GitHub project offers Create PR under Commit to main', async () => {
    const status = () => jsonResponse({ uncommitted: 2, unpushed: 0, behind: 0 })
    const config = () => jsonResponse({ landing: 'auto', landingBlocked: null, baseBranch: 'main', defaultRunner: 'claude' })
    stubFetch({
      '/api/v1/health': () =>
        jsonResponse({ bootProject: 'home', forge: null, checks: [{ name: 'gh', available: true }] }),
      '/api/v1/projects': () =>
        jsonResponse({
          bootProject: 'home',
          projectsDir: '/repos',
          projects: [{ id: 'shop', name: 'shop', root: '/repos/shop', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok', forge: 'github' }],
        }),
      '/api/v1/p/shop/repo': () => jsonResponse({ info: { root: '/repos/shop', branch: 'main', remote: 'origin' } }),
      '/api/v1/p/shop/config': config,
      '/api/v1/p/shop/runs/r1/git/status': status,
      '/api/v1/p/shop/runs': () => jsonResponse([]),
    })
    const record = run('done', { worktree: false })
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[`/tasks/${record.id}`]}>
          <ProjectScopeProvider projectId="shop">
            <Routes>
              <Route path="/tasks/:id" element={<RunHeader run={record} />} />
            </Routes>
          </ProjectScopeProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const chevron = await waitFor(() => {
      const el = document.querySelector('[data-slot="git-button"] [aria-label="More ways to commit to main"]')
      expect(el).not.toBeNull()
      return el!
    })
    fireEvent.pointerDown(chevron)
    const menu = await screen.findByRole('menu')
    const createPr = menu.querySelector('[data-action="create-pr"]')
    expect(createPr).not.toBeNull()
    expect(createPr!.getAttribute('aria-disabled')).not.toBe('true')
    expect(menu.textContent).not.toContain('no supported forge remote')
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

  it('the ⋯ menu is there for every status', () => {
    stubFetch()
    renderHeader(run('running'))
    expect(screen.getByRole('button', { name: 'More actions' })).not.toBeNull()
  })
})

describe('Mark unread (#775)', () => {
  const FINISHED_AT = '2026-07-14T13:00:00.000Z'
  const SEEN_AT = '2026-07-14T13:05:00.000Z'
  /** A finished run that has already been read — the one state the action is offered in. */
  const readDone = (extra: Partial<ApiRun> = {}) =>
    run('done', { finishedAt: FINISHED_AT, seenAt: SEEN_AT, ...extra })

  it('offers the row for a read, finished run — first in the menu, ahead of Pin', async () => {
    stubFetch()
    renderHeader(readDone())
    expect(menuLabels(await openMenu()).slice(0, 2)).toEqual(['Mark unread', 'Pin'])
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
    expect((await openMenu()).queryByRole('menuitem', { name: 'Mark unread' })).toBeNull()
  })

  it('Mark unread → POST /unread, bodyless like its read twin', async () => {
    const sent = stubFetch()
    renderHeader(readDone())
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Mark unread' }))
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
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Mark unread' }))
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
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Mark unread' }))
    await waitFor(() => expect(screen.getByText('not found')).not.toBeNull())
  })
})

describe('the state toggles share one ON pattern (violet, filled, aria-pressed)', () => {
  const FINISHED_AT = '2026-07-14T13:00:00.000Z'
  const isOn = (row: HTMLElement) =>
    row.getAttribute('aria-pressed') === 'true' && (row.querySelector('svg')?.getAttribute('class') ?? '').includes('fill-violet/25')

  it.each([
    ['pinned', { pinned: true, pinnedAt: FINISHED_AT }, 'Unpin'],
    ['archived', { archived: true }, 'Unarchive'],
    ['unread', { finishedAt: FINISHED_AT }, 'Mark read'],
  ] as const)('%s → its row is ON', async (_state, extra, name) => {
    stubFetch()
    renderHeader(run('done', extra))
    expect(isOn((await openMenu()).getByRole('menuitem', { name }))).toBe(true)
  })

  it.each([
    ['Pin', {}],
    ['Archive', {}],
    ['Mark unread', { finishedAt: FINISHED_AT, seenAt: '2026-07-14T13:05:00.000Z' }],
  ] as const)('%s off → no ON styling, aria-pressed false', async (name, extra) => {
    stubFetch()
    renderHeader(run('done', extra))
    const row = (await openMenu()).getByRole('menuitem', { name })
    expect(row.getAttribute('aria-pressed')).toBe('false')
    expect(row.querySelector('svg')?.getAttribute('class')).not.toContain('text-violet')
  })

  it('read/unread is ONE row that flips state, not two', async () => {
    stubFetch()
    renderHeader(run('done', { finishedAt: FINISHED_AT }))
    const menu = await openMenu()
    expect(menu.queryByRole('menuitem', { name: 'Mark unread' })).toBeNull()
    expect(menu.getAllByRole('menuitem').filter((row: HTMLElement) => row.getAttribute('data-command') === 'toggle-read')).toHaveLength(1)
  })
})

describe('the git group of the ⋯ menu', () => {
  const openKebab = async () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }))
    return screen.findByRole('menu')
  }

  it('carries the git step and its draft alternative, in the policy\'s order', async () => {
    stubFetch({
      '/api/v1/runs/r1/git/status': () => jsonResponse({ uncommitted: 2, unpushed: null }),
      '/api/v1/health': () => jsonResponse({ forge: { kind: 'github', available: true } }),
    })
    renderHeader(run('done', { worktreePath: '/tmp/wt/r1', branch: 'cez/r1' }))
    // Wait for the step to resolve (the desktop button paints it too) before opening the menu.
    await waitFor(() => expect(document.querySelector('[data-slot="git-button"]')).not.toBeNull())
    const menu = await openKebab()
    const items = [...menu.querySelectorAll('[role="menuitem"][data-action]')]
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

  it('offers Stop… on every tab — the composer\'s ■ is the same confirm', async () => {
    stubFetch()
    renderHeader(run('running'))
    expect(within(await openKebab()).getByRole('menuitem', { name: 'Stop…' })).not.toBeNull()
    closeMenu()
    cleanup()
    stubFetch()
    renderGitTab(run('running'))
    expect(within(await openKebab()).getByRole('menuitem', { name: 'Stop…' })).not.toBeNull()
  })
})

describe('actions hit their endpoints', () => {
  it('End session (a waiting run) → POST /finish, from the ⋯ menu', async () => {
    const sent = stubFetch()
    renderGitTab(run('waiting'))
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'End session' }))
    await waitFor(() => {
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/finish')).toBe(true)
    })
  })

  it('a review offers Accept changes without a PR instead of End session', async () => {
    stubFetch()
    renderGitTab(run('review'))
    const menu = await openMenu()
    expect(menu.queryByRole('menuitem', { name: 'End session' })).toBeNull()
    expect(menu.getByRole('menuitem', { name: 'Accept changes without a PR' })).not.toBeNull()
  })

  it('Archive → POST /archive with the flipped flag', async () => {
    const sent = stubFetch()
    renderHeader(run('done', { archived: true }))
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Unarchive' }))
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/archive')?.body).toEqual({ archived: false, surface: 'task_view' })
    })
  })

  it('Pin → POST /pin with the flipped flag, and reads Unpin once pinned (#935)', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Pin' }))
    await waitFor(() => {
      expect(sent.find((r) => r.path === '/api/v1/runs/r1/pin')?.body).toEqual({ pinned: true, surface: 'task_view' })
    })

    cleanup()
    const unpinning = stubFetch()
    renderHeader(run('done', { pinned: true, pinnedAt: '2026-08-29T10:00:00.000Z' }))
    const unpin = (await openMenu()).getByRole('menuitem', { name: 'Unpin' })
    expect(unpin.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(unpin)
    await waitFor(() => {
      expect(unpinning.find((r) => r.path === '/api/v1/runs/r1/pin')?.body).toEqual({ pinned: false, surface: 'task_view' })
    })
  })

  it('an archived run cannot be pinned — archiving retires it (#935)', async () => {
    const sent = stubFetch()
    renderHeader(run('done', { archived: true }))
    const pin = (await openMenu()).getByRole('menuitem', { name: 'Pin' })
    expect(pin.getAttribute('data-disabled')).not.toBeNull()
    expect(pin.getAttribute('title')).toBe('Archived tasks can’t be pinned')
    fireEvent.click(pin)
    await act(() => Promise.resolve())
    expect(sent.some((r) => r.path === '/api/v1/runs/r1/pin')).toBe(false)
  })

  it('Stop asks first — the POST fires only after the confirm dialog', async () => {
    const sent = stubFetch()
    renderHeader(run('running'))
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Stop…' }))

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
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Delete…' }))

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
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Delete…' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('button', { name: 'Delete' })).not.toBeNull()
    expect(within(dialog).getByText(longTitle)).not.toBeNull()
  })

  it('dismissing the confirm keeps the run', async () => {
    const sent = stubFetch()
    renderHeader(run('done'))
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Delete…' }))
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
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Archive' }))
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

describe('Terminal — hosted mode (telemetry f179cc7d)', () => {
  const hostedHealth = () => jsonResponse({ capabilities: { localHandoff: false } })

  it('a hosted cockpit offers no Terminal resume, so it never POSTs a refused open-in-cli', async () => {
    const sent = stubFetch({ '/api/v1/health': hostedHealth })
    renderHeader(run('done'))
    await waitFor(() => expect(sent.some((r) => r.path === '/api/v1/health')).toBe(true))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open in…' })).toBeNull())
    expect(sent.some((r) => r.path === '/api/v1/runs/r1/open-in-cli')).toBe(false)
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
    expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull()
  })
})

describe('preview tab', () => {
  it('Preview is a deep-linkable tab, closing the review group; Notes opens the run group after it', () => {
    stubFetch()
    renderHeader(run('done'))
    const tabs = within(document.querySelector('[data-slot="run-tabs"]') as HTMLElement)
    expect(tabs.getByRole('link', { name: 'Preview' }).getAttribute('href')).toBe('/tasks/r1/preview')
    const names = tabs.getAllByRole('link').map((link) => link.textContent)
    expect(names.indexOf('Notes')).toBe(names.indexOf('Preview') + 1)
    // Chat | Changes · Commits · Files · Preview | Notes · Assets: two hairlines.
    expect(tabs.getAllByRole('separator')).toHaveLength(2)
  })
})

/** A run id no other test has touched. The expand memory is a module-level map keyed by run id
 *  (the same shape `WorkflowSteps` keeps), so a test that toggles it must not poison the shared
 *  `r1` fixture every other test in this file renders. */
let detailsRunSeq = 0
const freshRunId = () => `details-r${++detailsRunSeq}`

describe('phone line 2 (#765, redesigned)', () => {
  it('leads with the status word and keeps the diff, the PR and the cost; workflow and branch step aside', () => {
    stubFetch()
    renderHeader(
      run('review', {
        id: freshRunId(),
        branch: 'cez/r1',
        diffStat: { adds: 42, dels: 7, files: 3 },
        costUsd: 0.04,
        pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/1311',
      }),
    )
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    expect(meta.firstElementChild?.getAttribute('data-slot')).toBe('pill')
    expect(within(meta).getByText('quick-task').className).toContain('max-md:hidden')
    expect(within(meta).getByText('cez/r1').parentElement?.className).toContain('max-md:hidden')
    expect(meta.querySelector('[data-slot="diff-stat"]')?.className).not.toContain('max-md:hidden')
    expect(meta.querySelector('[data-slot="pr-chip"]')).not.toBeNull()
    // The usage chip narrows to the cost.
    expect(meta.querySelector('[data-slot="agent-badge"] .md\\:hidden')?.textContent).toBe('$0.04')
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
    // The chip reads the usage; the runner and model are its accessible name and its popover.
    expect(badge.querySelector('[data-slot="usage-summary"]')?.textContent).toBe('24.6k in · 2.4k out · $0.04')
    // Still not loose text: nothing runner/model-shaped outside the badge.
    expect(meta.textContent).not.toContain('codex')
    expect(within(meta).getByText('cez/r1').getAttribute('data-slot')).toBe('branch-chip')
    expect(meta.querySelector('[data-slot="diff-stat"]')?.textContent).toBe('+42 −7')
    expect(meta.textContent).toContain('24.6k in · 2.4k out')
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
            localHandoff: true, terminal: false, followups: false, singleProject: false, automations: true,
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
            localHandoff: true, terminal: false, followups: false, singleProject: false, automations: false,
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
    terminal: false,
            followups: false,
            singleProject: false,
            tokenMetrics: false,
          },
        }),
    })
    renderHeader(run('done', { costUsd: 0.04 }))

    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    await waitFor(() => {
      expect(meta.textContent).not.toContain('24.6k')
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
      expect(branch?.parentElement?.nextElementSibling?.nextElementSibling).toBe(prChip.closest('[data-slot="run-pr-refs"]'))
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

  it('the usage chip reveals runner and model on click, reading "auto" when the model is unset', async () => {
    stubFetch()
    renderHeader(run('done', { runner: 'opencode' }))
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    fireEvent.click(within(meta).getByRole('button', { name: /Agent: opencode/ }))
    const details = within(await screen.findByRole('dialog'))
    expect(details.getByText('Runner').nextElementSibling?.textContent).toBe('opencode')
    expect(details.getByText('Model').nextElementSibling?.textContent).toBe('auto')
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
    fireEvent.click(within(meta).getByRole('button', { name: /Agent: claude/ }))
    const details = await screen.findByRole('dialog')
    expect(within(details).getByText('Next continuation')).not.toBeNull()
    expect(within(details).getByRole('button', { name: 'Model' }).textContent).toBe('sonnet')
  })

  it('keeps the historical badge read-only when no continuation picker is owned by the view', async () => {
    stubFetch()
    renderHeader(run('running', { runner: 'claude', model: 'sonnet' }))
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    fireEvent.click(within(meta).getByRole('button', { name: /Agent: claude/ }))
    const details = await screen.findByRole('dialog')
    expect(within(details).queryByText('Next continuation')).toBeNull()
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
      // The chip's accessible name carries it; the popover labels it.
      fireEvent.click(badge)
      expect((await screen.findByRole('dialog')).querySelector('[data-slot="agent-badge-account"]')?.textContent).toBe('Klaudiusz')
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
    /** Opens the usage chip's popover — its content is not in the DOM until it does. */
    const openAgentMenu = async () => {
      const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
      fireEvent.click(within(meta).getByRole('button', { name: /^Agent:/ }))
      return screen.findByRole('dialog')
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
      // It ADDS to the asked-for model rather than replacing it — `model` is still the free-text
      // the caller typed, and losing that would make the badge answer a different question.
      expect(within(menu).getByText('Model').nextElementSibling?.textContent).toBe('opus')
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
      expect(within(menu).getByText('Model').nextElementSibling?.textContent).toBe('anthropic/claude-opus-4-8')
    })
  })

  it.each(['session', 'changes', 'notes'] as RunTab[])(
    'the %s tab shows the same usage chip, one line on hover, the sheet on click',
    async (tab) => {
      stubFetch()
      renderHeader(run('running', { runner: 'claude', model: 'opus' }), undefined, undefined, undefined, tab)
      const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
      const badge = within(meta).getByRole('button', { name: /Agent: claude, model opus/ })
      expect(await tooltipOf(badge)).toBe('Time, tokens, cost and the agent — click for details')
      cleanupTooltip(badge)
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

  it('tabs: Chat is current; Changes and Files link to the routed surfaces', () => {
    stubFetch()
    renderHeader(run('done'))
    const tabs = within(document.querySelector('[data-slot="run-tabs"]') as HTMLElement)
    expect(tabs.getByRole('link', { name: 'Chat' }).getAttribute('aria-current')).toBe('page')
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
      expect(document.querySelector('[data-slot="pill"]')?.textContent).toBe('Queued #2')
    })
  })

  it('a closed run with a session offers the per-backend takeover command from the menu, never inline', async () => {
    stubFetch()
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderHeader(run('failed', { runner: 'opencode', worktreePath: '/tmp/wt' }))
    expect(document.querySelector('[data-slot="resume-hint"]')).toBeNull()
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Take over in terminal' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('cd /tmp/wt && opencode --session sess-1')
    })
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
    await waitFor(() => expect(document.querySelector('[data-slot="run-primary-actions"]')).not.toBeNull())
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
    await waitFor(() => expect(document.querySelector('[data-slot="run-primary-actions"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="unit-role"]')).toBeNull()
  })
})

describe('lifecycle-aware task deletion', () => {
  const operation = {id:'11111111-1111-4111-8111-111111111111',worktreeId:'22222222-2222-4222-8222-222222222222',generation:1,phase:'teardown',intent:'delete-task',state:'queued',revision:0,createdAt:'now',updatedAt:'now',history:[],entries:[],allowedActions:['stop']}
  it.each([true, false])('requests cleanup and keeps the task page for a %s managed projection', async managed => {
    const sent = stubFetch({
      '/api/v1/config': () => jsonResponse({worktreeLifecycle:{afterCreate:[],beforeRemove:[{id:'33333333-3333-4333-8333-333333333333',command:'echo cleanup'}]}}),
      '/api/v1/worktree-lifecycle/operations': () => jsonResponse({operation}, 202),
    })
    renderHeader(run('done', {worktreePath:'/project/.ai/cezar/worktrees/r1', ...(managed ? {worktreeLifecycle:{worktreeId:operation.worktreeId,generation:1,needsAttention:false}} : {})}))
    fireEvent.click((await openMenu()).getByRole('menuitem',{name:'Delete…'}))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button',{name:'Delete'}))
    await waitFor(() => expect(sent.some(request => request.path === '/api/v1/worktree-lifecycle/operations' && request.method === 'POST')).toBe(true))
    expect(sent.some(request => request.method === 'DELETE')).toBe(false)
    expect(sent.find(request => request.path === '/api/v1/worktree-lifecycle/operations')?.body).toMatchObject({runId:'r1',intent:'delete-task',requestId:expect.any(String)})
    await screen.findByText('Cleanup requested. The task is kept until cleanup completes.')
    expect(document.querySelector('[data-slot="home-probe"]')).toBeNull()
  })
  it('greys Delete out for a finished task whose cleanup is still running', async () => {
    stubFetch()
    renderHeader(run('done',{worktreeLifecycle:{worktreeId:operation.worktreeId,generation:1,activeOperationId:operation.id,phase:'teardown',state:'running',needsAttention:false}}))
    const row = (await openMenu()).getByRole('menuitem',{name:'Delete…'})
    expect(row.getAttribute('data-disabled')).not.toBeNull()
    expect(row.getAttribute('title')).toBe('Resolve the worktree operation first')
  })

  it('hides ordinary task actions while lifecycle recovery owns the worktree', async () => {
    stubFetch()
    renderHeader(run('waiting',{worktreeLifecycle:{worktreeId:operation.worktreeId,generation:1,activeOperationId:operation.id,phase:'setup',state:'needs_attention',needsAttention:true}}))
    expect(primaryLabel()).toBeNull()
    expect(secondaryLabel()).toBeNull()
    // Delete stays in place, greyed out like a live run's.
    expect((await openMenu()).getByRole('menuitem',{name:'Delete…'}).getAttribute('data-disabled')).not.toBeNull()
  })
})

describe('task worktree removal (#1600)', () => {
  const operation = { id: '11111111-1111-4111-8111-111111111111', worktreeId: '22222222-2222-4222-8222-222222222222', generation: 1, phase: 'teardown', intent: 'reclaim', state: 'queued', revision: 0, createdAt: 'now', updatedAt: 'now', history: [], entries: [], allowedActions: ['stop'] }
  const record = () => run('done', { worktreePath: '/project/.ai/cezar/worktrees/r1', branch: 'cez/r1' })
  const clean = { uncommitted: 0, unpushed: null, behind: 0, ahead: 1 }
  const endpoint = '/api/v1/worktree-lifecycle/operations'
  async function openRemoval() {
    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Remove worktree…' }))
    return within(await screen.findByRole('alertdialog'))
  }
  it.each([{ managed: false }, { managed: true }])('confirms reclaim from the menu (managed=$managed) without deleting or navigating', async ({ managed }) => {
    const sent = stubFetch({ '/api/v1/runs/r1/git/status': () => jsonResponse(clean), [endpoint]: () => jsonResponse({ operation }, 202) })
    renderHeader({ ...record(), ...(managed ? { worktreeLifecycle: { worktreeId: operation.worktreeId, generation: 1, needsAttention: false } } : {}) })
    const dialog = await openRemoval()
    expect(dialog.getByText(/including unpushed commits/)).not.toBeNull()
    expect(dialog.getByText(/Ignored local files/)).not.toBeNull()
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Remove worktree' }).hasAttribute('disabled')).toBe(false))
    expect(sent.filter(request => request.path === endpoint)).toHaveLength(0)
    fireEvent.click(dialog.getByRole('button', { name: 'Remove worktree' }))
    await screen.findByText('Worktree removal requested. Follow cleanup progress on this task.')
    expect(sent.find(request => request.path === endpoint)?.body).toEqual({ requestId: expect.any(String), runId: 'r1', intent: 'reclaim' })
    expect(sent.some(request => request.method === 'DELETE' || request.path.includes('remove-worktree'))).toBe(false)
    expect(document.querySelector('[data-slot="home-probe"]')).toBeNull()
  })
  it('Cancel retains everything and launches no operation', async () => {
    const sent = stubFetch({ '/api/v1/runs/r1/git/status': () => jsonResponse(clean) })
    renderHeader(record())
    const dialog = await openRemoval()
    fireEvent.click(dialog.getByRole('button', { name: 'Keep worktree' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(sent.some(request => request.method !== 'GET')).toBe(false)
  })
  it.each([
    { name: 'dirty', response: () => jsonResponse({ ...clean, uncommitted: 2 }), message: /This worktree has uncommitted/ },
    { name: 'missing', response: () => jsonResponse({ error: 'Worktree missing' }, 409), message: /Could not check/ },
    { name: 'unknown', response: () => jsonResponse({}), message: /Could not check/ },
  ])('refuses a $name checkout before removal', async ({ response, message }) => {
    const sent = stubFetch({ '/api/v1/runs/r1/git/status': response })
    renderHeader(record())
    const dialog = await openRemoval()
    await dialog.findByText(message)
    expect(dialog.getByRole('button', { name: 'Remove worktree' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(dialog.getByRole('button', { name: 'Remove worktree' }))
    expect(sent.some(request => request.path === endpoint)).toBe(false)
  })
  it('rechecks dirty status on submit and never requests removal when it changed', async () => {
    let dirty = false
    const sent = stubFetch({ '/api/v1/runs/r1/git/status': () => jsonResponse({ ...clean, uncommitted: dirty ? 1 : 0 }) })
    renderHeader(record())
    const dialog = await openRemoval()
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Remove worktree' }).hasAttribute('disabled')).toBe(false))
    dirty = true
    fireEvent.click(dialog.getByRole('button', { name: 'Remove worktree' }))
    await screen.findByText('Commit or stash uncommitted changes before removing the worktree.')
    expect(sent.some(request => request.path === endpoint)).toBe(false)
    expect(screen.queryByRole('alertdialog')).not.toBeNull()
  })
  it('surfaces a lifecycle conflict and retains the page/dialog', async () => {
    stubFetch({ '/api/v1/runs/r1/git/status': () => jsonResponse(clean), [endpoint]: () => jsonResponse({ error: 'Task is active; cancel it before removing its worktree' }, 409) })
    renderHeader(record())
    const dialog = await openRemoval()
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Remove worktree' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(dialog.getByRole('button', { name: 'Remove worktree' }))
    await screen.findByText('Task is active; cancel it before removing its worktree')
    expect(screen.queryByRole('alertdialog')).not.toBeNull()
    expect(document.querySelector('[data-slot="home-probe"]')).toBeNull()
  })
})

describe('the step rail agrees with how the run closed (#2022, #2025)', () => {
  const AT = '2026-11-04T10:00:00.000Z'
  const closing = [step({ status: 'failed', sessionId: 'sess-1', finishedAt: AT })]
  const dotVisual = () => document.querySelector('[data-slot="step-dot"]')?.getAttribute('data-visual')

  it('an idle-closed run paints its closing step orange, not red', () => {
    stubFetch()
    renderHeader(run('failed', { idleClosedAt: AT, steps: closing }))
    expect(dotVisual()).toBe('idle')
  })

  it('a run awaiting an answer paints its closing step amber, even when the idle timer closed it', () => {
    stubFetch()
    renderHeader(run('failed', { idleClosedAt: AT, awaitingAnswerSince: AT, steps: closing }))
    expect(dotVisual()).toBe('answer')
  })

  it('a plain failure stays red', () => {
    stubFetch()
    renderHeader(run('failed', { steps: closing }))
    expect(dotVisual()).toBe('failed')
  })
})

describe('the facts line reads cleanly on both sides of the breakpoint', () => {
  it('no stray dot: each breakpoint only separates what it shows', () => {
    stubFetch()
    renderHeader(run('review', { branch: 'cez/r1', diffStat: { adds: 1, dels: 0, files: 1 } }))
    const meta = document.querySelector('[data-slot="run-meta"]') as HTMLElement
    const nodes = [...meta.children].filter((node) => node.getAttribute('data-slot') !== 'run-usage')
    const reads = (breakpoint: 'phone' | 'desktop') =>
      nodes
        .filter((node) => {
          const className = node.className
          if (className.includes('max-md:hidden')) return breakpoint === 'desktop'
          if (/(^|\s)md:hidden/.test(className)) return breakpoint === 'phone'
          return !/(^|\s)hidden(\s|$)/.test(className)
        })
        .map((node) => node.textContent?.trim())
    expect(reads('desktop')).toEqual(['quick-task', '·', '1 of 1 done', '·', 'cez/r1', '·', '+1 −0'])
    expect(reads('phone')).toEqual(['Needs review', '·', '+1 −0'])
  })
})
