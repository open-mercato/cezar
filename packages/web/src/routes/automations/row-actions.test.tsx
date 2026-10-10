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

/** The cell sits in a clickable row — every action must stop there, or a run would also navigate. */
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
  it('runs now from the menu without opening the row', async () => {
    const { actions, rowClick } = renderActions()

    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Run now' }))
    expect(actions.runNow).toHaveBeenCalledWith(NIGHTLY)
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('leaves Pause and Enable to the row switch — the cell is one menu', async () => {
    renderActions()
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['More'])
    const menu = await openMenu()
    expect(within(menu).queryByRole('menuitem', { name: 'Pause' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: 'Enable' })).toBeNull()
  })

  it('disables the launching actions while a mutation is in flight', async () => {
    const tracker = { ...FLAKY, kind: 'tracker' as const }
    const { actions } = renderActions(tracker, mockActions({ busy: true }))
    const menu = await openMenu()

    const runNow = within(menu).getByRole('menuitem', { name: 'Run now' })
    const preview = within(menu).getByRole('menuitem', { name: 'Preview matches' })
    expect(runNow.getAttribute('aria-disabled')).toBe('true')
    expect(preview.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(runNow)
    fireEvent.click(preview)
    expect(actions.runNow).not.toHaveBeenCalled()
    expect(actions.preview).not.toHaveBeenCalled()
    // Navigation stays reachable — only what launches waits for the mutation.
    expect(within(menu).getByRole('menuitem', { name: 'Edit' }).getAttribute('aria-disabled')).toBeNull()
  })

  it('lists the menu in the design order with Delete set apart', async () => {
    const { rowClick } = renderActions()
    const menu = await openMenu()

    // A schedule has nothing to preview.
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Run now',
      'Edit',
      'View log',
      'Duplicate',
      'Copy as CLI',
      'Delete',
    ])
    expect(menu.querySelectorAll('[data-slot="dropdown-menu-separator"]')).toHaveLength(2)
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

it('offers preview for a tracker without launching or opening its row', async () => {
  const tracker = { ...FLAKY, kind: 'tracker' as const }
  const { actions, rowClick } = renderActions(tracker)
  const menu = await openMenu()
  expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent).slice(0, 2)).toEqual(['Run now', 'Preview matches'])
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Preview matches' }))
  expect(actions.preview).toHaveBeenCalledWith(tracker)
  expect(actions.runNow).not.toHaveBeenCalled()
  expect(rowClick).not.toHaveBeenCalled()
})
