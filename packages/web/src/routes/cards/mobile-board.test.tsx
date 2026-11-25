import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FrameworksResponse, RunRecord } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { cardAtGate, cardRun, HUMAN_ASK } from '@/lib/card-fixtures'
import type { CardRun, DropOutcome } from '@/lib/cards'

import { defaultBoardColumn, boardColumns } from './board-columns'
import { TasksBoardRoute } from './card-board'
import { MobileBoard } from './mobile-board'

/** The board on a phone (spec 2026-11-15-framework-board § Mobile board). */

const data = vi.hoisted(() => ({ runs: [] as RunRecord[] }))

const FRAMEWORKS: FrameworksResponse = {
  frameworks: [{ id: 'generic', name: 'Generic', source: 'builtin', stages: [{ id: 'plan', name: 'Plan' }, { id: 'build', name: 'Build' }, { id: 'review', name: 'Review' }] }],
  active: { id: 'generic', source: 'fallback' },
}

vi.mock('@/api/queries', async (original) => ({
  ...(await original<typeof import('@/api/queries')>()),
  useRuns: () => ({ data: data.runs, isPending: false }),
  useWorkspaceConfig: () => ({ data: { resources: { maxParallel: 4 } } }),
}))
vi.mock('@/api/frameworks', async (original) => ({
  ...(await original<typeof import('@/api/frameworks')>()),
  useFrameworks: () => ({ data: FRAMEWORKS, isPending: false, isError: false }),
  useFramework: () => ({ data: undefined }),
  useCardRecheckOnFocus: () => undefined,
}))

const NAMES = new Map([
  ['plan', 'Plan'],
  ['build', 'Build'],
  ['review', 'Review'],
])

/** `phone` answers the cockpit's phone query the way a 390px viewport would. */
function stubViewport(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 767px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }))
}

let location = ''
function LocationProbe() {
  const here = useLocation()
  location = `${here.pathname}${here.search}`
  return null
}

function mobile(cards: CardRun[], url = '/tasks?view=board') {
  const onMove = vi.fn<(run: CardRun, outcome: DropOutcome, readyIndex?: number) => void>()
  const onNew = vi.fn()
  const onShowList = vi.fn()
  render(
    <MemoryRouter initialEntries={[url]}>
      <LocationProbe />
      <MobileBoard
        cards={cards}
        activeStages={['plan', 'build', 'review']}
        names={NAMES}
        wip={new Map([['build', 1]])}
        framework={{ name: 'Generic', source: 'automatic' }}
        otherCount={3}
        slots={{ busy: 1, max: 4 }}
        onMove={onMove}
        onNew={onNew}
        onShowList={onShowList}
      />
    </MemoryRouter>,
  )
  return { onMove, onNew, onShowList }
}

const selectedTab = () => screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')!
/** Only the active panel is exposed — the others are `inert` + `aria-hidden` behind the snap pager. */
const visiblePanel = () => {
  const panels = screen.getAllByRole('tabpanel')
  expect(panels).toHaveLength(1)
  return panels[0]!
}
const col = () => new URLSearchParams(location.split('?')[1]).get('col')

beforeEach(() => {
  stubViewport(true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  data.runs = []
})

describe('mobile board — the route', () => {
  const route = () =>
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/tasks?view=board']}>
          <TasksBoardRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    )

  it('renders the tab strip, not the kanban, below md — and the FAB opens New card', () => {
    data.runs = [cardRun({ id: 'a', title: 'Alpha' })]
    route()
    expect(screen.getByRole('tablist', { name: 'Board columns' })).toBeTruthy()
    expect(document.querySelector('[data-slot="card-board"]')).toBeNull()
    expect(document.querySelector('[data-action="new-card"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New card' }))
    expect(document.querySelector('[data-slot="new-card-dialog"]')).not.toBeNull()
  })

  // Guard (passes both ways): the desktop board is the kanban it was.
  it('keeps the kanban at md and up', () => {
    stubViewport(false)
    data.runs = [cardRun({ id: 'a', title: 'Alpha' })]
    route()
    expect(document.querySelector('[data-slot="card-board"]')).not.toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(document.querySelector('[data-slot="new-card-fab"]')).toBeNull()
  })
})

describe('mobile board — the first column', () => {
  it('opens where a card needs you, else the first busy stage, else Ready', () => {
    const cols = (cards: CardRun[]) => defaultBoardColumn(boardColumns(cards, ['plan', 'build', 'review'], NAMES))
    expect(cols([cardRun({ id: 'b' }, { stage: 'build' }), cardAtGate('review', { id: 'g', asks: [HUMAN_ASK] })])).toBe('stage:review')
    expect(cols([cardRun({ id: 'q', status: 'queued' }), cardRun({ id: 'b' }, { stage: 'build' })])).toBe('stage:build')
    expect(cols([cardRun({ id: 'q', status: 'review' }, { stage: 'review' })])).toBe('ready')
  })

  it('pins the default in the URL, and honours ?col= over it', () => {
    mobile([cardRun({ id: 'b' }, { stage: 'build' })])
    expect(selectedTab().getAttribute('data-column')).toBe('stage:build')
    expect(col()).toBe('stage:build')
    cleanup()

    mobile([cardRun({ id: 'b' }, { stage: 'build' })], '/tasks?view=board&col=done')
    expect(selectedTab().getAttribute('data-column')).toBe('done')
    expect(visiblePanel().getAttribute('data-column')).toBe('done')
    cleanup()

    mobile([cardRun({ id: 'b' }, { stage: 'build' })], '/tasks?view=board&col=stage:nope')
    expect(selectedTab().getAttribute('data-column')).toBe('stage:build')
  })
})

