import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { TasksOverview } from './tasks-overview'
import { taskActionEligible } from './tasks-overview-actions'

const stamp = '2026-10-30T12:00:00.000Z'
const run = (id: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  id, title: id, task: id, workflow: 'default', status: 'done', archived: false,
  createdAt: stamp, finishedAt: stamp, tokensUsed: 0, steps: [], ...extra,
})
function Location() { return <output data-testid="location">{useLocation().pathname}</output> }
function overview(props: Partial<ComponentProps<typeof TasksOverview>> = {}) {
  return <MemoryRouter><Location /><TasksOverview runs={[]} view="active" onViewChange={vi.fn()}
    onArchiveFinished={vi.fn()} onMarkAllRead={vi.fn()} onRename={vi.fn()} {...props} /></MemoryRouter>
}
function row(id: string, card = false) {
  const node = document.querySelector(`[data-slot="${card ? 'task-card' : 'task-table-row'}"][data-run-id="${id}"]`)
  if (!(node instanceof HTMLElement)) throw new Error(`Missing ${id}`)
  return within(node)
}
const select = (id: string, card = false) => fireEvent.click(row(id, card).getByRole('checkbox', { name: `Select ${id}` }))
afterEach(cleanup)

describe('Tasks selected and quick actions (#1599)', () => {
  it('archives only picked eligible rows and reports skipped live rows without navigating', async () => {
    const onTaskAction = vi.fn().mockResolvedValue(undefined)
    render(overview({ runs: [run('chosen'), run('untouched'), run('live', { status: 'running' })], onTaskAction }))
    select('chosen')
    select('live')
    expect((screen.getByRole('checkbox', { name: 'Select displayed tasks' }) as HTMLInputElement).indeterminate).toBe(true)
    expect(screen.getByTestId('location').textContent).toBe('/')
    fireEvent.click(screen.getByRole('button', { name: 'Archive (1)' }))
    await waitFor(() => expect(screen.getByRole('status', { name: 'Task action status' }).textContent).toContain('1 succeeded, 1 skipped, 0 failed'))
    expect(onTaskAction.mock.calls.map(([r, action]) => [r.id, action])).toEqual([['chosen', 'archive']])
    expect(row('live').queryByRole('button', { name: 'Archive: live' })).toBeNull()
  })

  it('supports mobile selection and quick read actions without hijacking card navigation', async () => {
    const onTaskAction = vi.fn().mockResolvedValue(undefined)
    render(overview({ runs: [run('mobile')], onTaskAction }))
    select('mobile', true)
    expect((row('mobile').getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('location').textContent).toBe('/')
    fireEvent.click(row('mobile', true).getByRole('button', { name: 'Mark read: mobile' }))
    await waitFor(() => expect(onTaskAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'mobile' }), 'read'))
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('restores archived selections and excludes them from read/unread', async () => {
    const onTaskAction = vi.fn().mockResolvedValue(undefined)
    render(overview({ view: 'archived', runs: [run('old', { archived: true })], onTaskAction }))
    select('old')
    expect((screen.getByRole('button', { name: 'Mark unread (0)' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Restore (1)' }))
    await waitFor(() => expect(onTaskAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }), 'restore'))
  })

  it('prunes selections hidden by a search or tab, even when they later return', () => {
    const props = { runs: [run('apple'), run('banana')], onTaskAction: vi.fn() }
    const view = render(overview(props))
    select('banana')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'apple' } })
    expect(screen.queryByText('1 selected')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: '' } })
    expect((row('banana').getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    select('banana')
    view.rerender(overview({ ...props, view: 'archived' }))
    view.rerender(overview(props))
    expect((row('banana').getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('selects displayed tree rows, excluding collapsed children', async () => {
    const onTaskAction = vi.fn().mockResolvedValue(undefined)
    render(overview({ runs: [run('parent'), run('child', { dispatch: { rootRunId: 'parent', parentRunId: 'parent' } }), run('other')], onTaskAction }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select displayed tasks' }))
    expect(screen.getByText('2 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Archive (2)' }))
    await waitFor(() => expect(onTaskAction).toHaveBeenCalledTimes(2))
    expect(onTaskAction.mock.calls.map(([r]) => r.id).sort()).toEqual(['other', 'parent'])
  })

  it('bounds execution, blocks duplicate submissions and keeps failures selected for retry', async () => {
    let release: (() => void) | undefined
    const onTaskAction = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
      .mockRejectedValueOnce(new Error('Cannot update task')).mockResolvedValue(undefined)
    render(overview({ runs: [run('first'), run('second')], onTaskAction }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select displayed tasks' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive (2)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive (2)' }))
    expect(onTaskAction).toHaveBeenCalledTimes(1)
    expect((row('second').getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
    await act(async () => release?.())
    await waitFor(() => expect(screen.getByRole('status', { name: 'Task action status' }).textContent).toContain('1 succeeded, 0 skipped, 1 failed'))
    expect(screen.getByRole('status', { name: 'Task action status' }).textContent).toContain('Cannot update task')
    expect(screen.getByText('1 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Archive (1)' }))
    await waitFor(() => expect(onTaskAction).toHaveBeenCalledTimes(3))
    expect(onTaskAction.mock.calls[2]?.[0].id).toBe('second')
  })

  it('selects rows beyond the mounted virtual window and can clear the selection', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    try {
      render(overview({ runs: Array.from({ length: 300 }, (_, index) => run(`task-${index}`)), onTaskAction: vi.fn() }))
      expect(document.querySelectorAll('[data-slot="task-table-row"]').length).toBeLessThan(300)
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select displayed tasks' }))
      expect(screen.getByText('300 selected')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Archive (300)' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
      expect(screen.queryByText('300 selected')).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('marks only the eligible subset read or unread', async () => {
    const onTaskAction = vi.fn().mockResolvedValue(undefined)
    render(overview({ runs: [run('unread'), run('read', { seenAt: stamp }), run('cancelled', { status: 'cancelled' })], onTaskAction }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select displayed tasks' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark unread (1)' }))
    await waitFor(() => expect(screen.getByRole('status', { name: 'Task action status' }).textContent).toContain('1 succeeded, 2 skipped'))
    expect(onTaskAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'read' }), 'unread')
    fireEvent.click(screen.getByRole('button', { name: 'Mark read (1)' }))
    await waitFor(() => expect(onTaskAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'unread' }), 'read'))
  })

  it('uses current live records to withdraw eligibility after a status change', () => {
    const props = { runs: [run('changing')], onTaskAction: vi.fn() }
    const view = render(overview(props))
    select('changing')
    view.rerender(overview({ ...props, runs: [run('changing', { status: 'running' })] }))
    expect((screen.getByRole('button', { name: 'Archive (0)' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('preserves canonical read-state exceptions and inverse actions', () => {
    expect(taskActionEligible(run('unread'), 'read')).toBe(true)
    expect(taskActionEligible(run('read', { seenAt: stamp }), 'unread')).toBe(true)
    for (const extra of [{ status: 'cancelled' as const }, { archived: true }, { status: 'failed' as const, autoResumeAt: stamp },
      { status: 'failed' as const, awaitingAnswerSince: stamp }, { finishedAt: undefined }]) {
      expect(taskActionEligible(run('exception', extra), 'read')).toBe(false)
      expect(taskActionEligible(run('exception', extra), 'unread')).toBe(false)
    }
  })
})
