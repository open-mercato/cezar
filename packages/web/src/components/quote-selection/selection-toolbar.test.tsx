import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { QuoteSelectionChip } from './quote-selection-chip'
import { SelectionToolbar, useMessageSelection } from './selection-toolbar'
import { useCoarsePointer } from './touch'
import { captureFromSelection, type QuoteCapture } from './types'

function select(node: Node, start = 0, end = node.textContent?.length ?? 0) {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

async function selectionChanged() {
  await act(async () => {
    document.dispatchEvent(new Event('selectionchange'))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  })
}

/** `(pointer: coarse)` answers `coarse`; jsdom has no matchMedia of its own. */
function pointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.getSelection()?.removeAllRanges()
})

describe('captureFromSelection', () => {
  function body() {
    render(
      <div data-quote-body data-quote-role="assistant" data-quote-ref="4">
        <p data-testid="prose">Some prose to quote.</p>
        <div data-quote-excluded><p data-testid="card">Session card title</p></div>
        <p data-testid="after">Trailing prose.</p>
      </div>,
    )
  }

  it('captures prose inside one body with its role, ref and time', () => {
    body()
    select(screen.getByTestId('prose').firstChild!, 5, 10)
    expect(captureFromSelection(window.getSelection()!)).toMatchObject({ excerpt: 'prose', role: 'assistant', ref: 4, code: false })
  })

  it('captures a whole paragraph when the selection spans its inline markdown nodes', () => {
    render(
      <div data-quote-body data-quote-role="assistant" data-quote-ref="4">
        <p data-testid="paragraph">To nie jest osobne zadanie. <code>Build &amp; switch</code> albo lokalnie.</p>
      </div>,
    )
    const paragraph = screen.getByTestId('paragraph')
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)

    expect(captureFromSelection(window.getSelection()!)).toMatchObject({
      excerpt: 'To nie jest osobne zadanie. Build & switch albo lokalnie.',
      role: 'assistant',
      ref: 4,
    })
  })

  it('captures a whole quote body when range boundaries are in its parent', () => {
    const { container } = render(
      <div data-testid="selection-host">
        <p data-quote-body data-quote-role="assistant" data-quote-ref="4">A whole paragraph.</p>
      </div>,
    )
    const quoteBody = container.querySelector('[data-quote-body]')!
    const range = document.createRange()
    range.selectNode(quoteBody)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)

    expect(captureFromSelection(window.getSelection()!)).toMatchObject({ excerpt: 'A whole paragraph.', role: 'assistant', ref: 4 })
  })

  it('quotes only the code, as code, when a code block is selected with its header', () => {
    render(
      <div data-quote-body data-quote-role="assistant">
        <div data-streamdown="code-block" data-testid="block">
          <div data-streamdown="code-block-header"><span>ts</span><button type="button">Copy</button></div>
          <div data-streamdown="code-block-body"><pre><code><span><span>const a = 1</span></span><span>{'\n'}</span><span><span>  return a</span></span></code></pre></div>
        </div>
      </div>,
    )
    const range = document.createRange()
    range.selectNodeContents(screen.getByTestId('block'))
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    expect(captureFromSelection(window.getSelection()!)).toMatchObject({ excerpt: 'const a = 1\n\n  return a', code: true })
  })

  it('offers nothing when the selection drags text from outside the body into it', () => {
    const { container } = render(
      <div>
        <div data-testid="tool">Tool output</div>
        <div data-quote-body data-quote-role="assistant"><p data-testid="reply">agent reply</p></div>
        <div data-testid="after">Sub-agent panel</div>
      </div>,
    )
    const quoteBody = container.querySelector('[data-quote-body]')!
    select(screen.getByTestId('tool').firstChild!, 0, 0)
    window.getSelection()!.getRangeAt(0).setEnd(screen.getByTestId('reply').firstChild!, 5)
    expect(captureFromSelection(window.getSelection()!)).toBeNull()

    const across = document.createRange()
    across.setStart(screen.getByTestId('tool').firstChild!, 0)
    across.setEnd(screen.getByTestId('after').firstChild!, 3)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(across)
    expect(captureFromSelection(window.getSelection()!)).toBeNull()

    // An empty gap (a triple-click ending at the next block's start) still quotes the body.
    const whole = document.createRange()
    whole.setStart(quoteBody, 0)
    whole.setEnd(screen.getByTestId('after').firstChild!, 0)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(whole)
    expect(captureFromSelection(window.getSelection()!)).toMatchObject({ excerpt: 'agent reply' })
  })

  it('offers nothing for a selection inside, or across, an excluded element', () => {
    body()
    select(screen.getByTestId('card').firstChild!, 0, 7)
    expect(captureFromSelection(window.getSelection()!)).toBeNull()

    const range = document.createRange()
    range.setStart(screen.getByTestId('prose').firstChild!, 0)
    range.setEnd(screen.getByTestId('after').firstChild!, 8)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    expect(captureFromSelection(window.getSelection()!)).toBeNull()
  })

  it('offers nothing for a selection spanning two message bodies', () => {
    render(
      <>
        <div data-quote-body data-quote-role="assistant" data-quote-ref="1"><p data-testid="one">First message.</p></div>
        <div data-quote-body data-quote-role="user" data-quote-ref="2"><p data-testid="two">Second message.</p></div>
      </>,
    )
    const range = document.createRange()
    range.setStart(screen.getByTestId('one').firstChild!, 6)
    range.setEnd(screen.getByTestId('two').firstChild!, 6)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    expect(captureFromSelection(window.getSelection()!)).toBeNull()
  })
})

