import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotchToggle, shellHasNotch } from './notch-toggle'

type Shelled = Window & { __CEZ_DESKTOP__?: unknown; __TAURI_INTERNALS__?: unknown }

afterEach(() => {
  cleanup()
  delete (window as Shelled).__CEZ_DESKTOP__
  delete (window as Shelled).__TAURI_INTERNALS__
})

function shell(enabled: boolean) {
  const invoke = vi.fn(async (command: string) => (command === 'notch_enabled' ? enabled : undefined))
  ;(window as Shelled).__CEZ_DESKTOP__ = { platform: 'macos', notch: true }
  ;(window as Shelled).__TAURI_INTERNALS__ = { invoke }
  return invoke
}

describe('NotchToggle', () => {
  it('is offered only by a shell that has the notch', () => {
    expect(shellHasNotch()).toBe(false)
    ;(window as Shelled).__CEZ_DESKTOP__ = { platform: 'windows', notch: false }
    ;(window as Shelled).__TAURI_INTERNALS__ = { invoke: vi.fn() }
    expect(shellHasNotch()).toBe(false)
    shell(true)
    expect(shellHasNotch()).toBe(true)
  })

  it('shows the shell\'s answer and writes the flip back to it', async () => {
    const invoke = shell(false)
    render(<NotchToggle />)
    const toggle = await screen.findByRole('switch', { name: 'Manager notch' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_notch_enabled', { enabled: true }))
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })
})
