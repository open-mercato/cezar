import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router'
import { useDashboardFilter } from './url-filter'
afterEach(cleanup)
function Filters() {
  const [usage, setUsage] = useDashboardFilter('usagePeriod', ['all', '7d', '30d'] as const, 'all')
  const [trend, setTrend] = useDashboardFilter('trendPeriod', ['7d', '30d'] as const, '7d')
  return <><button onClick={() => setUsage('30d')}>Usage: {usage}</button><button onClick={() => setTrend('30d')}>Trend: {trend}</button><output>{useLocation().search}</output><span data-testid="entry">{JSON.stringify(useLocation().state)}</span></>
}
it('reads independent saved periods and preserves other dashboard parameters when changing both', () => {
  render(<MemoryRouter initialEntries={['/?view=costs&period=30d&usagePeriod=7d&trendPeriod=7d']}><Filters /></MemoryRouter>)
  fireEvent.click(screen.getByText('Usage: 7d'))
  fireEvent.click(screen.getByText('Trend: 7d'))
  const value = new URLSearchParams(screen.getByRole('status').textContent!)
  expect(Object.fromEntries(value)).toEqual({ view:'costs',period:'30d',usagePeriod:'30d',trendPeriod:'30d' })
})
it('uses defaults for invalid shared links', () => {
  render(<MemoryRouter initialEntries={['/?usagePeriod=garbage&trendPeriod=all']}><Filters /></MemoryRouter>)
  expect(screen.getByText('Usage: all')).toBeTruthy()
  expect(screen.getByText('Trend: 7d')).toBeTruthy()
})

it('keeps the original entry identity and unrelated state across repeated filter replacements', () => {
  render(<MemoryRouter initialEntries={[{ pathname: '/', key: 'original', state: { other: 'kept' } }]}><Filters /></MemoryRouter>)
  fireEvent.click(screen.getByText('Usage: all'))
  fireEvent.click(screen.getByText('Trend: 7d'))
  expect(JSON.parse(screen.getByTestId('entry').textContent!)).toEqual({ other: 'kept', dashboardEntry: 'original' })
})
