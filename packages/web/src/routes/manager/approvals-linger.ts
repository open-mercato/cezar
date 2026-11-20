import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

import type { ManagerActionStatus } from '@open-mercato/cezar-api-client'

/** How long a card decided on the Approvals or Questions page stays after it finished. */
export const LINGER_MS = 30_000
/** The collapse at the end of the linger; reduced motion skips it. */
export const FADE_MS = 300
/** A card leaves only once the reader has been still this long: no scroll, no key. */
export const IDLE_MS = 3_000
/** How often a removal held back by the pointer or focus looks again. */
const BUSY_RETRY_MS = 500

export function isFinished(status: ManagerActionStatus): boolean {
  return status !== 'pending' && status !== 'running'
}

export interface LingerRow { key: string; finishedAt?: number }

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true

const lingerSelector = (key: string) => `[data-linger-key="${key.replace(/["\\]/g, '\\$&')}"]`

/** The element a list scrolls in: its nearest scrolling ancestor, else null for the page. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

type Hold = { element: HTMLElement; top: number; scroller: HTMLElement | null }

/** How a visible card leaves: fading in place (something the reader sees follows it) or collapsing. */
export type LeaveMode = 'fade' | 'collapse'

/**
 * What the reader is looking at below the leaving cards: the first element after the earliest of
 * them that is laid out and in view. A hidden element reports top 0 wherever it sits, so it never
 * counts (an approval card's hidden outcome made the correction 0, #2335 QA).
 */
function readingAnchor(root: HTMLElement, leaving: readonly HTMLElement[], viewTop: number): HTMLElement | undefined {
  const first = [...leaving].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0]
  if (!first) return undefined
  return [...root.querySelectorAll<HTMLElement>('[data-linger-key], section, [data-slot]')].find((element) =>
    (first.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    && !leaving.some((item) => item.contains(element) || element.contains(item))
    && element.getClientRects().length > 0
    && element.getBoundingClientRect().top >= viewTop)
}

/**
 * Finished rows linger 30 s, then leave at the next idle moment: not while the pointer is over
 * `list`, not while focus is inside it (unless on the leaving card), and not within IDLE_MS of the
 * last scroll or key. A card above the view leaves at once; a visible one fades or collapses for
 * FADE_MS first (reduced motion: leaves at once). What the reader sees after it holds still: the
 * scroll position takes up its height. Rows are found by `data-linger-key` (LingerCollapse);
 * returns the keys leaving now and how.
 */
