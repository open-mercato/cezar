import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserView } from './browser-view'

/**
 * A HOSTED cockpit (`capabilities.localHandoff` false): a loopback address would open on the
 * viewer's machine, not the task's host, so it is refused with the reason and never framed — and
 * Design Mode, which the server reports off there, keeps its toggle disabled with the reason.
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
    const toggle = document.querySelector('[data-slot=browser-design-toggle]') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('title')).toMatch(/needs a local cockpit/)
  })

  it('leaves an empty tab to the address bar: there is no local app to run from here', () => {
    render(<BrowserView state={{ tabs: [''], active: 0 }} onChange={() => {}} renderEmpty={() => <p>run panel</p>} />)
    expect(screen.queryByText('run panel')).toBeNull()
    expect(screen.getByText('Empty tab')).toBeTruthy()
  })

  it('still frames a non-loopback address', () => {
    render(<BrowserView state={{ tabs: ['https://example.com/'], active: 0 }} onChange={() => {}} />)
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/')
  })
})
