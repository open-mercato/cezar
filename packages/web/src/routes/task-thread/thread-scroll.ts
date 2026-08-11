import type { CacheSnapshot } from 'virtua'

/**
 * The thread's scroll rules and per-run session caches — all pure data, no DOM (the DOM
 * wiring lives in thread-scroller.tsx so these rules stay table-testable).
 *
 * THE PERFORMANCE RULE (spec §"Task thread"; tech research §5 "don't virtualize prematurely"):
 * up to {@link VIRTUALIZE_THRESHOLD} top-level rows the thread renders flat with
 * `content-visibility: auto` on each row — the browser skips off-screen rendering work with
 * zero behavior risk (native scrolling, find-in-page, no iOS restoration edge cases). Beyond
 * the threshold the same rows go through virtua's `<Virtualizer>`, which bounds the DOM
 * itself. Measured on the synthetic 2,506-event / 1,003-row transcript
 * (thread-scroll.e2e.ts, real Chrome, both modes over the same file): flat keeps all 1,003
 * rows in the DOM (5,469 elements); virtualized holds a viewport window of ~16 rows
 * (~309 elements) — 17× fewer live elements, which is what keeps per-frame style/layout
 * costs flat as transcripts grow.
 */
export const VIRTUALIZE_THRESHOLD = 300

/** ~80px per the research: pin-to-bottom while streaming only when the reader is this close. */
export const NEAR_BOTTOM_SLACK_PX = 80
export const HISTORY_BOUNDARY_SLACK_PX = 600

/** Intent handlers only consume an older-page arm while the reader is near the retained start. */
export function isNearHistoryStart(box: { scrollTop: number; clientHeight: number }): boolean {
  return box.scrollTop < Math.max(HISTORY_BOUNDARY_SLACK_PX, box.clientHeight)
}

export interface ThreadRowPosition {
  key: string
  top: number
  bottom: number
}

export interface ThreadRowAnchor {
  key: string
  offset: number
}

/** Capture the first stable row intersecting the viewport, including a partially visible row. */
export function firstVisibleThreadAnchor(
  viewportTop: number,
  rows: readonly ThreadRowPosition[],
): ThreadRowAnchor | undefined {
  const row = rows.find(({ bottom }) => bottom > viewportTop)
  return row === undefined ? undefined : { key: row.key, offset: row.top - viewportTop }
}

/** Restore a captured row identity even when page eviction changed the total scroll height. */
export function threadAnchorScrollTop(
  currentScrollTop: number,
  viewportTop: number,
  anchor: ThreadRowAnchor | undefined,
  rows: readonly ThreadRowPosition[],
  fallbackTop: number,
): number {
  if (anchor === undefined) return fallbackTop
  const row = rows.find(({ key }) => key === anchor.key)
  return row === undefined
    ? fallbackTop
    : currentScrollTop + (row.top - viewportTop - anchor.offset)
}

/**
 * The stick rule shared by the thread scroller and the tool-output live tail: the viewport
 * counts as "at the bottom" while within `slack` px of it. Pure so both thresholds are
 * table-testable against the same math.
 */
export function isNearBottom(
  box: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slack = 24,
): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight < slack
}

/**
 * Which renderer the thread uses. `search` is the location's query string: `?thread=flat` and
 * `?thread=virtual` force a mode — the honest measurement seam (the e2e perf comparison loads
 * the same transcript both ways) and a debugging escape hatch; anything else is `auto`, the
 * threshold rule above.
 */
export function threadRenderMode(search: string, rowCount: number): 'flat' | 'virtual' {
  const forced = new URLSearchParams(search).get('thread')
  if (forced === 'flat' || forced === 'virtual') return forced
  return rowCount > VIRTUALIZE_THRESHOLD ? 'virtual' : 'flat'
}

/** Where a reader left a thread. `atBottom` wins over `top`: a thread left at its live tail
 *  re-opens at the (possibly grown) tail, not at a stale pixel offset. */
export interface ScrollMemory {
  top: number
  atBottom: boolean
}

/** Scroll positions per run/view key — module-level on purpose (the PlanDock collapse-memory
 *  pattern): survives route changes for the browser session, gone on reload, no server state. */
const scrollByRun = new Map<string, ScrollMemory>()

export function saveThreadScroll(runId: string, memory: ScrollMemory): void {
  scrollByRun.set(runId, memory)
}

export function readThreadScroll(runId: string): ScrollMemory | undefined {
  return scrollByRun.get(runId)
}

/** virtua's per-session measurement cache (research §5: "per-session measurement cache"),
 *  keyed by run/view: revisiting a virtualized thread restores measured row heights instead of
 *  re-estimating, so the restored scroll offset lands on the same content. The snapshot is
 *  opaque, so the row count it was taken at rides along — virtua's documented caveat is that
 *  a snapshot only fits the same item count, and a mid-replay remount must degrade to
 *  estimates, never mis-apply. */
export interface ThreadMeasurements {
  rows: number
  cache: CacheSnapshot
}

const measurementsByRun = new Map<string, ThreadMeasurements>()

export function saveThreadMeasurements(runId: string, measurements: ThreadMeasurements): void {
  measurementsByRun.set(runId, measurements)
}

export function readThreadMeasurements(runId: string, rows: number): CacheSnapshot | undefined {
  const found = measurementsByRun.get(runId)
  return found !== undefined && found.rows === rows ? found.cache : undefined
}

/** Test seam: caches are module state, and tests must not leak runs into each other. */
export function clearThreadScrollCaches(): void {
  scrollByRun.clear()
  measurementsByRun.clear()
}
