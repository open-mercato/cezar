import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from './theme-provider'
import { ThemeToggle } from './theme-toggle'
import { THEME_STORAGE_KEY, type Theme } from '@/lib/theme'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

function renderToggle(stored?: Theme, osPrefersLight = false) {
  if (stored) localStorage.setItem(THEME_STORAGE_KEY, stored)
  // jsdom ships no `matchMedia`; the provider needs one to resolve `system`.
  vi.stubGlobal(
    'matchMedia',
    () =>
      ({
        matches: osPrefersLight,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList
  )

  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>
  )
  return screen.getByRole('button')
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ThemeToggle', () => {
  it('renders an icon button reflecting the current choice', () => {
    const button = renderToggle('dark')

    expect(button.dataset.slot).toBe('theme-toggle')
    expect(button.dataset.themePref).toBe('dark')
    expect(button.dataset.size).toBe('icon-sm')
    expect(button.querySelector('svg')).not.toBeNull()
  })

  it.each([
    { theme: 'light', name: 'Theme: light. Switch to dark.' },
    { theme: 'dark', name: 'Theme: dark. Switch to system.' },
    { theme: 'system', name: 'Theme: system. Switch to light.' },
  ] as const)('has an accessible name announcing $theme and what is next', ({ theme, name }) => {
    renderToggle(theme)

    expect(screen.getByRole('button', { name })).toBeTruthy()
  })

  it('shows the chosen theme rather than the resolved one, so system stays visible', () => {
    // `system` on a light OS resolves to light, but the button must still read as system.
    const button = renderToggle('system', true)

    expect(button.dataset.themePref).toBe('system')
    expect(button.getAttribute('aria-label')).toContain('Theme: system')
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })

  it('cycles light → dark → system → light, persisting each step', () => {
    const button = renderToggle('light')

    fireEvent.click(button)
    expect(button.dataset.themePref).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    fireEvent.click(button)
    expect(button.dataset.themePref).toBe('system')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')

    fireEvent.click(button)
    expect(button.dataset.themePref).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('repaints the root as it cycles', () => {
    const button = renderToggle('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)

    fireEvent.click(button) // → dark

    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('starts from dark when the shared key holds an unknown value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    const button = renderToggle()

    expect(button.dataset.themePref).toBe('dark')

    fireEvent.click(button)

    expect(button.dataset.themePref).toBe('system')
  })
})
