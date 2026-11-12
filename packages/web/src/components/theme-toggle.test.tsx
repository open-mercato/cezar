import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from './theme-provider'
import { NEXT_THEME, THEME_OPTIONS, ThemeToggle } from './theme-toggle'
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

  const { container } = render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>
  )
  const toggle = container.querySelector('[data-slot="theme-toggle"]') as HTMLElement
  if (!toggle) throw new Error('ThemeToggle did not render')
  return toggle
}

const option = (name: 'System' | 'Dark' | 'Light') => screen.getByRole('button', { name })

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ThemeToggle', () => {
  // UI strategy: 2–4 options are a Segmented, never an icon that cycles through hidden states.
  it('is a Segmented System / Dark / Light with the current choice pressed', () => {
    const toggle = renderToggle('dark')

    expect(toggle.dataset.themePref).toBe('dark')
    const group = screen.getByRole('group', { name: 'Theme' })
    expect(group.getAttribute('data-slot')).toBe('theme-toggle-options')
    const buttons = Array.from(group.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['System', 'Dark', 'Light'])
    expect(option('Dark').getAttribute('aria-pressed')).toBe('true')
    expect(option('System').getAttribute('aria-pressed')).toBe('false')
    expect(option('Light').getAttribute('aria-pressed')).toBe('false')
    // Each option carries its icon beside the word, not instead of it.
    for (const button of buttons) expect(button.querySelector('svg')).not.toBeNull()
  })

  it('shows the chosen theme rather than the resolved one, so system stays visible', () => {
    // `system` on a light OS resolves to light, but the control must still read as system.
    const toggle = renderToggle('system', true)

    expect(toggle.dataset.themePref).toBe('system')
    expect(option('System').getAttribute('aria-pressed')).toBe('true')
    expect(option('Light').getAttribute('aria-pressed')).toBe('false')
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })

  it('persists each pick and repaints the root', () => {
    const toggle = renderToggle('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)

    fireEvent.click(option('Dark'))
    expect(toggle.dataset.themePref).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('dark')

    fireEvent.click(option('System'))
    expect(toggle.dataset.themePref).toBe('system')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')

    fireEvent.click(option('Light'))
    expect(toggle.dataset.themePref).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('re-picking the pressed option is a no-op (radio semantics)', () => {
    const toggle = renderToggle('dark')

    fireEvent.click(option('Dark'))
    expect(toggle.dataset.themePref).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('starts from dark when the shared key holds an unknown value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    const toggle = renderToggle()

    expect(toggle.dataset.themePref).toBe('dark')
  })

  // The ⌘K palette's "Toggle theme" still cycles through this order — one definition.
  it('keeps the palette cycle order and the shared option list', () => {
    expect(NEXT_THEME).toEqual({ light: 'dark', dark: 'system', system: 'light' })
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(['system', 'dark', 'light'])
  })
})
