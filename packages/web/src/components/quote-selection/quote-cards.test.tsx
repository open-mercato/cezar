import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { QuoteCards } from './quote-cards'

afterEach(cleanup)

const quote = (role: 'assistant' | 'user', ref: number | null = 7) => ({
  id: `${role}-${ref}`, role, ...(ref === null ? {} : { ref }), excerpt: 'quoted text', code: false, body: '',
})

describe('QuoteCards', () => {
  it('labels both source roles and offers a jump only for a quote with a #n', () => {
    render(<QuoteCards quotes={[quote('assistant'), quote('user', null)]} onJump={vi.fn()} />)

    expect(screen.getByText('From assistant message #7')).toBeTruthy()
    expect(screen.getByText('From your earlier message')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Jump to message/ })).toHaveLength(1)
  })

  it('lets the host decide which sources it can jump to', () => {
    render(<QuoteCards quotes={[quote('assistant')]} onJump={vi.fn()} canJump={() => false} />)
    expect(screen.queryByRole('button', { name: /^Jump to message/ })).toBeNull()
  })

  it('names each jump by its source, so the buttons are told apart', () => {
    render(<QuoteCards quotes={[quote('assistant'), quote('user', 9)]} onJump={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Jump to message: From assistant message #7' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Jump to message: From your earlier message #9' })).toBeTruthy()
  })

  it('reads ref 0 as the task description and the reply to the task, in a task only', () => {
    const task = render(<QuoteCards quotes={[quote('user', 0), quote('assistant', 0)]} onJump={vi.fn()} taskDescription />)
    expect(screen.getByRole('button', { name: 'Jump to message: From the task description' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Jump to message: From the reply to the task' })).toBeTruthy()
    task.unmount()

    // The manager chat's seq 0 is an ordinary message.
    render(<QuoteCards quotes={[quote('user', 0), quote('assistant', 0)]} onJump={vi.fn()} />)
    expect(screen.getByText('From your earlier message #0')).toBeTruthy()
    expect(screen.getByText('From assistant message #0')).toBeTruthy()
  })
})
