/**
 * Which side of its anchor a popover opens on, and how tall it may be there. Radix's own flip
 * compares the content's FULL natural height against each side and takes the least-bad one,
 * so a long list flips above the trigger as soon as the mobile keyboard shortens the space
 * below — under the status bar, cut off — while a perfectly usable band below stays empty.
 * Here the preferred side wins whenever it can hold the menu or a usable minimum (the list
 * then scrolls inside), and the other side only when it is clearly larger.
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
  minHeight?: number
}

export interface PopoverPlacement {
  side: PopoverSide
  /** The room on `side`: the content's max height there. */
  maxHeight: number
}

/** Below this the menu is not worth opening on the preferred side if the other one is roomier. */
export const POPOVER_MIN_HEIGHT = 160
/** How much larger the other side must be before the menu flips to it. */
export const POPOVER_FLIP_MARGIN = 48

export function choosePopoverPlacement(input: PopoverPlacementInput): PopoverPlacement {
  const below = Math.max(0, Math.floor(input.viewBottom - input.anchorBottom - input.sideOffset))
  const above = Math.max(0, Math.floor(input.anchorTop - input.viewTop - input.sideOffset))
  const preferredRoom = input.preferred === 'bottom' ? below : above
  const otherRoom = input.preferred === 'bottom' ? above : below
  const other: PopoverSide = input.preferred === 'bottom' ? 'top' : 'bottom'
  const usable = Math.min(input.naturalHeight, input.minHeight ?? POPOVER_MIN_HEIGHT)
  if (preferredRoom >= usable) return { side: input.preferred, maxHeight: preferredRoom }
  if (otherRoom >= preferredRoom + POPOVER_FLIP_MARGIN) return { side: other, maxHeight: otherRoom }
  return { side: input.preferred, maxHeight: preferredRoom }
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
 * The content's unclamped height: its own scroll height plus whatever its inner scrollers
 * hide, so a list that already shrank to fit still reports the height it wants.
 */
export function naturalHeight(el: HTMLElement): number {
  let hidden = 0
  for (const child of el.querySelectorAll<HTMLElement>('*')) {
    const extra = child.scrollHeight - child.clientHeight
    if (extra <= 1) continue
    const overflow = getComputedStyle(child).overflowY
    if (overflow === 'auto' || overflow === 'scroll') hidden += extra
  }
  return el.scrollHeight + hidden
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
