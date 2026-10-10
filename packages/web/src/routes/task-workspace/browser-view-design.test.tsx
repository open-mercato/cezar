import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { BrowserView, designOrigin, placeNote } from './browser-view'

/**
 * Design Mode in the Browser column (spec `.ai/specs/2026-10-09-design-mode.md`).
 *
 * jsdom loads no frame, so what is under test is the cockpit's half of the conversation: when the
 * toggle is offered, that the frame is re-pointed at the mirror the server answers (and the saved
 * tab is not), and — the part that is a trust boundary — which `message` events are believed.
 */

const health = vi.hoisted(() => ({ designMode: true }))
vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { capabilities: { preview: true, designMode: health.designMode } } }),
}))

const openDesignProxy = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ openDesignProxy }))

const toast = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toaster', () => ({ toast }))

const APP = 'http://localhost:5173/settings?tab=1'
const MIRROR = 'http://localhost:61000'

const ELEMENT = {
  url: APP,
  selector: 'main > button.save',
  tag: 'button',
  text: 'Save',
  html: '<button class="save">Save</button>',
  styles: {},
  rect: { x: 1, y: 2, width: 3, height: 4 },
  viewport: { width: 800, height: 600 },
  components: [],
  source: '',
}

const frame = () => document.querySelector('iframe')!
const toggle = () => screen.getByRole('button', { name: 'Design Mode' })

/** A message as the browser would deliver it from `source` at `origin`. */
function deliver(data: unknown, origin: string, source: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as MessageEventSource }))
  })
}

function renderView(onPickElement: ((pick: unknown) => boolean) | undefined = vi.fn(() => true), address = APP) {
  const onChange = vi.fn()
  render(<BrowserView state={{ tabs: [address], active: 0 }} onChange={onChange} onPickElement={onPickElement} />)
  return { onChange, onPickElement }
}

async function enterDesignMode() {
  fireEvent.click(toggle())
  await waitFor(() => expect(frame().getAttribute('src')).toBe(`${MIRROR}/settings?tab=1`))
  // The mirror arrives from a promise, outside `act`, so the DOM is committed before React has
  // flushed the effect that starts listening for the picker. A real frame takes a network round
  // trip to speak; a test dispatches on the next line.
  await act(async () => {})
}

beforeEach(() => {
  health.designMode = true
  openDesignProxy.mockReset().mockResolvedValue({ origin: MIRROR })
  toast.mockReset()
})
afterEach(cleanup)

