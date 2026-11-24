import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workspaceQueryKeys } from '@/api/queries'
import { resetDismissals } from '@/api/questions'
import { supersededAskIds, type ManagerMessage } from '@open-mercato/cezar-api-client'

import { actionMessage, assistantMessage, userMessage } from './manager-fixtures'
import { answersShownOnCard, askAnswerLines, CommandsRow, ManagerChatActionsContext, ManagerMessageRow, PrTitlesContext, usePrTitles } from './manager-message'

const origin = { id: 'global', name: 'Global Manager' }

function Probe() {
  const location = useLocation()
  return <span data-testid="at">{`${location.pathname}|${JSON.stringify(location.state)}`}</span>
}

function renderMessage(message: ManagerMessage, onDecide = vi.fn(), projects?: ReadonlyArray<{ id: string; name?: string; repoUrl?: string }>, superseded = false, answerOnCard = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(workspaceQueryKeys.projects, { projects: projects ?? [], bootProject: 'alpha', projectsDir: '' })
  client.setQueryData(workspaceQueryKeys.runsIndex, {
    runs: [{ projectId: 'alpha', id: 'run-1', title: 'Session 123123', status: 'running', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z', diffStat: { adds: 87, dels: 12, files: 3 } }],
  })
  const ui = (next: ManagerMessage, nextSuperseded = superseded) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/manager/global']}>
        <Routes>
          <Route path="*" element={<><ManagerMessageRow message={next} origin={origin} onDecide={onDecide} superseded={nextSuperseded} answerOnCard={answerOnCard} {...(projects ? { projects } : {})} /><Probe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const { rerender } = render(ui(message))
  return Object.assign(onDecide, { rerender: (next: ManagerMessage, nextSuperseded = superseded) => rerender(ui(next, nextSuperseded)), client })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
  resetDismissals()
  vi.unstubAllGlobals()
})

describe('ManagerMessageRow', () => {
  it('puts the user in a bubble, verbatim', () => {
    renderMessage(userMessage(1, '**not markdown**'))
    expect(screen.getByText('**not markdown**')).toBeTruthy()
  })

  it('renders a session card with live status and stats, leading into the task with the way home', async () => {
    renderMessage(assistantMessage(2, { text: 'Status:\n\n[[task:alpha/run-1]]' }))
    const card = document.querySelector('[data-slot="session-card"]') as HTMLAnchorElement
    expect(card.textContent).toContain('Session 123123')
    expect(card.textContent).toContain('+87')
    expect(card.textContent).toContain('−12')
    expect(card.querySelector('[data-slot="status-dot"]')).not.toBeNull()
    expect(card.getAttribute('href')).toBe('/p/alpha/tasks/run-1')
    fireEvent.click(card)
    await waitFor(() => {
      expect(screen.getByTestId('at').textContent).toBe(
        '/p/alpha/tasks/run-1|{"manager":{"id":"global","name":"Global Manager"}}',
      )
    })
  })

  it('shows a task named mid-sentence as a card too, with its title in the sentence', () => {
    renderMessage(assistantMessage(2, { text: 'The spec task is running: [[task:alpha/run-1]]. More soon.' }))
    expect(document.querySelector('[data-slot="manager-task-chip"]')?.textContent).toBe('Session 123123')
    expect(document.querySelectorAll('[data-slot="session-card"]')).toHaveLength(1)
  })

  it('identifies a task-origin approval inside the approval card', () => {
    // run-1 carries no PR: a merge card names it only for a card about some other action.
    renderMessage(actionMessage(205, { action: { type: 'enable-automation', projectId: 'alpha', automationId: 'a1' }, sourceTasks: [{ projectId: 'alpha', runId: 'run-1' }] }))
    expect(document.querySelector('[data-slot="manager-action"] [data-slot="decision-sources"]')?.textContent).toContain('Session 123123')
    expect(screen.getByRole('link', { name: /Inspect task:/ }).getAttribute('href')).toBe('/p/alpha/tasks/run-1/chat#latest')
  })

  describe('question card', () => {
    const ask = { questions: [
      { header: 'Shell', question: 'Which shell?', options: [{ label: 'Capacitor (recommended)' }, { label: 'Tauri' }] },
      { header: 'Default', question: 'Open on Manager?', options: [{ label: 'No' }, { label: 'Yes' }] },
    ] }

    it('names the source inside a decision even when the reply omits its task reference', () => {
      renderMessage(assistantMessage(2, { text: 'Inspect report.html and shots/mobile.png before answering.', ask, sourceTasks: [{ projectId: 'alpha', runId: 'run-1' }] }), vi.fn(), [{ id: 'alpha', name: 'Cockpit' }])
      const source = document.querySelector('[data-slot="manager-ask"] [data-slot="decision-sources"]')!
      expect(source.textContent).toContain('Session 123123')
      expect(source.textContent).toContain('Cockpit')
      expect(screen.getByRole('link', { name: /Inspect task:/ }).getAttribute('href')).toBe('/p/alpha/tasks/run-1/chat#latest')
      expect(screen.getByRole('link', { name: 'shots/mobile.png' }).getAttribute('href')).toBe('/p/alpha/tasks/run-1/assets/shots%2Fmobile.png')
      expect(screen.getByRole('link', { name: 'report.html' }).getAttribute('href')).toBe('/p/alpha/tasks/run-1/assets/report.html')
    })

    it('retains an unanswered selection across a card remount', () => {
      const message = assistantMessage(202, { ask, sourceTasks: [{ projectId: 'alpha', runId: 'run-1' }] })
      renderMessage(message)
      fireEvent.click(screen.getByRole('button', { name: 'Capacitor (recommended)' }))
      cleanup()
      renderMessage(message)
      expect(screen.getByRole('button', { name: 'Capacitor (recommended)' }).getAttribute('aria-pressed')).toBe('true')
    })

    it('provides task and asset navigation for a missing task without blocking the answer', () => {
      renderMessage(assistantMessage(203, { ask, sourceTasks: [{ projectId: 'gone', runId: 'deleted-task' }] }))
      expect(screen.getByText(/Task unavailable or no longer listed/)).toBeTruthy()
      expect(screen.getByRole('link', { name: /Inspect task:/ }).getAttribute('href')).toContain('/p/gone/tasks/deleted-task/chat#latest')
      expect(screen.getByRole('button', { name: 'Capacitor (recommended)' })).toBeTruthy()
    })

    it('uses explicit task references on older messages and deduplicates sources', () => {
      renderMessage(assistantMessage(204, { text: '[[task:alpha/run-1]]', ask, sourceTasks: [{ projectId: 'alpha', runId: 'run-1' }] }))
      expect(document.querySelectorAll('[data-slot="decision-sources"] a')).toHaveLength(2)
    })

    it('sends every answer as one message', async () => {
      renderMessage(assistantMessage(2, { text: 'Two decisions.', ask }))
      const fetchMock = vi.mocked(fetch)
      fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      fireEvent.click(screen.getByRole('button', { name: 'Capacitor (recommended)' }))
      fireEvent.click(screen.getByRole('button', { name: 'No' }))
      fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      const init = fetchMock.mock.calls.at(-1)![1] as RequestInit
      expect(JSON.parse(String(init.body))).toEqual({ text: 'Shell: Capacitor (recommended)\nDefault: No', askId: 'm2', idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    })

    it('still answers a server older than askId, by resending the answer without it', async () => {
      renderMessage(assistantMessage(2, { text: 'Two decisions.', ask }))
      const fetchMock = vi.mocked(fetch)
      fetchMock
        .mockResolvedValueOnce(Response.json({ error: 'Unrecognized key: "askId"' }, { status: 400 }))
        .mockResolvedValueOnce(Response.json({ ok: true, attachments: 0 }))
      fireEvent.click(screen.getByRole('button', { name: 'Capacitor (recommended)' }))
      fireEvent.click(screen.getByRole('button', { name: 'No' }))
      fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)))
      expect(bodies).toEqual([
        { text: 'Shell: Capacitor (recommended)\nDefault: No', askId: 'm2', idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) },
        { text: 'Shell: Capacitor (recommended)\nDefault: No', idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      ])
      await waitFor(() => expect(document.querySelector('[data-slot="manager-ask"][data-resolved="true"]')).not.toBeNull())
      expect(document.body.textContent).not.toContain('Unrecognized key')
    })

    it('keeps the card open with its answer to send again when the server refuses for another reason', async () => {
      renderMessage(assistantMessage(2, { text: 'Two decisions.', ask }))
      const fetchMock = vi.mocked(fetch)
      fetchMock.mockResolvedValueOnce(Response.json({ error: 'manager not found' }, { status: 404 }))
      fireEvent.click(screen.getByRole('button', { name: 'Capacitor (recommended)' }))
      fireEvent.click(screen.getByRole('button', { name: 'No' }))
      fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
      await waitFor(() => expect(document.body.textContent).toContain('manager not found'))
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(document.querySelector('[data-slot="manager-ask"][data-resolved="false"]')).not.toBeNull()
      expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(false)
    })

    it('hands focus to the answered card when its own Send collapsed it', async () => {
      const message = assistantMessage(2, { text: 'Two decisions.', ask })
      const { rerender } = renderMessage(message)
      vi.mocked(fetch).mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      fireEvent.click(screen.getByRole('button', { name: 'Capacitor (recommended)' }))
      fireEvent.click(screen.getByRole('button', { name: 'No' }))
      const sendButton = screen.getByRole('button', { name: 'Send answer' })
      sendButton.focus()
      fireEvent.click(sendButton)
      await waitFor(() => expect(fetch).toHaveBeenCalled())
      rerender({ ...message, askAnswer: 'Shell: Capacitor (recommended)\nDefault: No' } as ManagerMessage)
      const answered = document.querySelector<HTMLElement>('[data-slot="manager-ask"][data-resolved="true"]')!
      await waitFor(() => expect(document.activeElement).toBe(answered))
      expect(answered.tabIndex).toBe(-1)
      expect(answered.className).toContain('focus-visible:ring-[3px]')
    })

    it('leaves focus alone for an answer typed in the composer', async () => {
      const message = assistantMessage(2, { text: 'Two decisions.', ask })
      const { rerender } = renderMessage(message)
      rerender({ ...message, askAnswer: 'Shell: Tauri' } as ManagerMessage)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(document.activeElement).toBe(document.body)
    })

    // Questions inbox: a closed card is one quiet line, never actionable.
    it('draws a replaced card as one quiet line with a link to the newer card', () => {
      renderMessage(assistantMessage(2, { text: 'v1', ask, askClosed: { reason: 'replaced', at: new Date().toISOString(), replacedBy: 'msg-9' } }))
      const closed = document.querySelector('[data-slot="ask-closed"]')!
      // Keeps its anchor: an older card's "Go to the newer question" may point here.
      expect(closed.id).toMatch(/^decision-/)
      expect(closed.getAttribute('data-reason')).toBe('replaced')
      expect(closed.textContent).toContain('Closed: replaced')
      expect(closed.querySelector('s')?.textContent).toBe('Which shell?')
      expect(screen.queryByRole('button', { name: 'Tauri' })).toBeNull()
      expect(screen.getByRole('link', { name: 'Go to the newer question ↓' }).getAttribute('href')).toBe('/manager/global#decision-msg-9')
    })

    it.each([
      ['dismissed', 'Closed: dismissed by you', 'The manager was told you skipped it.'],
      ['retracted', 'Closed: withdrawn by the manager', '#2280 merged'],
      ['expired', 'Closed: expired', '#2280 merged'],
    ] as const)('draws a %s card quietly with its reason', (reason, headline, detail) => {
      renderMessage(assistantMessage(2, { ask, askClosed: { reason, at: new Date().toISOString(), ...(reason === 'dismissed' ? {} : { detail: '#2280 merged' }) } }))
      const closed = document.querySelector('[data-slot="ask-closed"]')!
      expect(closed.querySelector('[data-slot="ask-closed-reason"]')?.textContent).toBe(headline)
      expect(closed.textContent).toContain(detail)
      expect(document.querySelector('[data-slot="manager-ask"][data-resolved="false"]')).toBeNull()
    })

    it('says a card answered in its task, with the answer and a way to the task', () => {
      renderMessage(assistantMessage(2, { ask, askClosed: { reason: 'answered', at: new Date().toISOString(), answeredIn: 'task:alpha/run-1', answer: 'Shell: Tauri' } }))
      const closed = document.querySelector('[data-slot="ask-closed"]')!
      expect(closed.textContent).toContain('Answered in the task')
      expect(closed.textContent).toContain('Shell: Tauri')
      expect(screen.getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe('/p/alpha/tasks/run-1/chat')
    })

    it('keeps a stale card open with the amber note; Dismiss as out of date holds it for undo', () => {
      renderMessage(assistantMessage(2, { ask, askStale: { why: 'replied-in-chat', detail: 'you replied 4m after it was asked', since: new Date().toISOString() } }))
      expect(screen.getByText('May be out of date: you replied 4m after it was asked')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Tauri' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss as out of date' }))
      expect(screen.getByText('Dismissed «Shell»')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Tauri' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      expect(screen.getByRole('button', { name: 'Tauri' })).toBeTruthy()
    })

    it('is the one card shape while open: a titled header with Open at the right, the form inside', () => {
      renderMessage(assistantMessage(2, { text: 'Two decisions.', ask }))
      const card = document.querySelector('[data-slot="manager-ask"][data-resolved="false"]')!
      expect(card.querySelector('[data-slot="manager-card-header"]')?.textContent).toBe('Your decisionOpen')
      expect(card.querySelector('[data-slot="manager-card-status"] [data-slot="status-dot"]')?.className).toContain('bg-info')
      // The form keeps its chips, "Other…" and "Need more info" per question included; its own
      // box and asker line fold into the card.
      expect(card.querySelector('[data-slot="ask-card"]')).not.toBeNull()
      expect(screen.getAllByRole('button', { name: 'Need more info' })).toHaveLength(2)
      expect(card.querySelector('[data-slot="manager-card-actions"]')).toBeNull()
    })

    it('collapses to what was answered, leaving the answer to the user message below', () => {
      renderMessage(assistantMessage(2, { text: 'Two decisions.', ask, askAnswer: 'Shell: Tauri' }))
      const card = document.querySelector('[data-slot="manager-ask"]')!
      expect(card.getAttribute('data-resolved')).toBe('true')
      // A back link to an answered decision still lands on it instead of paging all history.
      expect(card.id).toMatch(/^decision-/)
      expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
      expect(card.textContent).toBe('Answered:ShellDefault')
      expect([...card.querySelectorAll('[data-slot="manager-ask-topics"] [data-slot="chip"]')].map((chip) => chip.textContent)).toEqual(['Shell', 'Default'])
      expect(card.textContent).not.toContain('Tauri')
    })

    it('says each header and its answer when the answer is drawn on the card', () => {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <ManagerMessageRow
              message={assistantMessage(2, { text: 'Two decisions.', ask, askAnswer: 'Shell: Capacitor (recommended)\nDefault: No' })}
              origin={origin}
              onDecide={vi.fn()}
              answerOnCard
            />
          </MemoryRouter>
        </QueryClientProvider>,
      )
      const card = document.querySelector('[data-slot="manager-ask"][data-resolved="true"]')!
      expect([...card.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['Shell:', 'Default:'])
      // Every option is a chip; the chosen one wears the chip's `active` face and says so.
      const chosen = [...card.querySelectorAll('[data-slot="chip"][data-active="true"]')].map((chip) => chip.textContent)
      expect(chosen).toEqual(['Capacitor (recommended) (chosen)', 'No (chosen)'])
      expect([...card.querySelectorAll('[data-slot="chip"]:not([data-active])')].map((chip) => chip.textContent)).toEqual(['Tauri', 'Yes'])
      expect(screen.queryAllByRole('button')).toHaveLength(0)
    })

    it('renders a superseded card as the quiet replaced line, with no buttons', () => {
      renderMessage(assistantMessage(2, { text: 'Older decision.', ask }), vi.fn(), undefined, true)
      // History from before the server closed replaced cards draws the same quiet line (Questions inbox).
      const card = document.querySelector('[data-slot="ask-closed"]')!
      expect(card.querySelector('[data-slot="ask-closed-reason"]')?.textContent).toBe('Closed: replaced')
      expect(card.id).toBe('decision-m2')
      expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
      expect(screen.queryAllByRole('button')).toHaveLength(0)
    })

    it('locks the card immediately on send so it cannot send again', async () => {
      renderMessage(assistantMessage(2, { text: 'Choose now.', ask }))
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: true, attachments: 0 }))
      fireEvent.click(screen.getByRole('button', { name: 'Capacitor (recommended)' }))
      fireEvent.click(screen.getByRole('button', { name: 'No' }))
      const sendButton = screen.getByRole('button', { name: 'Send answer' })
      fireEvent.click(sendButton)
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      const resolved = document.querySelector('[data-slot="manager-ask"][data-resolved="true"]')
      expect(resolved).not.toBeNull()
      expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
    })

    describe('which answers the card draws', () => {
      const card = assistantMessage(2, { text: 'Two decisions.', ask, askAnswer: 'Shell: Tauri\nDefault: Yes' })
      const reply = (text: string, extra: object = {}) => ({ ...userMessage(3, text), ...extra }) as ManagerMessage

      it('reads a card answer back per question, and nothing else', () => {
        expect(askAnswerLines(ask, 'Shell: Tauri\nDefault: Yes')).toEqual([{ header: 'Shell', value: 'Tauri' }, { header: 'Default', value: 'Yes' }])
        expect(askAnswerLines(ask, 'just use tauri')).toBeNull()
        expect(askAnswerLines(ask, 'Shell: Tauri')).toBeNull()
        expect(askAnswerLines(ask, 'Default: Yes\nShell: Tauri')).toBeNull()
        expect(askAnswerLines(ask, 'Shell: \nDefault: Yes')).toBeNull()
      })

      it('takes the very next message when it is the card answer', () => {
        expect([...answersShownOnCard([userMessage(1), card, reply('Shell: Tauri\nDefault: Yes')])]).toEqual(['m3'])
      })

      it('leaves a typed reply, files, or a later message as their own bubbles', () => {
        const typed = { ...card, askAnswer: 'whatever is cheaper' } as ManagerMessage
        expect(answersShownOnCard([typed, reply('whatever is cheaper')]).size).toBe(0)
        const withFiles = reply('Shell: Tauri\nDefault: Yes', { attachments: [{ file: 'a.png' }] })
        expect(answersShownOnCard([card, withFiles]).size).toBe(0)
        expect(answersShownOnCard([card, assistantMessage(3), reply('Shell: Tauri\nDefault: Yes')]).size).toBe(0)
        expect(answersShownOnCard([card, reply('Shell: Capacitor (recommended)\nDefault: No')]).size).toBe(0)
        expect(answersShownOnCard([{ ...card, askAnswer: undefined } as ManagerMessage, reply('Shell: Tauri\nDefault: Yes')]).size).toBe(0)
      })
    })
  })

  it('dates every reply, a watch check included', () => {
    renderMessage(assistantMessage(2, { text: 'Hi', turn: 'watch' }))
    const meta = document.querySelector('[data-slot="manager-message-meta"]')
    expect(meta?.textContent).toContain('Watch check')
    expect(meta?.querySelector('time')?.getAttribute('datetime')).toBeTruthy()
  })

  it('shows a sent screenshot and offers a file for download, with no empty bubble', () => {
    renderMessage({
      ...userMessage(1, ''),
      attachments: [
        { file: 'pasted-1-a.png', mediaType: 'image/png' },
        { file: 'pasted-1-b.pdf', mediaType: 'application/pdf', name: 'plan.pdf' },
      ],
    } as ManagerMessage)
    const row = document.querySelector('[data-slot="manager-user"]') as HTMLElement
    expect(row.querySelector('p')).toBeNull()
    expect(row.querySelector('img')?.getAttribute('src')).toContain('/workspace/managers/global/attachments/pasted-1-a.png')
    const file = row.querySelector('[data-slot="manager-file"]') as HTMLAnchorElement
    expect(file.textContent).toBe('plan.pdf')
    expect(file.getAttribute('download')).toBe('plan.pdf')
  })

  it('marks what the manager judged important, with its headline', () => {
    renderMessage(assistantMessage(2, { text: 'It asks which shell.', important: true, headline: 'Blocked on you' }))
    expect(document.querySelector('[data-slot="manager-important"]')?.textContent).toBe('Blocked on you')
  })

  it('still offers a card for a run the index does not know', () => {
    renderMessage(assistantMessage(2, { text: '[[task:alpha/abcdef0123456]]' }))
    expect(document.querySelector('[data-slot="session-card"]')?.textContent).toContain('Task abcdef01')
  })

  it('paints a pull request and a bare number as the shared bubble, inside the sentence', async () => {
    const projects = [{ id: 'alpha', repoUrl: 'https://github.com/o/alpha' }]
    renderMessage(assistantMessage(2, { text: 'Merged [[pr:alpha/12]] for #1821 today.' }), vi.fn(), projects)
    const chip = await waitFor(() => {
      const found = document.querySelector('[data-slot="pr-chip"]')
      expect(found).not.toBeNull()
      return found as HTMLAnchorElement
    })
    expect(chip.textContent).toContain('#12')
    expect(chip.getAttribute('href')).toBe('https://github.com/o/alpha/pull/12')
    expect(chip.closest('p')?.textContent).toContain('Merged')
    expect(document.querySelector('[data-slot="issue-chip"]')?.getAttribute('href')).toBe('https://github.com/o/alpha/issues/1821')
  })

  it('names a pull request chip by the pull request, never by the manager', async () => {
    const projects = [{ id: 'alpha', name: 'Alpha', repoUrl: 'https://github.com/o/alpha' }]
    const { client } = renderMessage(assistantMessage(2, { text: 'Ready: [[pr:alpha/12]] and [[pr:alpha/13]].' }), vi.fn(), projects)
    client.setQueryData(workspaceQueryKeys.runsIndex, {
      runs: [{ projectId: 'alpha', id: 'run-9', title: 'Fix the login bug', status: 'review', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z', prNumber: 12 }],
    })
    const chips = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLAnchorElement>('[data-slot="pr-chip"]')]
      expect(found).toHaveLength(2)
      expect(found[0]!.getAttribute('aria-label')).toContain('Fix the login bug')
      return found
    })
    for (const chip of chips) expect(chip.getAttribute('aria-label')).not.toContain('Global Manager')
    expect(chips[0]!.getAttribute('aria-label')).toBe('Open the pull request for #12, Fix the login bug')
    expect(chips[1]!.getAttribute('aria-label')).toBe('Open the pull request for #13, Alpha')
  })

  describe('references inside a decision card', () => {
    const projects = [{ id: 'alpha', name: 'Alpha', repoUrl: 'https://github.com/o/alpha' }]
    const chipAsk = { questions: [
      {
        header: 'Dependabot',
        question: 'Start assessment tasks for [[pr:alpha/2897]] and [[pr:alpha/2896]]?',
        options: [
          { label: 'Assess [[pr:alpha/2897]] (recommended)', description: 'Opens a task for [[issue:alpha/41]] in [[task:alpha/run-1]]' },
          { label: 'Skip both' },
        ],
      },
    ] }

    it('paints markers in the question, a label and a description as the chat chips', () => {
      renderMessage(assistantMessage(2, { text: 'Two PRs.', ask: chipAsk }), vi.fn(), projects)
      const card = document.querySelector('[data-slot="manager-ask"]')!
      const question = card.querySelector('[role="group"] p')!
      expect([...question.querySelectorAll('[data-slot="pr-chip"]')].map((chip) => chip.getAttribute('href')))
        .toEqual(['https://github.com/o/alpha/pull/2897', 'https://github.com/o/alpha/pull/2896'])
      expect(question.textContent).not.toContain('[[')
      const option = card.querySelector('[data-slot="ask-choice"]')!
      expect(option.querySelector('[data-slot="pr-chip"]')?.getAttribute('href')).toBe('https://github.com/o/alpha/pull/2897')
      expect(option.querySelector('[data-slot="issue-chip"]')?.getAttribute('href')).toBe('https://github.com/o/alpha/issues/41')
      expect(option.querySelector('[data-slot="manager-task-chip"]')?.textContent).toBe('Session 123123')
      // The pick is still one button, named by what the label reads.
      expect(screen.getByRole('button', { name: 'Assess #2897 (recommended)' })).toBeTruthy()
      expect(card.textContent).not.toContain('[[')
    })

    it('opens a chip inside an option without picking the option', async () => {
      renderMessage(assistantMessage(2, { text: 'Two PRs.', ask: chipAsk }), vi.fn(), projects)
      const option = document.querySelector('[data-slot="ask-choice"]')!
      const chip = option.querySelector<HTMLAnchorElement>('[data-slot="pr-chip"]')!
      // The chip is not inside the button that picks, so its click can never reach it.
      expect(chip.closest('button')).toBeNull()
      const sent = () => vi.mocked(fetch).mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')
      fireEvent.click(chip)
      expect(sent()).toHaveLength(0)
      expect(option.querySelector('button')!.getAttribute('aria-pressed')).toBe('false')
      vi.mocked(fetch).mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
      fireEvent.click(screen.getByRole('button', { name: 'Assess #2897 (recommended)' }))
      await waitFor(() => expect(sent()).toHaveLength(1))
      expect(JSON.parse(String((sent()[0]![1] as RequestInit).body)).text).toBe('Dependabot: Assess [[pr:alpha/2897]] (recommended)')
    })

    it('resolves a bare #N against the only connected project, never a plain number', () => {
      const ask = { questions: [{ header: 'Merge', question: 'Merge PR #2897 now? It closes 2896.', options: [{ label: 'Yes' }, { label: 'No' }] }] }
      renderMessage(assistantMessage(2, { text: 'One PR.', ask }), vi.fn(), projects)
      const question = document.querySelector('[data-slot="manager-ask"] [role="group"] p')!
      const chips = question.querySelectorAll('[data-slot="pr-chip"], [data-slot="issue-chip"]')
      expect(chips).toHaveLength(1)
      expect(chips[0]!.getAttribute('data-slot')).toBe('pr-chip')
      expect(question.textContent).toContain('It closes 2896.')
    })

    it('falls back to the words for an unknown project or a malformed number', () => {
      const ask = { questions: [{ header: 'Odd', question: 'Look at [[pr:elsewhere/12]] and [[issue:alpha/abc]]?', options: [{ label: 'About [[task:elsewhere/abcdef1234]]' }, { label: 'No' }] }] }
      renderMessage(assistantMessage(2, { text: 'Hm.', ask }), vi.fn(), projects)
      const card = document.querySelector('[data-slot="manager-ask"]')!
      expect(card.querySelectorAll('[data-slot="pr-chip"], [data-slot="issue-chip"], [data-slot="manager-task-chip"]')).toHaveLength(0)
      expect(card.querySelector('[role="group"] p')!.textContent).toContain('Look at #12 and issue abc?')
      expect(screen.getByRole('button', { name: 'About task abcdef12' })).toBeTruthy()
      expect(card.textContent).not.toContain('[[')
    })

    it('keeps a chip inside an option to its own edges on a touch screen', () => {
      renderMessage(assistantMessage(2, { text: 'Two PRs.', ask: chipAsk }), vi.fn(), projects)
      const card = document.querySelector('[data-slot="manager-ask"]')!
      expect(card.querySelector('[data-slot="ask-choice"] [data-slot="pr-chip"]')!.className).not.toContain('after:-inset-3')
      expect(card.querySelector('[role="group"] p [data-slot="pr-chip"]')!.className).toContain('after:-inset-3')
    })

    it('reads the references back as words on the answered card', () => {
      renderMessage(assistantMessage(2, { text: 'Two PRs.', ask: chipAsk, askAnswer: 'Dependabot: Assess [[pr:alpha/2897]] (recommended)' }), vi.fn(), projects, false, true)
      const answered = document.querySelector('[data-slot="manager-ask"][data-resolved="true"]')!
      expect(answered.textContent).toContain('Assess #2897 (recommended)')
      expect(answered.querySelector('[data-slot="ask-answer-description"] [data-slot="issue-chip"]')).not.toBeNull()
    })

    it('shows each source task with its pull request and issue', () => {
      const { client } = renderMessage(assistantMessage(2, { text: 'Both wait.', ask: chipAsk, sourceTasks: [{ projectId: 'alpha', runId: 'run-1' }, { projectId: 'alpha', runId: 'run-2' }] }), vi.fn(), projects)
      client.setQueryData(workspaceQueryKeys.runsIndex, {
        runs: [
          { projectId: 'alpha', id: 'run-1', title: 'Bump react', status: 'waiting', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z', pullRequestUrl: 'https://github.com/o/alpha/pull/2897', issueNumber: 41 },
          { projectId: 'alpha', id: 'run-2', title: 'Bump vite', status: 'waiting', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z', markerRefs: { pr: 2896 } },
        ],
      })
      return waitFor(() => {
        const rows = [...document.querySelectorAll('[data-slot="manager-ask"] [data-slot="decision-sources"] > div')]
        expect(rows).toHaveLength(2)
        expect([...rows[0]!.querySelectorAll('[data-slot="pr-chip"], [data-slot="issue-chip"]')].map((chip) => chip.getAttribute('href')))
          .toEqual(['https://github.com/o/alpha/pull/2897', 'https://github.com/o/alpha/issues/41'])
        expect([...rows[1]!.querySelectorAll('[data-slot="pr-chip"]')].map((chip) => chip.getAttribute('href')))
          .toEqual(['https://github.com/o/alpha/pull/2896'])
        expect(rows[1]!.querySelector('[data-slot="issue-chip"]')).toBeNull()
      })
    })

    it('shows the source task chips on an approval card too', async () => {
      const { client } = renderMessage(actionMessage(207, { action: { type: 'merge-pr', projectId: 'alpha', number: 2897 }, sourceTasks: [{ projectId: 'alpha', runId: 'run-1' }] }), vi.fn(), projects)
      client.setQueryData(workspaceQueryKeys.runsIndex, {
        runs: [{ projectId: 'alpha', id: 'run-1', title: 'Bump react', status: 'review', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z', pullRequestUrl: 'https://github.com/o/alpha/pull/2897' }],
      })
      await waitFor(() => expect(document.querySelector('[data-slot="manager-action"] [data-slot="decision-sources"] [data-slot="pr-chip"]')?.getAttribute('href'))
        .toBe('https://github.com/o/alpha/pull/2897'))
    })

    it('leaves out a stored source task that does not carry the merge card\'s PR', () => {
      renderMessage(actionMessage(208, { sourceTasks: [{ projectId: 'alpha', runId: 'run-1' }], reason: 'Seen in [[task:alpha/run-1]]' }), vi.fn(), projects)
      expect(document.querySelector('[data-slot="manager-action"] [data-slot="decision-sources"]')).toBeNull()
    })

    it('paints references in an approval reason', () => {
      renderMessage(actionMessage(206, { reason: 'Green after [[pr:alpha/2897]] landed.' }), vi.fn(), projects)
      const reason = [...document.querySelectorAll('[data-slot="manager-action"] p')].find((p) => p.textContent?.startsWith('Green after'))!
      expect(reason.querySelector('[data-slot="pr-chip"]')?.getAttribute('href')).toBe('https://github.com/o/alpha/pull/2897')
      expect(reason.textContent).not.toContain('[[')
    })
  })

  describe('a conflicting pull request chip', () => {
    // Its own project: the status cache outlives a test, and an `alpha` conflict would leak.
    const projects = [{ id: 'beta', name: 'Beta', repoUrl: 'https://github.com/o/beta' }]
    const owner = { projectId: 'beta', id: 'run-9', title: 'Fix the login bug', status: 'review', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z', prNumber: 12 }
    let sent: Array<{ path: string; method: string; body: unknown }>

    beforeEach(() => {
      sent = []
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        sent.push({ path, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
        if (path.includes('/ref-status')) return json({ available: true, prs: { 12: 'ready' }, issues: {}, conflicts: [12], recheckAfterMs: null })
        if (path === '/api/v1/providers/status') return json({ providers: [{ provider: 'claude', status: 'connected', enabled: true }] })
        if (path.endsWith('/runs/run-9')) {
          return json({ id: 'run-9', title: 'Fix the login bug', workflow: 'quick-task', task: 'Fix it.', status: 'review', createdAt: owner.createdAt, tokensUsed: 0, archived: false, prNumber: 12, steps: [{ id: 'task', name: 'Task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 'sess-1' }] })
        }
        return json({})
      }))
    })

    const openPanel = async () => {
      const chip = await waitFor(() => {
        const found = document.querySelector<HTMLElement>('[data-slot="pr-chip"][data-conflicting="true"]')
        if (!found) throw new Error('no conflicting chip yet')
        return found
      })
      fireEvent.focus(chip)
    }

    it('offers Resolve conflicts and sends it to the task that owns the pull request', async () => {
      const { client } = renderMessage(assistantMessage(2, { text: 'Conflicts on [[pr:beta/12]].' }), vi.fn(), projects)
      client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [owner] })
      await openPanel()
      const button = await waitFor(() => {
        const found = screen.getByRole('button', { name: 'Resolve conflicts' })
        expect(found.hasAttribute('disabled')).toBe(false)
        return found
      })
      fireEvent.click(button)
      await waitFor(() => expect(sent.find((request) => request.method === 'POST')?.path).toContain('/runs/run-9/continue'))
    })

    it('says so, with no button, when no task owns the pull request', async () => {
      const { client } = renderMessage(assistantMessage(2, { text: 'Conflicts on [[pr:beta/12]].' }), vi.fn(), projects)
      client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [{ ...owner, prNumber: 99 }] })
      await openPanel()
      await waitFor(() => expect(screen.getByText('No cezar task owns this PR')).toBeTruthy())
      expect(screen.queryByRole('button', { name: 'Resolve conflicts' })).toBeNull()
    })
  })

  it('names a pull request chip by the title its merge proposal carries', async () => {
    const projects = [{ id: 'alpha', name: 'Alpha', repoUrl: 'https://github.com/o/alpha' }]
    const message = assistantMessage(2, { text: 'Ready: [[pr:alpha/12]].' })
    const { result } = renderHook(() => usePrTitles([message, actionMessage(3)]))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(workspaceQueryKeys.projects, { projects, bootProject: 'alpha', projectsDir: '' })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <PrTitlesContext.Provider value={result.current}>
            <ManagerMessageRow message={message} origin={origin} onDecide={vi.fn()} projects={projects} />
          </PrTitlesContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const chip = await waitFor(() => document.querySelector('[data-slot="pr-chip"]')!)
    expect(chip.getAttribute('aria-label')).toBe('Open the pull request for #12, Fix the thing')
  })

  it('keeps the same titles map while a reply streams', () => {
    const { result, rerender } = renderHook(({ text }) => usePrTitles([assistantMessage(2, { text }), actionMessage(3)]), { initialProps: { text: 'He' } })
    const first = result.current
    rerender({ text: 'Hello' })
    expect(result.current).toBe(first)
  })

  it('says a usage-limited turn resumes, not that it failed, and Don’t resume stops it', async () => {
    renderMessage(assistantMessage(2, { text: 'You’ve hit your session limit', resumeAt: '2026-11-10T15:11:00.000Z' }))
    const hint = document.querySelector('[data-slot="manager-resume-hint"]')
    expect(hint?.textContent).toContain('resumes automatically at')
    expect(hint?.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-10T15:11:00.000Z')
    expect(document.querySelector('[data-slot="manager-error"]')).toBeNull()
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    fireEvent.click(screen.getByRole('button', { name: 'Don’t resume' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(String(fetchMock.mock.calls.at(-1)![0])).toMatch(/\/workspace\/managers\/global\/stop$/)
  })

  it('says a stopped or failed chat turn as a line', () => {
    renderMessage(assistantMessage(2, { text: '', stopped: true, error: 'Boom' }))
    expect(screen.getByText('Response stopped.')).toBeTruthy()
    expect(document.querySelector('[data-slot="manager-error"]')?.textContent).toContain('Boom')
    expect(document.querySelector('[data-slot="manager-check-failed"]')).toBeNull()
    // History must not shout: only the announcer speaks for a failure that happens live.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  describe('a failed watch or job turn', () => {
    const failed = (error: string, turn: 'watch' | 'job' = 'watch') => assistantMessage(2, { text: '', turn, ...(turn === 'job' ? { jobName: 'Nightly' } : {}), error })
    const card = () => document.querySelector<HTMLElement>('[data-slot="manager-check-failed"]')

    it('is a card with the cause in words, the raw message under it, and a retry', async () => {
      renderMessage(failed('claude CLI exited with code 1'))
      expect(document.querySelector('[data-slot="manager-error"]')).toBeNull()
      expect(card()!.getAttribute('data-tone')).toBe('danger')
      expect(card()!.getAttribute('data-cause')).toBe('exit')
      expect(card()!.querySelector('[data-slot="manager-card-header"]')?.textContent).toContain('Check failed')
      expect(card()!.textContent).toContain("The agent's CLI exited with code 1 before the check finished. The next check retries.")
      expect(card()!.querySelector('[data-slot="manager-check-failed-raw"]')?.textContent).toBe('claude CLI exited with code 1')
      expect(screen.queryByRole('button', { name: 'Switch account' })).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      const fetchMock = vi.mocked(fetch)
      fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(String(fetchMock.mock.calls.at(-1)![0])).toMatch(/\/workspace\/managers\/global\/check$/)
    })

    it('offers another account for a usage limit or a sign-in, when the chat can open the gear', () => {
      const switchAccount = vi.fn()
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <ManagerChatActionsContext.Provider value={{ switchAccount }}>
              <ManagerMessageRow message={failed('Usage limit reached until 14:00 · claude CLI exit 1')} origin={origin} onDecide={vi.fn()} />
            </ManagerChatActionsContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>,
      )
      expect(card()!.getAttribute('data-cause')).toBe('usage')
      expect(card()!.textContent).toContain('hit its usage limit')
      fireEvent.click(screen.getByRole('button', { name: 'Switch account' }))
      expect(switchAccount).toHaveBeenCalledTimes(1)
      cleanup()
      // A bare render has no gear to open: the button stays away rather than doing nothing.
      renderMessage(failed('Not logged in'))
      expect(card()!.getAttribute('data-cause')).toBe('auth')
      expect(screen.queryByRole('button', { name: 'Switch account' })).toBeNull()
    })

    it('names a failed job by its job', () => {
      renderMessage(failed('ECONNREFUSED', 'job'))
      expect(card()!.querySelector('[data-slot="manager-card-header"]')?.textContent).toContain('Job failed: Nightly')
      expect(card()!.textContent).toContain('It runs again on its own interval.')
    })
  })

  it('labels a watch turn and a job turn', () => {
    renderMessage(assistantMessage(2, { turn: 'job', jobName: 'Nightly' }))
    expect(screen.getByText('Job: Nightly')).toBeTruthy()
    cleanup()
    renderMessage(assistantMessage(3, { turn: 'watch' }))
    expect(screen.getByText('Watch check')).toBeTruthy()
  })

  it('labels a task card and folds a long final message behind Show the whole message', () => {
    const body = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
    renderMessage(assistantMessage(4, {
      turn: 'watch',
      text: `[[task:alpha/run-1]]\n\n**Finished.**\n\n${body}`,
      taskReport: { projectId: 'alpha', runId: 'run-1', state: 'done' },
    }))
    expect(screen.getByText('Task update')).toBeTruthy()
    expect(screen.queryByText('Watch check')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Show the whole message' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true')
    cleanup()
    renderMessage(assistantMessage(5, { turn: 'watch', text: '[[task:alpha/run-1]]\n\n**Failed: boom**', important: true, headline: 'Task: failed', taskReport: { projectId: 'alpha', runId: 'run-1', state: 'failed' } }))
    expect(screen.queryByRole('button', { name: 'Show the whole message' })).toBeNull()
  })

  it('renders a notice as a quiet line', () => {
    renderMessage({ id: 'n', seq: 1, at: '', kind: 'notice', text: 'Merged #12' })
    expect(document.querySelector('[data-slot="manager-notice"]')?.textContent).toBe('Merged #12')
  })
})

describe('CommandsRow', () => {
  const commands = [
    { id: '1', tool: 'Bash', summary: 'cez-manager status', output: 'fine' },
    { id: '2', tool: 'Bash', summary: 'gh pr list', isError: true },
  ]

  it('collapses to a count and opens from the keyboard-reachable trigger', () => {
    render(<CommandsRow commands={commands} />)
    const trigger = screen.getByRole('button', { name: 'Ran 2 commands' })
    expect(screen.queryByText('cez-manager status')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByText('cez-manager status')).toBeTruthy()
    expect(screen.getByText('fine')).toBeTruthy()
  })

  it('uses the singular and renders nothing with no commands', () => {
    const { rerender, container } = render(<CommandsRow commands={[commands[0]!]} />)
    expect(screen.getByRole('button', { name: 'Ran 1 command' })).toBeTruthy()
    rerender(<CommandsRow commands={[]} />)
    expect(container.textContent).toBe('')
  })
})

describe('a reply with no words yet', () => {
  it('says it is thinking, quietly, and stops once text streams in', () => {
    renderMessage(assistantMessage(1, { text: '', streaming: true }))
    const thinking = document.querySelector('[data-slot="manager-thinking"]')!
    expect(thinking.textContent).toBe('Thinking…')
    expect(thinking.closest('[role="status"],[role="log"],[aria-live]')).toBeNull()
    const dots = thinking.querySelectorAll('[aria-hidden="true"] > span')
    expect(dots).toHaveLength(3)
    for (const dot of dots) expect(dot.className.split(' ')).toEqual(expect.arrayContaining(['animate-pulse', 'motion-reduce:animate-none']))
    cleanup()
    renderMessage(assistantMessage(1, { text: 'Here', streaming: true }))
    expect(document.querySelector('[data-slot="manager-thinking"]')).toBeNull()
  })

  it('is gone once the reply settles, even an empty one', () => {
    renderMessage(assistantMessage(1, { text: '', streaming: false }))
    expect(document.querySelector('[data-slot="manager-thinking"]')).toBeNull()
  })
})

// soft-foreground is 2.52:1 on white: under WCAG AA for these 12px runs (light theme).
describe('light-theme contrast', () => {
  const sources = import.meta.glob('./*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

  it('keeps manager text off the sub-AA soft grey', () => {
    const offenders = Object.entries(sources)
      .filter(([path, source]) => !path.endsWith('.test.tsx') && source.includes('text-soft-foreground'))
      .map(([path]) => path)
    expect(Object.keys(sources).length).toBeGreaterThan(5)
    expect(offenders).toEqual([])
  })

  it('draws timestamps and notices in muted ink', () => {
    renderMessage(assistantMessage(1, { text: 'Hi' }))
    expect(document.querySelector('[data-slot="manager-message-meta"]')!.className).toContain('text-muted-foreground')
    cleanup()
    renderMessage({ id: 'n', seq: 2, at: '2026-10-31T09:00:00Z', kind: 'notice', text: 'Turn limit reached' } as ManagerMessage)
    expect(screen.getByText('Turn limit reached').className).toContain('text-muted-foreground')
  })
})

describe('supersededAskIds', () => {
  const card = (seq: number, headers: string[], askAnswer?: string) => assistantMessage(seq, {
    text: `Q${seq}`,
    ask: { questions: headers.map((header) => ({ header, question: `${header}?`, options: [{ label: 'Yes' }] })) },
    ...(askAnswer ? { askAnswer } : {}),
  })

  it('supersedes an older unanswered card a newer card re-asks, answered or not', () => {
    const older = card(1, ['PR 2225'])
    expect([...supersededAskIds([older, card(2, ['PR 2225'])])]).toEqual([older.id])
    expect([...supersededAskIds([card(2, ['PR 2225'], 'Yes'), older])]).toEqual([older.id])
  })

  it('keeps a card open when a newer card shares only some of its headers', () => {
    expect(supersededAskIds([card(1, ['Shell', 'Default']), card(2, ['Shell'])]).size).toBe(0)
    expect(supersededAskIds([card(1, ['PR 100']), card(2, ['PR 200'])]).size).toBe(0)
  })
})

describe('ManagerMessageRow — expired login (spec 2026-11-18-inline-account-reconnect)', () => {
  const failed = (over = {}) => assistantMessage(4, { text: '', error: 'Sign in to Claude Code again', authFailure: { provider: 'claude', profileId: 'default' }, ...over })

  it('draws the reconnect card instead of the red line', () => {
    renderMessage(failed())
    expect(screen.getByRole('group', { name: 'Claude Code · Default is signed out' }).textContent).toContain('This turn stopped before answering')
    expect(document.querySelector('[data-slot="manager-error"]')).toBeNull()
  })

  it('an older failure on the same account is a quiet line', () => {
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter><ManagerMessageRow message={failed()} origin={origin} onDecide={vi.fn()} authLive={false} /></MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByText(/Claude Code · Default was signed out here/)).toBeTruthy()
  })

  it('a reconnected turn says so quietly', () => {
    renderMessage(assistantMessage(5, { text: '', error: 'Sign in to Claude Code again', reconnectedAt: '2026-11-18T10:51:00Z' }))
    expect(screen.getByText(/Reconnected · resumed/)).toBeTruthy()
    expect(document.querySelector('[data-slot="manager-error"]')).toBeNull()
  })

  it('a reconnected turn names the account it came back on', () => {
    renderMessage(assistantMessage(6, { text: '', reconnectedAt: '2026-11-18T10:51:00Z', reconnectedFrom: { provider: 'claude', profileId: 'default' } }))
    expect(screen.getByText(/Reconnected Claude Code · Default · resumed/)).toBeTruthy()
  })
})

describe('the reply footnote (restored 2026-11-22)', () => {
  const usage = { pp: 0.8, alonePp: 0.8, windows: ['Claude · default · 5-hour limit 10:00–15:00'] }
  const renderWith = (message: ManagerMessage, planUsage?: typeof usage) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(workspaceQueryKeys.projects, { projects: [], bootProject: 'alpha', projectsDir: '' })
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ManagerMessageRow message={message} origin={origin} onDecide={vi.fn()} {...(planUsage ? { planUsage } : {})} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('shows under a finished reply what it cost', () => {
    renderWith(assistantMessage(3, { text: 'Merged.' }), usage)
    expect(screen.getByText(/^This reply ≈ 0.8% of 5h/)).toBeTruthy()
  })

  it('waits for a streaming reply to finish, and shows nothing without a ledger entry', () => {
    const { container } = renderWith(assistantMessage(4, { text: 'Work', streaming: true }), usage)
    expect(container.querySelector('[data-slot="manager-reply-usage"]')).toBeNull()
    cleanup()
    renderWith(assistantMessage(5, { text: 'Done.' }))
    expect(document.querySelector('[data-slot="manager-reply-usage"]')).toBeNull()
  })
})
