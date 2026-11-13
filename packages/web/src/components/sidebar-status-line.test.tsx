import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarStatusLine, type SidebarStatusLineProps } from './sidebar-status-line'
import { ThemeProvider } from './theme-provider'

// The real dialog needs react-query; what is under test is only that the chip opens it.
vi.mock('@/components/self-update-dialog', () => ({
  SelfUpdateDialog: ({ open, brandName }: { open: boolean; brandName: string }) =>
    open ? <div data-slot="self-update-stub">{brandName} updater</div> : null,
}))

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderLine(props: Partial<SidebarStatusLineProps> = {}) {
  return render(
    <ThemeProvider>
      <SidebarStatusLine brandName="cezar" version="0.20.0" latestVersion={null} starCount={null} health="healthy" {...props} />
    </ThemeProvider>,
  )
}

const footer = () => document.querySelector('[data-slot="sidebar-footer"]') as HTMLElement
const chip = () => footer().querySelector('[data-slot="version-chip"]') as HTMLButtonElement
const openMore = () => {
  fireEvent.pointerDown(within(footer()).getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false })
  return screen.getByRole('menu')
}

describe('SidebarStatusLine', () => {
  it('puts the version chip in the footer, and it opens the updater', () => {
    renderLine()
    expect(chip().closest('[data-slot="sidebar-footer-controls"]')).not.toBeNull()
    expect(chip().textContent).toBe('v0.20.0')
    expect(chip().getAttribute('aria-label')).toBe('cezar v0.20.0 — open updater')
    expect(document.querySelector('[data-slot="self-update-stub"]')).toBeNull()
    fireEvent.click(chip())
    expect(document.querySelector('[data-slot="self-update-stub"]')?.textContent).toBe('cezar updater')
  })

  it('turns the chip into an Update call naming both versions', () => {
    renderLine({ latestVersion: '0.21.0' })
    expect(chip().getAttribute('data-update-available')).toBe('true')
    const update = chip().querySelector('[data-slot="version-chip-update"]') as HTMLElement
    expect(update.textContent).toBe('Update')
    expect(update.className).toContain('text-pending-strong')
    expect(chip().querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('pending')
    const name = chip().getAttribute('aria-label') ?? ''
    expect(name).toContain('v0.20.0')
    expect(name).toContain('v0.21.0')
  })

  it('dots ⋯ only for unseen What’s new, never for an update', () => {
    renderLine({ latestVersion: '0.21.0' })
    expect(footer().querySelector('[data-slot="sidebar-more-update"]')).toBeNull()
    cleanup()
    renderLine({ whatsNewUnseen: true })
    const dot = footer().querySelector('[data-slot="sidebar-more-update"]') as HTMLElement
    expect(dot.getAttribute('data-reason')).toBe('whats-new')
    expect(dot.className).toContain('bg-violet')
  })

  it('keeps the version out of the ⋯ menu', () => {
    renderLine({ starCount: 12 })
    const menu = openMore()
    expect(menu.querySelector('[data-slot="version-chip"]')).toBeNull()
    expect(menu.querySelector('[data-slot="star-chip"]')?.textContent).toContain('12')
  })

  it('switches the theme from the segmented row', () => {
    renderLine()
    const menu = openMore()
    const group = menu.querySelector('[data-slot="theme-toggle"]') as HTMLElement
    expect(group.className).toContain('grid-cols-3')
    const items = within(group).getAllByRole('menuitemradio')
    expect(items.map((item) => item.getAttribute('data-theme'))).toEqual(['system', 'dark', 'light'])
    expect(items.map((item) => item.textContent)).toEqual(['System', 'Dark', 'Light'])
    fireEvent.click(within(group).getByRole('menuitemradio', { name: 'Dark' }))
    expect(localStorage.getItem('cez-theme')).toBe('dark')
  })

  it('marks the Tools row while health needs attention', () => {
    renderLine({ health: 'attention', toolsMenu: <span>tool rows</span> })
    const tools = within(openMore()).getByRole('menuitem', { name: 'Tools' })
    expect(tools.querySelector('[data-slot="tools-menu-attention"]')?.getAttribute('data-tone')).toBe('pending')
    cleanup()
    renderLine({ health: 'healthy', toolsMenu: <span>tool rows</span> })
    expect(within(openMore()).getByRole('menuitem', { name: 'Tools' }).querySelector('[data-slot="tools-menu-attention"]')).toBeNull()
  })

  it('in Settings (health omitted) shows only the version and ⋯ under the search', () => {
    renderLine({ health: undefined })
    const controls = footer().querySelector('[data-slot="sidebar-footer-controls"]') as HTMLElement
    expect(controls.querySelector('[data-slot="sidebar-health-dot"]')).toBeNull()
    expect(controls.querySelector('[data-slot="sidebar-status"]')).toBeNull()
    expect(controls.querySelector('[data-slot="version-chip"]')).not.toBeNull()
    expect(controls.querySelector('[data-slot="sidebar-more"]')).not.toBeNull()
    expect(footer().querySelector('[data-slot="command-palette-hint"]')).not.toBeNull()
  })

  it('lets the long pieces give, not overflow the 264px column', () => {
    renderLine({ version: '0.9.2-nightly.20260813.1', runningCount: 12, health: 'attention' })
    expect(chip().className).toContain('min-w-0')
    expect(chip().querySelector('.font-mono')?.className).toContain('truncate')
    expect(footer().querySelector('[data-slot="sidebar-status"]')?.className).toContain('truncate')
    expect(within(footer().querySelector('[data-slot="command-palette-hint"]') as HTMLElement).getByText('Search tasks, pages, commands…').className).toContain('truncate')
  })
})
