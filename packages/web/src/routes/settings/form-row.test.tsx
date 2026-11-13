import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FormRow, SettingsCard, isCommitKey, useSavedFlash } from './form-row'

/**
 * The one form grammar (design doc, Proposal 9 "Form rows and saving"): label + description
 * left, control right, "Saved" inline for two seconds after a write — and the keyboard's
 * "commit this field" for text inputs.
 */

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useSavedFlash', () => {
  it('says Saved for two seconds after a flash, then goes quiet', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useSavedFlash())
    expect(result.current[0]).toBe(false)
    act(() => result.current[1]())
    expect(result.current[0]).toBe(true)
    act(() => vi.advanceTimersByTime(1500))
    expect(result.current[0]).toBe(true)
    // A second write restarts the clock rather than cutting the first short.
    act(() => result.current[1]())
    act(() => vi.advanceTimersByTime(1500))
    expect(result.current[0]).toBe(true)
    act(() => vi.advanceTimersByTime(600))
    expect(result.current[0]).toBe(false)
  })
})

describe('FormRow', () => {
  it('lays out label and description beside the control, and shows Saved inline only when told to', () => {
    const { rerender } = render(
      <FormRow label="Max parallel tasks" description="How many tasks run at once." htmlFor="mp">
        <input id="mp" />
      </FormRow>,
    )
    expect(screen.getByLabelText('Max parallel tasks')).not.toBeNull()
    expect(screen.getByText('How many tasks run at once.')).not.toBeNull()
    const indicator = () => document.querySelector('[data-slot="saved-indicator"]')!
    expect(indicator().textContent).toBe('')
    expect(indicator().getAttribute('aria-live')).toBe('polite')
    // No `role="status"`: the toaster owns that role, and the two must not be confused.
    expect(screen.queryByRole('status')).toBeNull()
    rerender(
      <FormRow label="Max parallel tasks" description="How many tasks run at once." htmlFor="mp" saved>
        <input id="mp" />
      </FormRow>,
    )
    expect(indicator().textContent).toBe('Saved')
    expect(document.querySelector('[data-slot="form-row"]')?.hasAttribute('data-saved')).toBe(true)
  })

  it('a card titles its rows and carries the anchor id a merged page is linked by', () => {
    render(
      <SettingsCard id="accounts" title="Accounts" action={<button type="button">Add</button>}>
        <FormRow label="personal" description="~/.claude" />
      </SettingsCard>,
    )
    expect(document.getElementById('accounts')?.getAttribute('data-slot')).toBe('settings-card')
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Accounts')
    expect(screen.getByRole('button', { name: 'Add' })).not.toBeNull()
    expect(screen.getByText('~/.claude')).not.toBeNull()
  })
})

describe('isCommitKey', () => {
  const key = (init: Partial<KeyboardEvent>) => ({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, ...init }) as never
  it('is Enter in an input, ⌘↵ or Ctrl+↵ in a textarea', () => {
    expect(isCommitKey(key({}))).toBe(true)
    expect(isCommitKey(key({ shiftKey: true }))).toBe(false)
    expect(isCommitKey(key({ key: 'a' }))).toBe(false)
    expect(isCommitKey(key({}), true)).toBe(false)
    expect(isCommitKey(key({ metaKey: true }), true)).toBe(true)
    expect(isCommitKey(key({ ctrlKey: true }), true)).toBe(true)
  })

  it('a text field saves on blur and on Enter, never on every keystroke', () => {
    const save = vi.fn()
    render(
      <input
        aria-label="Name"
        onBlur={save}
        onKeyDown={(event) => {
          if (isCommitKey(event)) save()
        }}
      />,
    )
    const field = screen.getByLabelText('Name')
    fireEvent.change(field, { target: { value: 'x' } })
    expect(save).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(save).toHaveBeenCalledTimes(1)
    fireEvent.blur(field)
    expect(save).toHaveBeenCalledTimes(2)
  })
})
