import { describe, expect, it, vi } from 'vitest'

import { choosePopoverPlacement, naturalHeight, POPOVER_MIN_HEIGHT, visibleBand } from './popover-placement'

// An iPhone-sized layout viewport (858px) with the keyboard up: the visual viewport is 507px
// tall, so 351px of layout viewport sits under the keys. The switcher trigger is at 180–216.
const PHONE = { innerHeight: 858, visualViewport: { height: 507, offsetTop: 0 } }
const SAFE_TOP = 47
const trigger = { anchorTop: 180, anchorBottom: 216, sideOffset: 6 }

describe('choosePopoverPlacement — keyboard-reduced visual viewport', () => {
  const band = visibleBand(PHONE, SAFE_TOP, { top: 0, bottom: 0 })

  it('measures the band against the visual viewport and the safe-area top', () => {
    expect(band).toEqual({ top: 47, bottom: 507 })
  })

  it('opens below and shrinks a menu taller than the room left above the keyboard', () => {
    // 474px natural menu; 285px below the trigger, 127px above it.
    const placement = choosePopoverPlacement({ ...trigger, viewTop: band.top, viewBottom: band.bottom, naturalHeight: 474, preferred: 'bottom' })
    expect(placement).toEqual({ side: 'bottom', maxHeight: 285 })
  })

  it('opens below at full height when the menu fits there', () => {
    const placement = choosePopoverPlacement({ ...trigger, viewTop: band.top, viewBottom: band.bottom, naturalHeight: 200, preferred: 'bottom' })
    expect(placement).toEqual({ side: 'bottom', maxHeight: 285 })
  })

  it('stays below with a usable minimum even when the space above is a little larger', () => {
    const low = { anchorTop: 300, anchorBottom: 336, sideOffset: 6 }
    const placement = choosePopoverPlacement({ ...low, viewTop: band.top, viewBottom: band.bottom, naturalHeight: 474, preferred: 'bottom' })
    expect(placement.side).toBe('bottom')
    expect(placement.maxHeight).toBe(165)
    expect(placement.maxHeight).toBeGreaterThanOrEqual(POPOVER_MIN_HEIGHT)
  })

  it('flips up only when the room below is short and above is clearly larger, never past the safe area', () => {
    const nearKeys = { anchorTop: 420, anchorBottom: 456, sideOffset: 6 }
    const placement = choosePopoverPlacement({ ...nearKeys, viewTop: band.top, viewBottom: band.bottom, naturalHeight: 474, preferred: 'bottom' })
    // 367px between the safe-area top (47) and the trigger, minus the offset.
    expect(placement).toEqual({ side: 'top', maxHeight: 367 })
  })

  it('does not flip when the other side is not clearly larger', () => {
    const middle = { anchorTop: 210, anchorBottom: 380, sideOffset: 6 }
    const placement = choosePopoverPlacement({ ...middle, viewTop: band.top, viewBottom: band.bottom, naturalHeight: 474, preferred: 'bottom' })
    // 121 below vs 157 above: short both ways, above is not 48px roomier.
    expect(placement).toEqual({ side: 'bottom', maxHeight: 121 })
  })

  it('flips to the other side when only it holds the whole menu (desktop, trigger near the bottom)', () => {
    const nearBottom = { anchorTop: 600, anchorBottom: 636, sideOffset: 4 }
    const placement = choosePopoverPlacement({ ...nearBottom, viewTop: 0, viewBottom: 880, naturalHeight: 400, preferred: 'bottom' })
    // 240px below would hold the usable minimum, but 596px above holds the whole menu.
    expect(placement).toEqual({ side: 'top', maxHeight: 596 })
  })

  it('never clamps to 0: with no room below and a sliver above it opens unclamped on the larger side', () => {
    // A 100px-tall visible band; the trigger fills its bottom 60px.
    const placement = choosePopoverPlacement({ anchorTop: 40, anchorBottom: 100, viewTop: 0, viewBottom: 100, sideOffset: 6, naturalHeight: 474, preferred: 'bottom' })
    expect(placement).toEqual({ side: 'top', maxHeight: null })
  })

  it('flips to a clearly larger side without clamping it below the floor', () => {
    const placement = choosePopoverPlacement({ anchorTop: 66, anchorBottom: 100, viewTop: 0, viewBottom: 100, sideOffset: 6, naturalHeight: 474, preferred: 'bottom' })
    expect(placement).toEqual({ side: 'top', maxHeight: null })
  })

  it('honors a preferred top side the same way', () => {
    const composer = { anchorTop: 440, anchorBottom: 480, sideOffset: 4 }
    const placement = choosePopoverPlacement({ ...composer, viewTop: band.top, viewBottom: band.bottom, naturalHeight: 300, preferred: 'top' })
    expect(placement).toEqual({ side: 'top', maxHeight: 389 })
  })
})

describe('visibleBand', () => {
  it('follows a visual viewport panned down by the keyboard', () => {
    expect(visibleBand({ innerHeight: 858, visualViewport: { height: 507, offsetTop: 120 } }, 47, { top: 8, bottom: 8 })).toEqual({
      top: 175,
      bottom: 619,
    })
  })

  it('falls back to the layout viewport without visualViewport', () => {
    expect(visibleBand({ innerHeight: 800, visualViewport: null }, 0, { top: 0, bottom: 0 })).toEqual({ top: 0, bottom: 800 })
  })
})

describe('naturalHeight', () => {
  /** A content element whose border-box height is 340px rendered, or `clamped` under an inline max-height. */
  function content(clamped: number) {
    const el = document.createElement('div')
    // A capped inner list (CommandList's own max-height) hides 600px it never shows.
    const list = document.createElement('div')
    list.style.overflowY = 'auto'
    vi.spyOn(list, 'scrollHeight', 'get').mockReturnValue(900)
    vi.spyOn(list, 'clientHeight', 'get').mockReturnValue(300)
    el.appendChild(list)
    vi.spyOn(el, 'offsetHeight', 'get').mockImplementation(() => (el.style.maxHeight ? clamped : 340))
    return el
  }

  it('is the rendered height, not counting what a self-capped inner list hides', () => {
    expect(naturalHeight(content(340))).toBe(340)
  })

  it('measures with the placement clamp lifted and puts the clamp back', () => {
    const el = content(250)
    el.style.maxHeight = '250px'
    el.style.overflowY = 'auto'
    expect(naturalHeight(el)).toBe(340)
    expect(el.style.maxHeight).toBe('250px')
    expect(el.style.overflowY).toBe('auto')
  })

  it('lets a 340px menu flip to the side that holds it even with a capped inner list', () => {
    const natural = naturalHeight(content(250))
    const placement = choosePopoverPlacement({ anchorTop: 520, anchorBottom: 556, viewTop: 0, viewBottom: 812, sideOffset: 4, naturalHeight: natural, preferred: 'bottom' })
    expect(placement).toEqual({ side: 'top', maxHeight: 516 })
  })
})
