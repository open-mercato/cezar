import * as React from 'react'

/** Rows past which a task table mounts only the rows near the viewport. */
export const WINDOWED_ROWS_THRESHOLD = 100

/** Both task tables' row: a cell's `h-11` plus the row's bottom border. */
export const TABLE_ROW_HEIGHT_PX = 45

const OVERSCAN_ROWS = 12
const INITIAL_ROWS = 40

export interface RowWindow<T extends HTMLElement> {
  /** Attach to the element that holds the rows (the `<tbody>`). */
  anchorRef: React.RefObject<T | null>
  windowed: boolean
  start: number
  end: number
  /** Height of the spacer standing in for the rows before `start` / after `end`. */
  padTop: number
  padBottom: number
  /** The table's `aria-rowcount` (body rows plus the one header row) while windowed: the spacers
   *  are `aria-hidden`, so without it assistive tech counts only the mounted rows. */
  ariaRowCount: number | undefined
  /** A body row's `aria-rowindex` from its position in the full list, while windowed. */
  ariaRowIndex: (position: number) => number | undefined
}

/** The stand-in for the rows a window leaves unmounted; `data-row-spacer` keeps it out of the
 *  row-height sample. */
export function RowSpacer({ height, colSpan }: { height: number; colSpan: number }) {
  if (height <= 0) return null
  return (
    <tr data-row-spacer="" aria-hidden="true">
      <td colSpan={colSpan} style={{ height, padding: 0, border: 0 }} />
    </tr>
  )
}

/**
 * Viewport windowing for a `<table>` body whose rows have one fixed height.
 *
 * Not virtua: virtua positions each item absolutely, which takes a `<tr>` out of the table's
 * column layout, so cells would stop lining up under their headers. Rows here are a fixed
 * single line, so two spacer rows with exact heights keep the table in normal flow instead.
 * The scroller is the app shell's `[data-slot="main"]`, falling back to the window.
 */
export function useWindowedRows<T extends HTMLElement>(count: number, rowHeight = TABLE_ROW_HEIGHT_PX): RowWindow<T> {
  const windowed = count > WINDOWED_ROWS_THRESHOLD
  const anchorRef = React.useRef<T | null>(null)
  const [range, setRange] = React.useState({ start: 0, end: INITIAL_ROWS, height: rowHeight })

  React.useLayoutEffect(() => {
    if (!windowed) return
    const anchor = anchorRef.current
    if (!anchor) return
    const scroller = anchor.closest<HTMLElement>('[data-slot="main"]')
    const measure = () => {
      const viewTop = scroller ? scroller.getBoundingClientRect().top : 0
      const viewHeight = scroller ? scroller.clientHeight : window.innerHeight
      const offset = anchor.getBoundingClientRect().top - viewTop
      const sample = anchor.querySelector(':scope > tr:not([data-row-spacer])')?.getBoundingClientRect().height
      const height = sample !== undefined && sample > 0 ? sample : rowHeight
      const first = Math.floor(Math.max(0, -offset) / height)
      const last = Math.ceil(Math.max(0, viewHeight - offset) / height)
      const start = Math.max(0, first - OVERSCAN_ROWS)
      const end = Math.max(start, last + OVERSCAN_ROWS)
      setRange((current) =>
        current.start === start && current.end === end && current.height === height ? current : { start, end, height },
      )
    }
    measure()
    // Scroll fires far faster than a repaint on some engines; one window update per frame is all
    // the window can use, so coalesce.
    let frame = 0
    const onScroll = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    const target: HTMLElement | Window = scroller ?? window
    target.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', measure)
    // Content above this table (another group on /tasks) can grow without a scroll event and
    // shift the table under a stale window.
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined
    for (const content of scroller ? Array.from(scroller.children) : [document.body]) resize?.observe(content)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      target.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', measure)
      resize?.disconnect()
    }
  }, [windowed, count, rowHeight])

  if (!windowed) {
    return { anchorRef, windowed, start: 0, end: count, padTop: 0, padBottom: 0, ariaRowCount: undefined, ariaRowIndex: noRowIndex }
  }
  // Keep a full window's worth of rows after the count shrinks: clamping `start` straight to the
  // new count would leave an empty slice (spacers only) until the next scroll or observer tick.
  const windowSize = Math.max(1, range.end - range.start)
  const start = Math.max(0, Math.min(range.start, count - windowSize))
  const end = Math.min(Math.max(range.end, start + windowSize), count)
  return {
    anchorRef,
    windowed,
    start,
    end,
    padTop: start * range.height,
    padBottom: (count - end) * range.height,
    ariaRowCount: count + 1,
    ariaRowIndex: headedRowIndex,
  }
}

const noRowIndex = (): undefined => undefined
const headedRowIndex = (position: number): number => position + 2
