import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'

import { TasksOverview } from './tasks-overview'
import { planLimitCell, PlanLimitCellView, planWindowsByRun } from './tasks-plan-limit'
import { planEntry } from './task-thread/__fixtures__/plan-usage'

afterEach(cleanup)

const started = { startedAt: new Date(Date.now() - 3_600_000).toISOString() }

describe('planLimitCell', () => {
  it('is a dash until the ledger answers, and for a run that never started', () => {
    expect(planLimitCell({ id: 'a', ...started }, undefined, 'claude')).toEqual({ kind: 'none' })
    expect(planLimitCell({ id: 'a' }, [], 'claude')).toEqual({ kind: 'none' })
  })

  it('says "not measured yet" for Claude/Codex and "not reported" for other tools — never 0%', () => {
    expect(planLimitCell({ id: 'a', ...started }, [], undefined).kind).toBe('not-measured')
    expect(planLimitCell({ id: 'a', runner: 'codex', ...started }, [], 'claude').kind).toBe('not-measured')
    expect(planLimitCell({ id: 'a', runner: 'opencode', ...started }, [], 'claude').kind).toBe('not-reported')
    expect(planLimitCell({ id: 'a', ...started }, [], 'cursor').kind).toBe('not-reported')
  })

  it('is a dash, not "not measured yet", for a run older than the loaded two weeks', () => {
    const old = { startedAt: new Date(Date.now() - 20 * 86_400_000).toISOString() }
    expect(planLimitCell({ id: 'a', ...old }, [], 'claude')).toEqual({ kind: 'none' })
  })

  it('shows the first window, the later ones as "+N% next", and the markers', () => {
    const entries = [
      planEntry('a', '2026-11-19T20:00:00.000Z', { estimatePp: 2, sharedEstimatePp: 0, aloneInferredPp: 2 }),
      planEntry('a', '2026-11-19T15:00:00.000Z', { estimatePp: 14, retryWasteEstimatePp: 3 }),
      planEntry('other', '2026-11-19T15:00:00.000Z'),
    ]
    const cell = planLimitCell({ id: 'a', ...started }, entries, 'claude')
    expect(cell).toMatchObject({ kind: 'share', estimatePp: 14, nextPp: 2, retry: true, alone: false })
    expect(cell.kind === 'share' && cell.title).toMatch(/^Claude · default · 5-hour limit /)
  })

  it('marks "alone" only when no window was shared', () => {
    const cell = planLimitCell({ id: 'a', ...started }, [planEntry('a', '2026-11-19T15:00:00.000Z', { sharedEstimatePp: 0, aloneInferredPp: 18, estimatePp: 18 })], 'claude')
    expect(cell).toMatchObject({ kind: 'share', alone: true, retry: false, nextPp: 0 })
  })

  it('groups one response per run, five-hour task windows only', () => {
    const byRun = planWindowsByRun([
      planEntry('a', '2026-11-19T15:00:00.000Z'),
      planEntry('a', '2026-11-24T15:00:00.000Z', {}, { kind: 'weekly' }),
      planEntry('m', '2026-11-19T15:00:00.000Z', { kind: 'manager', runId: undefined, managerId: 'm' }),
    ])
    expect([...byRun.keys()]).toEqual(['a'])
    expect(byRun.get('a')).toHaveLength(1)
  })
})

describe('PlanLimitCellView', () => {
  it('prints the estimate with ≈, the bar and the markers', () => {
    render(<PlanLimitCellView cell={{ kind: 'share', estimatePp: 14, nextPp: 2, retry: true, alone: false, title: '' }} />)
    expect(screen.getByText('≈ 14% 5h')).toBeTruthy()
    expect(screen.getByLabelText('Part went to a failed attempt').textContent).toBe('↻')
    expect(screen.getByText('+2% next')).toBeTruthy()
    expect(document.querySelector('[data-slot="plan-limit-alone"]')).toBeNull()
    expect((document.querySelector('[data-slot="plan-limit-bar"]') as HTMLElement).style.width).toBe('14%')
  })

  it('keeps ≈ next to "alone"', () => {
    render(<PlanLimitCellView cell={{ kind: 'share', estimatePp: 18, nextPp: 0, retry: false, alone: true, title: '' }} />)
    expect(document.querySelector('[data-slot="plan-limit"]')?.textContent).toBe('≈ 18% 5halone')
  })

  it('never prints 0% for an unknown share', () => {
    render(<PlanLimitCellView cell={{ kind: 'not-reported' }} />)
    expect(screen.getByText('not reported')).toBeTruthy()
    cleanup()
    render(<PlanLimitCellView cell={{ kind: 'not-measured' }} />)
    expect(screen.getByText('not measured yet')).toBeTruthy()
  })
})

describe('TasksOverview — Plan limit column', () => {
  const run = (id: string, extra: Partial<RunRecord> = {}): RunRecord => ({
    id,
    title: id,
    workflow: 'quick-task',
    task: id,
    status: 'done',
    createdAt: '2026-11-19T10:00:00.000Z',
    startedAt: '2026-11-19T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...extra,
  }) as RunRecord

  const renderTable = (props: Partial<React.ComponentProps<typeof TasksOverview>>) =>
    render(
      <MemoryRouter>
        <TasksOverview
          runs={[run('a'), run('b', { runner: 'opencode' }), run('c')]}
          view="active"
          onViewChange={() => undefined}
          onArchiveFinished={() => undefined}
          onMarkAllRead={() => undefined}
          onRename={() => undefined}
          {...props}
        />
      </MemoryRouter>,
    )
  const cell = (id: string) =>
    document.querySelector(`[data-slot="task-table-row"][data-run-id="${id}"] td[data-column-id="planLimit"]`)

  it('is folded by default', () => {
    renderTable({ planUsage: [planEntry('a', '2026-11-19T15:00:00.000Z')] })
    expect(document.querySelector('th[data-column-id="planLimit"]')?.getAttribute('data-folded')).toBe('true')
    expect(cell('a')?.textContent).toBe('')
  })

  it('fills each row from one response when opened, with the header ⓘ', () => {
    renderTable({
      expandedColumns: { planLimit: true },
      defaultRunner: 'claude',
      planUsage: [planEntry('a', '2026-11-19T15:00:00.000Z', { estimatePp: 25, retryWasteEstimatePp: 2 })],
    })
    expect(cell('a')?.textContent).toBe('≈ 25% 5h↻')
    expect(cell('a')?.getAttribute('title')).toMatch(/^Claude · default · 5-hour limit/)
    expect(cell('b')?.textContent).toBe('not reported')
    expect(cell('c')?.textContent).toBe('not measured yet')
    expect(document.querySelector('th[data-column-id="planLimit"] [data-slot="column-hint"]')?.getAttribute('aria-label')).toMatch(/^About Plan limit: /)
  })

  it('shows dashes, not "not measured yet", while the ledger has not answered', () => {
    renderTable({ expandedColumns: { planLimit: true } })
    expect(cell('a')?.textContent).toBe('—')
  })
})
