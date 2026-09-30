import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Coverage } from './rows'

afterEach(cleanup)

it('labels saved partial task counts without attributing them to complete projects', () => {
  render(<Coverage
    coverage={{ projects: [{ projectId: 'saved', state: 'partial', omittedRuns: 0 }] }}
    count={1}
    retry={() => {}}
  />)
  expect(screen.getByRole('status').textContent).toContain(
    '1 tasks need you in the available data. Complete coverage: 0 of 1 projects.',
  )
  expect(screen.getByRole('status').textContent).toContain('One project has incomplete coverage.')
  expect(screen.queryByText('One project is unavailable.')).toBeNull()
})
