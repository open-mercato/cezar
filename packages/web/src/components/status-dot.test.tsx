import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StatusDot, type StatusDotTone } from './status-dot'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

function renderDot(ui: React.ReactElement) {
  const { container } = render(ui)
  const dot = container.querySelector('[data-slot="status-dot"]')
  if (!dot) throw new Error('StatusDot did not render')
  return dot
}

describe('StatusDot', () => {
  describe('tone → class mapping', () => {
    it.each([
      { tone: 'success', expected: 'bg-success' },
      { tone: 'pending', expected: 'bg-pending' },
      { tone: 'danger', expected: 'bg-danger' },
      { tone: 'violet', expected: 'bg-violet' },
      { tone: 'info', expected: 'bg-info' },
      { tone: 'neutral', expected: 'bg-soft-foreground' },
      { tone: 'idle', expected: 'bg-conflict' },
    ] as const satisfies readonly { tone: StatusDotTone; expected: string }[])(
      '$tone',
      ({ tone, expected }) => {
        const dot = renderDot(<StatusDot tone={tone} />)

        expect(dot.className).toContain(expected)
        expect(dot.getAttribute('data-tone')).toBe(tone)
      }
    )
  })

  it('defaults to the neutral tone', () => {
    const dot = renderDot(<StatusDot />)

    expect(dot.getAttribute('data-tone')).toBe('neutral')
    expect(dot.className).toContain('bg-soft-foreground')
  })

  it('renders at the design system 7px size', () => {
    const dot = renderDot(<StatusDot />)

    expect(dot.className).toContain('size-[7px]')
    expect(dot.className).toContain('rounded-full')
  })

  it('pulses only when asked to', () => {
    expect(renderDot(<StatusDot tone="success" pulse />).className).toContain('animate-pulse')
    expect(renderDot(<StatusDot tone="success" />).className).not.toContain('animate-pulse')
    expect(renderDot(<StatusDot tone="success" pulse={false} />).className).not.toContain(
      'animate-pulse'
    )
  })

  it('holds still under prefers-reduced-motion', () => {
    expect(renderDot(<StatusDot tone="pending" pulse />).className.split(' ')).toContain('motion-reduce:animate-none')
  })

  it('lets a caller className override the tone', () => {
    const dot = renderDot(<StatusDot tone="success" className="bg-violet" />)

    expect(dot.className).toContain('bg-violet')
    expect(dot.className).not.toContain('bg-success')
  })

  describe('off-screen pause', () => {
    afterEach(() => vi.unstubAllGlobals())

    function stubObserver() {
      const observed = new Set<Element>()
      let callback: IntersectionObserverCallback = () => {}
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(cb: IntersectionObserverCallback) {
            callback = cb
          }
          observe = (el: Element) => observed.add(el)
          unobserve = (el: Element) => observed.delete(el)
          disconnect = () => observed.clear()
        }
      )
      const report = (target: Element, isIntersecting: boolean) =>
        callback([{ target, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver)
      return { observed, report }
    }

    it('marks a pulsing dot off screen so CSS pauses it, and clears it back on screen', () => {
      const { observed, report } = stubObserver()
      const dot = renderDot(<StatusDot tone="pending" pulse />)

      expect(observed.has(dot)).toBe(true)
      expect(dot.className).toContain('data-offscreen:[animation-play-state:paused]')
      report(dot, false)
      expect(dot.hasAttribute('data-offscreen')).toBe(true)
      report(dot, true)
      expect(dot.hasAttribute('data-offscreen')).toBe(false)
    })

    it('watches only pulsing dots, and stops watching on unmount', () => {
      const { observed } = stubObserver()
      renderDot(<StatusDot tone="success" />)
      expect(observed.size).toBe(0)

      const { unmount } = render(<StatusDot tone="pending" pulse />)
      expect(observed.size).toBe(1)
      unmount()
      expect(observed.size).toBe(0)
    })

    it('still forwards a caller ref', () => {
      stubObserver()
      const ref = { current: null as HTMLSpanElement | null }
      const dot = renderDot(<StatusDot pulse ref={ref} />)
      expect(ref.current).toBe(dot)
    })
  })
})
