import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FLAKY, NIGHTLY, mockActions, stubResizeObserver } from './automations-list.fixtures'
import { RowActions } from './row-actions'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(stubResizeObserver)

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

/** The cell sits in a clickable row — every action must stop there, or a pause would also navigate. */
function renderActions(automation = NIGHTLY, actions = mockActions()) {
  const rowClick = vi.fn()
  render(
    <MemoryRouter initialEntries={['/automations']}>
      <div data-testid="row" onClick={rowClick}>
        <RowActions automation={automation} actions={actions} />
      </div>
      <LocationProbe />
    </MemoryRouter>,
  )
  return { actions, rowClick }
}

/** Radix opens the menu on pointerdown, not click. */
async function openMenu(): Promise<HTMLElement> {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }))
  return await screen.findByRole('menu')
}

describe('RowActions', () => {
  it('runs now without opening the row', () => {
    const { actions, rowClick } = renderActions()

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(actions.runNow).toHaveBeenCalledWith(NIGHTLY)
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('offers Pause for an enabled automation and Enable for a paused one', async () => {
    const { actions } = renderActions()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    // Nothing pending: the pause lands without a dialog.
    await waitFor(() => expect(actions.toggleEnabled).toHaveBeenCalledWith(NIGHTLY))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    cleanup()
    const paused = renderActions(FLAKY)
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    expect(paused.actions.toggleEnabled).toHaveBeenCalledWith(FLAKY)
  })

  const WORK = {
    queued: [
      { id: 'q1', title: 'fresh', status: 'queued' as const, kind: 'never-started' as const },
      { id: 'q2', title: 'resumed', status: 'queued' as const, kind: 'continuation' as const, rootRunId: 'r1' },
    ],
    active: [{ id: 'r1', title: 'root', status: 'running' as const }],
  }

  it('discloses pending work before pausing, and pauses without cancelling by default (#1980)', async () => {
    const { actions, rowClick } = renderActions(NIGHTLY, mockActions({ loadWork: vi.fn(() => Promise.resolve(WORK)) }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(actions.toggleEnabled).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain('2 queued tasks (1 never started, 1 continuing earlier work) will still start')
    expect(dialog.textContent).toContain('1 task is running or waiting and will keep going')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(actions.toggleEnabled).toHaveBeenCalledWith(NIGHTLY))
    expect(actions.cancelQueued).not.toHaveBeenCalled()
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('pauses and then cancels the queued tasks when asked to (#1980)', async () => {
    const { actions } = renderActions(NIGHTLY, mockActions({ loadWork: vi.fn(() => Promise.resolve(WORK)) }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause and cancel 2 queued tasks' }))
    await waitFor(() => expect(actions.cancelQueued).toHaveBeenCalledWith(NIGHTLY))
    expect(actions.toggleEnabled).toHaveBeenCalledWith(NIGHTLY)
  })

  it('still pauses when the pending-work read fails (#1980)', async () => {
    const { actions } = renderActions(NIGHTLY, mockActions({ loadWork: vi.fn(() => Promise.resolve(undefined)) }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(actions.toggleEnabled).toHaveBeenCalledWith(NIGHTLY))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('backs out of the pause from the disclosure (#1980)', async () => {
    const { actions } = renderActions(NIGHTLY, mockActions({ loadWork: vi.fn(() => Promise.resolve(WORK)) }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(actions.toggleEnabled).not.toHaveBeenCalled()
    expect(actions.cancelQueued).not.toHaveBeenCalled()
  })

  it('cancels a paused automation\'s queued tasks from its menu (#1980)', async () => {
    const { actions } = renderActions(FLAKY, mockActions({ loadWork: vi.fn(() => Promise.resolve(WORK)) }))
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Pending tasks…' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).queryByRole('button', { name: 'Pause' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel 2 queued tasks' }))
    await waitFor(() => expect(actions.cancelQueued).toHaveBeenCalledWith(FLAKY))
    expect(actions.toggleEnabled).not.toHaveBeenCalled()
  })

  it('disables the direct actions while a mutation is in flight', () => {
    renderActions(NIGHTLY, mockActions({ busy: true }))

    expect(screen.getByRole('button', { name: 'Run now' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveProperty('disabled', true)
  })

  it('lists the More menu in the design order with Delete set apart', async () => {
    const { rowClick } = renderActions()
    const menu = await openMenu()

    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Edit',
      'View log',
      'Duplicate',
      'Copy as CLI',
      'Delete',
    ])
    expect(menu.querySelector('[data-slot="dropdown-menu-separator"]')).not.toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'Delete' }).getAttribute('data-variant')).toBe('destructive')
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('duplicates from the menu', async () => {
    const { actions, rowClick } = renderActions()
    const menu = await openMenu()

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }))
    expect(actions.duplicate).toHaveBeenCalledWith(NIGHTLY)
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('copies the CLI line from the menu', async () => {
    const { actions } = renderActions()
    const menu = await openMenu()

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy as CLI' }))
    expect(actions.copyCli).toHaveBeenCalledWith(NIGHTLY)
  })

  it('navigates to the editor and the log from the menu', async () => {
    renderActions()
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByTestId('location').textContent).toBe('/automations/a1')

    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'View log' }))
    expect(screen.getByTestId('location').textContent).toBe('/automations/a1/log')
  })

  it('asks before deleting, and only then removes', async () => {
    const { actions, rowClick } = renderActions()
    const menu = await openMenu()

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Delete “Nightly dependency bump”?')
    expect(actions.remove).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(actions.remove).toHaveBeenCalledWith(NIGHTLY)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('cancels the delete confirm without removing', async () => {
    const { actions } = renderActions()
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(actions.remove).not.toHaveBeenCalled()
  })
})

it('offers preview for a tracker without launching or opening its row', () => {
  const tracker = { ...FLAKY, kind: 'tracker' as const }
  const { actions, rowClick } = renderActions(tracker)
  fireEvent.click(screen.getByRole('button', { name: 'Preview matches' }))
  expect(actions.preview).toHaveBeenCalledWith(tracker)
  expect(actions.runNow).not.toHaveBeenCalled()
  expect(rowClick).not.toHaveBeenCalled()
})