describe('mobile board — switching columns', () => {
  it('a chip tap shows that column alone and writes it to the URL', () => {
    mobile([cardRun({ id: 'b', title: 'Building' }, { stage: 'build' }), cardRun({ id: 's', title: 'Shipping', status: 'review' }, { stage: 'review' })])
    expect(within(visiblePanel()).getByText('Building')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Ship,/ }))
    expect(selectedTab().getAttribute('data-column')).toBe('ship')
    expect(col()).toBe('ship')
    expect(within(visiblePanel()).getByText('Shipping')).toBeTruthy()
    expect(within(visiblePanel()).queryByText('Building')).toBeNull()
  })

  it('is a tablist with roving focus on the arrow keys', () => {
    mobile([cardRun({ id: 'b' }, { stage: 'build' })])
    const tab = selectedTab()
    expect(tab.tabIndex).toBe(0)
    expect(screen.getAllByRole('tab').filter((t) => t.tabIndex === 0)).toHaveLength(1)
    tab.focus()
    fireEvent.keyDown(tab, { key: 'ArrowRight' })
    expect(selectedTab().getAttribute('data-column')).toBe('stage:review')
    expect(document.activeElement).toBe(selectedTab())
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(selectedTab().getAttribute('data-column')).toBe('backlog')
  })

  it('names counts, a full WIP stage and a card that needs you in the chip’s label', () => {
    mobile([cardRun({ id: 'b' }, { stage: 'build' }), cardAtGate('plan', { id: 'g', asks: [HUMAN_ASK] })])
    expect(screen.getByRole('tab', { name: 'Build, 1 of 1 WIP, full' }).textContent).toContain('· 1/1')
    expect(screen.getByRole('tab', { name: 'Plan, 1 card, 1 needs you' }).querySelector('[data-slot="tab-needs-you"]')).not.toBeNull()
  })

  it('says what lands in an empty column, and filters to the cards that need you', () => {
    mobile([cardRun({ id: 'b', title: 'Building' }, { stage: 'build' }), cardAtGate('build', { id: 'g', title: 'Gated', asks: [HUMAN_ASK] })], '/tasks?view=board&col=ready')
    expect(within(visiblePanel()).getByText('Cards here start when a slot frees up.')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Build,/ }))
    fireEvent.click(screen.getByRole('button', { name: '⏸ 1 need you' }))
    expect(within(visiblePanel()).getByText('Gated')).toBeTruthy()
    expect(within(visiblePanel()).queryByText('Building')).toBeNull()
  })
})

describe('mobile board — the action sheet', () => {
  it('lists the moves the drop rules allow, and refused ones disabled with the reason', () => {
    const { onMove } = mobile([cardAtGate('build', { id: 'g', title: 'Gated', asks: [HUMAN_ASK] }), cardRun({ id: 'r', title: 'Running' }, { stage: 'plan' })], '/tasks?view=board&col=stage:plan')
    fireEvent.click(screen.getByRole('button', { name: 'Card actions for Running' }))
    const sheet = screen.getByRole('dialog')
    const approve = within(sheet).getByRole('button', { name: 'Approve & continue → Build' })
    expect(approve.getAttribute('aria-disabled')).toBe('true')
    expect(approve.textContent).toContain('this one is not waiting at one')
    fireEvent.click(approve)
    expect(onMove).not.toHaveBeenCalled()
    expect(within(sheet).getByRole('button', { name: 'Open card' })).toBeTruthy()
    expect(within(sheet).getByRole('button', { name: 'Open task view' })).toBeTruthy()
    fireEvent.keyDown(sheet, { key: 'Escape' })

    fireEvent.click(screen.getByRole('tab', { name: /^Build,/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Card actions for Gated' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve & continue → Review' }))
    expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'g' }), expect.objectContaining({ kind: 'approve', to: 'review' }), undefined)
  })

  it('picks the stage to re-run from in a second step', () => {
    const { onMove } = mobile([cardRun({ id: 's', title: 'Shipping', status: 'review' }, { stage: 'review' })], '/tasks?view=board&col=ship')
    fireEvent.click(screen.getByRole('button', { name: 'Card actions for Shipping' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Re-run from…' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Re-run from Build' }))
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: 's' }), { kind: 'rerun', fromStage: 'build' }, undefined)
  })

  it('reorders Ready with Move up / Move down', () => {
    const ready = ['a', 'b'].map((id, i) => cardRun({ id, title: `Ready ${id}`, status: 'queued' }, { order: i + 1 }))
    const { onMove } = mobile(ready, '/tasks?view=board&col=ready')
    fireEvent.click(screen.getByRole('button', { name: 'Card actions for Ready b' }))
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByRole('button', { name: 'Move down' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move up' }))
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), { kind: 'reorder' }, 0)
  })
})

describe('mobile board — header', () => {
  it('keeps slots, Change framework, the List link and Filter behind ⋯', async () => {
    const { onShowList } = mobile([cardRun({ id: 'b', title: 'Building' }, { stage: 'build' })])
    expect(screen.queryByText(/Autopick/)).toBeNull()
    const trigger = screen.getByRole('button', { name: 'Board options' })
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    })
    expect(screen.getByText('Autopick · 1/4 slots busy')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Change framework' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '+ 3 other tasks · in the List' }))
    expect(onShowList).toHaveBeenCalled()
  })
})
