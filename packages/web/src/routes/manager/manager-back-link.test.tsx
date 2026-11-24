import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { clearManagerOrigins } from '@/lib/managers'

import { ManagerBackLink } from './manager-back-link'

afterEach(() => {
  cleanup()
  clearManagerOrigins()
})

describe('ManagerBackLink', () => {
  it('renders nothing for a task not opened from a manager', () => {
    const { container } = render(<MemoryRouter><ManagerBackLink runId="r1" /></MemoryRouter>)
    expect(container.textContent).toBe('')
  })

  it('names the manager and leads home', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/p/a/tasks/r1', state: { manager: { id: 'g', name: 'Global' } } }]}>
        <ManagerBackLink runId="r1" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Back to Global' }).getAttribute('href')).toBe('/manager/g')
  })

  it('returns to the exact decision from a task or its assets', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/p/a/tasks/r1/assets', state: { manager: { id: 'g', name: 'Global', decision: 'm:2' } } }]}>
        <ManagerBackLink runId="r1" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Back to Global' }).getAttribute('href')).toBe('/manager/g#decision-m%3A2')
  })

  it('from a manager\'s Tasks table, offers both the filtered list and the manager', () => {
    function Probe() {
      const location = useLocation()
      return <span data-testid="at">{`${location.pathname}${location.search} ${JSON.stringify(location.state)}`}</span>
    }
    render(
      <MemoryRouter initialEntries={[{ pathname: '/p/a/tasks/r1', state: { manager: { id: 'g', name: 'Global', tasks: '/tasks?manager=g' } } }]}>
        <Routes>
          <Route path="/p/a/tasks/r1" element={<ManagerBackLink runId="r1" />} />
          <Route path="*" element={null} />
        </Routes>
        <Probe />
      </MemoryRouter>,
    )
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(crumbs.textContent).toBe('GlobalTasks started')
    expect(screen.getByRole('link', { name: 'Back to Global' }).getAttribute('href')).toBe('/manager/g')
    const list = screen.getByRole('link', { name: 'Back to tasks started by Global' })
    expect(list.getAttribute('href')).toBe('/tasks?manager=g')
    fireEvent.click(list)
    // The list is asked to come back where it was left.
    expect(screen.getByTestId('at').textContent).toBe('/tasks?manager=g {"restoreScroll":true}')
  })

  it('ignores a list path that is not the Tasks table', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/p/a/tasks/r1', state: { manager: { id: 'g', name: 'Global', tasks: 'https://evil.example/' } } }]}>
        <ManagerBackLink runId="r1" />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Back to Global' }).textContent).toBe('Back to Global')
  })
})
