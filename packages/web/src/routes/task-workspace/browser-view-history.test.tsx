import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserView } from './browser-view'
import type { BrowserState } from './layout-state'

/**
 * Back and Forward in the Browser column (spec `.ai/specs/2026-10-07-task-workspace.md` §7:
 * tabs "include Back, Forward, Reload").
 *
 * The regression this pins: both buttons used to call `frameRef.current?.contentWindow?.history`,
 * and `history` is not on the cross-origin property allowlist — merely READING it raises
 * `SecurityError`. So for every page not same-origin with the cockpit, which in practice is every
 * page worth framing (a dev server on another port included), the buttons threw inside the click
 * handler and navigated nothing. The view now keeps its own per-tab stack, which is also what
 * lets the buttons be disabled truthfully.
 */

vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { capabilities: { preview: true } } }),
}))

function fireFrameLoad() {
  const frame = document.querySelector('iframe')
  if (!frame) throw new Error('no iframe rendered')
  act(() => {
    frame.dispatchEvent(new Event('load'))
  })
}

/** Controlled, so a persisted address really comes back as a new prop. */
function Harness({ initial }: { initial: BrowserState }) {
  const [state, setState] = useState(initial)
  return <BrowserView state={state} onChange={setState} />
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

function navigateTo(url: string) {
  const input = screen.getByPlaceholderText(/Wpisz adres/)
  fireEvent.change(input, { target: { value: url } })
  fireEvent.submit(input.closest('form')!)
  fireFrameLoad()
}

const back = () => screen.getByRole('button', { name: 'Wstecz' })
const forward = () => screen.getByRole('button', { name: 'Dalej' })
const framedUrl = () => document.querySelector('iframe')?.getAttribute('src')
const addressBar = () => (screen.getByPlaceholderText(/Wpisz adres/) as HTMLInputElement).value

describe('BrowserView — Back and Forward', () => {
  it('starts with both disabled on a blank tab', () => {
    render(<Harness initial={{ tabs: [''], active: 0 }} />)

    expect(back().hasAttribute('disabled')).toBe(true)
    expect(forward().hasAttribute('disabled')).toBe(true)
  })

  it('walks back and forward through the addresses the bar held', () => {
    render(<Harness initial={{ tabs: [''], active: 0 }} />)

    navigateTo('http://localhost:3000/')
    navigateTo('http://localhost:3000/about')
    expect(framedUrl()).toBe('http://localhost:3000/about')
    expect(forward().hasAttribute('disabled')).toBe(true)

    fireEvent.click(back())
    expect(framedUrl()).toBe('http://localhost:3000/')
    // The bar follows, so the address shown is the address framed.
    expect(addressBar()).toBe('http://localhost:3000/')
    expect(forward().hasAttribute('disabled')).toBe(false)

    fireFrameLoad()
    fireEvent.click(forward())
    expect(framedUrl()).toBe('http://localhost:3000/about')
  })

  it('does not throw reaching into a cross-origin frame', () => {
    // The actual old failure: `contentWindow.history` raised SecurityError. jsdom will not
    // reproduce the cross-origin boundary, so what is asserted is that the handler no longer
    // touches the frame at all — a click on a one-entry history is simply inert.
    render(<Harness initial={{ tabs: ['https://github.com/'], active: 0 }} />)
    fireFrameLoad()

    expect(back().hasAttribute('disabled')).toBe(true)
    expect(() => fireEvent.click(back())).not.toThrow()
    expect(framedUrl()).toBe('https://github.com/')
  })

  it('drops the forward entries when the user navigates after going back', () => {
    render(<Harness initial={{ tabs: [''], active: 0 }} />)

    navigateTo('http://localhost:3000/a')
    navigateTo('http://localhost:3000/b')
    fireEvent.click(back())
    fireFrameLoad()
    expect(forward().hasAttribute('disabled')).toBe(false)

    navigateTo('http://localhost:3000/c')
    // The grammar every browser uses: a new navigation truncates what was ahead.
    expect(forward().hasAttribute('disabled')).toBe(true)
    fireEvent.click(back())
    expect(framedUrl()).toBe('http://localhost:3000/a')
  })

  it('keeps each tab on its own history', () => {
    render(<Harness initial={{ tabs: [''], active: 0 }} />)

    navigateTo('http://localhost:3000/first')
    navigateTo('http://localhost:3000/second')

    fireEvent.click(screen.getByRole('button', { name: 'Nowa karta' }))
    // A fresh tab has been nowhere, whatever the tab beside it has visited.
    expect(back().hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getAllByRole('tab')[0]!)
    expect(back().hasAttribute('disabled')).toBe(false)
  })
})
