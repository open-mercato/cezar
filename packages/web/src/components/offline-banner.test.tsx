import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setConnectionOffline, setConnectionRetry } from '@/api/connection-state'

import { OfflineBanner } from './offline-banner'

afterEach(() => {
  cleanup()
  act(() => setConnectionOffline(false))
  setConnectionRetry(null)
})

const banner = () => document.querySelector('[data-slot="offline-banner"]')

describe('OfflineBanner (audit C1)', () => {
  it('renders nothing while the stream is healthy', () => {
    render(<OfflineBanner />)
    expect(banner()).toBeNull()
  })

  it('appears as an alert when the stream goes offline, and clears when it recovers', () => {
    render(<OfflineBanner />)
    act(() => setConnectionOffline(true))
    expect(banner()?.getAttribute('role')).toBe('alert')
    expect(banner()?.textContent).toContain('Server unreachable')

    // Any received event marks the stream healthy again — the banner must leave on its own.
    act(() => setConnectionOffline(false))
    expect(banner()).toBeNull()
  })

  it('Retry now invokes the provider-registered reconnect', () => {
    const retry = vi.fn()
    setConnectionRetry(retry)
    render(<OfflineBanner />)
    act(() => setConnectionOffline(true))

    fireEvent.click(document.querySelector('[data-slot="offline-banner"] button') as HTMLButtonElement)
    expect(retry).toHaveBeenCalledTimes(1)
  })
})
