import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AskCard } from './ask-card'
import type { ThreadAsk } from './thread-state'

const mutateAsync = vi.fn().mockResolvedValue({})
vi.mock('@/api/queries', () => ({
  useSendMessage: () => ({ mutateAsync, isPending: false }),
}))

afterEach(() => {
  cleanup()
  mutateAsync.mockClear()
})

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
    render(<AskCard ask={singleAsk} runId="r1" />)
    expect(screen.getByText('Library')).toBeTruthy()
    expect(screen.getByText('Which date library should I standardize on?')).toBeTruthy()
    expect(screen.getByRole('button', { name: /date-fns/ })).toBeTruthy()
    expect(screen.getByText('Tree-shakeable')).toBeTruthy()
  })

  it('a single single-select question sends "header: label" on one tap (no Send button)', () => {
    render(<AskCard ask={singleAsk} runId="r1" />)
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: date-fns' })
  })

  it('multiple questions: one Send posts every answer in one combined message', () => {
    render(<AskCard ask={twoQuestionAsk} runId="r1" />)
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
    render(<AskCard ask={multiAsk} runId="r1" />)
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Profile/ }))
    fireEvent.click(screen.getByRole('button', { name: /Billing/ }))
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Sections: Profile, Billing' })
  })

  it('a resolved ask collapses to a compact answered summary with no option buttons', () => {
    render(<AskCard ask={{ ...singleAsk, resolved: true, answer: 'Library: date-fns' }} runId="r1" />)
    expect(screen.getByText('Answered')).toBeTruthy()
    expect(screen.getByText('Library: date-fns')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /date-fns/ })).toBeNull()
  })
})
