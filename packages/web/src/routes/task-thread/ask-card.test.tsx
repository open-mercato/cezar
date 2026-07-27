import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AskCard } from './ask-card'
import type { ThreadAsk } from './thread-state'
import type { ApiRun, ProviderStatusResponse } from '@open-mercato/cezar-api-client'

const mutateAsync = vi.fn().mockResolvedValue({})
let providerStatus: ProviderStatusResponse
vi.mock('@/api/queries', () => ({
  useSendMessage: () => ({ mutateAsync, isPending: false }),
  useProviderStatus: () => ({ data: providerStatus, isSuccess: true }),
}))

afterEach(() => {
  cleanup()
  mutateAsync.mockClear()
  providerStatus = {
    providers: [
      { provider: 'claude', status: 'connected', enabled: true },
      { provider: 'codex', status: 'not-installed', enabled: true },
      { provider: 'opencode', status: 'not-installed', enabled: true },
    ],
  }
})

const activeRun: ApiRun = {
  id: 'r1',
  title: 'Task',
  workflow: 'quick-task',
  task: 'Task',
  status: 'waiting',
  createdAt: '2026-07-24T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  runner: 'claude',
  steps: [],
}

const renderAsk = (ask: ThreadAsk) => render(
  <MemoryRouter>
    <AskCard ask={ask} run={activeRun} />
  </MemoryRouter>,
)

const singleAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_1',
  resolved: false,
  questions: [
    {
      header: 'Library',
      question: 'Which date library should I standardize on?',
      options: [
        { label: 'date-fns', description: 'Tree-shakeable' },
        { label: 'Luxon', description: 'Immutable, tz-aware' },
      ],
    },
  ],
}

const multiAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_2',
  resolved: false,
  questions: [
    {
      header: 'Sections',
      question: 'Which settings sections?',
      multiSelect: true,
      options: [{ label: 'Profile' }, { label: 'Appearance' }, { label: 'Billing' }],
    },
  ],
}

const twoQuestionAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_3',
  resolved: false,
  questions: [
    {
      header: 'Library',
      question: 'Which library?',
      options: [{ label: 'date-fns' }, { label: 'Luxon' }],
    },
    {
      header: 'Style',
      question: 'Which style?',
      options: [{ label: 'ISO' }, { label: 'Relative' }],
    },
  ],
}

describe('AskCard', () => {
  it('renders the header, question and each option with its description', () => {
    renderAsk(singleAsk)
    expect(screen.getByText('Library')).toBeTruthy()
    expect(screen.getByText('Which date library should I standardize on?')).toBeTruthy()
    expect(screen.getByRole('button', { name: /date-fns/ })).toBeTruthy()
    expect(screen.getByText('Tree-shakeable')).toBeTruthy()
  })

  it('a single single-select question sends "header: label" on one tap (no Send button)', () => {
    renderAsk(singleAsk)
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: date-fns' })
  })

  it('multiple questions: one Send posts every answer in one combined message', () => {
    renderAsk(twoQuestionAsk)
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    // Answering only the first question does NOT send, and does not resolve.
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(send.disabled).toBe(true)
    expect(mutateAsync).not.toHaveBeenCalled()
    // Both answered → one combined message.
    fireEvent.click(screen.getByRole('button', { name: /Relative/ }))
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledTimes(1)
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: date-fns\nStyle: Relative' })
  })

  it('multi-select: Send is disabled until options are picked, then sends the comma-joined labels', () => {
    renderAsk(multiAsk)
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Profile/ }))
    fireEvent.click(screen.getByRole('button', { name: /Billing/ }))
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Sections: Profile, Billing' })
  })

  it('a resolved ask collapses to a compact answered summary with no option buttons', () => {
    renderAsk({ ...singleAsk, resolved: true, answer: 'Library: date-fns' })
    expect(screen.getByText('Answered')).toBeTruthy()
    expect(screen.getByText('Library: date-fns')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /date-fns/ })).toBeNull()
  })

  it.each([
    ['disabled', { provider: 'claude', status: 'connected', enabled: false }, 'Claude Code is disabled. Enable it in Settings → Agents → Providers.'],
    ['disconnected', { provider: 'claude', status: 'disconnected', enabled: true }, 'Claude Code credentials are unavailable. Authorize it in Settings → Agents → Providers.'],
  ] as const)('disables Ask submissions when its active provider is %s', (_case, claude, reason) => {
    providerStatus = {
      providers: [
        claude,
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    }

    renderAsk(singleAsk)

    expect((screen.getByRole('button', { name: /date-fns/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(reason)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/settings/agents#providers',
    )
    expect(mutateAsync).not.toHaveBeenCalled()
  })
})
