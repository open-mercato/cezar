import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
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
})
