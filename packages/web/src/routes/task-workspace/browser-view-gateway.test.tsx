import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserView } from './browser-view'

/**
 * The Browser column on a HOSTED cockpit (spec `.ai/specs/2026-10-10-preview-gateway.md`).
 *
 * `capabilities.preview` is false there: a loopback address would resolve on the viewer's
 * machine. Under test is that such an address is never framed as typed — it goes through the
 * gateway the server answers, or is refused with the server's own reason.
 */

vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { capabilities: { preview: false, designMode: false } } }),
}))

const openPreviewGateway = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ openDesignProxy: vi.fn(), openPreviewGateway }))

vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))

const APP = 'http://localhost:3000/cart?step=2'
const GATEWAY = 'https://cezar.example.com:8501'

const frame = () => document.querySelector('iframe')

function renderView(address = APP) {
  const onChange = vi.fn()
  render(<BrowserView state={{ tabs: [address], active: 0 }} onChange={onChange} />)
  return { onChange }
}

beforeEach(() => {
  openPreviewGateway.mockReset().mockResolvedValue({ origin: GATEWAY, ticket: 'T1', ticketParam: '__cez_preview' })
})
afterEach(cleanup)

describe('a loopback address on a hosted cockpit', () => {
  it('is framed through the gateway, with its path and a ticket, and never as typed', async () => {
    renderView()
    // Before the server answers there is no frame at all — not even one pointed at localhost.
    expect(frame()).toBeNull()

    await waitFor(() => expect(frame()).not.toBeNull())
    expect(frame()!.getAttribute('src')).toBe(`${GATEWAY}/cart?step=2&__cez_preview=T1`)
    expect(openPreviewGateway).toHaveBeenCalledWith({ target: 'http://localhost:3000', parentOrigin: window.location.origin })
  })

  it('keeps the address the user typed as the saved one, not the gateway’s', async () => {
    const { onChange } = renderView()
    await waitFor(() => expect(frame()).not.toBeNull())
    frame()!.dispatchEvent(new Event('load'))
    for (const [state] of onChange.mock.calls as Array<[{ tabs: string[] }]>) {
      expect(state.tabs.join(' ')).not.toContain(GATEWAY)
    }
  })

  it('is refused with the server’s reason when this cockpit has no gateway', async () => {
    openPreviewGateway.mockRejectedValue(new Error('this cockpit has no preview gateway (CEZ_PREVIEW_PORTS is not set)'))
    renderView()

    expect(await screen.findByText('This address points at the machine you are sitting at')).toBeTruthy()
    expect(screen.getByText(/CEZ_PREVIEW_PORTS is not set/)).toBeTruthy()
    expect(frame()).toBeNull()
  })

  it('leaves an address that is not local alone', async () => {
    renderView('https://github.com/')
    expect(frame()!.getAttribute('src')).toBe('https://github.com/')
    expect(openPreviewGateway).not.toHaveBeenCalled()
  })
})
