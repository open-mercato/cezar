import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const draws: string[] = []
vi.mock('./mascot-renderer', () => ({
  loadMascot: () => Promise.resolve({}),
  readMascotPalette: () => ({}),
  drawMascot: () => { draws.push('draw') },
}))

import { ManagerMascot, mascotBackingSize } from './manager-mascot'
import { mascotFrameInterval } from './mascot-motion'

let reduced = false
let intersect: ((entries: { isIntersecting: boolean }[]) => void) | undefined
const frames: FrameRequestCallback[] = []
const ctx = { setTransform: vi.fn(), imageSmoothingQuality: 'low' }

beforeEach(() => {
  vi.useFakeTimers()
  draws.length = 0; frames.length = 0; reduced = false
  vi.stubGlobal('devicePixelRatio', 3)
  vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: typeof intersect) { intersect = callback } observe() {} disconnect() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 56 } as DOMRect)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Runs queued animation frames at `now`; returns how many ran. */
function flushFrames(now: number) {
  const queued = frames.splice(0)
  for (const frame of queued) frame(now)
  return queued.length
}

async function mount(activity: 'idle' | 'working' = 'idle') {
  const view = render(<ManagerMascot mascot="base" activity={activity} />)
  await act(async () => { await Promise.resolve() })
  return view
}

describe('ManagerMascot cost', () => {
  it('sizes the backing store to the drawn box, capped at 3x, not the 400 px rig', async () => {
    const { container } = await mount()
    const canvas = container.querySelector('canvas')!
    expect([canvas.width, canvas.height]).toEqual([168, 168])
    expect(ctx.setTransform).toHaveBeenCalledWith(168 / 400, 0, 0, 168 / 400, 0, 0)
    expect(mascotBackingSize(40, 1)).toBe(40)
    expect(mascotBackingSize(40, 4)).toBe(120)
  })

  it('redraws an idle mascot at ~15 fps once the blend settles, every frame while working', async () => {
    await mount()
    let now = 1000
    for (let i = 0; i < 20; i++) { flushFrames(now += 16); vi.advanceTimersByTime(16) }
    const settled = draws.length
    for (let i = 0; i < 60; i++) { flushFrames(now += 16); vi.advanceTimersByTime(16) }
    expect(draws.length - settled).toBeLessThanOrEqual(16)
    expect(mascotFrameInterval('working')).toBe(0)
    expect(mascotFrameInterval('idle')).toBeGreaterThanOrEqual(60)
  })

  it('stops scheduling while off screen and draws one static frame under reduced motion', async () => {
    await mount()
    act(() => intersect?.([{ isIntersecting: false }]))
    frames.length = 0; vi.runOnlyPendingTimers()
    expect(flushFrames(2000)).toBe(0)
    cleanup(); draws.length = 0; frames.length = 0
    reduced = true
    await mount()
    flushFrames(3000); vi.runOnlyPendingTimers()
    expect(draws).toHaveLength(1)
    expect(frames).toHaveLength(0)
  })
})
