import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { managerKeys } from '@/api/managers'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { applyQuestionCounts, DISMISS_UNDO_MS, questionKeys, resetDismissals } from '@/api/questions'
import { FADE_MS as FADE, IDLE_MS, LINGER_MS } from '@/routes/manager/approvals-linger'
import { managerFixture } from '@/routes/manager/manager-fixtures'
import { ManagerSidebar } from '@/routes/manager/manager-sidebar'
import type { QuestionItem, QuestionsResponse } from '@open-mercato/cezar-api-client'

import { answerShown, closedLabel, groupQuestions, questionContextHref, QuestionsRoute } from './questions-route'

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
let dismissStatus = 200
/** Holds the answer POST open until released, so the in-flight card can be inspected. */
let answerGate: Promise<void> | undefined
let dismissGate: Promise<void> | undefined
let managerList = [managerFixture({ pendingActions: 2 })]
/** Managers the server holds inactive: their cards stay listed but leave `live` (spec 2026-11-19-manager-deactivate). */
let inactiveIds = new Set<string>()

function respond(): QuestionsResponse {
  const live = data.open.filter((item) => !item.older && !(item.source.kind === 'manager' && inactiveIds.has(item.source.managerId))).length
  return { ...data, counts: { live, older: data.open.length - live } }
}