describe('useCoarsePointer', () => {
  it('is false without matchMedia (jsdom, SSR) and follows (pointer: coarse) when present', () => {
    expect(renderHook(() => useCoarsePointer()).result.current).toBe(false)
    pointer(true)
    expect(renderHook(() => useCoarsePointer()).result.current).toBe(true)
  })
})

function Host({ onQuote, chip = false }: { onQuote: (capture: QuoteCapture) => void; chip?: boolean }) {
  const capture = useMessageSelection()
  return (
    <>
      <div data-quote-body data-quote-role="user" data-quote-ref="2"><p data-testid="text">Quote me please.</p></div>
      <button type="button">Elsewhere</button>
      {capture ? <SelectionToolbar capture={capture} onQuote={onQuote} /> : null}
      {capture && chip ? <QuoteSelectionChip capture={capture} onQuote={onQuote} /> : null}
    </>
  )
}

describe('useMessageSelection + SelectionToolbar', () => {
  it('re-places itself when content above the selection reflows (no scroll, no resize)', async () => {
    const observers: Array<{ callback: () => void; targets: Element[] }> = []
    vi.stubGlobal('ResizeObserver', class {
      targets: Element[] = []
      constructor(public callback: () => void) { observers.push(this) }
      observe(el: Element) { this.targets.push(el) }
      disconnect() {}
      unobserve() {}
    })
    render(<Host onQuote={vi.fn()} />)
    const text = screen.getByTestId('text')
    let top = 300
    const rect = () => ({ top, bottom: top + 20, left: 100, right: 200, width: 100, height: 20, x: 100, y: top, toJSON() {} }) as DOMRect
    // jsdom's Range has no layout at all.
    const proto = Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect }
    const had = Object.prototype.hasOwnProperty.call(proto, 'getBoundingClientRect')
    const original = proto.getBoundingClientRect
    proto.getBoundingClientRect = rect
    onTestFinished(() => { if (had) proto.getBoundingClientRect = original; else delete proto.getBoundingClientRect })
    vi.spyOn(text.parentElement!, 'getBoundingClientRect').mockImplementation(rect)
    select(text.firstChild!, 0, 8)
    await selectionChanged()
    const toolbar = await screen.findByRole('toolbar')
    const before = toolbar.style.top
    const observer = observers.find((o) => o.targets.includes(text.parentElement!))
    expect(observer).toBeDefined()
    top = 500
    act(() => observer!.callback())
    expect(toolbar.style.top).not.toBe(before)
  })

  it('keeps the capture on touch when a tap on the toolbar collapses the selection first', async () => {
    pointer(true)
    const onQuote = vi.fn()
    render(<Host onQuote={onQuote} />)
    select(screen.getByTestId('text').firstChild!, 0, 8)
    await selectionChanged()
    const quote = await screen.findByRole('button', { name: /Quote/ })

    // Touch: the tap collapses the selection before `click` fires.
    fireEvent.pointerDown(quote)
    window.getSelection()!.removeAllRanges()
    await selectionChanged()
    fireEvent.click(screen.getByRole('button', { name: /Quote/ }))

    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ excerpt: 'Quote me', role: 'user', ref: 2 }))
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('hides on a click elsewhere and on Escape', async () => {
    render(<Host onQuote={vi.fn()} />)
    select(screen.getByTestId('text').firstChild!, 0, 8)
    await selectionChanged()
    await screen.findByRole('toolbar')
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull())

    select(screen.getByTestId('text').firstChild!, 6, 8)
    await selectionChanged()
    await screen.findByRole('toolbar')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('toolbar')).toBeNull()
    // The toolbar clears the selection itself, so every host leaves nothing highlighted.
    expect(window.getSelection()!.isCollapsed).toBe(true)
  })

  it('keeps the same capture object while the selection is unchanged, so hosts do not re-render', async () => {
    render(<div data-quote-body data-quote-role="user" data-quote-ref="2"><p data-testid="text">Quote me please.</p></div>)
    const { result } = renderHook(() => useMessageSelection())
    select(screen.getByTestId('text').firstChild!, 0, 8)
    await selectionChanged()
    const first = result.current
    expect(first).toMatchObject({ excerpt: 'Quote me' })
    await selectionChanged()
    expect(result.current).toBe(first)
    select(screen.getByTestId('text').firstChild!, 0, 5)
    await selectionChanged()
    expect(result.current).toMatchObject({ excerpt: 'Quote' })
  })

  it('offers the toolbar again when the same text is selected after it was quoted', async () => {
    const onQuote = vi.fn()
    render(<Host onQuote={onQuote} />)
    for (let round = 0; round < 2; round++) {
      select(screen.getByTestId('text').firstChild!, 0, 8)
      await selectionChanged()
      fireEvent.click(await screen.findByRole('button', { name: /Quote/ }))
    }
    expect(onQuote).toHaveBeenCalledTimes(2)
    expect(onQuote.mock.calls[0]![0]).not.toBe(onQuote.mock.calls[1]![0])
  })

  it('drops the capture when the keyboard collapses the selection on a non-touch device', async () => {
    pointer(false)
    render(<Host onQuote={vi.fn()} />)
    select(screen.getByTestId('text').firstChild!, 0, 8)
    await selectionChanged()
    await screen.findByRole('toolbar')

    // Shift+arrow back to nothing: no pointerdown anywhere.
    window.getSelection()!.collapseToEnd()
    await selectionChanged()
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('quotes with Alt+Q, announced on the button', async () => {
    const onQuote = vi.fn()
    render(<Host onQuote={onQuote} />)
    select(screen.getByTestId('text').firstChild!, 6, 8)
    await selectionChanged()
    const quote = await screen.findByRole('button', { name: /Quote/ })
    expect(quote.getAttribute('aria-keyshortcuts')).toBe('Alt+Q')

    fireEvent.keyDown(window, { key: 'œ', code: 'KeyQ', altKey: true })
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ excerpt: 'me' }))
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('on touch, a scroll gesture keeps the capture and a tap elsewhere drops it', async () => {
    pointer(true)
    render(<Host onQuote={vi.fn()} chip />)
    select(screen.getByTestId('text').firstChild!, 0, 5)
    await selectionChanged()
    await screen.findByRole('button', { name: 'Quote selection' })
    // A touch scroll starts with a pointerdown on the transcript but never clicks.
    fireEvent.pointerDown(screen.getByTestId('text'))
    expect(screen.getByRole('button', { name: 'Quote selection' })).toBeTruthy()
    fireEvent.click(screen.getByTestId('text'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Quote selection' })).toBeNull())
  })

  it('quotes from the touch chip after the tap collapsed the selection', async () => {
    pointer(true)
    const onQuote = vi.fn()
    render(<Host onQuote={onQuote} chip />)
    select(screen.getByTestId('text').firstChild!, 0, 5)
    await selectionChanged()
    const chip = await screen.findByRole('button', { name: 'Quote selection' })
    expect(chip.getAttribute('data-slot')).toBe('quote-selection-chip')

    fireEvent.pointerDown(chip)
    window.getSelection()!.removeAllRanges()
    await selectionChanged()
    fireEvent.click(screen.getByRole('button', { name: 'Quote selection' }))
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ excerpt: 'Quote' }))
  })
})
