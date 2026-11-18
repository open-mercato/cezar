import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { managerKeys } from '@/api/managers'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { DISMISS_UNDO_MS, resetDismissals } from '@/api/questions'
import { managerFixture } from '@/routes/manager/manager-fixtures'
import { ManagerSidebar } from '@/routes/manager/manager-sidebar'
import type { QuestionItem, QuestionsResponse } from '@open-mercato/cezar-api-client'

import { closedLabel, groupQuestions, questionContextHref, QuestionsRoute } from './questions-route'

const HOUR = 3_600_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const managerItem = (messageId: string, header: string, rest: Partial<QuestionItem> = {}): QuestionItem => ({
  key: `m:global:${messageId}`,
  source: { kind: 'manager', managerId: 'global', name: 'Global' },
  askedAt: ago(HOUR),
  questions: [{ header, question: `${header}?`, options: [{ label: 'Yes' }, { label: 'No' }] }],
  older: false,
  ...rest,
})
const taskItem = (requestId: string, header: string, rest: Partial<QuestionItem> = {}): QuestionItem => ({
  key: `r:alpha:run1:${requestId}`,
  source: { kind: 'task', projectId: 'alpha', runId: 'run1', title: 'Migrate push tokens', status: 'waiting' },
  askedAt: ago(2 * HOUR),
  questions: [{ header, question: `${header}?`, options: [{ label: 'Relay KV' }, { label: 'SQLite' }] }],
  older: false,
  ...rest,
})

let data: QuestionsResponse
const posts: Array<{ path: string; body: unknown }> = []
let answerStatus = 200

function respond(): QuestionsResponse {
  const live = data.open.filter((item) => !item.older).length
  return { ...data, counts: { live, older: data.open.length - live } }
}

