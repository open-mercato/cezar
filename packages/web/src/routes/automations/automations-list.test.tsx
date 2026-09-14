import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AutomationsList } from './automations-list'
import { NOW, mockActions, response, stubResizeObserver } from './automations-list.fixtures'
import type { AutomationsView } from './automations-route'

beforeEach(() => {
  stubResizeObserver()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function renderList(props: Partial<Parameters<typeof AutomationsList>[0]> = {}) {
  const onViewChange = vi.fn<(view: AutomationsView) => void>()
  render(
    <MemoryRouter initialEntries={['/automations']}>
      <AutomationsList data={response()} actions={mockActions()} view="list" onViewChange={onViewChange} {...props} />
    </MemoryRouter>,
  )
  return { onViewChange }
}

const status = () => document.querySelector('[data-slot="automations-status"]')

describe('AutomationsList', () => {
  it('shows the loading state under the header until data arrives', () => {
    renderList({ data: undefined })

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Automations')
    expect(screen.getByText('Loading automations…')).toBeTruthy()
    expect(status()).toBeNull()
    expect(document.querySelector('[data-slot="automations-table"]')).toBeNull()
  })

  it('shows the error state', () => {
    renderList({ data: undefined, error: 'Boom' })

    expect(screen.getByText('Boom')).toBeTruthy()
  })

  it('offers to create the first automation when there are none', () => {
    renderList({ data: response({ automations: [] }) })

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('No automations yet')
    expect(screen.getByText('Create one paused, preview it, then enable it.')).toBeTruthy()
    const links = screen.getAllByRole('link', { name: /New automation/ })
    expect(links).toHaveLength(2)
    expect(links.every((link) => link.getAttribute('href') === '/automations/new')).toBe(true)
  })

  it('renders the header status trio in the server zone and the counted view switch', () => {
    renderList()

    expect(status()?.textContent).toBe('Scheduler running·GitHub available·UTC')
    expect(status()?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
    expect(status()?.className).toContain('max-[1280px]:hidden')

    const group = screen.getByRole('group', { name: 'View' })
    const list = within(group).getByRole('button', { name: /List/ })
    expect(list.textContent).toBe('List7')
    expect(list.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('link', { name: /New automation/ }).getAttribute('href')).toBe('/automations/new')
  })

  it('says when the scheduler is idle and GitHub is unavailable, with the reason', () => {
    renderList({ data: response({ scheduler: { state: 'idle' }, available: false, reason: 'gh not installed' }) })

    expect(status()?.textContent).toBe('Scheduler idle·GitHub unavailable · gh not installed·UTC')
    expect(status()?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('neutral')
  })

  it('switches views through the segmented control', () => {
    const { onViewChange } = renderList()

    fireEvent.click(screen.getByRole('button', { name: 'Week' }))
    expect(onViewChange).toHaveBeenCalledWith('week')
    fireEvent.click(screen.getByRole('button', { name: 'Day' }))
    expect(onViewChange).toHaveBeenCalledWith('day')
  })

  it('renders the strip and the table for the list view', () => {
    renderList()

    expect(document.querySelector('[data-slot="stats-strip"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="automations-table"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-slot="automation-row"]')).toHaveLength(7)
    expect(document.querySelector('[data-slot="week-view"]')).toBeNull()
  })

  it('opens the Next runs rail from the strip', () => {
    renderList()

    fireEvent.click(screen.getByRole('button', { name: /Next runs/ }))
    // Synchronous: the sheet mounts with the state change, and fake timers would stall `findBy`.
    const rail = screen.getByRole('dialog')
    expect(rail.getAttribute('data-slot')).toBe('next-runs-rail')
    expect(within(rail).getAllByRole('button').filter((b) => b.dataset.slot === 'next-run-row')).toHaveLength(12)
  })

  it('renders the week and day calendars for their views', () => {
    renderList({ view: 'week' })
    expect(document.querySelector('[data-slot="week-view"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="automations-table"]')).toBeNull()

    cleanup()
    renderList({ view: 'day' })
    expect(document.querySelector('[data-slot="day-view"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="day-title"]')?.textContent).toBe('Wed 16 Sep')
  })
})
