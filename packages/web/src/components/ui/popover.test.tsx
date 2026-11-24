import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Popover, PopoverContent, PopoverTrigger } from './popover'

/** A drivable visualViewport: the test opens and closes the keyboard like Safari does. */
class StubViewport extends EventTarget {
  width = 390
  offsetLeft = 0
  pageLeft = 0
  pageTop = 0
  scale = 1
  constructor(
    public height: number,
    public offsetTop = 0,
  ) {
    super()
  }
}

const NATURAL = 474
let viewport: StubViewport
let triggerRect = { top: 180, bottom: 216 }

beforeEach(() => {
  triggerRect = { top: 180, bottom: 216 }
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  Object.defineProperty(window, 'innerHeight', { value: 858, configurable: true })
  viewport = new StubViewport(858)
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.slot === 'popover-content' ? NATURAL : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.slot !== 'popover-trigger') return new DOMRect(0, 0, 0, 0)
    return new DOMRect(16, triggerRect.top, 240, triggerRect.bottom - triggerRect.top)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'visualViewport', { value: null, configurable: true })
})

function renderOpen() {
  render(
    <Popover open>
      <PopoverTrigger>Projects</PopoverTrigger>
      <PopoverContent sideOffset={6}>menu</PopoverContent>
    </Popover>,
  )
  return () => screen.getByText('menu').closest<HTMLElement>('[data-slot="popover-content"]')!
}

async function keyboard(height: number) {
  await act(async () => {
    viewport.height = height
    viewport.dispatchEvent(new Event('resize'))
  })
}

describe('PopoverContent placement against the visual viewport', () => {
  it('stays below the trigger and shrinks when the keyboard opens under it', async () => {
    const content = renderOpen()
    await act(async () => {})
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('')

    await keyboard(507) // 285px left between the trigger and the keys
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('285px')

    await keyboard(858)
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('')
  })

  it('flips above only once the keyboard leaves no usable room below, and back when it closes', async () => {
    triggerRect = { top: 420, bottom: 456 }
    const content = renderOpen()
    await act(async () => {})
    expect(content().dataset.side).toBe('bottom')

    await keyboard(507) // 45px below, 414px above
    expect(content().dataset.side).toBe('top')
    expect(content().style.maxHeight).toBe('414px')

    await keyboard(858)
    expect(content().dataset.side).toBe('bottom')
  })
})
