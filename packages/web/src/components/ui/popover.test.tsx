import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './popover'

// jsdom has no safe area; a test sets one to stand in for the iPhone status bar.
const safeArea = vi.hoisted(() => ({ top: 0 }))
vi.mock('@/lib/popover-placement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/popover-placement')>()),
  safeAreaTop: () => safeArea.top,
}))

/**
 * Element sizes and rects are stubbed so Radix's own collision logic (floating-ui's flip,
 * clipped to `visualViewport`) really runs: `data-side` is the side floating-ui settled on,
 * not just the one we asked for.
 */
class StubViewport extends EventTarget {
  /** Listeners currently attached, by event type. */
  active = new Map<string, number>()
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    this.active.set(type, (this.active.get(type) ?? 0) + 1)
    super.addEventListener(type, listener, options)
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    this.active.set(type, (this.active.get(type) ?? 0) - 1)
    super.removeEventListener(type, listener, options)
  }
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

/** A ResizeObserver the test fires by hand (jsdom has none). */
class StubResizeObserver {
  static all: StubResizeObserver[] = []
  targets = new Set<Element>()
  disconnected = false
  constructor(public callback: ResizeObserverCallback) {
    StubResizeObserver.all.push(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.disconnected = true
    this.targets.clear()
  }
}

/** A real MutationObserver that records its instances and what they watch. */
class RecordingMutationObserver extends MutationObserver {
  static all: RecordingMutationObserver[] = []
  targets: Node[] = []
  disconnected = false
  constructor(callback: MutationCallback) {
    super(callback)
    RecordingMutationObserver.all.push(this)
  }
  override observe(target: Node, options?: MutationObserverInit) {
    this.targets.push(target)
    super.observe(target, options)
  }
  override disconnect() {
    this.disconnected = true
    super.disconnect()
  }
}

/** Fire every live observer watching `el` (or only the placement hook's, which also watches the
 *  content — Radix's own watches the wrapper), then let the frame run. */
async function resized(el: Element, onlyPlacement = false) {
  await act(async () => {
    for (const observer of StubResizeObserver.all) {
      if (!observer.targets.has(el)) continue
      if (onlyPlacement && ![...observer.targets].some((t) => (t as HTMLElement).dataset?.slot === 'popover-content')) continue
      observer.callback([], observer as unknown as ResizeObserver)
    }
  })
  await frame()
}

let viewport: StubViewport
/** The content's unclamped border-box height (1px border included) and its width. */
let natural = 474
let width = 300
/** Rects by `data-testid`, plus the trigger by its slot. */
let rects: Record<string, { x: number; top: number; width: number; height: number }> = {}

function contentHeight(el: HTMLElement): number {
  const cap = Number.parseFloat(el.style.maxHeight)
  return Number.isFinite(cap) ? Math.min(natural, cap) : natural
}

function sizeOf(el: HTMLElement): { width: number; height: number } | null {
  if (el.dataset.slot === 'popover-content') return { width, height: contentHeight(el) }
  if (el.hasAttribute('data-radix-popper-content-wrapper')) {
    const content = el.firstElementChild as HTMLElement | null
    return content ? { width, height: contentHeight(content) } : null
  }
  return null
}

beforeEach(() => {
  natural = 474
  width = 300
  safeArea.top = 0
  StubResizeObserver.all = []
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  rects = { trigger: { x: 16, top: 180, width: 240, height: 36 } }
  // A real frame later, as in a browser: Radix's own visualViewport listener recomputes in the
  // event itself, and that compute settles before the next frame re-picks the side.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  Object.defineProperty(window, 'innerHeight', { value: 858, configurable: true })
  viewport = new StubViewport(858)
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return sizeOf(this)?.height ?? 0
  })
  // A real 1px border: the box inside it is 2px shorter than the border box.
  for (const prop of ['scrollHeight', 'clientHeight'] as const) {
    vi.spyOn(HTMLElement.prototype, prop, 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.slot === 'popover-content' ? contentHeight(this) - 2 : 0
    })
  }
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return sizeOf(this)?.width ?? 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const key = this.dataset.testid ?? (this.dataset.slot === 'popover-trigger' ? 'trigger' : '')
    const rect = rects[key]
    return rect ? new DOMRect(rect.x, rect.top, rect.width, rect.height) : new DOMRect(0, 0, 0, 0)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'visualViewport', { value: null, configurable: true })
})