beforeEach(() => {
  data = { open: [], closed: [], counts: { live: 0, older: 0 }, olderAfterDays: 7 }
  posts.length = 0
  answerStatus = 200
  dismissStatus = 200
  answerGate = undefined
  dismissGate = undefined
  managerList = [managerFixture({ pendingActions: 2 })]
  inactiveIds = new Set()
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    if (url.pathname === '/api/v1/workspace/questions') return Response.json(respond())
    const verb = /\/workspace\/questions\/([^/]+)\/(answer|dismiss)$/.exec(url.pathname)
    if (verb) {
      const key = decodeURIComponent(verb[1]!)
      posts.push({ path: `${verb[2]} ${key}`, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (verb[2] === 'answer' && answerGate) await answerGate
      if (verb[2] === 'dismiss' && dismissGate) await dismissGate
      if (verb[2] === 'dismiss' && dismissStatus !== 200) return Response.json({ error: 'the store is read-only' }, { status: dismissStatus })
      if (verb[2] === 'answer' && answerStatus !== 200) return Response.json({ error: answerStatus === 409 ? 'already closed' : 'the agent session is gone' }, { status: answerStatus })
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
    if (url.pathname.endsWith('/managers')) return Response.json({ managers: managerList })
    return Response.json({})
  }))
})
afterEach(() => {
  cleanup()
  resetDismissals()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderPage({ managers = true, entry = '/manager/questions', client: reuse, list }: { managers?: boolean; entry?: string; client?: QueryClient; list?: typeof managerList } = {}) {
  // `list` is what the server's manager list answers too, so a refetch keeps it.
  if (list) managerList = list
  const client = reuse ?? new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (!reuse) {
    client.setQueryData(queryKeys.health, { capabilities: { managers, localHandoff: true } })
    client.setQueryData(managerKeys.list, { managers: managerList })
    client.setQueryData(workspaceQueryKeys.projects, { projects: [{ id: 'alpha', name: 'Alpha' }], bootProject: null, projectsDir: '' })
    client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [] })
    client.setQueryData(workspaceQueryKeys.uiState, {})
  }
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

  it('answers in place: the card stays locked with the answer, then lingers 30 s and leaves', async () => {
    data.open = [managerItem('m1', 'Design'), managerItem('m2', 'Budget', { askedAt: ago(10 * 60_000) })]
    renderPage()
    const yes = within(await screen.findByRole('group', { name: 'Design' })).getByRole('button', { name: 'Yes' })
    yes.focus()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(yes)
    await waitFor(() => expect(within(card('Design')).getByText('Sent to Global Manager')).toBeTruthy())
    expect(posts).toEqual([{ path: 'answer m:global:m1', body: { text: 'Design: Yes' } }])
    const outcome = card('Design').querySelector('[data-slot="question-outcome"]')!
    expect(outcome.textContent).toContain('Answered: Yes')
    expect(within(card('Design')).getByRole('img', { name: 'Delivered' })).toBeTruthy()
    // Locked: no chips, no Dismiss; the focus the chip held moved to the outcome.
    expect(within(card('Design')).queryByRole('button', { name: 'Yes' })).toBeNull()
    expect(within(card('Design')).queryByRole('button', { name: /Dismiss/ })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(outcome))
    expect(screen.getByText('Answered «Design».')).toBeTruthy()
    // A lingering card is not counted.
    expect(screen.getByText('1 question waiting, from 1 manager')).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(LINGER_MS - 1_000) })
    expect(card('Design').getAttribute('data-lingering')).toBe('shown')
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(card('Design').getAttribute('data-lingering')).toBe('leaving')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(screen.queryByRole('group', { name: 'Design' })).toBeNull()
    // Focus held by the leaving card goes to the next answerable one.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(document.activeElement?.closest('[data-question-key]')?.getAttribute('data-question-key')).toBe('m:global:m2')
    fireEvent.click(screen.getByRole('button', { name: /Closed · 1/ }))
    expect(document.querySelector('[data-slot="question-closed-reason"]')?.textContent).toBe('Answered')
  })

  it('a leaving card in the middle hands focus to its nearest neighbour, never the top of the page', async () => {
    data.open = [
      managerItem('m1', 'Alpha', { askedAt: ago(40 * 60_000) }),
      managerItem('m2', 'Bravo', { askedAt: ago(30 * 60_000) }),
      managerItem('m3', 'Charlie', { askedAt: ago(20 * 60_000) }),
      managerItem('m4', 'Delta', { askedAt: ago(10 * 60_000) }),
    ]
    renderPage()
    await screen.findByRole('group', { name: 'Charlie' })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const focusedKey = () => document.activeElement?.closest('[data-question-key]')?.getAttribute('data-question-key')
    const answerAndLinger = async (name: string) => {
      const yes = within(card(name)).getByRole('button', { name: 'Yes' })
      yes.focus()
      fireEvent.click(yes)
      await waitFor(() => expect(within(card(name)).getByRole('img', { name: 'Delivered' })).toBeTruthy())
      await waitFor(() => expect(document.activeElement).toBe(card(name).querySelector('[data-slot="question-outcome"]')))
      await act(async () => { await vi.advanceTimersByTimeAsync(LINGER_MS + 10) })
      expect(screen.queryByRole('group', { name })).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    }
    // Third of four: the next card down.
    await answerAndLinger('Charlie')
    expect(focusedKey()).toBe('m:global:m4')
    // Now the last card: the one just above it, not Alpha at the top.
    await answerAndLinger('Delta')
    expect(focusedKey()).toBe('m:global:m2')
  })

  describe('a lingering card leaves only when the reader is idle', () => {
    const answerDesign = async () => {
      data.open = [managerItem('m1', 'Design', { askedAt: ago(20 * 60_000) }), managerItem('m2', 'Budget', { askedAt: ago(10 * 60_000) })]
      renderPage()
      fireEvent.click(within(await screen.findByRole('group', { name: 'Design' })).getByRole('button', { name: 'Yes' }))
      await waitFor(() => expect(within(card('Design')).getByRole('img', { name: 'Delivered' })).toBeTruthy())
    }
    const listRegion = () => document.querySelector<HTMLElement>('[data-slot="questions-list"]')!
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
    const present = () => screen.queryByRole('group', { name: 'Design' }) !== null

    it('not while the pointer is over the list', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      await answerDesign()
      fireEvent.pointerEnter(listRegion())
      await advance(LINGER_MS + 5_000)
      expect(present()).toBe(true)
      expect(card('Design').getAttribute('data-lingering')).toBe('shown')
      fireEvent.pointerLeave(listRegion())
      // The held-back removal looks again within half a second, then collapses.
      await advance(500 + FADE)
      expect(present()).toBe(false)
    })

    it('not while focus is on another card in the list', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      await answerDesign()
      within(card('Budget')).getByRole('button', { name: 'No' }).focus()
      await advance(LINGER_MS + 5_000)
      expect(present()).toBe(true)
      screen.getByRole('heading', { name: 'Questions' }).focus()
      await advance(1_000)
      expect(present()).toBe(false)
    })

    it('not within 3 s of a scroll or a key', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      await answerDesign()
      await advance(LINGER_MS - 2_000)
      fireEvent.scroll(window)
      await advance(2_500)
      expect(present()).toBe(true)
      fireEvent.keyDown(document.body, { key: 'ArrowDown' })
      await advance(IDLE_MS - 200)
      expect(present()).toBe(true)
      expect(card('Design').getAttribute('data-lingering')).toBe('shown')
      await advance(600)
      await advance(FADE)
      expect(present()).toBe(false)
    })

    it.each([false, true])('a card above the view leaves at once and the scroll keeps the reader’s place (reduced motion: %s)', async (reduced) => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: reduced && query.includes('reduce'), media: query, onchange: null,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
      }))
      vi.useFakeTimers({ shouldAdvanceTime: true })
      await answerDesign()
      const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect
      // Design sits 300 px above the view; everything after it moves up by its 200 px once it's gone.
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        if (this.closest('[data-linger-key]')?.getAttribute('data-linger-key') === 'm:global:m1') return box(-300, 200)
        return box(document.querySelector('[data-question-key="m:global:m1"]') ? 300 : 100, 100)
      })
      vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) { return [this.getBoundingClientRect()] as unknown as DOMRectList })
      const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
      await advance(LINGER_MS - 400)
      expect(present()).toBe(true)
      await advance(500)
      expect(present()).toBe(false)
      expect(scrollBy).toHaveBeenCalledWith(0, -200)
    })

    it('reduced motion: a visible card leaves at 30 s with no collapse', async () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('reduce'), media: query, onchange: null,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
      }))
      vi.useFakeTimers({ shouldAdvanceTime: true })
      await answerDesign()
      await advance(LINGER_MS - 100)
      expect(card('Design').getAttribute('data-lingering')).toBe('shown')
      await advance(200)
      expect(present()).toBe(false)
    })

    it('a visible card collapses before it leaves, with the gap before it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      await answerDesign()
      await advance(LINGER_MS - 200)
      const wrapper = card('Design').closest<HTMLElement>('[data-linger-key]')!
      expect(wrapper.dataset.leaving).toBe('collapse')
      expect(wrapper.className).toContain('grid-rows-[0fr]')
      await advance(300)
      expect(present()).toBe(false)
    })
  })

  it('counts drop on the click: the Questions badge and the manager’s “Waiting for N answers”', async () => {
    managerList = [managerFixture({ pendingQuestions: 2 })]
    data.open = [managerItem('m1', 'Design'), managerItem('m2', 'Budget')]
    let release!: () => void
    answerGate = new Promise((resolve) => { release = resolve })
    renderPage()
    const count = () => document.querySelector('[data-slot="sidebar-questions-count"]')?.textContent
    await waitFor(() => expect(count()).toBe('2'))
    expect(screen.getAllByText('Waiting for 2 answers').length).toBeGreaterThan(0)
    fireEvent.click(within(card('Design')).getByRole('button', { name: 'Yes' }))
    // Still in flight: locked, no ✓ yet, and already not counted.
    expect(await within(card('Design')).findByText('Sending to Global Manager…')).toBeTruthy()
    expect(within(card('Design')).queryByRole('img', { name: 'Delivered' })).toBeNull()
    expect(count()).toBe('1')
    expect(screen.getAllByText('Waiting for your answer').length).toBeGreaterThan(0)
    managerList = [managerFixture({ pendingQuestions: 1 })]
    release()
    expect(await within(card('Design')).findByRole('img', { name: 'Delivered' })).toBeTruthy()
    await waitFor(() => expect(count()).toBe('1'))
  })

  it('a failed delivery hands the card back, answerable, with the error; counts come back', async () => {
    managerList = [managerFixture({ pendingQuestions: 1 })]
    data.open = [managerItem('m1', 'Design')]
    answerStatus = 500
    renderPage()
    const count = () => document.querySelector('[data-slot="sidebar-questions-count"]')?.textContent
    await waitFor(() => expect(count()).toBe('1'))
    fireEvent.click(within(card('Design')).getByRole('button', { name: 'Yes' }))
    expect(await within(card('Design')).findByText(/the agent session is gone/)).toBeTruthy()
    expect(within(card('Design')).getByRole('button', { name: 'Yes' })).toBeTruthy()
    expect(card('Design').getAttribute('data-state')).toBe('open')
    expect(count()).toBe('1')
    expect(screen.getByText(/Your answer to «Design» was not delivered/)).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText('Waiting for your answer').length).toBeGreaterThan(0))
  })

  it('a failed delivery from the keyboard puts focus back on the card’s answer, mid-list', async () => {
    data.open = [
      managerItem('m1', 'Alpha', { askedAt: ago(30 * 60_000) }),
      managerItem('m2', 'Bravo', { askedAt: ago(20 * 60_000) }),
      managerItem('m3', 'Charlie', { askedAt: ago(10 * 60_000) }),
    ]
    answerStatus = 500
    renderPage()
    const yes = within(await screen.findByRole('group', { name: 'Bravo' })).getByRole('button', { name: 'Yes' })
    yes.focus()
    fireEvent.click(yes)
    expect(await within(card('Bravo')).findByText(/the agent session is gone/)).toBeTruthy()
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-pressed')).not.toBeNull())
    expect(document.activeElement?.closest('[data-question-key]')?.getAttribute('data-question-key')).toBe('m:global:m2')
    expect(screen.getByText(/Your answer to «Bravo» was not delivered/)).toBeTruthy()
  })

  it('a failed one-tap answer puts focus back on the option sent, so Enter retries that same option', async () => {
    data.open = [managerItem('m1', 'Alpha', { askedAt: ago(30 * 60_000) }), managerItem('m2', 'Bravo', { askedAt: ago(20 * 60_000) })]
    answerStatus = 500
    renderPage()
    const no = within(await screen.findByRole('group', { name: 'Bravo' })).getByRole('button', { name: 'No' })
    no.focus()
    fireEvent.click(no)
    expect(await within(card('Bravo')).findByText(/the agent session is gone/)).toBeTruthy()
    await waitFor(() => expect(document.activeElement?.textContent).toBe('No'))
    expect(document.activeElement?.closest('[data-question-key]')?.getAttribute('data-question-key')).toBe('m:global:m2')
    // Enter on the restored chip: the same answer again, and it comes back to the same chip.
    fireEvent.click(document.activeElement!)
    await waitFor(() => expect(posts.filter((post) => post.path === 'answer m:global:m2')).toHaveLength(2))
    expect(posts.filter((post) => post.path === 'answer m:global:m2').map((post) => post.body)).toEqual([{ text: 'Bravo: No' }, { text: 'Bravo: No' }])
    await waitFor(() => expect(card('Bravo').getAttribute('data-state')).toBe('open'))
    await waitFor(() => expect(document.activeElement?.textContent).toBe('No'))
  })

  it('a failed answer leaves focus alone when the user moved it elsewhere meanwhile', async () => {
    data.open = [managerItem('m1', 'Alpha', { askedAt: ago(30 * 60_000) }), managerItem('m2', 'Bravo', { askedAt: ago(20 * 60_000) })]
    answerStatus = 500
    let release!: () => void
    answerGate = new Promise((resolve) => { release = resolve })
    renderPage()
    const no = within(await screen.findByRole('group', { name: 'Bravo' })).getByRole('button', { name: 'No' })
    no.focus()
    fireEvent.click(no)
    await within(card('Bravo')).findByText(/Sending to/)
    const elsewhere = within(card('Alpha')).getByRole('button', { name: 'Yes' })
    elsewhere.focus()
    release()
    expect(await within(card('Bravo')).findByText(/the agent session is gone/)).toBeTruthy()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('a 409 announces that the question closed first', async () => {
    data.open = [managerItem('m1', 'Design')]
    answerStatus = 409
    renderPage()
    fireEvent.click(within(await screen.findByRole('group', { name: 'Design' })).getByRole('button', { name: 'Yes' }))
    expect(await screen.findByText('«Design» closed before your answer arrived.')).toBeTruthy()
  })

  it('coming back after answering shows the card already gone, under Closed', async () => {
    data.open = [managerItem('m1', 'Design')]
    const client = renderPage()
    fireEvent.click(within(await screen.findByRole('group', { name: 'Design' })).getByRole('button', { name: 'Yes' }))
    await waitFor(() => expect(within(card('Design')).getByRole('img', { name: 'Delivered' })).toBeTruthy())
    cleanup()
    renderPage({ client })
    expect(await screen.findByRole('heading', { name: 'No questions waiting' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Design' })).toBeNull()
    expect(screen.getByRole('button', { name: /Closed · 1/ })).toBeTruthy()
  })

  it('a question the system closes while on screen shows why, in place, then lingers', async () => {
    data.open = [managerItem('m1', 'Design'), taskItem('ask_1', 'Storage')]
    const client = renderPage()
    await screen.findByRole('group', { name: 'Design' })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const [design] = data.open
    data = { ...data, open: data.open.slice(1), closed: [{ ...design!, closed: { reason: 'replaced', at: new Date().toISOString(), replacedBy: 'm9' } }] }
    await act(async () => { await client.invalidateQueries({ queryKey: questionKeys.all }) })
    const outcome = await waitFor(() => {
      const found = card('Design').querySelector('[data-slot="question-outcome"]')
      expect(found?.getAttribute('data-reason')).toBe('replaced')
      return found!
    })
    expect(outcome.textContent).toContain('Replaced')
    expect(outcome.textContent).toContain('A newer “Design” question replaced this one.')
    expect(screen.getByText('1 question waiting, from 1 task')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(LINGER_MS + 10) })
    expect(screen.queryByRole('group', { name: 'Design' })).toBeNull()
  })

  it('dismiss shows “Dismissed” with Undo in place, POSTs after 6 s, then lingers; counts drop at once', async () => {
    managerList = [managerFixture({ pendingQuestions: 1 })]
    data.open = [managerItem('m1', 'Design'), taskItem('ask_1', 'Storage')]
    renderPage()
    await screen.findByRole('group', { name: 'Design' })
    const count = () => document.querySelector('[data-slot="sidebar-questions-count"]')?.textContent
    await waitFor(() => expect(count()).toBe('2'))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(within(card('Design')).getByRole('button', { name: 'Dismiss «Design»' }))
    expect(within(card('Design')).getByText('Dismissed «Design»')).toBeTruthy()
    expect(within(card('Design')).getByRole('button', { name: 'Undo' })).toBeTruthy()
    expect(count()).toBe('1')
    // The manager list's change reaches the sidebar on the query cache's next tick.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryAllByText('Waiting for your answer')).toEqual([])
    expect(screen.getByText('Dismissed «Design». Undo available for 6 seconds.')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS - 100) })
    expect(posts).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    await waitFor(() => expect(posts).toEqual([{ path: 'dismiss m:global:m1', body: undefined }]))
    await waitFor(() => expect(card('Design').querySelector('[data-slot="question-outcome"]')?.getAttribute('data-reason')).toBe('dismissed'))
    expect(card('Design').textContent).toContain('Dismissed')
    expect(within(card('Design')).queryByRole('button', { name: 'Undo' })).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(LINGER_MS + 10) })
    expect(screen.queryByRole('group', { name: 'Design' })).toBeNull()
    expect(card('Storage')).toBeTruthy()
  })

  it('a live count that lands while the dismissal is sent keeps the badge true and the card on “Dismissed”', async () => {
    data.open = [managerItem('m1', 'Design'), taskItem('ask_1', 'Storage')]
    const client = renderPage()
    await screen.findByRole('group', { name: 'Design' })
    const count = () => document.querySelector('[data-slot="sidebar-questions-count"]')?.textContent
    await waitFor(() => expect(count()).toBe('2'))
    const seen: Array<string | undefined> = []
    const observer = new MutationObserver(() => seen.push(count()))
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })
    let release!: () => void
    dismissGate = new Promise((resolve) => { release = resolve })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(within(card('Design')).getByRole('button', { name: 'Dismiss «Design»' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS + 10) })
    await waitFor(() => expect(posts).toEqual([{ path: 'dismiss m:global:m1', body: undefined }]))
    // The server already counted it off; the list re-read is slower than the frame.
    await act(async () => { applyQuestionCounts(client, { live: 1, older: 0 }); await vi.advanceTimersByTimeAsync(0) })
    expect(within(card('Design')).getByRole('button', { name: 'Undo' })).toBeTruthy()
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(50) })
    await waitFor(() => expect(card('Design').querySelector('[data-slot="question-outcome"]')?.getAttribute('data-reason')).toBe('dismissed'))
    observer.disconnect()
    expect(seen.filter((value) => value !== undefined && Number(value) < 1)).toEqual([])
    expect(count()).toBe('1')
  })

  it('a card closed elsewhere during its undo window shows why, not Undo', async () => {
    data.open = [managerItem('m1', 'Design'), taskItem('ask_1', 'Storage')]
    const client = renderPage()
    await screen.findByRole('group', { name: 'Design' })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(within(card('Design')).getByRole('button', { name: 'Dismiss «Design»' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(within(card('Design')).getByRole('button', { name: 'Undo' })).toBeTruthy()
    const [design] = data.open
    data = { ...data, open: data.open.slice(1), closed: [{ ...design!, closed: { reason: 'replaced', at: new Date().toISOString(), replacedBy: 'm9' } }] }
    await act(async () => { await client.invalidateQueries({ queryKey: questionKeys.all }) })
    await waitFor(() => expect(card('Design').querySelector('[data-slot="question-outcome"]')?.getAttribute('data-reason')).toBe('replaced'))
    expect(within(card('Design')).queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('a dismissal that fails gives the manager its “Waiting for N answers” back', async () => {
    managerList = [managerFixture({ pendingQuestions: 1 })]
    data.open = [managerItem('m1', 'Design')]
    dismissStatus = 500
    renderPage()
    await screen.findByRole('group', { name: 'Design' })
    await waitFor(() => expect(screen.getAllByText('Waiting for your answer').length).toBeGreaterThan(0))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(within(card('Design')).getByRole('button', { name: 'Dismiss «Design»' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryAllByText('Waiting for your answer')).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS + 100) })
    expect(await screen.findByText(/Couldn’t dismiss «Design»/)).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText('Waiting for your answer').length).toBeGreaterThan(0))
  })

  it('Undo cancels the dismissal: nothing is sent and the card comes back', async () => {
    data.open = [managerItem('m1', 'Design')]
    renderPage()
    await screen.findByRole('group', { name: 'Design' })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(within(card('Design')).getByRole('button', { name: 'Dismiss «Design»' }))
    expect(screen.getByText('Nothing waiting on you')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS * 2) })
    expect(posts).toEqual([])
    expect(within(card('Design')).getByRole('button', { name: 'Yes' })).toBeTruthy()
  })

  it('a stale tab: answering a question that closed meanwhile says so and refetches', async () => {
    data.open = [managerItem('m1', 'Design')]
    answerStatus = 409
    renderPage()
    fireEvent.click(within(await screen.findByRole('group', { name: 'Design' })).getByRole('button', { name: 'Yes' }))
    expect(await screen.findByText('This question closed before your answer arrived.')).toBeTruthy()
  })

  it('the undo window pauses while focus is on the card’s Undo', async () => {
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

  // Leaving the page while focus is on Undo fires no blur: the paused clock must restart.
  it('a dismissal paused by focus still lands after the page unmounts', async () => {
    data.open = [managerItem('m1', 'Design')]
    renderPage()
    await screen.findByRole('group', { name: 'Design' })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(within(card('Design')).getByRole('button', { name: 'Dismiss «Design»' }))
    fireEvent.focus(screen.getByRole('button', { name: 'Undo' }))
    cleanup()
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS) })
    await waitFor(() => expect(posts).toEqual([{ path: 'dismiss m:global:m1', body: undefined }]))
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

describe('references on the Questions page (#2306)', () => {
  const chipsIn = (root: Element) => root.querySelectorAll('[data-slot="pr-chip"], [data-slot="issue-chip"]')
  const asked = {
    header: '2902 + 2894',
    question: 'Should I assess [[pr:alpha/2902]] and alpha/2894, not 2895?',
    options: [{ label: 'Assess [[pr:alpha/2902]] (recommended)' }, { label: 'Skip' }],
  }

  it.each([['desktop', 1280], ['mobile', 375]])('paints a manager card’s markers and project/N as chips, never the header or a bare number (%s)', async (_label, width) => {
    vi.stubGlobal('innerWidth', width)
    data.open = [managerItem('m1', 'x', { questions: [asked] })]
    renderPage()
    const group = await screen.findByRole('group', { name: '2902 + 2894' })
    const question = within(group).getByRole('group', { name: /Should I assess/ })
    await waitFor(() => expect(chipsIn(question.querySelector('p')!)).toHaveLength(2))
    expect(question.querySelector('p')!.textContent).toContain('not 2895?')
    expect(group.textContent).not.toContain('[[')
    expect(group.textContent).toContain('2902 + 2894')
    expect(screen.getByRole('button', { name: 'Assess #2902 (recommended)' })).toBeTruthy()
  })

  it('leaves a project the manager is not connected to as words', async () => {
    data.open = [managerItem('m1', 'x', { questions: [{ header: 'Odd', question: 'Look at gamma/12 and [[pr:gamma/13]]?', options: [{ label: 'Yes' }, { label: 'No' }] }] })]
    renderPage()
    const group = await screen.findByRole('group', { name: 'Odd' })
    expect(chipsIn(group)).toHaveLength(0)
    expect(group.textContent).toContain('Look at gamma/12 and #13?')
  })

  it('paints chips in a closed row', async () => {
    data.closed = [managerItem('m1', 'x', { questions: [asked], closed: { reason: 'answered', at: new Date().toISOString(), answer: '2902 + 2894: Assess [[pr:alpha/2902]] (recommended)' } })]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Closed · 1/ }))
    const row = document.querySelector('[data-slot="question-closed"]')!
    await waitFor(() => expect(chipsIn(row)).toHaveLength(3))
    expect(row.textContent).not.toContain('[[')
    expect(row.textContent).toContain('2902 + 2894')
  })

  it('shows a task’s card as written', async () => {
    data.open = [taskItem('ask_1', 'Storage', { questions: [{ header: 'Storage', question: 'Merge alpha/12?', options: [{ label: 'Yes' }, { label: 'No' }] }] })]
    renderPage()
    const group = await screen.findByRole('group', { name: 'Storage' })
    expect(chipsIn(group)).toHaveLength(0)
    expect(group.textContent).toContain('Merge alpha/12?')
  })
})

