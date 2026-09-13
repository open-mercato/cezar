import { ArrowDownIcon } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { Virtualizer, type VirtualizerHandle } from 'virtua'

import {
  NEAR_BOTTOM_SLACK_PX,
  isNearHistoryStart,
  isNearBottom,
  firstVisibleThreadAnchor,
  readThreadMeasurements,
  readThreadScroll,
  saveThreadMeasurements,
  saveThreadScroll,
  threadAnchorScrollTop,
  type ThreadRowPosition,
} from './thread-scroll'

/**
 * The thread's scroll machinery: one hook that owns the shell scroller's behavior for the
 * route's lifetime, plus the threshold-switched rows renderer (flat + `content-visibility`
 * vs virtua — the rule and its measurements live in thread-scroll.ts) and the jump pill.
 *
 * ONE SCROLL OWNER (research §6 gotcha): the app shell's `[data-slot="main"]` region is the
 * only scroller — flat rows scroll it natively, virtua receives it via `scrollRef`, and this
 * hook is the only code steering it. Nothing here owns a nested scroll container.
 */

/** One renderable thread row — a user bubble, a grouped block, whatever the view flattened. */
export interface ThreadRow {
  key: string
  node: ReactNode
}

export interface ThreadScrollControls {
  /** Callback ref for the rows container; finds the shell scroller from it. */
  attachContent: (el: HTMLElement | null) => void
  /** The shell scroller, for virtua's `scrollRef`. Filled by `attachContent`. */
  scrollElRef: RefObject<HTMLElement | null>
  /** virtua's imperative handle while the thread is virtualized (VirtualRows fills it) —
   *  programmatic scrolls must go through it, or they race virtua's own offset writes. */
  virtualizerRef: RefObject<VirtualizerHandle | null>
  /** True while the reader is away from the live tail — the pill's visibility. */
  pillVisible: boolean
  /** The pill's action: smooth-scroll to the tail and stick again. */
  jumpToLatest: () => void
  /** Load one older page while preserving the current pixel anchor. */
  loadOlder: () => void
  /** Re-pin if stuck — the keyboard-settled hook (content height didn't change, but the
   *  visual viewport did, so the RO won't fire). */
  restickIfStuck: () => void
}

/**
 * Stick-to-bottom, the jump pill, and the per-view scroll cache (spec §"Task thread").
 *
 *  - While content grows, stay pinned to the bottom ONLY while the reader is within
 *    {@link NEAR_BOTTOM_SLACK_PX} of it; the moment they scroll up, growth stops moving them
 *    and the pill appears.
 *  - First visit lands at the tail (chat convention); a revisit restores the cached position —
 *    including through the SSE replay, which re-grows the content after mount: the desired
 *    offset is re-applied on every growth until it is reachable or the user scrolls.
 */
