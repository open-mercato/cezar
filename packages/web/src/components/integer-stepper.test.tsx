import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IntegerStepper } from './integer-stepper'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const field = () => screen.getByRole('spinbutton') as HTMLInputElement
const up = () => screen.getByRole('button', { name: 'Increase Limit' })
const down = () => screen.getByRole('button', { name: 'Decrease Limit' })

describe('IntegerStepper', () => {
  it('is a text field with arrows, showing the saved value', () => {
    render(<IntegerStepper value={4} min={1} max={16} onCommit={vi.fn()} aria-label="Limit" />)
    expect(field().value).toBe('4')
    expect(field().getAttribute('inputmode')).toBe('numeric')
    expect(up()).not.toBeNull()
    expect(down()).not.toBeNull()
  })

  it('commits a typed number on Enter and on blur — never the keystrokes on the way', () => {
    const onCommit = vi.fn()
    render(<IntegerStepper value={4} min={1} max={16} onCommit={onCommit} aria-label="Limit" />)

    fireEvent.change(field(), { target: { value: '1' } })
    fireEvent.change(field(), { target: { value: '12' } })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(12)

    fireEvent.change(field(), { target: { value: '9' } })
    fireEvent.blur(field())
    expect(onCommit).toHaveBeenLastCalledWith(9)
  })

  it('does not commit an unchanged value', () => {
    const onCommit = vi.fn()
    render(<IntegerStepper value={4} min={1} max={16} onCommit={onCommit} aria-label="Limit" />)
    fireEvent.blur(field())
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it.each(['0', '17', '2.5', 'abc', ''])('refuses %j with an inline error and no commit', (bad) => {
    const onCommit = vi.fn()
    render(<IntegerStepper value={4} min={1} max={16} onCommit={onCommit} aria-label="Limit" />)
    fireEvent.change(field(), { target: { value: bad } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    fireEvent.blur(field())
    expect(onCommit).not.toHaveBeenCalled()
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Enter a whole number from 1 to 16.')).not.toBeNull()
  })

  it('Escape reverts the draft to the saved value', () => {
    const onCommit = vi.fn()
    render(<IntegerStepper value={4} min={1} max={16} onCommit={onCommit} aria-label="Limit" />)
    fireEvent.change(field(), { target: { value: '99' } })
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(field().value).toBe('4')
    fireEvent.blur(field())
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('arrows step at once and a burst commits once, after a pause', () => {
    const onCommit = vi.fn()
    render(<IntegerStepper value={4} min={1} max={16} onCommit={onCommit} aria-label="Limit" />)

    fireEvent.click(up())
    fireEvent.click(up())
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(field().value).toBe('7')
    expect(onCommit).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(500))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(7)

    fireEvent.click(down())
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    act(() => vi.advanceTimersByTime(500))
    expect(onCommit).toHaveBeenLastCalledWith(5)
  })

  it('clamps stepping to the range and disables the arrow at each end', () => {
    const { rerender } = render(
      <IntegerStepper value={16} min={0} max={16} onCommit={vi.fn()} aria-label="Limit" />,
    )
    expect((up() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(field().value).toBe('16')
    act(() => vi.advanceTimersByTime(500))

    rerender(<IntegerStepper value={0} min={0} max={16} onCommit={vi.fn()} aria-label="Limit" />)
    expect((down() as HTMLButtonElement).disabled).toBe(true)
  })

  it('with allowEmpty, an empty field commits null and stepping starts from emptyStepFrom', () => {
    const onCommit = vi.fn()
    render(
      <IntegerStepper
        value={3}
        min={1}
        max={16}
        allowEmpty
        emptyStepFrom={2}
        placeholder="Inherit (2)"
        onCommit={onCommit}
        aria-label="Limit"
      />,
    )
    fireEvent.change(field(), { target: { value: '' } })
    fireEvent.blur(field())
    expect(onCommit).toHaveBeenCalledWith(null)
    expect(field().placeholder).toBe('Inherit (2)')

    fireEvent.click(up())
    expect(field().value).toBe('2')
  })

  it('follows a new saved value, and falls back to it when a save is rejected', async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error('nope')))
    const { rerender } = render(
      <IntegerStepper value={4} min={1} max={16} onCommit={onCommit} aria-label="Limit" />,
    )
    rerender(<IntegerStepper value={6} min={1} max={16} onCommit={onCommit} aria-label="Limit" />)
    expect(field().value).toBe('6')

    fireEvent.change(field(), { target: { value: '9' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    await act(async () => {})
    expect(field().value).toBe('6')
  })
})
