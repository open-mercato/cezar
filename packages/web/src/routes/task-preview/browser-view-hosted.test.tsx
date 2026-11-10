import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserView, tunnelCommand } from './browser-view'

/**
 * A HOSTED cockpit (`capabilities.localHandoff` false): a loopback address would open on the
 * viewer's machine, not the task's host, so it is refused with the `ssh -L` command that forwards
 * it, and framed only once the user says the tunnel is open — and Design Mode, which the server
 * reports off there, keeps its toggle disabled with the reason.
 */

vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { capabilities: { localHandoff: false, designMode: false } } }),
}))
vi.mock('@/api/client', () => ({ openDesignProxy: vi.fn() }))

afterEach(cleanup)

describe('the Preview tab on a hosted cockpit', () => {
  it('refuses a loopback address instead of framing it, with the tunnel that would forward it', () => {
    render(<BrowserView state={{ tabs: ['http://localhost:3000/'], active: 0 }} onChange={() => {}} onPickElement={() => true} />)
    expect(screen.getByText('This address points at the machine you are sitting at')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
    expect(screen.getByText(`ssh -N -L 3000:localhost:3000 ${window.location.hostname}`)).toBeTruthy()
    const toggle = document.querySelector('[data-slot=browser-design-toggle]') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('title')).toMatch(/needs a local cockpit/)
  })

  it('frames the loopback address once the user says the tunnel is open', () => {
    render(<BrowserView state={{ tabs: ['http://localhost:3000/'], active: 0 }} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'The tunnel is open — show it here' }))
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:3000/')
  })

  it("offers the run panel in an empty tab: the app runs on the task's host either way", () => {
    render(<BrowserView state={{ tabs: [''], active: 0 }} onChange={() => {}} renderEmpty={() => <p>run panel</p>} />)
    expect(screen.getByText('run panel')).toBeTruthy()
  })

  it('without a run panel, says how to get one on a hosted cockpit', () => {
    render(<BrowserView state={{ tabs: [''], active: 0 }} onChange={() => {}} />)
    expect(screen.getByText('Empty tab')).toBeTruthy()
    expect(screen.getByText(/CEZ_TERMINAL=1/)).toBeTruthy()
  })

  it('builds the forward for the address port, defaulting by scheme', () => {
    expect(tunnelCommand('http://127.0.0.1:5173/app', 'vps.example.com')).toBe('ssh -N -L 5173:localhost:5173 vps.example.com')
    expect(tunnelCommand('http://localhost/', '')).toBe('ssh -N -L 80:localhost:80 <host>')
    expect(tunnelCommand('not a url', 'h')).toBeNull()
  })

  it('still frames a non-loopback address', () => {
    render(<BrowserView state={{ tabs: ['https://example.com/'], active: 0 }} onChange={() => {}} />)
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/')
  })
})
