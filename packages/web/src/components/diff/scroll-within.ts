/** The diff's scroller: the view's own column (`data-diff-scroller`, md and up), else `main`.
 *  Outside the lazy engine chunk so the fallback renderer shares it. */
export function diffScroller(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>('[data-diff-scroller], [data-slot="main"]')
}

/** Put `element`'s top `inset` px below `scroller`'s top, moving ONLY `scroller`: `scrollIntoView`
 *  hands any leftover distance to the shell's `overflow: hidden` ancestors and shoves the cockpit up. */
export function scrollWithin(scroller: HTMLElement, element: HTMLElement, inset: number): void {
  const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - inset
  scroller.scrollTop = Math.max(0, top)
}
