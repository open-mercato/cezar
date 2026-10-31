import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workspaceQueryKeys } from '@/api/queries'
import type { ManagerMessage } from '@open-mercato/cezar-api-client'

import { actionMessage, assistantMessage, userMessage } from './manager-fixtures'
import { ActionCard, CommandsRow, ManagerMessageRow } from './manager-message'

const origin = { id: 'global', name: 'Global Manager' }

function Probe() {
  const location = useLocation()
  return <span data-testid="at">{`${location.pathname}|${JSON.stringify(location.state)}`}</span>
}

function renderMessage(message: ManagerMessage, onDecide = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(workspaceQueryKeys.projects, { projects: [], bootProject: 'alpha', projectsDir: '' })
  client.setQueryData(workspaceQueryKeys.runsIndex, {
    runs: [{ projectId: 'alpha', id: 'run-1', title: 'Session 123123', status: 'running', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z', diffStat: { adds: 87, dels: 12, files: 3 } }],
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/manager/global']}>
        <Routes>
          <Route path="*" element={<><ManagerMessageRow message={message} origin={origin} onDecide={onDecide} /><Probe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return onDecide
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

  it('still offers a card for a run the index does not know', () => {
    renderMessage(assistantMessage(2, { text: '[[task:alpha/abcdef0123456]]' }))
    expect(document.querySelector('[data-slot="session-card"]')?.textContent).toContain('Session abcdef01')
  })

  it('paints an inline pull request as a chip inside its sentence', async () => {
    renderMessage(assistantMessage(2, { text: 'Merged [[pr:alpha/12]] today.' }))
    const chip = await waitFor(() => {
      const found = document.querySelector('[data-slot="manager-pr-chip"]')
      expect(found).not.toBeNull()
      return found as HTMLAnchorElement
    })
    expect(chip.getAttribute('href')).toBe('/p/alpha/github/prs/12')
    expect(chip.closest('p')?.textContent).toContain('Merged')
  })

  it('says a stopped or failed turn', () => {
    renderMessage(assistantMessage(2, { text: '', stopped: true, error: 'Boom' }))
    expect(screen.getByText('Response stopped by the user.')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Boom')
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

describe('ActionCard', () => {
  it('offers Approve and Reject while pending', () => {
    const onDecide = vi.fn()
    render(<ActionCard message={actionMessage(1)} onDecide={onDecide} />)
    const card = screen.getByRole('region', { name: 'Merge #12 — Fix the thing' })
    expect(card.textContent).toContain('Checks are green.')
    expect(card.textContent).toContain('squash')
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }))
    expect(onDecide).toHaveBeenCalledWith('a1', 'approve')
    fireEvent.click(within(card).getByRole('button', { name: 'Reject' }))
    expect(onDecide).toHaveBeenCalledWith('a1', 'reject')
  })

  it('locks the buttons while a decision is in flight', () => {
    render(<ActionCard message={actionMessage(1)} onDecide={vi.fn()} busy />)
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('replaces the buttons with the outcome once decided', () => {
    render(<ActionCard message={actionMessage(1, { status: 'done', result: 'Merged #12' })} onDecide={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByText('Merged #12')).toBeTruthy()
  })

  it('falls back to the status when no result was written', () => {
    render(<ActionCard message={actionMessage(1, { status: 'rejected' })} onDecide={vi.fn()} />)
    expect(screen.getByText('Rejected')).toBeTruthy()
  })
})
