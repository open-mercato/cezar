/**
 * Which side of its anchor a popover opens on, and how tall it may be there. Radix's own flip
 * compares the content's FULL natural height against each side and takes the least-bad one,
 * so a long list flips above the trigger as soon as the mobile keyboard shortens the space
 * below — under the status bar, cut off — while a perfectly usable band below stays empty.
 * Here a side that holds the whole menu wins (preferred first). When neither does, the menu
 * shrinks to its side's room and scrolls inside: on the preferred side, unless the other is
 * clearly roomier (48px more and 1.5× the room). It is never clamped below 80px; with less
 * than that either way it opens unclamped on the larger side, overflowing as Radix would.
 *
 * Every coordinate is in the layout viewport (what `getBoundingClientRect` and Radix's fixed
 * strategy use); the visible band comes from `visualViewport`, so the keyboard area and a
 * panned-away top never count as room.
 */

export type PopoverSide = 'top' | 'bottom'

export interface PopoverPlacementInput {
  /** The anchor's top and bottom edges. */
  anchorTop: number
  anchorBottom: number
  /** The visible band: visual viewport minus safe area and collision padding. */
  viewTop: number
  viewBottom: number
  /** The content's height with nothing clamped. */
  naturalHeight: number
  sideOffset: number
  preferred: PopoverSide
}

export interface PopoverPlacement {
  side: PopoverSide
  /** The room on `side`: the content's max height there, or null to leave it unclamped. */
  maxHeight: number | null
}

/** The other side is "clearly roomier" when it has this many px more… */
export const POPOVER_FLIP_MARGIN = 48
/** …and at least this many times the preferred side's room. */
export const POPOVER_FLIP_RATIO = 1.5
/** Never clamp below this: a sliver of a menu is worse than one that overflows. */
export const POPOVER_CLAMP_FLOOR = 80

export function choosePopoverPlacement(input: PopoverPlacementInput): PopoverPlacement {
  const below = Math.max(0, Math.floor(input.viewBottom - input.anchorBottom - input.sideOffset))
  const above = Math.max(0, Math.floor(input.anchorTop - input.viewTop - input.sideOffset))
  const preferredRoom = input.preferred === 'bottom' ? below : above
  const otherRoom = input.preferred === 'bottom' ? above : below
  const other: PopoverSide = input.preferred === 'bottom' ? 'top' : 'bottom'
  // A side that holds the whole menu wins first, as Radix's own flip does on desktop.
  if (preferredRoom >= input.naturalHeight) return { side: input.preferred, maxHeight: preferredRoom }
  if (otherRoom >= input.naturalHeight) return { side: other, maxHeight: otherRoom }
  // Neither holds it: the menu shrinks and scrolls, on the other side only if that is clearly roomier.
  const clamp = (room: number) => (room >= POPOVER_CLAMP_FLOOR ? room : null)
  const clearlyRoomier =
    otherRoom >= preferredRoom + POPOVER_FLIP_MARGIN && otherRoom >= preferredRoom * POPOVER_FLIP_RATIO
  if (clearlyRoomier) return { side: other, maxHeight: clamp(otherRoom) }
  if (preferredRoom >= POPOVER_CLAMP_FLOOR) return { side: input.preferred, maxHeight: preferredRoom }
  // Too little room either way: the larger side, unclamped (Radix's overflowing behavior).
  return { side: otherRoom > preferredRoom ? other : input.preferred, maxHeight: null }
}

/** The subset of `window` the band reads — stubbable. */
export interface PlacementWindow {
  innerHeight: number
  visualViewport: { height: number; offsetTop: number } | null
}

/** The visible vertical band in layout coordinates, minus the safe-area top and padding. */
export function visibleBand(
  win: PlacementWindow,
  safeTop: number,
  padding: { top: number; bottom: number },
): { top: number; bottom: number } {
  const viewport = win.visualViewport
  const top = viewport ? viewport.offsetTop : 0
  const bottom = viewport ? viewport.offsetTop + viewport.height : win.innerHeight
  return { top: top + safeTop + padding.top, bottom: bottom - padding.bottom }
}

/**
 * The content's height without the placement clamp: measured with the inline max-height lifted
 * (restored before anything paints), so a list shrunk by the clamp reports its real height while
 * one capped by its own max-height (CommandList) is not counted past that cap. `offsetHeight`
 * includes the border, which Radix's own overflow check counts too.
 */
export function naturalHeight(el: HTMLElement): number {
  const { maxHeight, overflowY } = el.style
  if (!maxHeight) return el.offsetHeight
  el.style.maxHeight = ''
  el.style.overflowY = ''
  const height = el.offsetHeight
  el.style.maxHeight = maxHeight
  el.style.overflowY = overflowY
  return height
}

/** `env(safe-area-inset-top)` in px — 0 where the engine has none (desktop, jsdom). */
export function safeAreaTop(doc: Document = document): number {
  const probe = doc.createElement('div')
  probe.style.cssText = 'position:fixed;top:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top)'
  doc.body.appendChild(probe)
  const px = Number.parseFloat(getComputedStyle(probe).paddingTop)
  probe.remove()
  return Number.isFinite(px) ? px : 0
}