beforeEach(() => {
  data = { open: [], closed: [], counts: { live: 0, older: 0 }, olderAfterDays: 7 }
  posts.length = 0
  answerStatus = 200
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    if (url.pathname === '/api/v1/workspace/questions') return Response.json(respond())
    const verb = /\/workspace\/questions\/([^/]+)\/(answer|dismiss)$/.exec(url.pathname)
    if (verb) {
      const key = decodeURIComponent(verb[1]!)
      posts.push({ path: `${verb[2]} ${key}`, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (verb[2] === 'answer' && answerStatus === 409) return Response.json({ error: 'already closed' }, { status: 409 })
      const item = data.open.find((row) => row.key === key)!
      const closed = { ...item, closed: verb[2] === 'answer'
        ? { reason: 'answered' as const, at: new Date().toISOString(), answer: (JSON.parse(init!.body as string) as { text: string }).text }
        : { reason: 'dismissed' as const, at: new Date().toISOString() } }
      data = { ...data, open: data.open.filter((row) => row.key !== key), closed: [closed, ...data.closed] }
      return Response.json({ ok: true, item: closed })
    }
    if (url.pathname === '/api/v1/workspace/ui-state') {
      posts.push({ path: 'ui-state', body: JSON.parse(init!.body as string) })
      const days = (JSON.parse(init!.body as string) as { questions: { olderAfterDays: number } }).questions.olderAfterDays
      data = { ...data, olderAfterDays: days, open: data.open.map((item) => ({ ...item, older: days > 0 && Date.now() - Date.parse(item.askedAt) > days * 24 * HOUR })) }
      return Response.json({})
    }
    if (url.pathname.endsWith('/managers')) return Response.json({ managers: [managerFixture({ pendingActions: 2 })] })
    return Response.json({})
  }))
})
afterEach(() => {
  cleanup()
  resetDismissals()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function renderPage({ managers = true, entry = '/manager/questions' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { capabilities: { managers, localHandoff: true } })
  client.setQueryData(managerKeys.list, { managers: [managerFixture({ pendingActions: 2 })] })
  client.setQueryData(workspaceQueryKeys.projects, { projects: [{ id: 'alpha', name: 'Alpha' }], bootProject: null, projectsDir: '' })
  client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [] })
  client.setQueryData(workspaceQueryKeys.uiState, {})
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        {managers ? <ManagerSidebar /> : null}
        <Routes>
          <Route path="/manager/questions" element={<QuestionsRoute />} />
          <Route path="/questions" element={<QuestionsRoute />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const card = (header: string) => screen.getByRole('group', { name: header })

describe('the Questions page', () => {
  it('shows the empty state, and the approvals cross-link', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'No questions waiting' })).toBeTruthy()
    expect(screen.getByText('Nothing waiting on you')).toBeTruthy()
    const chip = screen.getByRole('link', { name: /^2 approvals waiting/ })
    expect(chip.getAttribute('href')).toBe('/manager/approvals')
  })

  it('groups by source, newest group first, with Open chat / Open task and Open in context', async () => {
    data.open = [managerItem('m1', 'Design', { askedAt: ago(10 * 60_000) }), taskItem('ask_1', 'Storage'), managerItem('m2', 'Budget', { askedAt: ago(3 * HOUR) })]
    renderPage()
    const groups = await screen.findAllByRole('region')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Global', 'Migrate push tokens'])
    // Oldest first inside a group: the order it was asked in.
    expect([...groups[0]!.querySelectorAll('[data-slot="question-card"]')].map((row) => row.getAttribute('aria-label'))).toEqual(['Budget', 'Design'])
    expect(within(groups[0]!).getByRole('link', { name: 'Open chat with Global' }).getAttribute('href')).toBe('/manager/global')
    expect(within(groups[1]!).getByRole('link', { name: 'Open task Migrate push tokens' }).getAttribute('href')).toBe('/p/alpha/tasks/run1/chat')
    expect(within(groups[1]!).getByText('Alpha · waiting')).toBeTruthy()
    expect(within(card('Design')).getByRole('link', { name: 'Open in context' }).getAttribute('href')).toBe('/manager/global#decision-m1')
    expect(within(card('Storage')).getByRole('link', { name: 'Open in context' }).getAttribute('href')).toBe('/p/alpha/tasks/run1/chat#ask')
    expect(screen.getByText('3 questions waiting, from 1 manager and 1 task')).toBeTruthy()
  })

  it('filters by Managers and Tasks', async () => {
    data.open = [managerItem('m1', 'Design'), taskItem('ask_1', 'Storage')]
    renderPage()
    await screen.findByRole('group', { name: 'Design' })
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    expect(screen.queryByRole('group', { name: 'Design' })).toBeNull()
    expect(card('Storage')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Managers' }))
    expect(card('Design')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Storage' })).toBeNull()
  })

  it('answers in place with one tap, then moves focus to the next card and lists it as closed', async () => {
    data.open = [managerItem('m1', 'Design'), managerItem('m2', 'Budget', { askedAt: ago(10 * 60_000) })]
    renderPage()
    fireEvent.click(within(await screen.findByRole('group', { name: 'Design' })).getByRole('button', { name: 'Yes' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Design' })).toBeNull())
    expect(posts).toEqual([{ path: 'answer m:global:m1', body: { text: 'Design: Yes' } }])
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Yes'))
    expect(document.activeElement?.closest('[data-question-key]')?.getAttribute('data-question-key')).toBe('m:global:m2')
    expect(screen.getByText('Answered «Design».')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Closed · 1/ }))
    expect(screen.getByText('Answered')).toBeTruthy()
  })

  it('a stale tab: answering a question that closed meanwhile says so and refetches', async () => {
    data.open = [managerItem('m1', 'Design')]
    answerStatus = 409
    renderPage()
    fireEvent.click(within(await screen.findByRole('group', { name: 'Design' })).getByRole('button', { name: 'Yes' }))
    expect(await screen.findByText('This question closed before your answer arrived.')).toBeTruthy()
  })

  it('dismiss waits out the 6 s undo before it POSTs; the sidebar count drops at once', async () => {
    data.open = [managerItem('m1', 'Design'), taskItem('ask_1', 'Storage')]
    renderPage()
    await screen.findByRole('group', { name: 'Design' })
    const count = () => document.querySelector('[data-slot="sidebar-questions-count"]')?.textContent
    await waitFor(() => expect(count()).toBe('2'))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(within(card('Design')).getByRole('button', { name: 'Dismiss «Design»' }))
    expect(screen.queryByRole('group', { name: 'Design' })).toBeNull()
    expect(count()).toBe('1')
    expect(screen.getByText('Dismissed «Design». Undo available for 6 seconds.')).toBeTruthy()
    // Focus went to the next card's first option.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(document.activeElement?.closest('[data-question-key]')?.getAttribute('data-question-key')).toBe('r:alpha:run1:ask_1')
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS - 100) })
    expect(posts).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    await waitFor(() => expect(posts).toEqual([{ path: 'dismiss m:global:m1', body: undefined }]))
  })

  it('Undo cancels the dismissal: nothing is sent and the card comes back', async () => {
    data.open = [managerItem('m1', 'Design')]
    renderPage()
    await screen.findByRole('group', { name: 'Design' })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(within(card('Design')).getByRole('button', { name: 'Dismiss «Design»' }))
    expect(screen.getByRole('heading', { name: 'No questions waiting' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS * 2) })
    expect(posts).toEqual([])
    expect(card('Design')).toBeTruthy()
  })

  it('the undo window pauses while focus is inside the toast', async () => {
    data.open = [managerItem('m1', 'Design')]
    renderPage()
    await screen.findByRole('group', { name: 'Design' })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(within(card('Design')).getByRole('button', { name: 'Dismiss «Design»' }))
    const undo = screen.getByRole('button', { name: 'Undo' })
    fireEvent.focus(undo)
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS * 2) })
    expect(posts).toEqual([])
    fireEvent.blur(undo)
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS) })
    await waitFor(() => expect(posts).toHaveLength(1))
  })

  it('a stale card sorts last in its group with the amber note and Dismiss as out of date', async () => {
    data.open = [
      managerItem('m1', 'Base', { askedAt: ago(3 * HOUR), stale: { why: 'replied-in-chat', detail: 'you replied 4m after it was asked', since: ago(HOUR) } }),
      managerItem('m2', 'Design'),
    ]
    renderPage()
    const group = await screen.findByRole('region', { name: 'Global' })
    expect([...group.querySelectorAll('[data-slot="question-card"]')].map((row) => row.getAttribute('aria-label'))).toEqual(['Design', 'Base'])
    expect(within(card('Base')).getByText('May be out of date: you replied 4m after it was asked')).toBeTruthy()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(within(card('Base')).getByRole('button', { name: 'Dismiss as out of date' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS + 10) })
    await waitFor(() => expect(posts.map((post) => post.path)).toEqual(['dismiss m:global:m1']))
  })

  it('Older is a fold, not counted, and its toggle writes questions.olderAfterDays', async () => {
    data.open = [managerItem('m1', 'Design'), taskItem('ask_1', 'Storage', { askedAt: ago(10 * 24 * HOUR), older: true })]
    renderPage()
    await screen.findByRole('group', { name: 'Design' })
    expect(screen.queryByRole('group', { name: 'Storage' })).toBeNull()
    expect(document.querySelector('[data-slot="sidebar-questions-count"]')?.textContent).toBe('1')
    const older = screen.getByRole('button', { name: /Older · 1/ })
    expect(older.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(older)
    expect(card('Storage')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Move to Older after' }))
    await waitFor(() => expect(posts).toContainEqual({ path: 'ui-state', body: { questions: { olderAfterDays: 0 } } }))
    // Off: nothing is Older, so both count again.
    await waitFor(() => expect(document.querySelector('[data-slot="sidebar-questions-count"]')?.textContent).toBe('2'))
  })

  it('Closed lists each reason with its detail and a link to the source task', async () => {
    data.closed = [
      taskItem('ask_2', 'Retry', { closed: { reason: 'ended', at: ago(HOUR), detail: '“Fix relay reconnect loop” was cancelled.' } }),
      managerItem('m3', 'Release', { closed: { reason: 'retracted', at: ago(HOUR), detail: '#2280 merged, so the question is moot.' } }),
      managerItem('m4', 'Merge', { sourceTasks: [{ projectId: 'alpha', runId: 'run7' }], closed: { reason: 'expired', at: ago(HOUR), detail: 'PR #2290 was merged' } }),
      managerItem('m5', 'Design', { closed: { reason: 'replaced', at: ago(HOUR), replacedBy: 'm9' } }),
    ]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Closed · 4/ }))
    const rows = document.querySelectorAll('[data-slot="question-closed"]')
    expect([...rows].map((row) => row.querySelector('[data-slot="question-closed-reason"]')?.textContent)).toEqual(['Task ended', 'Withdrawn', 'Expired', 'Replaced'])
    expect(rows[0]!.textContent).toContain('was cancelled')
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe('/p/alpha/tasks/run1/chat')
    expect(within(rows[2] as HTMLElement).getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe('/p/alpha/tasks/run7/chat')
    expect(rows[0]!.querySelector('s')?.textContent).toBe('Retry?')
  })

  it('a linked pair shows once, under the task, with the “also in” chip to the manager’s card', async () => {
    data.open = [taskItem('ask_1', 'Storage', { linked: { key: 'm:global:m7', source: { kind: 'manager', managerId: 'global', name: 'Global' } } })]
    renderPage()
    const chip = await screen.findByRole('link', { name: 'also in Global’s chat' })
    expect(chip.getAttribute('href')).toBe('/manager/global#decision-m7')
    expect(screen.getAllByRole('region').map((group) => group.getAttribute('aria-label'))).toEqual(['Migrate push tokens'])
  })

  it('a manager question that names tasks shows the Source task block', async () => {
    data.open = [managerItem('m1', 'Design', { sourceTasks: [{ projectId: 'alpha', runId: 'run7' }] })]
    renderPage()
    const sources = await waitFor(() => {
      const found = card('Design').querySelector('[data-slot="decision-sources"]')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    expect(within(sources).getByRole('link', { name: /Inspect task/ }).getAttribute('href')).toBe('/p/alpha/tasks/run7/chat#latest')
  })

  it('serves /questions with managers off, without the approvals chip', async () => {
    data.open = [taskItem('ask_1', 'Storage')]
    renderPage({ managers: false, entry: '/questions' })
    expect(await screen.findByRole('group', { name: 'Storage' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /approvals waiting/ })).toBeNull()
  })
})

describe('question helpers', () => {
  it('closedLabel names where a linked copy was answered', () => {
    expect(closedLabel({ reason: 'answered', at: '', answeredIn: 'task:alpha/run1' })).toBe('Answered in the task')
    expect(closedLabel({ reason: 'answered', at: '', answeredIn: 'manager:global' }, () => 'Scout')).toBe('Answered in Scout’s chat')
    expect(closedLabel({ reason: 'retracted', at: '' })).toBe('Withdrawn')
  })

  it('questionContextHref escapes ids and points a task at its open ask', () => {
    expect(questionContextHref(managerItem('a b', 'X'))).toBe('/manager/global#decision-a%20b')
    expect(questionContextHref(taskItem('ask_1', 'X'))).toBe('/p/alpha/tasks/run1/chat#ask')
  })

  it('groupQuestions keeps one group per source', () => {
    const groups = groupQuestions([managerItem('m1', 'A'), taskItem('r1', 'B'), managerItem('m2', 'C')])
    expect(groups.map((group) => [group.key, group.items.length])).toEqual([['manager:global', 2], ['task:alpha/run1', 1]])
  })
})