export function useThreadScroll(
  viewKey: string,
  options: {
    surface?: 'document' | 'panel'
    onLoadOlder?: () => Promise<void>
    onJumpToLatest?: () => Promise<void>
    rowKeys?: readonly string[]
  } = {},
): ThreadScrollControls {
  const { surface = 'document', onLoadOlder, onJumpToLatest, rowKeys = [] } = options
  const scrollElRef = useRef<HTMLElement | null>(null)
  // State, not a ref: crossing the virtualization threshold mid-replay REPLACES the rows
  // container, and the observers below must re-subscribe to the new element.
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null)
  const [pillVisible, setPillVisible] = useState(false)

  const stuckRef = useRef(true)
  /** A cached offset not yet reachable (content still replaying). Cleared by user intent. */
  const pendingRestoreRef = useRef<number | null>(null)
  /** Arrival (cache restore / land at tail) happens once per view, not once per container. */
  const arrivedForRef = useRef<string | null>(null)
  /** virtua's handle while virtualized (VirtualRows fills it), null in flat mode. */
  const virtualizerRef = useRef<VirtualizerHandle | null>(null)

  // EVERY programmatic scroll goes through virtua's handle when virtualized. A raw
  // `scrollTop` write races virtua's own jump compensation (it also writes scrollTop, from
  // its internally tracked offset) — observed on the 1,000-row fixture as restores landing
  // at the bottom. `handle.scrollTo` updates that internal offset first, so the two agree.
  const setOffset = useCallback((top: number) => {
    const scroller = scrollElRef.current
    if (!scroller) return
    const handle = virtualizerRef.current
    if (handle) handle.scrollTo(top)
    else scroller.scrollTop = top
  }, [])

  const toBottom = useCallback(() => {
    const scroller = scrollElRef.current
    if (scroller) setOffset(scroller.scrollHeight - scroller.clientHeight)
  }, [setOffset])

  const applyArrival = useCallback(() => {
    const scroller = scrollElRef.current
    if (!scroller) return
    if (arrivedForRef.current !== viewKey) {
      arrivedForRef.current = viewKey
      const memory = readThreadScroll(viewKey)
      if (memory && !memory.atBottom) {
        stuckRef.current = false
        pendingRestoreRef.current = memory.top
      } else {
        stuckRef.current = true
        pendingRestoreRef.current = null
      }
    }
    if (pendingRestoreRef.current !== null) setOffset(pendingRestoreRef.current)
    else if (stuckRef.current) toBottom()
  }, [viewKey, setOffset, toBottom])

  // The callback ref runs in the destination commit itself. Applying arrival here closes the
  // gap between the route render and the follow-up state update that installs subscriptions;
  // the layout effect below re-applies once virtua's handle/content state are fully attached.
  const attachContent = useCallback((el: HTMLElement | null) => {
    setContentEl(el)
    if (el) {
      scrollElRef.current = el.closest<HTMLElement>(
        surface === 'panel' ? '[data-slot="transcript-viewport"]' : '[data-slot="main"]',
      )
      applyArrival()
    }
  }, [surface, applyArrival])

  const restickIfStuck = useCallback(() => {
    if (stuckRef.current) toBottom()
  }, [toBottom])

  const loadingOlderRef = useRef(false)
  const wheelGestureActiveRef = useRef(false)
  const wheelGestureTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const touchHistoryConsumedRef = useRef(false)
  const pointerHistoryConsumedRef = useRef(false)
  const rowKeysRef = useRef(rowKeys)
  rowKeysRef.current = rowKeys

  const measuredRows = useCallback((scroller: HTMLElement): ThreadRowPosition[] =>
    [...scroller.querySelectorAll<HTMLElement>('[data-slot="thread-row"][data-row-key]')].map((row) => {
      const rect = row.getBoundingClientRect()
      return { key: row.dataset.rowKey!, top: rect.top, bottom: rect.bottom }
    }), [])

  const loadOlder = useCallback(() => {
    const scroller = scrollElRef.current
    if (!scroller || !onLoadOlder || loadingOlderRef.current) return
    loadingOlderRef.current = true
    const beforeHeight = scroller.scrollHeight
    const beforeTop = scroller.scrollTop
    const beforeViewportTop = scroller.getBoundingClientRect().top
    const anchor = firstVisibleThreadAnchor(beforeViewportTop, measuredRows(scroller))
    void onLoadOlder().finally(() => {
      requestAnimationFrame(() => {
        const current = scrollElRef.current
        if (current) {
          const fallbackTop = beforeTop + Math.max(0, current.scrollHeight - beforeHeight)
          const viewportTop = current.getBoundingClientRect().top
          const anchorIndex = anchor === undefined ? -1 : rowKeysRef.current.indexOf(anchor.key)
          const handle = virtualizerRef.current
          if (handle && anchorIndex >= 0) {
            handle.scrollToIndex(anchorIndex, { align: 'start', offset: -anchor!.offset })
          } else {
            setOffset(threadAnchorScrollTop(
              current.scrollTop,
              viewportTop,
              anchor,
              measuredRows(current),
              fallbackTop,
            ))
          }
        }
        loadingOlderRef.current = false
      })
    })
  }, [measuredRows, onLoadOlder, setOffset])

  useEffect(() => () => clearTimeout(wheelGestureTimerRef.current), [])

  const jumpToLatest = useCallback(() => {
    const scroller = scrollElRef.current
    if (!scroller) return
    pendingRestoreRef.current = null
    stuckRef.current = true
    void (onJumpToLatest?.() ?? Promise.resolve()).finally(() => {
      requestAnimationFrame(() => {
        const current = scrollElRef.current
        current?.scrollTo({ top: current.scrollHeight - current.clientHeight, behavior: 'smooth' })
      })
    })
  }, [onJumpToLatest])

  // Arrival is the route-owned pre-paint write. AppShell deliberately does not reset task
  // routes, so a destination thread never exposes an intermediate top-of-transcript frame.
  // Keep this separate from the long-lived event/observer effect below: route arrival has a
  // stricter timing contract, while subscriptions only need to exist after paint.
  useLayoutEffect(() => {
    const scroller = scrollElRef.current
    const content = contentEl
    if (!scroller || !content) return
    applyArrival()
  }, [contentEl, applyArrival])

  useEffect(() => {
    const scroller = scrollElRef.current
    const content = contentEl
    if (!scroller || !content) return

    // PINNING FOLLOWS INTENT, NOT POSITION. During replay/streaming the scroller's position
    // moves without the user's hand: this hook pins it, virtua re-measures rows and writes
    // its own offset corrections, and the browser's native scroll anchoring nudges scrollTop
    // when content above the viewport resizes. Position-derived rules mis-read all of that
    // (observed on the 1,000-row fixture: restores landing at the tail, unpins at random):
    //  - UNPIN on an explicit gesture away from the tail: wheel up, an upward touch drag, an
    //    up nav key, or grabbing the scrollbar away from the tail (pointerdown).
    //  - RE-PIN when the scroller is near the tail AND the reader recently gestured toward
    //    it (wheel down, downward drag, down nav key) — or via the pill. Without the intent
    //    window, virtua's at-rest sub-pixel corrections near the tail would re-pin a reader
    //    who just wheeled up. A slow scrollbar drag to the tail (>2s) misses the window,
    //    accepted — wheel and touch cover real readers.
    const RESTICK_INTENT_MS = 2000
    let downIntentAt = 0
    let lastTouchY: number | null = null
    let pointerScrolling = false
    let previousScrollTop = scroller.scrollTop
    const unstick = () => {
      pendingRestoreRef.current = null
      stuckRef.current = false
      downIntentAt = 0 // the LATEST intent wins — an up gesture voids a recent down one
    }
    const markDown = () => {
      downIntentAt = Date.now()
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        unstick()
        const freshGesture = !wheelGestureActiveRef.current
        wheelGestureActiveRef.current = true
        clearTimeout(wheelGestureTimerRef.current)
        wheelGestureTimerRef.current = setTimeout(() => {
          wheelGestureActiveRef.current = false
        }, 180)
        if (freshGesture && isNearHistoryStart(scroller)) loadOlder()
      }
      else markDown()
    }
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
        unstick()
        if (!event.repeat && isNearHistoryStart(scroller)) loadOlder()
      }
      else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) markDown()
    }
    const onPointerDown = () => {
      pointerScrolling = true
      pointerHistoryConsumedRef.current = false
      previousScrollTop = scroller.scrollTop
      if (!isNearBottom(scroller, NEAR_BOTTOM_SLACK_PX)) {
        unstick()
        markDown() // a scrollbar grab can go either way — let a drag to the tail re-pin
      }
    }
    const onPointerUp = () => {
      pointerScrolling = false
    }
    const onTouchStart = (event: TouchEvent) => {
      touchHistoryConsumedRef.current = false
      lastTouchY = event.touches[0]?.clientY ?? null
    }
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY
      if (y === undefined) return
      // Finger moving down pans the content up (away from the tail), and vice versa.
      if (lastTouchY !== null && y > lastTouchY + 1) {
        unstick()
        if (!touchHistoryConsumedRef.current && isNearHistoryStart(scroller)) {
          touchHistoryConsumedRef.current = true
          loadOlder()
        }
      }
      else if (lastTouchY !== null && y < lastTouchY - 1) markDown()
      lastTouchY = y
    }
    const onScroll = () => {
      if (
        pointerScrolling &&
        !pointerHistoryConsumedRef.current &&
        scroller.scrollTop < previousScrollTop &&
        isNearHistoryStart(scroller)
      ) {
        pointerHistoryConsumedRef.current = true
        loadOlder()
      }
      previousScrollTop = scroller.scrollTop
      const near = isNearBottom(scroller, NEAR_BOTTOM_SLACK_PX)
      // No re-pinning while a restore is in flight: the clamped position rides the (still
      // growing) bottom on its way to the cached offset, and near-bottom moments there are
      // the replay's, not the reader's.
      if (near && pendingRestoreRef.current === null) {
        if (stuckRef.current || Date.now() - downIntentAt < RESTICK_INTENT_MS) stuckRef.current = true
      }
      setPillVisible(!near)
      // …and no overwriting the memory being restored, either — leaving again mid-restore
      // must find the parked position, not a replay artifact.
      if (pendingRestoreRef.current === null) {
        saveThreadScroll(viewKey, { top: scroller.scrollTop, atBottom: near })
      }
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: true })
    scroller.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })
    scroller.addEventListener('keydown', onKey)

    // Content growth (streamed items, replay, virtua's total-size updates) re-applies the
    // stick or the pending restore. jsdom has no ResizeObserver; the hook degrades to
    // arrival-only behavior there, which is exactly what component tests exercise.
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        const pending = pendingRestoreRef.current
        if (pending !== null) {
          const maxTop = scroller.scrollHeight - scroller.clientHeight
          setOffset(Math.min(pending, maxTop))
          if (maxTop >= pending) pendingRestoreRef.current = null // reached — restore done
        } else if (stuckRef.current) {
          toBottom()
        }
      })
      observer.observe(content)
    }

    return () => {
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      scroller.removeEventListener('keydown', onKey)
      observer?.disconnect()
    }
  }, [viewKey, contentEl, loadOlder, setOffset, toBottom])

  return { attachContent, scrollElRef, virtualizerRef, pillVisible, jumpToLatest, loadOlder, restickIfStuck }
}

