import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiScope, type UiState } from '@open-mercato/cezar-api-client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AutomationsList } from './automations-list'
import { NOW, entry, mockActions, response, stubResizeObserver } from './automations-list.fixtures'
import type { AutomationsView } from './automations-route'
import { getUiState, putUiState } from '@/api/client'

vi.mock('@/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  getUiState: vi.fn(async () => ({})),
  putUiState: vi.fn(async (patch: UiState) => patch),
}))

beforeEach(() => {
  stubResizeObserver()
  setApiScope(null)
  vi.mocked(putUiState).mockClear()
  vi.mocked(getUiState).mockReset().mockResolvedValue({})
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function renderList(props: Partial<Parameters<typeof AutomationsList>[0]> = {}, prefs: UiState | null = {}) {
  const onViewChange = vi.fn<(view: AutomationsView) => void>()
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  if (prefs !== null) queryClient.setQueryData(['default', 'ui-state'], prefs)
  render(
    <QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={['/automations']}>
      <AutomationsList data={response()} actions={mockActions()} view="list" onViewChange={onViewChange} {...props} />
    </MemoryRouter>
    </QueryClientProvider>,
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

  it('saves keyboard-accessible manual moves and preserves them across alternate sorts and reload', async () => {
    renderList({}, { automationList: { sort: 'manual', order: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'] } })
    const order = () => [...document.querySelectorAll('[data-slot="automation-row"]')].map((row) => row.getAttribute('data-automation'))
    const before = order()
    const first = document.querySelector<HTMLElement>('[data-slot="automation-row"]')
    if (first === null) throw new Error('The fixture must render an automation row')
    fireEvent.click(within(first as HTMLElement).getByRole('button', { name: /Move .* down/ }))
    await waitFor(() => expect(order().slice(0, 2)).toEqual([before[1], before[0]]))
    await waitFor(() => expect(putUiState).toHaveBeenCalled())
    const moved = order()
    fireEvent.click(within(screen.getByRole('group', { name: 'Sort automations' })).getByRole('button', { name: 'Name' }))
    await waitFor(() => expect(document.querySelector('[aria-label^="Reorder "]')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }))
    await waitFor(() => expect(order()).toEqual(moved))
    await waitFor(() => expect(vi.mocked(putUiState).mock.calls.at(-1)?.[0].automationList?.sort).toBe('manual'))
    const saved = vi.mocked(putUiState).mock.calls.at(-1)?.[0]
    if (saved === undefined) throw new Error('The manual move must be persisted')
    cleanup()
    renderList({}, saved)
    expect(order()).toEqual(moved)
  })

  it('keeps alphabetic order as the default and uses the saved Next run sort', () => {
    renderList()
    expect(screen.getByRole('button', { name: 'Name' }).getAttribute('aria-pressed')).toBe('true')
    cleanup()
    renderList({}, { automationList: { sort: 'nextRun' } })
    expect(screen.getByRole('button', { name: 'Next run' }).getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[aria-label^="Reorder "]')).toBeNull()
  })

  it('keeps the list readable while preferences load and offers recovery from a failed read', async () => {
    vi.mocked(getUiState).mockRejectedValueOnce(new Error('permission denied'))
    renderList({}, null)
    expect(screen.getByText('Loading saved order…')).toBeTruthy()
    expect(document.querySelectorAll('[data-slot="automation-row"]')).toHaveLength(7)
    await waitFor(() => expect(screen.getByText('Saved order unavailable.')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Manual' }).closest('fieldset')?.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText('Saved order unavailable.')).toBeNull())
    expect(screen.getByRole('button', { name: 'Manual' }).closest('fieldset')?.disabled).toBe(false)
  })

  it('keeps every row visible and explains the manual-placement cap', () => {
    const large = response({ automations: Array.from({ length: 201 }, (_, index) => entry({
      id: `automation-${index}`, name: `Automation ${index}`, kind: 'schedule',
    })) })
    renderList({ data: large }, { automationList: { sort: 'manual' } })
    expect(document.querySelectorAll('[data-slot="automation-row"]')).toHaveLength(201)
    expect(screen.getByText('Manual placement supports up to 200 automations.')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Move / }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
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
