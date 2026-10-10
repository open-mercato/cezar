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
  it('tells the page which elements to frame and what number each wears', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <BrowserView state={{ tabs: [APP], active: 0 }} onChange={onChange} onPickElement={() => true} designMarks={[]} />,
    )
    await enterDesignMode()
    const post = vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(() => {})
    deliver({ source: 'cezar-design', type: 'ready' }, MIRROR, frame().contentWindow)
    expect(post).toHaveBeenCalledWith({ source: 'cezar-design-host', type: 'set-marks', marks: [] }, MIRROR)
    // The second element of the note is the first the page can still frame: it keeps number 2.
    rerender(
      <BrowserView
        state={{ tabs: [APP], active: 0 }}
        onChange={onChange}
        onPickElement={() => true}
        designMarks={[{ key: 'abc-4', n: 2 }]}
      />,
    )
    expect(post).toHaveBeenLastCalledWith(
      { source: 'cezar-design-host', type: 'set-marks', marks: [{ key: 'abc-4', n: 2 }] },
      MIRROR,
    )
  })

  it('opens the note beside a picked element, and follows the element when the page reports it moved', async () => {
    const renderNote = vi.fn(({ close }: { close: () => void }) => (
      <button type="button" data-testid="note" onClick={close}>
        note
      </button>
    ))
    const view = (count: number) => (
      <BrowserView
        state={{ tabs: [APP], active: 0 }}
        onChange={onChange}
        onPickElement={() => true}
        designPickCount={count}
        renderDesignNote={renderNote}
      />
    )
    const onChange = vi.fn()
    // jsdom lays nothing out, so the frame area would be 0×0 and every position would clamp to
    // the margin. Give it a size; the popup itself stays 0×0, which is enough to see WHERE.
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    onTestFinished(() => {
      width.mockRestore()
      height.mockRestore()
    })
    const { rerender } = render(view(0))
    await enterDesignMode()
    // Selecting, nothing picked: no note — the hint says what to do.
    expect(screen.queryByTestId('note')).toBeNull()

    deliver(
      { source: 'cezar-design', type: 'picked', element: { ...ELEMENT, mark: 'abc-1', rect: { x: 40, y: 50, width: 100, height: 20 } } },
      MIRROR,
      frame().contentWindow,
    )
    rerender(view(1))
    const note = () => document.querySelector<HTMLElement>('[data-slot=browser-design-note]')!
    expect(screen.getByTestId('note')).toBeTruthy()
    // Shown in the note, so no toast about a composer the user is not looking at.
    expect(toast).not.toHaveBeenCalled()
    // Only the anchoring itself is observable here:
    // the popup's left edge is the element's, and it sits under it.
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

  it('closes on request, comes back when a mark is clicked, and goes when the note is emptied', async () => {
    const view = (count: number) => (
      <BrowserView
        state={{ tabs: [APP], active: 0 }}
        onChange={onChange}
        onPickElement={() => true}
        designPickCount={count}
        renderDesignNote={({ close }) => (
          <button type="button" data-testid="note" onClick={close}>
            note
          </button>
        )}
      />
    )
    const onChange = vi.fn()
    const { rerender } = render(view(0))
    await enterDesignMode()
    deliver({ source: 'cezar-design', type: 'picked', element: { ...ELEMENT, mark: 'abc-1' } }, MIRROR, frame().contentWindow)
    rerender(view(1))
    fireEvent.click(screen.getByTestId('note'))
    expect(screen.queryByTestId('note')).toBeNull()

    // Clicking the marked element again is how the note comes back — it is not picked twice.
    deliver({ source: 'cezar-design', type: 'mark-clicked', key: 'abc-1' }, MIRROR, frame().contentWindow)
    expect(screen.getByTestId('note')).toBeTruthy()

    // Sent (or emptied): there is nothing left for a note to be about.
    rerender(view(0))
    expect(screen.queryByTestId('note')).toBeNull()
  })

  it('ignores a malformed report of where the marks are', async () => {
    const view = (
      <BrowserView
        state={{ tabs: [APP], active: 0 }}
        onChange={vi.fn()}
        onPickElement={() => true}
        designPickCount={1}
        renderDesignNote={() => <span data-testid="note">note</span>}
      />
    )
    render(view)
    await enterDesignMode()
    deliver({ source: 'cezar-design', type: 'picked', element: { ...ELEMENT, mark: 'abc-1', rect: { x: 40, y: 50, width: 100, height: 20 } } }, MIRROR, frame().contentWindow)
    for (const rects of ['nope', [{ key: '../../x', x: 1 }], [null, 7], [{ key: 'abc-1', x: 'left', y: Number.NaN, width: 5, height: 5 }]]) {
      deliver({ source: 'cezar-design', type: 'rects', rects }, MIRROR, frame().contentWindow)
    }
    // Still there, still on screen: a hostile page can move its own note, not break the view.
    expect(screen.getByTestId('note')).toBeTruthy()
  })

  it('reports an element deselected in the page', async () => {
    const onUnpickElement = vi.fn()
    render(
      <BrowserView
        state={{ tabs: [APP], active: 0 }}
        onChange={vi.fn()}
        onPickElement={() => true}
        onUnpickElement={onUnpickElement}
      />,
    )
    await enterDesignMode()
    deliver({ source: 'cezar-design', type: 'unpicked', key: 'abc-4' }, MIRROR, frame().contentWindow)
    expect(onUnpickElement).toHaveBeenCalledWith('abc-4')
  })

  it('tells the page to drop the frame of a pick the host did not keep', async () => {
    // The page frames an element the moment it is clicked. A refused pick must not stay lime.
    render(
      <BrowserView
        state={{ tabs: [APP], active: 0 }}
        onChange={vi.fn()}
        onPickElement={() => false}
        designMarks={[{ key: 'abc-1', n: 1 }]}
      />,
    )
    await enterDesignMode()
    const post = vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(() => {})
    deliver({ source: 'cezar-design', type: 'picked', element: { ...ELEMENT, mark: 'abc-2' } }, MIRROR, frame().contentWindow)
    expect(post).toHaveBeenCalledWith(
      { source: 'cezar-design-host', type: 'set-marks', marks: [{ key: 'abc-1', n: 1 }] },
      MIRROR,
    )
  })

  it('shows the queues strip whenever the host provides one', () => {
    const { rerender } = render(<BrowserView state={{ tabs: [APP], active: 0 }} onChange={vi.fn()} onPickElement={() => true} />)
    expect(screen.queryByTestId('dock')).toBeNull()
    rerender(
      <BrowserView
        state={{ tabs: [APP], active: 0 }}
        onChange={vi.fn()}
        onPickElement={() => true}
        designDock={<div data-testid="dock">queues</div>}
      />,
    )
    expect(screen.getByTestId('dock')).toBeTruthy()
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
