import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workspaceQueryKeys } from '@/api/queries'
import type { ManagerMessage } from '@open-mercato/cezar-api-client'

import { actionMessage, assistantMessage, userMessage } from './manager-fixtures'
import { answersShownOnCard, askAnswerLines, CommandsRow, ManagerChatActionsContext, ManagerMessageRow, PrTitlesContext, usePrTitles } from './manager-message'

const origin = { id: 'global', name: 'Global Manager' }

function Probe() {
  const location = useLocation()
  return <span data-testid="at">{`${location.pathname}|${JSON.stringify(location.state)}`}</span>
}

function renderMessage(message: ManagerMessage, onDecide = vi.fn(), projects?: ReadonlyArray<{ id: string; name?: string; repoUrl?: string }>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(workspaceQueryKeys.projects, { projects: projects ?? [], bootProject: 'alpha', projectsDir: '' })
  client.setQueryData(workspaceQueryKeys.runsIndex, {
    runs: [{ projectId: 'alpha', id: 'run-1', title: 'Session 123123', status: 'running', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z', diffStat: { adds: 87, dels: 12, files: 3 } }],
  })
  const ui = (next: ManagerMessage) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/manager/global']}>
        <Routes>
          <Route path="*" element={<><ManagerMessageRow message={next} origin={origin} onDecide={onDecide} {...(projects ? { projects } : {})} /><Probe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const { rerender } = render(ui(message))
  return Object.assign(onDecide, { rerender: (next: ManagerMessage) => rerender(ui(next)), client })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
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

  describe('question card', () => {
    const ask = { questions: [
      { header: 'Shell', question: 'Which shell?', options: [{ label: 'Capacitor (recommended)' }, { label: 'Tauri' }] },
      { header: 'Default', question: 'Open on Manager?', options: [{ label: 'No' }, { label: 'Yes' }] },
    ] }

    it('sends every answer as one message', async () => {
      renderMessage(assistantMessage(2, { text: 'Two decisions.', ask }))
      const fetchMock = vi.mocked(fetch)
      fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      fireEvent.click(screen.getByRole('button', { name: 'Capacitor (recommended)' }))
      fireEvent.click(screen.getByRole('button', { name: 'No' }))
      fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      const init = fetchMock.mock.calls.at(-1)![1] as RequestInit
      expect(JSON.parse(String(init.body))).toEqual({ text: 'Shell: Capacitor (recommended)\nDefault: No' })
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
      expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
      expect(card.textContent).toBe('Answered:Shell · Default')
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
      expect(card.textContent).toBe('AnsweredShell:Capacitor (recommended)Default:No')
      expect([...card.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['Shell:', 'Default:'])
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
