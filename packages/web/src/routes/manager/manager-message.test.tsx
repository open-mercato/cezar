import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workspaceQueryKeys } from '@/api/queries'
import type { ManagerMessage } from '@open-mercato/cezar-api-client'

import { actionMessage, assistantMessage, userMessage } from './manager-fixtures'
import { CommandsRow, ManagerMessageRow, PrTitlesContext, usePrTitles } from './manager-message'

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

    it('collapses to the answer', () => {
      renderMessage(assistantMessage(2, { text: 'Two decisions.', ask, askAnswer: 'Shell: Tauri' }))
      expect(document.querySelector('[data-slot="manager-ask"]')?.getAttribute('data-resolved')).toBe('true')
      expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
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

  it('says a stopped or failed turn', () => {
    renderMessage(assistantMessage(2, { text: '', stopped: true, error: 'Boom' }))
    expect(screen.getByText('Response stopped.')).toBeTruthy()
    expect(document.querySelector('[data-slot="manager-error"]')?.textContent).toContain('Boom')
    // History must not shout: only the announcer speaks for a failure that happens live.
    expect(screen.queryByRole('alert')).toBeNull()
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
