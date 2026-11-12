import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Select, SelectTrigger, SelectValue } from './select'

afterEach(cleanup)

function renderTrigger(size?: 'sm' | 'default') {
  render(
    <Select value="a">
      <SelectTrigger size={size} aria-label="Runner">
        <SelectValue />
      </SelectTrigger>
    </Select>,
  )
  return screen.getByRole('combobox', { name: 'Runner' })
}

describe('SelectTrigger', () => {
  // The trigger shares the row pills' metrics so a Select can sit beside a PickerPill.
  it('is 36px by default and 28px at sm, on the 13px ui size', () => {
    const trigger = renderTrigger()
    expect(trigger.dataset.size).toBe('default')
    expect(trigger.className).toContain('data-[size=default]:h-9')
    expect(trigger.className).toContain('data-[size=sm]:h-7')
    expect(trigger.className).toContain('text-ui')
    expect(trigger.className).not.toContain('text-sm')
  })

  it('wears the pills\' small soft chevron', () => {
    const trigger = renderTrigger('sm')
    expect(trigger.dataset.size).toBe('sm')
    const chevron = trigger.querySelector('[data-slot="select-chevron"]')
    expect(chevron?.getAttribute('class')).toContain('size-3')
    expect(chevron?.getAttribute('class')).toContain('text-soft-foreground')
  })
})
