import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { AttentionItem } from '@open-mercato/cezar-api-client'
import { managerFixture } from '@/routes/manager/manager-fixtures'

import { ManagerNowView } from './manager-now'
import { managerNowEntries } from './manager-now-model'

/** Manager mode's Now: All managers by default, a filter for one (spec 2026-11-23-needs-you-triage). */

const item = (over: Partial<AttentionItem> & Pick<AttentionItem, 'key' | 'kind'>): AttentionItem => ({ title: over.key, since: new Date().toISOString(), counted: true, ...over })
const managers = [
  { ...managerFixture({ id: 'scout', name: 'Scout' }), followedTasks: ['app/r1'] },
  { ...managerFixture({ id: 'mobile', name: 'Mobile app creator' }), followedTasks: [] },
]
const ITEMS = [
  item({ key: 'q', kind: 'question', title: 'Which API?', managerId: 'scout', managerName: 'Scout', questionKey: 'm:scout:1' }),
  item({ key: 'a', kind: 'approval', title: 'Merge #12', managerId: 'mobile', managerName: 'Mobile app creator', actionId: 'x' }),
  item({ key: 't', kind: 'review', title: 'Fix login', projectId: 'app', runId: 'r1' }),
]

const actions = { answer: vi.fn(async () => undefined), decide: vi.fn(async () => undefined), markRead: vi.fn(async () => undefined) }
const triage = { dismiss: vi.fn(), dismissAll: vi.fn(), snooze: vi.fn(), keep: vi.fn() }

function renderView(props: Partial<ComponentProps<typeof ManagerNowView>> = {}) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))))
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/manager/now']}>
        <ManagerNowView entries={managerNowEntries(ITEMS, managers)} managers={managers} filter={undefined} onFilter={vi.fn()}
          pendingQuestions={new Set()} running={[]} actions={actions} triage={triage} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const keysShown = () => [...document.querySelectorAll('[data-slot="manager-now-needs-you"] [data-slot="now-attention-row"]')]
  .filter((row) => !row.closest('[data-slot="now-probably-done"]')).map((row) => row.getAttribute('data-key'))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ManagerNowView', () => {
  it('shows every manager’s items by default, a task naming its manager', () => {
    renderView()
    expect(keysShown()).toEqual(['q', 'a', 't'])
    expect(document.querySelector('[data-slot="manager-now-needs-you"]')?.getAttribute('data-count')).toBe('3')
    expect(document.querySelector('[data-key="t"]')?.textContent).toContain('Task of Scout')
    expect(document.querySelector('[data-slot="manager-now-filter"]')?.textContent).toContain('All managers')
    expect(document.querySelector('[data-slot="manager-now-filtered"]')).toBeNull()
  })

  it('filters to one manager from the menu, with a way back to all', async () => {
    const onFilter = vi.fn()
    renderView({ onFilter })
    fireEvent.pointerDown(document.querySelector('[data-slot="manager-now-filter"]')!, { button: 0, pointerType: 'mouse' })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual(['All managers3', 'Scout2', 'Mobile app creator1'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Scout/ }))
    expect(onFilter).toHaveBeenCalledWith('scout')
  })

  it('filtered, shows only that manager’s items and says so', () => {
    const onFilter = vi.fn()
    renderView({ filter: 'scout', onFilter })
    expect(keysShown()).toEqual(['q', 't'])
    expect(document.querySelector('[data-slot="manager-now-filtered"]')?.textContent).toContain('Showing Scout')
    fireEvent.click(document.querySelector('[data-slot="manager-now-show-all"]')!)
    expect(onFilter).toHaveBeenCalledWith(undefined)
  })

  it('the phone’s floating filter names what it shows, and clears to all', () => {
    const onFilter = vi.fn()
    renderView({ filter: 'mobile', onFilter })
    const fab = document.querySelector('[data-slot="manager-now-filter-fab"]')!
    expect(fab.textContent).toBe('Mobile app creator')
    expect(fab.getAttribute('data-filter')).toBe('mobile')
    fireEvent.click(document.querySelector('[data-slot="manager-now-fab-clear"]')!)
    expect(onFilter).toHaveBeenCalledWith(undefined)
    cleanup()
    renderView()
    expect(document.querySelector('[data-slot="manager-now-filter-fab"]')?.textContent).toBe('All managers')
    expect(document.querySelector('[data-slot="manager-now-fab-clear"]')).toBeNull()
  })

  it('leaves out dismissed items and folds probably-done ones', () => {
    const settled = item({ key: 'old', kind: 'question', managerId: 'scout', managerName: 'Scout', settled: { why: 'quiet', detail: 'Quiet for 9 days' } })
    renderView({ entries: managerNowEntries([...ITEMS, settled], managers), overrides: [{ key: 'a', mode: 'dismiss', at: new Date().toISOString() }] })
    expect(keysShown()).toEqual(['q', 't'])
    expect(document.querySelector('[data-slot="now-probably-done"]')?.textContent).toContain('Probably done1')
  })
})
