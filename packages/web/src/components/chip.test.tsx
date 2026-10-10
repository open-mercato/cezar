import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Chip, chipClass } from './chip'

afterEach(cleanup)

function chipOf(ui: React.ReactElement) {
  const { container } = render(ui)
  const chip = container.querySelector('[data-slot="chip"]')
  if (!chip) throw new Error('Chip did not render')
  return chip as HTMLButtonElement
}

describe('Chip', () => {
  it('is a 28px bordered, rounded button by default', () => {
    const chip = chipOf(<Chip>quick-task</Chip>)

    expect(chip.tagName).toBe('BUTTON')
    expect(chip.type).toBe('button')
    expect(chip.classList.contains('h-7')).toBe(true)
    expect(chip.classList.contains('rounded-md')).toBe(true)
    expect(chip.classList.contains('border-border')).toBe(true)
    expect(chip.getAttribute('data-active')).toBeNull()
  })

  it('marks the active option with a foreground border and semibold text', () => {
    const chip = chipOf(<Chip active>Every day</Chip>)

    expect(chip.getAttribute('data-active')).toBe('true')
    expect(chip.className).toContain('border-foreground')
    expect(chip.className).toContain('font-semibold')
  })

  it('renders the skill grammar: violet border, mono', () => {
    const chip = chipOf(<Chip skill>om-spec-writing</Chip>)

    expect(chip.getAttribute('data-skill')).toBe('true')
    expect(chip.className).toContain('border-violet')
    expect(chip.className).toContain('font-mono')
  })

  it('renders the dashed affordance, an icon and the chevron', () => {
    const chip = chipOf(
      <Chip dashed chevron icon={<svg data-testid="icon" />}>
        Manage…
      </Chip>,
    )

    expect(chip.className).toContain('border-dashed')
    expect(chip.querySelector('[data-testid="icon"]')).not.toBeNull()
    // The chevron is the last child, after the label.
    expect(chip.lastElementChild?.tagName.toLowerCase()).toBe('svg')
    expect(chip.textContent).toBe('Manage…')
  })

  it('forwards disabled and click handlers', () => {
    const onClick = vi.fn()
    const chip = chipOf(
      <Chip disabled onClick={onClick}>
        off
      </Chip>,
    )

    expect(chip.disabled).toBe(true)
    fireEvent.click(chip)
    expect(onClick).not.toHaveBeenCalled()
  })

  // The composer's PickerPill shares this exact string — one chip grammar, one place to change it.
  it('exposes the shared class string', () => {
    expect(chipClass.split(' ')).toContain('h-7')
    // The chip is a shadcn Button now, so the Button's own classes come first; what has to hold
    // is that the WHOLE shared string survives the merge, intact and in one piece.
    expect(chipOf(<Chip>x</Chip>).className).toContain(chipClass)
  })
})