async function renderOpen(content: ReactNode) {
  render(content)
  await frame()
  return () => screen.getByText('menu').closest<HTMLElement>('[data-slot="popover-content"]')!
}

/** The height Radix's own size middleware found on the settled side, padding included. */
const radixRoom = (content: HTMLElement) =>
  content.parentElement!.style.getPropertyValue('--radix-popper-available-height')

const switcher = (props: Partial<React.ComponentProps<typeof PopoverContent>> = {}) => (
  <Popover open>
    <PopoverTrigger>Projects</PopoverTrigger>
    <PopoverContent sideOffset={6} {...props}>
      menu
    </PopoverContent>
  </Popover>
)

/** Open (or close) the keyboard: Safari shrinks only the visual viewport. */
async function keyboard(height: number) {
  await act(async () => {
    viewport.height = height
    viewport.dispatchEvent(new Event('resize'))
  })
  await frame()
}

/** Let the scheduled frame run and Radix's position settle. */
async function frame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await act(async () => {})
}

describe('PopoverContent placement against the visual viewport', () => {
  it('stays below the trigger and shrinks when the keyboard opens under it', async () => {
    const content = await renderOpen(switcher())
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('')

    await keyboard(507) // 285px left between the trigger and the keys, 174px above
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('285px')

    await keyboard(858)
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('')
  })

  it('flips above only once the keyboard leaves no usable room below, and back when it closes', async () => {
    rects.trigger = { x: 16, top: 420, width: 240, height: 36 }
    const content = await renderOpen(switcher())
    expect(content().dataset.side).toBe('bottom')

    await keyboard(507) // 45px below, 414px above
    expect(content().dataset.side).toBe('top')
    expect(content().style.maxHeight).toBe('414px')

    await keyboard(858) // 396px below, 414px above: below holds the usable minimum
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('396px')
  })

  it('places a side="top" popover against its PopoverAnchor, not the trigger (composer)', async () => {
    rects.trigger = { x: 16, top: 100, width: 40, height: 20 }
    rects.composer = { x: 16, top: 440, width: 300, height: 40 }
    const content = await renderOpen(
      <Popover open>
        <PopoverAnchor asChild>
          <div data-testid="composer">
            <PopoverTrigger>/</PopoverTrigger>
          </div>
        </PopoverAnchor>
        <PopoverContent side="top">menu</PopoverContent>
      </Popover>,
    )
    await keyboard(507) // 436px above the composer, 23px between it and the keys
    expect(content().dataset.side).toBe('top')
    expect(content().style.maxHeight).toBe('436px')
  })

  it('measures only the content box: an inner list with hidden rows does not make a fitting menu flip or clamp', async () => {
    // Desktop: 390px below, 494px above; the 342px menu fits below whole.
    Object.defineProperty(window, 'innerHeight', { value: 932, configurable: true })
    viewport.height = 932
    rects.trigger = { x: 16, top: 500, width: 240, height: 36 }
    natural = 342
    const content = await renderOpen(
      <Popover open>
        <PopoverTrigger>Pick</PopoverTrigger>
        <PopoverContent sideOffset={6}>
          <div data-testid="list" style={{ overflowY: 'auto', maxHeight: 300 }}>
            menu
          </div>
        </PopoverContent>
      </Popover>,
    )
    // 600px of hidden rows: counting them would read 942px and clamp the menu to 390px.
    const list = screen.getByTestId('list')
    vi.spyOn(list, 'scrollHeight', 'get').mockReturnValue(900)
    vi.spyOn(list, 'clientHeight', 'get').mockReturnValue(300)
    await keyboard(932) // re-measure with the inner list in place
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('')
  })

  it('takes a numeric collisionPadding off the room once, in the clamp and in Radix (composer options)', async () => {
    const content = await renderOpen(switcher({ collisionPadding: 8 }))
    await keyboard(507) // 285px below the trigger, minus 8px padding
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('277px')
    expect(radixRoom(content())).toBe('277px')
  })

  it('takes a per-side collisionPadding off the matching edge', async () => {
    rects.trigger = { x: 16, top: 420, width: 240, height: 36 }
    const content = await renderOpen(switcher({ collisionPadding: { top: 20, bottom: 30 } }))
    await keyboard(507) // 15px below after padding, 394px above after padding: flips
    expect(content().dataset.side).toBe('top')
    expect(content().style.maxHeight).toBe('394px')
    expect(radixRoom(content())).toBe('394px')
  })

  it('keeps a flipped menu below the safe-area top, in the clamp and in Radix', async () => {
    safeArea.top = 47
    rects.trigger = { x: 16, top: 420, width: 240, height: 36 }
    const content = await renderOpen(switcher())
    await keyboard(507) // 45px below; 414px above, 367px of it under the status bar's inset
    expect(content().dataset.side).toBe('top')
    expect(content().style.maxHeight).toBe('367px')
    expect(radixRoom(content())).toBe('367px')
  })

  it("counts the content's 1px border: a menu whose inner box fits but border box does not is clamped", async () => {
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
    viewport.height = 600
    rects.trigger = { x: 16, top: 217, width: 240, height: 36 } // 341px below, 211px above
    natural = 342 // 340px inside the border: it would fit the 341px room without it
    const content = await renderOpen(switcher())
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('341px')
  })

  it('never clamps to a bare border: with no room either way it opens unclamped on the larger side', async () => {
    rects.trigger = { x: 16, top: 40, width: 240, height: 60 }
    const content = await renderOpen(switcher())
    await keyboard(100) // 0px below the trigger, 34px above it
    expect(content().dataset.side).toBe('top')
    expect(content().style.maxHeight).toBe('')
  })

  it('leaves avoidCollisions={false} to Radix: no flip, no clamp', async () => {
    rects.trigger = { x: 16, top: 420, width: 240, height: 36 }
    const content = await renderOpen(switcher({ avoidCollisions: false }))
    await keyboard(507)
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('')
  })

  it("leaves left/right popovers to Radix's own flip", async () => {
    width = 200
    rects.trigger = { x: 250, top: 180, width: 100, height: 36 } // no room on the right
    const content = await renderOpen(switcher({ side: 'right' }))
    await keyboard(507)
    expect(content().dataset.side).toBe('left')
    expect(content().style.maxHeight).toBe('')
  })
})

