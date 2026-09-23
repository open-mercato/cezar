import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Segmented } from './segmented'

afterEach(cleanup)

const OPTIONS = [
  { value: 'list', label: 'List', count: 7 },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
] as const

describe('Segmented', () => {
  it('renders a labelled group with one pressed option and its count', () => {
    render(<Segmented slot="view" label="View" value="list" options={OPTIONS} onChange={() => {}} />)

    const group = screen.getByRole('group', { name: 'View' })
    expect(group.getAttribute('data-slot')).toBe('view')
    const buttons = group.querySelectorAll('button')
    expect(buttons).toHaveLength(3)
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[0]?.className).toContain('bg-card')
    expect(buttons[0]?.querySelector('small')?.textContent).toBe('7')
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('false')
    expect(buttons[1]?.querySelector('small')).toBeNull()
  })

  it('uses the kit metrics: 28px buttons in a 3px well', () => {
    render(<Segmented slot="view" label="View" value="list" options={OPTIONS} onChange={() => {}} />)

    const group = screen.getByRole('group', { name: 'View' })
    expect(group.className).toContain('p-[3px]')
    expect(group.querySelector('button')?.className).toContain('h-7')
    expect(group.querySelector('button')?.className).toContain('text-[12.5px]')
  })

  it('reports a pick and ignores a re-click of the pressed option', () => {
    const onChange = vi.fn()
    render(<Segmented slot="view" label="View" value="list" options={OPTIONS} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Week' }))
    fireEvent.click(screen.getByRole('button', { name: /List/ }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('week')
  })

  it('reports the re-click when release is allowed', () => {
    const onChange = vi.fn()
    render(
      <Segmented slot="view" label="View" value="list" options={OPTIONS} onChange={onChange} allowRelease />,
    )

    fireEvent.click(screen.getByRole('button', { name: /List/ }))

    expect(onChange).toHaveBeenCalledWith('list')
  })

  it('presses nothing for a value matching no option', () => {
    render(<Segmented slot="view" label="View" value="" options={OPTIONS} onChange={() => {}} />)

    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('aria-pressed')).toBe('false')
    }
  })

  it('stretches when full', () => {
    render(<Segmented slot="view" label="View" value="list" options={OPTIONS} onChange={() => {}} full />)

    const group = screen.getByRole('group', { name: 'View' })
    expect(group.className).toContain('w-full')
    expect(group.querySelector('button')?.className).toContain('flex-1')
  })
})