/**
 * The flattened rows, rendered by the mode thread-scroll.ts picked. Both modes produce the
 * same `[data-slot="thread-row"]` wrappers (each a flex column, so bubbles keep `self-end`);
 * the spacing that used to be the column's `gap` is each row's bottom padding, so the two
 * modes measure identically.
 */
export function ThreadRows({
  runId,
  rows,
  mode,
  controls,
}: {
  runId: string
  rows: ThreadRow[]
  mode: 'flat' | 'virtual'
  controls: ThreadScrollControls
}) {
  if (mode === 'virtual') return <VirtualRows runId={runId} rows={rows} controls={controls} />
  return (
    <div ref={controls.attachContent} data-slot="thread-rows" data-virtualized="false">
      {rows.map((row) => (
        // content-visibility skips render work for off-screen rows; the intrinsic-size hint
        // keeps the scrollbar stable before a skipped row is first measured.
        <div
          key={row.key}
          data-slot="thread-row"
          data-row-key={row.key}
          className="flex w-full flex-col pb-2.5 [contain-intrinsic-block-size:auto_3rem] [content-visibility:auto]"
        >
          {row.node}
        </div>
      ))}
    </div>
  )
}

function VirtualRows({
  runId,
  rows,
  controls,
}: {
  runId: string
  rows: ThreadRow[]
  controls: ThreadScrollControls
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // The per-run measurement cache: read once per mount (only honored at the row count the
  // snapshot was taken at — virtua's caveat), written back with the final count on detach.
  const [measurements] = useState(() => readThreadMeasurements(runId, rows.length))
  const rowCountRef = useRef(rows.length)
  rowCountRef.current = rows.length
  const lastHandleRef = useRef<VirtualizerHandle | null>(null)
  const attachHandle = useCallback(
    (handle: VirtualizerHandle | null) => {
      controls.virtualizerRef.current = handle
      if (handle) {
        lastHandleRef.current = handle
      } else if (lastHandleRef.current) {
        // Detach = unmount: snapshot in the ref callback, where the handle is still known
        // (effect cleanup order vs ref detach is not a contract worth leaning on).
        saveThreadMeasurements(runId, { rows: rowCountRef.current, cache: lastHandleRef.current.cache })
        lastHandleRef.current = null
      }
    },
    [runId, controls.virtualizerRef],
  )

  // virtua needs the distance between the scroller's content start and the virtualizer (the
  // run header + column padding above the rows). Measured, not assumed: header height varies
  // by breakpoint and content. A stale value only shifts the overscan window (buffered), so
  // re-measuring on viewport resize is enough.
  const [startMargin, setStartMargin] = useState(0)
  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current
      const scroller = controls.scrollElRef.current
      if (!container || !scroller) return
      setStartMargin(
        Math.max(
          0,
          Math.round(
            container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
          ),
        ),
      )
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [controls.scrollElRef])

  return (
    <div
      ref={(el) => {
        containerRef.current = el
        controls.attachContent(el)
      }}
      data-slot="thread-rows"
      data-virtualized="true"
    >
      {/* No `shift`: the transcript only ever appends (the SSE replay starts from seq 1 —
          there is no prepend pagination), so start-anchored offsets stay correct as-is. */}
      <Virtualizer
        ref={attachHandle}
        scrollRef={controls.scrollElRef}
        startMargin={startMargin}
        {...(measurements !== undefined ? { cache: measurements } : {})}
      >
        {rows.map((row) => (
          <div key={row.key} data-slot="thread-row" data-row-key={row.key} className="flex w-full flex-col pb-2.5">
            {row.node}
          </div>
        ))}
      </Virtualizer>
    </div>
  )
}

/** The floating "Jump to latest" pill, absolutely positioned above the dock by its caller. */
export function JumpToLatestPill({ onJump }: { onJump: () => void }) {
  return (
    <button
      type="button"
      data-slot="jump-to-latest"
      onClick={onJump}
      className="pointer-events-auto inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3.5 text-xs font-medium text-muted-foreground shadow-modal hover:text-foreground"
    >
      <ArrowDownIcon aria-hidden className="size-3.5" />
      Jump to latest
    </button>
  )
}
