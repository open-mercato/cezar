import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GhostCodeBackdrop } from './ghost-code-backdrop'

/**
 * The ghost-code backdrop is decorative, so the things worth pinning are not the animation
 * (CSS timing is not unit-testable) but the two contracts a refactor could silently break:
 * the decorative-safety one — `aria-hidden` + pointer-transparency, or the fake code becomes
 * readable to screen readers and starts eating clicks meant for the composer — and the
 * component↔stylesheet one, where `styles/index.css` §ghost code drives every reveal from
 * `--n`/`--t`/`--d`/`--cycle`. A missing custom property does not throw; it renders zero-width
 * lines, i.e. nothing at all, which no human notices on a backdrop.
 *
 * Plus the motion contract: under `prefers-reduced-motion: reduce` (and wherever `matchMedia`
 * is missing, which is jsdom's default and this suite's baseline) the loop timer must never be
 * scheduled, and toggling the OS setting at runtime must start/stop it live.
 */

/** jsdom ships no `matchMedia` at all, so stub rather than spy (same convention as theme.test). */
function stubMatchMedia(reduce: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  vi.stubGlobal(
    'matchMedia',
    vi.fn(
      (media: string) =>
        ({
          media,
          matches: reduce,
          addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
            listeners.add(listener),
          removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
            listeners.delete(listener),
        }) as unknown as MediaQueryList,
    ),
  )
  /** Fire an OS-level change of the preference at every subscribed listener. */
  return (matches: boolean) => {
    for (const listener of listeners) listener({ matches } as MediaQueryListEvent)
  }
}

const blocksOf = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('.ghost-code-block'),
]
const cycleMsOf = (container: HTMLElement) =>
  Number.parseInt(blocksOf(container)[0]?.style.getPropertyValue('--cycle') ?? '', 10)
/** Did the component schedule its own loop timer? Keyed on the exact cycle length so React's
 *  own internal timers can never be mistaken for it. */
const scheduledLoop = (calls: readonly unknown[][], cycleMs: number) =>
  calls.some((call) => call[1] === cycleMs)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('GhostCodeBackdrop', () => {
  it('renders as a decorative layer: aria-hidden, pointer-transparent, behind everything', () => {
    const { container } = render(<GhostCodeBackdrop />)
    const backdrop = container.querySelector<HTMLElement>('[data-slot="ghost-code-backdrop"]')
    expect(backdrop).not.toBeNull()
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true')
    expect(backdrop?.className).toContain('pointer-events-none')
    expect(backdrop?.className).toContain('-z-10')
    // Below xl the side margins would collide with the composer column, so the layer is hidden.
    expect(backdrop?.className).toContain('max-xl:hidden')
  })

  it('lays out one snippet panel per screen zone, each with typed lines', () => {
    const { container } = render(<GhostCodeBackdrop />)
    const blocks = blocksOf(container)
    expect(blocks).toHaveLength(3)
    for (const block of blocks) {
      expect(block.querySelectorAll('.ghost-code-line').length).toBeGreaterThan(0)
      // Every panel lands in a positioned slot, so no two of them stack in the same corner.
      expect(block.className).toMatch(/(left|right)-\[\d+%\]/)
      expect(block.className).toMatch(/top-\[\d+%\]/)
    }
  })

  it('drives the stylesheet through the --n/--t/--d/--cycle contract', () => {
    const { container } = render(<GhostCodeBackdrop />)
    const cycleMs = cycleMsOf(container)
    expect(cycleMs).toBeGreaterThan(0)
    for (const block of blocksOf(container)) {
      // One shared cycle length per scene: every panel fades on the same clock.
      expect(block.style.getPropertyValue('--cycle')).toBe(`${cycleMs}ms`)
      for (const line of block.querySelectorAll<HTMLElement>('.ghost-code-line')) {
        const chars = Number(line.style.getPropertyValue('--n'))
        expect(chars).toBe(line.textContent?.length)
        expect(chars).toBeGreaterThan(0)
        // `--t` is the steps() duration and `--d` the start delay; both must reach CSS as time.
        expect(line.style.getPropertyValue('--t')).toMatch(/^\d+ms$/)
        expect(line.style.getPropertyValue('--d')).toMatch(/^\d+ms$/)
      }
    }
  })

  it('types every panel in sequence — one author, never two carets at once', () => {
    const { container } = render(<GhostCodeBackdrop />)
    let previousEnd = -1
    for (const block of blocksOf(container)) {
      for (const line of block.querySelectorAll<HTMLElement>('.ghost-code-line')) {
        const delay = Number.parseInt(line.style.getPropertyValue('--d'), 10)
        const duration = Number.parseInt(line.style.getPropertyValue('--t'), 10)
        expect(delay).toBeGreaterThanOrEqual(previousEnd)
        previousEnd = delay + duration
      }
    }
    // The loop must outlast the last keystroke, or the scene would restart mid-typing.
    expect(cycleMsOf(container)).toBeGreaterThan(previousEnd)
  })

  it('schedules no loop timer where matchMedia is missing (jsdom, SSR)', () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const { container } = render(<GhostCodeBackdrop />)
    expect(scheduledLoop(setTimeoutSpy.mock.calls, cycleMsOf(container))).toBe(false)
  })

  it('schedules no loop timer under prefers-reduced-motion: reduce', () => {
    stubMatchMedia(true)
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const { container } = render(<GhostCodeBackdrop />)
    expect(scheduledLoop(setTimeoutSpy.mock.calls, cycleMsOf(container))).toBe(false)
  })

  it('loops on the scene length when motion is allowed, and stops live when it is revoked', () => {
    const emitPreferenceChange = stubMatchMedia(false)
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    const { container } = render(<GhostCodeBackdrop />)
    expect(scheduledLoop(setTimeoutSpy.mock.calls, cycleMsOf(container))).toBe(true)

    // The CSS half re-evaluates on an OS toggle, so the timer has to unwind with it.
    setTimeoutSpy.mockClear()
    act(() => emitPreferenceChange(true))
    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(scheduledLoop(setTimeoutSpy.mock.calls, cycleMsOf(container))).toBe(false)
  })
})
