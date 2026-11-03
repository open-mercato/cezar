import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserView, pageAddress, sameDocument } from './browser-view'
import type { BrowserState } from './browser-view'

/**
 * The Preview following a page that moves without a load — `replaceState`, `pushState`, a hash
 * change. The regression: the bar kept the address first loaded, and Reload went back to it, so a
 * page keeping its state in the URL (a filter in its hash) lost it on every reload.
 */

vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { capabilities: { localHandoff: true } } }),
}))

const APP = 'http://localhost:5173/orders#status=open'

let persisted: BrowserState[]
function Harness({ initial }: { initial: BrowserState }) {
  const [state, setState] = useState(initial)
  return (
    <BrowserView
      state={state}
      onChange={(next) => {
        persisted.push(next)
        setState(next)
      }}
    />
  )
}

const frame = () => {
  const node = document.querySelector('iframe')
  if (!node) throw new Error('no iframe rendered')
  return node
}
const framedUrl = () => frame().getAttribute('src')
const addressBar = () => screen.getByPlaceholderText(/Enter an address/) as HTMLInputElement
const back = () => screen.getByRole('button', { name: 'Back' })
const forward = () => screen.getByRole('button', { name: 'Forward' })

function load() {
  act(() => {
    frame().dispatchEvent(new Event('load'))
  })
}

/** What the reporter inside the page posts, delivered the way the browser would. */
function report(url: string, how: string, { origin = 'http://localhost:5173', source = frame().contentWindow } = {}) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'cezar-preview', type: 'location', url, how },
        origin,
        source: source as MessageEventSource,
      }),
    )
  })
}

function type(url: string) {
  fireEvent.change(addressBar(), { target: { value: url } })
  fireEvent.submit(addressBar().closest('form')!)
}

beforeEach(() => {
  persisted = []
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('BrowserView — in-page navigation', () => {
  it('follows a replaceState in the bar, keeps it, and reloads it', () => {
    render(<Harness initial={{ tabs: [APP], active: 0 }} />)
    load()
    report('http://localhost:5173/orders#status=shipped', 'replace')

    expect(addressBar().value).toBe('http://localhost:5173/orders#status=shipped')
    expect(persisted.at(-1)?.tabs[0]).toBe('http://localhost:5173/orders#status=shipped')
    // A replace rewrites the entry it is on: nothing to go back to.
    expect(back().hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(framedUrl()).toBe('http://localhost:5173/orders#status=shipped')
  })

  it('turns pushes into entries, and Back to a hash entry moves the page in place', () => {
    render(<Harness initial={{ tabs: [APP], active: 0 }} />)
    load()
    const element = frame()
    report('http://localhost:5173/orders#status=paid', 'push')
    expect(back().hasAttribute('disabled')).toBe(false)

    fireEvent.click(back())
    expect(addressBar().value).toBe(APP)
    // Same document: the frame is not rebuilt and nothing is loading — the page gets `hashchange`.
    expect(frame()).toBe(element)
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(forward().hasAttribute('disabled')).toBe(false)

    // The page's own report of that move is the entry it is already on.
    report(APP, 'pop')
    fireEvent.click(forward())
    expect(framedUrl()).toBe('http://localhost:5173/orders#status=paid')
    expect(frame()).toBe(element)
  })

  it('a hash typed into the bar moves the open page without reloading it', () => {
    render(<Harness initial={{ tabs: [APP], active: 0 }} />)
    load()
    const element = frame()
    type('http://localhost:5173/orders#status=returned')

    expect(frame()).toBe(element)
    expect(framedUrl()).toBe('http://localhost:5173/orders#status=returned')
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(persisted.at(-1)?.tabs[0]).toBe('http://localhost:5173/orders#status=returned')
    // No `load` follows a fragment move, and that is not a failure.
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(screen.queryByText('Could not open')).toBeNull()
  })

  it('still reloads for a different document', () => {
    render(<Harness initial={{ tabs: [APP], active: 0 }} />)
    load()
    const element = frame()
    type('http://localhost:5173/other')
    expect(frame()).not.toBe(element)
    expect(screen.getByText('Loading…')).toBeTruthy()
  })

  it('leaves the bar alone while the user is typing in it', () => {
    render(<Harness initial={{ tabs: [APP], active: 0 }} />)
    load()
    addressBar().focus()
    fireEvent.change(addressBar(), { target: { value: 'localhost:3000' } })
    report('http://localhost:5173/orders#status=shipped', 'replace')
    expect(addressBar().value).toBe('localhost:3000')
  })

  it.each([
    ['another origin', { origin: 'http://localhost:9999' }],
    ['another window', { source: window }],
  ])('ignores a report from %s', (_name, from) => {
    render(<Harness initial={{ tabs: [APP], active: 0 }} />)
    load()
    report('http://localhost:5173/orders#status=shipped', 'replace', from)
    expect(addressBar().value).toBe(APP)
  })
})

describe('sameDocument', () => {
  it.each([
    ['http://a/#1', 'http://a/#5', true],
    ['http://a/', 'http://a/#5', true],
    ['http://a/#1', 'http://a/', false],
    ['http://a/x#1', 'http://a/y#1', false],
    ['', 'http://a/#1', false],
  ])('%s → %s is %s', (from, to, expected) => {
    expect(sameDocument(from, to)).toBe(expected)
  })
})

describe('pageAddress', () => {
  it('renames a mirror address back to the app', () => {
    expect(pageAddress('http://127.0.0.1:40001/orders#page=2', 'http://127.0.0.1:40001', 'http://localhost:5173')).toBe(
      'http://localhost:5173/orders#page=2',
    )
  })

  it('refuses an address off the frame origin', () => {
    expect(pageAddress('https://evil.example/#1', 'http://localhost:5173', null)).toBeNull()
    expect(pageAddress('javascript:void(0)', 'http://localhost:5173', null)).toBeNull()
  })
})