describe('the Design Mode toggle', () => {
  it('is absent without a host to receive picks, and when the server does not offer it', () => {
    render(<BrowserView state={{ tabs: [APP], active: 0 }} onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Design Mode' })).toBeNull()
    cleanup()
    health.designMode = false
    renderView()
    expect(screen.queryByRole('button', { name: 'Design Mode' })).toBeNull()
  })

  it('is disabled, with the reason, for an address that cannot be mirrored', () => {
    renderView(undefined, 'https://github.com/')
    expect((toggle() as HTMLButtonElement).disabled).toBe(true)
    expect(toggle().getAttribute('title')).toMatch(/works on local http:\/\/ addresses/)
  })

  it('frames the app directly until it is switched on', () => {
    renderView()
    expect(frame().getAttribute('src')).toBe(APP)
    expect(openDesignProxy).not.toHaveBeenCalled()
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })
})

describe('entering Design Mode', () => {
  it('asks for a mirror of the app ORIGIN and frames the same page on it', async () => {
    renderView()
    await enterDesignMode()
    expect(openDesignProxy).toHaveBeenCalledWith({ target: 'http://localhost:5173', parentOrigin: window.location.origin })
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
  })

  it('never persists the mirror address — the port is this session\'s', async () => {
    const { onChange } = renderView()
    await enterDesignMode()
    act(() => {
      frame().dispatchEvent(new Event('load'))
    })
    for (const [state] of onChange.mock.calls as [{ tabs: string[] }][]) {
      expect(state.tabs.join(' ')).not.toContain('61000')
    }
  })

  it('switches itself off and says why when the mirror cannot be opened', async () => {
    openDesignProxy.mockRejectedValue(new Error('Design Mode is not available on this cockpit'))
    renderView()
    fireEvent.click(toggle())
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Design Mode is not available on this cockpit', { tone: 'danger' }))
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    expect(frame().getAttribute('src')).toBe(APP)
  })
})

describe('the picker conversation', () => {
  it('activates the picker once it announces itself, addressed to the mirror origin only', async () => {
    renderView()
    await enterDesignMode()
    const post = vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(() => {})
    deliver({ source: 'cezar-design', type: 'ready' }, MIRROR, frame().contentWindow)
    expect(post).toHaveBeenCalledWith({ source: 'cezar-design-host', type: 'set-active', active: true }, MIRROR)
  })

  it('hands a picked element to the host and confirms it', async () => {
    const { onPickElement } = renderView()
    await enterDesignMode()
    deliver({ source: 'cezar-design', type: 'picked', element: ELEMENT }, MIRROR, frame().contentWindow)
    expect(onPickElement).toHaveBeenCalledWith(ELEMENT)
    expect(toast).toHaveBeenCalledWith('Element added to your next message.')
  })

  it('says nothing when the host did not keep the pick', async () => {
    renderView(vi.fn(() => false))
    await enterDesignMode()
    deliver({ source: 'cezar-design', type: 'picked', element: ELEMENT }, MIRROR, frame().contentWindow)
    expect(toast).not.toHaveBeenCalled()
  })

  it.each([
    ['another origin', 'http://localhost:5173', 'own'],
    ['the cockpit itself', 'http://localhost:3000', 'own'],
    ['another window on the mirror origin', MIRROR, 'other'],
  ])('ignores a pick from %s', async (_label, origin, source) => {
    const { onPickElement } = renderView()
    await enterDesignMode()
    deliver(
      { source: 'cezar-design', type: 'picked', element: ELEMENT },
      origin,
      source === 'own' ? frame().contentWindow : window,
    )
    expect(onPickElement).not.toHaveBeenCalled()
  })

  it('ignores a message that is not the picker\'s, and an element that is not one', async () => {
    const { onPickElement } = renderView()
    await enterDesignMode()
    deliver({ type: 'picked', element: ELEMENT }, MIRROR, frame().contentWindow)
    deliver({ source: 'cezar-design', type: 'picked', element: { nope: true } }, MIRROR, frame().contentWindow)
    deliver('picked', MIRROR, frame().contentWindow)
    expect(onPickElement).not.toHaveBeenCalled()
  })

  it('leaves Design Mode on Esc inside the page, without reloading the page', async () => {
    renderView()
    await enterDesignMode()
    const before = frame()
    deliver({ source: 'cezar-design', type: 'cancel' }, MIRROR, before.contentWindow)
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    // Same element, same address: the picker stands down, the page keeps its state.
    expect(frame()).toBe(before)
    expect(frame().getAttribute('src')).toBe(`${MIRROR}/settings?tab=1`)
  })

  it('frames the app directly again on the next reload once Design Mode is off', async () => {
    renderView()
    await enterDesignMode()
    fireEvent.click(toggle())
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(frame().getAttribute('src')).toBe(APP)
  })
})

describe('marks and the note popup', () => {
  const DRAFT = { key: 'abc-1', selector: 'main > button.save', path: '/settings', label: 'button.save', draft: true }
  const SENT = { key: 'abc-2', n: 1, label: 'p.price', draft: false }

  /** A view whose marks the test controls, with a note that names the element it is about. */
  function harness(onEscape = vi.fn()) {
    const onChange = vi.fn()
    const view = (marks: (typeof DRAFT | typeof SENT)[], onPick: () => boolean = () => true) => (
      <BrowserView
        state={{ tabs: [APP], active: 0 }}
        onChange={onChange}
        onPickElement={onPick}
        designMarks={marks}
        onDesignEscape={onEscape}
        renderDesignNote={({ mark, close }) => (
          <button type="button" data-testid="note" data-mark={mark} onClick={close}>
            note
          </button>
        )}
      />
    )
    return { view, onEscape }
  }
  const note = () => document.querySelector<HTMLElement>('[data-slot=browser-design-note]')!

  it('tells the page what to frame: a draft with how to find it again, a sent note with its number', async () => {
    const { view } = harness()
    const { rerender } = render(view([]))
    await enterDesignMode()
    const post = vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(() => {})
    deliver({ source: 'cezar-design', type: 'ready' }, MIRROR, frame().contentWindow)
    expect(post).toHaveBeenCalledWith({ source: 'cezar-design-host', type: 'set-marks', marks: [] }, MIRROR)
    rerender(view([DRAFT, SENT]))
    expect(post).toHaveBeenLastCalledWith(
      {
        source: 'cezar-design-host',
        type: 'set-marks',
        marks: [
          { key: 'abc-1', selector: 'main > button.save', path: '/settings' },
          { key: 'abc-2', n: 1 },
        ],
      },
      MIRROR,
    )
  })

  it('opens the note under a picked element and follows it when the page reports it moved', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    onTestFinished(() => {
      width.mockRestore()
      height.mockRestore()
    })
    const { view } = harness()
    const { rerender } = render(view([]))
    await enterDesignMode()
    expect(screen.queryByTestId('note')).toBeNull()

    deliver(
      { source: 'cezar-design', type: 'picked', element: { ...ELEMENT, mark: 'abc-1', rect: { x: 40, y: 50, width: 100, height: 20 } } },
      MIRROR,
      frame().contentWindow,
    )
    rerender(view([DRAFT]))
    expect(screen.getByTestId('note').dataset.mark).toBe('abc-1')
    expect(toast).not.toHaveBeenCalled()
    expect(note().style.left).toBe('40px')
    expect(note().style.top).toBe('80px')

    deliver(
      { source: 'cezar-design', type: 'rects', rects: [{ key: 'abc-1', x: 200, y: 300, width: 100, height: 20 }] },
      MIRROR,
      frame().contentWindow,
    )
    expect(note().style.left).toBe('200px')
    expect(note().style.top).toBe('330px')
  })

  it('moves to another element when it is picked, and back when the first frame is clicked', async () => {
    const { view } = harness()
    const { rerender } = render(view([]))
    await enterDesignMode()
    deliver({ source: 'cezar-design', type: 'picked', element: { ...ELEMENT, mark: 'abc-1' } }, MIRROR, frame().contentWindow)
    rerender(view([DRAFT]))
    deliver({ source: 'cezar-design', type: 'picked', element: { ...ELEMENT, mark: 'abc-2' } }, MIRROR, frame().contentWindow)
    rerender(view([DRAFT, { ...DRAFT, key: 'abc-2' }]))
    expect(screen.getByTestId('note').dataset.mark).toBe('abc-2')
    // The first element kept its frame and its draft; clicking the frame is the way back to it.
    deliver({ source: 'cezar-design', type: 'mark-clicked', key: 'abc-1' }, MIRROR, frame().contentWindow)
    expect(screen.getByTestId('note').dataset.mark).toBe('abc-1')
  })

  it('closes on request, and when the note it was showing is gone', async () => {
    const { view } = harness()
    const { rerender } = render(view([]))
    await enterDesignMode()
    deliver({ source: 'cezar-design', type: 'picked', element: { ...ELEMENT, mark: 'abc-1' } }, MIRROR, frame().contentWindow)
    rerender(view([DRAFT]))
    fireEvent.click(screen.getByTestId('note'))
    expect(screen.queryByTestId('note')).toBeNull()

    deliver({ source: 'cezar-design', type: 'mark-clicked', key: 'abc-1' }, MIRROR, frame().contentWindow)
    expect(screen.getByTestId('note')).toBeTruthy()
    // Discarded (or withdrawn): there is no note left for a popup to be about.
    rerender(view([]))
    expect(screen.queryByTestId('note')).toBeNull()
  })

  it('reads Esc in the page as "close this note" while one is open, and "leave Design Mode" otherwise', async () => {
    const { view, onEscape } = harness()
    const { rerender } = render(view([]))
    await enterDesignMode()
    deliver({ source: 'cezar-design', type: 'picked', element: { ...ELEMENT, mark: 'abc-1' } }, MIRROR, frame().contentWindow)
    rerender(view([DRAFT]))

    deliver({ source: 'cezar-design', type: 'cancel' }, MIRROR, frame().contentWindow)
    expect(onEscape).toHaveBeenCalledWith('abc-1')
    expect(screen.queryByTestId('note')).toBeNull()
    expect(toggle().getAttribute('aria-pressed')).toBe('true')

    deliver({ source: 'cezar-design', type: 'cancel' }, MIRROR, frame().contentWindow)
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  it('offers a draft whose element the page could not find, instead of losing it', async () => {
    const { view } = harness()
    render(view([DRAFT, SENT]))
    await enterDesignMode()
    // Not before the page has reported: an unreported draft is not a lost one.
    expect(document.querySelector('[data-slot=browser-design-adrift]')).toBeNull()
    deliver({ source: 'cezar-design', type: 'rects', rects: [] }, MIRROR, frame().contentWindow)
    const adrift = document.querySelector('[data-slot=browser-design-adrift]')!
    // The draft only — a sent note without a frame has nothing left to write.
    expect(adrift.textContent).toBe('Draft · button.save')
    fireEvent.click(adrift.querySelector('button')!)
    expect(screen.getByTestId('note').dataset.mark).toBe('abc-1')
  })

  it('tells the page to drop the frame of a pick the host did not keep', async () => {
    const { view } = harness()
    render(view([SENT], () => false))
    await enterDesignMode()
    const post = vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(() => {})
    deliver({ source: 'cezar-design', type: 'picked', element: { ...ELEMENT, mark: 'abc-9' } }, MIRROR, frame().contentWindow)
    expect(post).toHaveBeenCalledWith({ source: 'cezar-design-host', type: 'set-marks', marks: [{ key: 'abc-2', n: 1 }] }, MIRROR)
    expect(screen.queryByTestId('note')).toBeNull()
  })

  it('ignores a malformed report of where the frames are', async () => {
    const { view } = harness()
    const { rerender } = render(view([]))
    await enterDesignMode()
    deliver({ source: 'cezar-design', type: 'picked', element: { ...ELEMENT, mark: 'abc-1' } }, MIRROR, frame().contentWindow)
    rerender(view([DRAFT]))
    for (const rects of ['nope', [{ key: '../../x', x: 1 }], [null, 7], [{ key: 'abc-1', x: 'left', y: Number.NaN, width: 5, height: 5 }]]) {
      deliver({ source: 'cezar-design', type: 'rects', rects }, MIRROR, frame().contentWindow)
    }
    expect(screen.getByTestId('note')).toBeTruthy()
  })
})

describe('placeNote', () => {
  const area = { width: 800, height: 600 }
  const note = { width: 360, height: 200 }
  it('sits under the element, aligned to its left edge', () => {
    expect(placeNote({ x: 100, y: 50, width: 120, height: 30 }, area, note)).toEqual({ left: 100, top: 90 })
  })
  it('flips above when there is no room below', () => {
    expect(placeNote({ x: 100, y: 500, width: 120, height: 30 }, area, note)).toEqual({ left: 100, top: 290 })
  })
  it('stays inside the frame for an element near the right edge or scrolled out of view', () => {
    expect(placeNote({ x: 760, y: 50, width: 30, height: 30 }, area, note).left).toBe(432)
    expect(placeNote({ x: 100, y: -900, width: 120, height: 30 }, area, note).top).toBe(8)
    expect(placeNote({ x: 100, y: 5000, width: 120, height: 30 }, area, note).top).toBe(392)
  })
  it('parks in the bottom-right corner without an element to sit beside', () => {
    expect(placeNote(undefined, area, note)).toEqual({ left: 432, top: 392 })
  })
})

describe('designOrigin', () => {
  it.each([
    ['http://localhost:5173/a?b#c', 'http://localhost:5173'],
    ['http://127.0.0.1:3000/', 'http://127.0.0.1:3000'],
    ['http://[::1]:8080/', 'http://[::1]:8080'],
  ])('mirrors a loopback http address: %s', (url, origin) => {
    expect(designOrigin(url)).toBe(origin)
  })

  it.each(['', 'https://localhost:5173/', 'http://example.com/', 'http://127.0.0.1.evil.example/', 'nope'])(
    'refuses %j',
    (url) => {
      expect(designOrigin(url)).toBeNull()
    },
  )
})