describe('PopoverContent re-placement while open', () => {
  it('re-picks when the content shrinks (a filtered list) and its ResizeObserver fires', async () => {
    const content = await renderOpen(switcher())
    await keyboard(507)
    expect(content().style.maxHeight).toBe('285px')

    natural = 200 // the search narrowed the list: it now fits below whole
    await resized(content())
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('')
  })

  it('re-picks when the anchor resizes (the composer textarea grows upward)', async () => {
    rects.trigger = { x: 16, top: 100, width: 40, height: 20 }
    rects.composer = { x: 16, top: 440, width: 300, height: 40 }
    const content = await renderOpen(
      <Popover open>
        <PopoverAnchor asChild>
          <div data-testid="composer">
            <PopoverTrigger>/</PopoverTrigger>
          </div>
        </PopoverAnchor>
        <PopoverContent side="top">menu</PopoverContent>
      </Popover>,
    )
    await keyboard(507)
    expect(content().style.maxHeight).toBe('436px')

    rects.composer = { x: 16, top: 380, width: 300, height: 100 }
    await resized(screen.getByTestId('composer'), true)
    expect(content().dataset.side).toBe('top')
    expect(content().style.maxHeight).toBe('376px')
  })

  it("re-picks when Radix repositions the popper because the anchor moved on its own", async () => {
    const content = await renderOpen(switcher())
    await keyboard(507)
    expect(content().style.maxHeight).toBe('285px')

    rects.trigger = { x: 16, top: 240, width: 240, height: 36 } // a banner pushed it down 60px
    // Radix's autoUpdate notices the shift and rewrites the wrapper's style.
    await act(async () => {
      content().parentElement!.style.setProperty('--test-reposition', '1')
    })
    await frame()
    expect(content().style.maxHeight).toBe('225px')
  })

  it('measures a panned visual viewport (offsetTop) in layout coordinates', async () => {
    const content = await renderOpen(switcher())
    await act(async () => {
      viewport.height = 507
      viewport.offsetTop = 120 // iOS panned down to reveal the focused field
      viewport.dispatchEvent(new Event('scroll'))
    })
    await frame()
    // The visible band is 120–627: 405px below the trigger, 54px above it.
    expect(content().dataset.side).toBe('bottom')
    expect(content().style.maxHeight).toBe('405px')
  })

  it("ignores scrolls inside the menu's own list, re-picks on a page scroll", async () => {
    const content = await renderOpen(switcher())
    await keyboard(507)
    expect(content().style.maxHeight).toBe('285px')

    rects.trigger = { x: 16, top: 200, width: 240, height: 36 }
    await act(async () => {
      content().dispatchEvent(new Event('scroll'))
    })
    await frame()
    expect(content().style.maxHeight).toBe('285px')

    await act(async () => {
      document.dispatchEvent(new Event('scroll'))
    })
    await frame()
    expect(content().style.maxHeight).toBe('265px')
  })

  it('re-reads the safe-area inset on a window resize (rotation)', async () => {
    rects.trigger = { x: 16, top: 420, width: 240, height: 36 }
    const content = await renderOpen(switcher())
    await keyboard(507)
    expect(content().style.maxHeight).toBe('414px')

    safeArea.top = 47
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    await frame()
    expect(content().dataset.side).toBe('top')
    expect(content().style.maxHeight).toBe('367px')
  })

  it('removes every listener and observer on close, and re-attaches on reopen', async () => {
    // Keyed by type AND capture: a listener removed without the capture flag it was added with
    // stays attached, and must leave its count non-zero.
    const windowActive = new Map<string, number>()
    const key = (type: string, options?: boolean | EventListenerOptions) =>
      `${type}:${typeof options === 'boolean' ? options : !!options?.capture}`
    const live = (type: string) =>
      [...windowActive].filter(([k]) => k.startsWith(`${type}:`)).reduce((sum, [, n]) => sum + n, 0)
    const leaked = (type: string) => [...windowActive].filter(([k, n]) => k.startsWith(`${type}:`) && n !== 0)
    const add = window.addEventListener.bind(window)
    const remove = window.removeEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        windowActive.set(key(type, options), (windowActive.get(key(type, options)) ?? 0) + 1)
        add(type, listener, options)
      },
    )
    vi.spyOn(window, 'removeEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
        windowActive.set(key(type, options), (windowActive.get(key(type, options)) ?? 0) - 1)
        remove(type, listener, options)
      },
    )
    RecordingMutationObserver.all = []
    vi.stubGlobal('MutationObserver', RecordingMutationObserver)
    const placementObservers = () =>
      RecordingMutationObserver.all.filter((o) =>
        o.targets.some((t) => t instanceof HTMLElement && t.hasAttribute('data-radix-popper-content-wrapper')),
      )
    const tree = (open: boolean) => (
      <Popover open={open}>
        <PopoverTrigger>Projects</PopoverTrigger>
        <PopoverContent sideOffset={6}>menu</PopoverContent>
      </Popover>
    )
    const { rerender } = render(tree(true))
    await frame()
    expect(viewport.active.get('resize')).toBeGreaterThan(0)
    expect(live('resize')).toBeGreaterThan(0)
    expect(windowActive.get('scroll:true')).toBeGreaterThan(0) // the hook's capture-phase scroll
    expect(StubResizeObserver.all.some((o) => !o.disconnected)).toBe(true)
    expect(placementObservers().length).toBeGreaterThan(0)

    rerender(tree(false))
    await frame()
    expect(screen.queryByText('menu')).toBeNull()
    expect(viewport.active.get('resize')).toBe(0)
    expect(viewport.active.get('scroll')).toBe(0)
    expect(leaked('resize')).toEqual([])
    expect(leaked('scroll')).toEqual([])
    expect(StubResizeObserver.all.every((o) => o.disconnected)).toBe(true)
    expect(placementObservers().every((o) => o.disconnected)).toBe(true)

    rerender(tree(true))
    await frame()
    await keyboard(507)
    const content = screen.getByText('menu').closest<HTMLElement>('[data-slot="popover-content"]')!
    expect(content.style.maxHeight).toBe('285px')
  })
})
