import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SIDEBAR_WIDTH_STORAGE_KEY } from '@/lib/sidebar-width'
import { SidebarFrame, useSidebarWidth } from './sidebar-frame'

/**
 * The shared width store (spec 2026-10-13-unified-settings, "one shared sidebar width"): the
 * app sidebar and the settings sidebar are different components mounted at different times,
 * and the app shell stays mounted while settings is open — so a width dragged in ONE column must
 * reach every other mounted instance live, not on the next reload.
 */

/** Two independent consumers of the hook, the way the app shell and the settings frame are. */
function Column({ slot }: { slot: string }) {
  const [width, onWidthChange] = useSidebarWidth()
  return (
    <SidebarFrame slot={slot} width={width} onWidthChange={onWidthChange}>
      <span data-testid={`${slot}-width`}>{width}</span>
    </SidebarFrame>
  )
}

beforeEach(() => localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY))
afterEach(() => {
  cleanup()
  localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY)
})

const frame = (slot: string) => document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!
const handle = (slot: string) => frame(slot).querySelector<HTMLElement>('[data-slot="sidebar-resize-handle"]')!

describe('useSidebarWidth — one width for every sidebar, live', () => {
  it('seeds every instance from the stored preference', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '350')
    render(<><Column slot="sidebar" /><Column slot="settings-sidebar" /></>)
    expect(frame('sidebar').style.width).toBe('350px')
    expect(frame('settings-sidebar').style.width).toBe('350px')
  })

  it('a drag on one column moves the OTHER mounted column too, and persists', () => {
    render(<><Column slot="sidebar" /><Column slot="settings-sidebar" /></>)
    expect(frame('sidebar').style.width).toBe('264px')

    // Resize the settings column with the keyboard (the handle's splitter contract).
    fireEvent.keyDown(handle('settings-sidebar'), { key: 'ArrowRight' })
    fireEvent.keyDown(handle('settings-sidebar'), { key: 'ArrowRight' })

    expect(frame('settings-sidebar').style.width).toBe('296px')
    // The app column was mounted the whole time and never touched — it follows anyway.
    expect(frame('sidebar').style.width).toBe('296px')
    expect(screen.getByTestId('sidebar-width').textContent).toBe('296')
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('296')
  })

  it('a width written by another tab (storage event) reaches mounted columns', () => {
    render(<Column slot="sidebar" />)
    act(() => {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '400')
      window.dispatchEvent(new StorageEvent('storage', { key: SIDEBAR_WIDTH_STORAGE_KEY, newValue: '400' }))
    })
    expect(frame('sidebar').style.width).toBe('400px')
  })

  it('keeps a drag for this page even when storage refuses to persist it', () => {
    render(<><Column slot="sidebar" /><Column slot="settings-sidebar" /></>)
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      fireEvent.keyDown(handle('settings-sidebar'), { key: 'ArrowRight' })
      // Nothing persisted — but the width still applies, in both columns.
      expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull()
      expect(frame('settings-sidebar').style.width).toBe('280px')
      expect(frame('sidebar').style.width).toBe('280px')
    } finally {
      setItem.mockRestore()
    }
    // Once storage works again a write lands there and takes over from the unsaved value.
    fireEvent.keyDown(handle('sidebar'), { key: 'ArrowRight' })
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('296')
    expect(frame('settings-sidebar').style.width).toBe('296px')
  })

  it('clamps and resets like the handle always did', () => {
    render(<Column slot="sidebar" />)
    fireEvent.keyDown(handle('sidebar'), { key: 'End' })
    expect(frame('sidebar').style.width).toBe('420px')
    fireEvent.doubleClick(handle('sidebar'))
    expect(frame('sidebar').style.width).toBe('264px')
  })
})
