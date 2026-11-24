import { describe, expect, it, vi } from 'vitest'

import { choosePopoverPlacement, naturalHeight, visibleBand } from './popover-placement'

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

  it('stays below when the space above is larger but not 1.5x larger', () => {
    const low = { anchorTop: 300, anchorBottom: 336, sideOffset: 6 }
    const placement = choosePopoverPlacement({ ...low, viewTop: band.top, viewBottom: band.bottom, naturalHeight: 474, preferred: 'bottom' })
    // 165px below vs 247px above: 82px more, but only 1.497x.
    expect(placement).toEqual({ side: 'bottom', maxHeight: 165 })
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
    // 121 below vs 157 above: short both ways, above is neither 48px nor 1.5x roomier.
    expect(placement).toEqual({ side: 'bottom', maxHeight: 121 })
  })

  describe('when neither side holds the menu, flips only to a clearly roomier side', () => {
    // A 700px band, no offset: below = 700 - anchorBottom, above = anchorTop.
    const place = (above: number, below: number) =>
      choosePopoverPlacement({ anchorTop: above, anchorBottom: 700 - below, viewTop: 0, viewBottom: 700, sideOffset: 0, naturalHeight: 1000, preferred: 'bottom' })

    it('flips: 450px above vs 170px below (280px more, 2.6x)', () => {
      expect(place(450, 170)).toEqual({ side: 'top', maxHeight: 450 })
    })

    it('stays: 290px above vs 200px below (90px more, but 1.45x)', () => {
      expect(place(290, 200)).toEqual({ side: 'bottom', maxHeight: 200 })
    })

    it('stays: 135px above vs 90px below (1.5x, but only 45px more)', () => {
      expect(place(135, 90)).toEqual({ side: 'bottom', maxHeight: 90 })
    })
  })

  it('flips to the other side when only it holds the whole menu (desktop, trigger near the bottom)', () => {
    const nearBottom = { anchorTop: 600, anchorBottom: 636, sideOffset: 4 }
    const placement = choosePopoverPlacement({ ...nearBottom, viewTop: 0, viewBottom: 880, naturalHeight: 400, preferred: 'bottom' })
    // 240px below is roomy, but only the 596px above holds the whole menu.
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
    vi.spyOn(el, 'offsetHeight', 'get').mockImplementation(() => (el.style.maxHeight ? clamped : 340))
    return el
  }

  it('is the border-box height of the content', () => {
    expect(naturalHeight(content(340))).toBe(340)
  })

  it("never adds an inner list's hidden overflow (a list capped by its own max-height)", () => {
    const el = content(340)
    const list = document.createElement('div')
    list.style.overflowY = 'auto'
    // CommandList capped at 300px over 900px of rows: summing its overflow would read 940.
    vi.spyOn(list, 'scrollHeight', 'get').mockReturnValue(900)
    vi.spyOn(list, 'clientHeight', 'get').mockReturnValue(300)
    el.appendChild(list)
    expect(naturalHeight(el)).toBe(340)
  })

  it('measures with the placement clamp lifted and puts the clamp back', () => {
    const el = content(250)
    el.style.maxHeight = '250px'
    el.style.overflowY = 'auto'
    expect(naturalHeight(el)).toBe(340)
    expect(el.style.maxHeight).toBe('250px')
    expect(el.style.overflowY).toBe('auto')
  })

  it('lets a clamped 340px menu flip to the side that holds it whole', () => {
    const el = content(250)
    el.style.maxHeight = '250px'
    const placement = choosePopoverPlacement({ anchorTop: 520, anchorBottom: 556, viewTop: 0, viewBottom: 812, sideOffset: 4, naturalHeight: naturalHeight(el), preferred: 'bottom' })
    expect(placement).toEqual({ side: 'top', maxHeight: 516 })
  })
})