describe('question helpers', () => {
  it('answerShown drops a lone header and cuts long text', () => {
    expect(answerShown(managerItem('m1', 'Design'), 'Design: Yes')).toBe('Yes')
    expect(answerShown({ questions: [{ header: 'A', question: '', options: [] }, { header: 'B', question: '', options: [] }] }, 'A: x\nB: y')).toBe('A: x · B: y')
    const long = answerShown(managerItem('m1', 'Design'), `Design: ${'w'.repeat(400)}`)
    expect(long.length).toBe(140)
    expect(long.endsWith('…')).toBe(true)
  })

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

describe('an inactive manager on the Questions page (spec 2026-11-19-manager-deactivate)', () => {
  const list = () => [managerFixture({ id: 'global', name: 'Global', inactive: { since: ago(HOUR) } })]

  it('keeps its group listed and flagged, and leaves it out of the badge with a +N note', async () => {
    inactiveIds = new Set(['global'])
    data.open = [managerItem('m1', 'Design'), taskItem('ask_1', 'Storage')]
    renderPage({ list: list() })
    const group = (await screen.findAllByRole('region')).find((region) => region.getAttribute('aria-label') === 'Global')!
    expect(group.dataset.inactive).toBe('true')
    expect(within(group).getByText('Manager · inactive')).toBeTruthy()
    expect(group.querySelector('[data-slot="manager-avatar-inactive"]')).not.toBeNull()
    expect(within(card('Design')).getByText('Manager inactive — answering reactivates it; dismissing does not')).toBeTruthy()
    expect(within(card('Storage')).queryByText(/Manager inactive/)).toBeNull()
    await waitFor(() => expect(document.querySelector('[data-slot="sidebar-questions-count"]')?.textContent).toBe('1'))
    expect(screen.getByText('+1 from inactive managers, not counted')).toBeTruthy()
    // The header counts what the sidebar badge counts: the task question only.
    expect(document.querySelector('[data-slot="questions-status"]')!.textContent).toBe('1 question waiting, from 1 task')
    expect(document.querySelector('[data-slot="sidebar-questions"]')!.getAttribute('title')).toBe('1 more from inactive managers, not counted')
  })

  it('asks before an answer wakes it: Cancel sends nothing, Reactivate and answer sends reactivate: true', async () => {
    inactiveIds = new Set(['global'])
    data.open = [managerItem('m1', 'Design')]
    renderPage({ list: list() })
    fireEvent.click(within(await screen.findByRole('group', { name: 'Design' })).getByRole('button', { name: 'Yes' }))
    let dialog = await screen.findByRole('alertdialog', { name: /Reactivate Global and answer\?/ })
    expect(within(dialog).getByText('“Design: Yes”')).toBeTruthy()
    expect(within(dialog).getByText('Dismiss')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(posts).toEqual([])
    fireEvent.click(within(card('Design')).getByRole('button', { name: 'Yes' }))
    dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reactivate and answer' }))
    await waitFor(() => expect(posts).toEqual([{ path: 'answer m:global:m1', body: { text: 'Design: Yes', reactivate: true } }]))
  })

  it('Cancel or Escape on the reactivate confirm puts focus back on the option pressed and says “Not sent”', async () => {
    inactiveIds = new Set(['global'])
    data.open = [managerItem('m1', 'Design')]
    renderPage({ list: list() })
    const no = within(await screen.findByRole('group', { name: 'Design' })).getByRole('button', { name: 'No' })
    no.focus()
    fireEvent.click(no)
    let dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(document.activeElement?.textContent).toBe('No'))
    expect(within(card('Design')).getByText(/Not sent: Global is still inactive/)).toBeTruthy()
    // Escape, from the restored chip.
    fireEvent.click(document.activeElement!)
    dialog = await screen.findByRole('alertdialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(document.activeElement?.textContent).toBe('No'))
    expect(within(card('Design')).getByText(/Not sent: Global is still inactive/)).toBeTruthy()
    expect(posts).toEqual([])
  })

  it('dismisses without asking and without counting it off the badge', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    inactiveIds = new Set(['global'])
    data.open = [managerItem('m1', 'Design'), taskItem('ask_1', 'Storage')]
    renderPage({ list: list() })
    fireEvent.click(within(await screen.findByRole('group', { name: 'Design' })).getByRole('button', { name: 'Dismiss «Design»' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    // Inside the undo window the badge still reads 1: the server never counted this card.
    await waitFor(() => expect(document.querySelector('[data-slot="sidebar-questions-count"]')?.textContent).toBe('1'))
    await act(async () => { vi.advanceTimersByTime(DISMISS_UNDO_MS + 10) })
    await waitFor(() => expect(posts).toEqual([{ path: 'dismiss m:global:m1', body: undefined }]))
  })
})