export function useLinger(rows: readonly LingerRow[], remove: (keys: ReadonlySet<string>) => void, list: RefObject<HTMLElement | null>): ReadonlyMap<string, LeaveMode> {
  const [leaving, setLeaving] = useState<ReadonlyMap<string, LeaveMode>>(() => new Map())
  const latest = useRef({ rows, remove, leaving })
  latest.current = { rows, remove, leaving }
  const activity = useRef({ at: 0, hovering: false, ownScrollUntil: 0 })
  const anchor = useRef<Hold | null>(null)
  const collapses = useRef(new Set<ReturnType<typeof setTimeout>>())
  // Scroll by however far the held element moved, back to where the reader had it.
  const keep = (held: Hold) => {
    if (!held.element.isConnected) return
    const delta = held.element.getBoundingClientRect().top - held.top
    if (delta === 0) return
    activity.current.ownScrollUntil = Date.now() + 100
    if (held.scroller) held.scroller.scrollTop += delta
    else window.scrollBy(0, delta)
  }

  useEffect(() => {
    const root = list.current
    // Our own scroll correction is not the reader moving.
    const touch = () => { if (Date.now() > activity.current.ownScrollUntil) activity.current.at = Date.now() }
    const enter = () => { activity.current.hovering = true }
    const leave = () => { activity.current.hovering = false }
    window.addEventListener('scroll', touch, { capture: true, passive: true })
    document.addEventListener('keydown', touch, true)
    root?.addEventListener('pointerenter', enter)
    root?.addEventListener('pointerleave', leave)
    const timers = collapses.current
    return () => {
      window.removeEventListener('scroll', touch, { capture: true })
      document.removeEventListener('keydown', touch, true)
      root?.removeEventListener('pointerenter', enter)
      root?.removeEventListener('pointerleave', leave)
      timers.forEach(clearTimeout)
    }
  }, [list])

  // A card was just removed: put the text below it back where the reader had it.
  useLayoutEffect(() => {
    const held = anchor.current
    if (!held) return
    anchor.current = null
    keep(held)
  })

  const signature = `${rows.map((row) => `${row.key}:${row.finishedAt ?? ''}`).join('|')}#${[...leaving.keys()].join('|')}`
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const lead = () => (reducedMotion() ? 0 : FADE_MS)
    const waiting = () => latest.current.rows.filter((row) => row.finishedAt !== undefined && !latest.current.leaving.has(row.key))
    const itemOf = (key: string) => list.current?.querySelector<HTMLElement>(lingerSelector(key)) ?? null
    const busyFor = (due: readonly LingerRow[], at: number) => {
      if (activity.current.hovering) return BUSY_RETRY_MS
      const focused = document.activeElement
      const root = list.current
      if (root && focused && focused !== document.body && root.contains(focused) && !due.some((row) => itemOf(row.key)?.contains(focused))) return BUSY_RETRY_MS
      return Math.max(0, activity.current.at + IDLE_MS - at)
    }
    const tick = () => {
      const at = Date.now()
      const due = waiting().filter((row) => row.finishedAt! + LINGER_MS - lead() <= at)
      if (due.length === 0) return arm()
      const wait = busyFor(due, at)
      if (wait > 0) {
        timer = setTimeout(tick, wait)
        return
      }
      const root = list.current
      const scroller = root ? scrollerOf(root) : null
      const viewTop = scroller ? scroller.getBoundingClientRect().top : 0
      const gone = new Set<string>()
      const visible = new Set<string>()
      for (const row of due) {
        const element = itemOf(row.key)
        if (!element || element.getBoundingClientRect().top < viewTop || reducedMotion()) gone.add(row.key)
        else visible.add(row.key)
      }
      const holdFor = (keys: ReadonlySet<string>): Hold | null => {
        const below = root ? readingAnchor(root, [...keys].map(itemOf).filter((element) => element !== null), viewTop) : undefined
        return below ? { element: below, top: below.getBoundingClientRect().top, scroller } : null
      }
      if (gone.size > 0) {
        anchor.current = holdFor(gone)
        latest.current.remove(gone)
      }
      if (visible.size > 0) {
        // Something the reader sees follows it and the scroll can take up its height: fade in place,
        // then leave with the scroll correction, so that stays exactly still. Otherwise (nothing
        // visible after it, or too near the top to scroll back) collapse, so what follows slides.
        const hold = holdFor(visible)
        const firstTop = Math.min(...[...visible].map((key) => itemOf(key)?.getBoundingClientRect().top ?? Infinity))
        const room = scroller ? scroller.scrollTop : window.scrollY
        const mode: LeaveMode = hold && room >= hold.top - firstTop ? 'fade' : 'collapse'
        setLeaving((keys) => new Map([...keys, ...[...visible].map((key) => [key, mode] as const)]))
        const done = setTimeout(() => {
          collapses.current.delete(done)
          anchor.current = holdFor(visible)
          latest.current.remove(visible)
          setLeaving((keys) => new Map([...keys].filter(([key]) => !visible.has(key))))
        }, FADE_MS)
        collapses.current.add(done)
      }
    }
    const arm = () => {
      const next = Math.min(...waiting().map((row) => row.finishedAt! + LINGER_MS - lead()))
      if (Number.isFinite(next)) timer = setTimeout(tick, Math.max(0, next - Date.now()))
    }
    arm()
    return () => clearTimeout(timer)
  }, [signature, list])

  return leaving
}

/**
 * Keeps the order items first appeared in for this mount; new ones follow. A decision bumps its
 * manager's last activity, and re-sorting then moved the decided card out from under the reader.
 */
export function useStableOrder<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = useRef<readonly string[]>([])
  const rank = new Map(seen.current.map((id, index) => [id, index]))
  const known = items.filter((item) => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  const ordered = [...known, ...items.filter((item) => !rank.has(item.id))]
  // An id briefly missing from a list keeps its slot for when it comes back.
  seen.current = [...ordered.map((item) => item.id), ...seen.current.filter((id) => !items.some((item) => item.id === id))]
  return ordered
}
