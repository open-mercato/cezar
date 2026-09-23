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

  it('offers Pause for an enabled automation and Enable for a paused one', () => {
    const { actions } = renderActions()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(actions.toggleEnabled).toHaveBeenCalledWith(NIGHTLY)

    cleanup()
    const paused = renderActions(FLAKY)
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    expect(paused.actions.toggleEnabled).toHaveBeenCalledWith(FLAKY)
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
