import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserView } from './browser-view'

/**
 * A HOSTED cockpit (`capabilities.localHandoff` false): a loopback address would open on the
 * viewer's machine, not the task's host, so it is refused with the reason and never framed — and
 * Design Mode, which the server reports off there, offers no toggle.
 */

vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { capabilities: { localHandoff: false, designMode: false } } }),
}))
vi.mock('@/api/client', () => ({ openDesignProxy: vi.fn() }))

afterEach(cleanup)

describe('the Preview tab on a hosted cockpit', () => {
  it('refuses a loopback address instead of framing it', () => {
    render(<BrowserView state={{ tabs: ['http://localhost:3000/'], active: 0 }} onChange={() => {}} onPickElement={() => true} />)
    expect(screen.getByText('This address points at the machine you are sitting at')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector('[data-slot=browser-design-toggle]')).toBeNull()
  })

  it('still frames a non-loopback address', () => {
    render(<BrowserView state={{ tabs: ['https://example.com/'], active: 0 }} onChange={() => {}} />)
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/')
  })
})
