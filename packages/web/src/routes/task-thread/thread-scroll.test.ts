import { afterEach, describe, expect, it } from 'vitest'
import type { CacheSnapshot } from 'virtua'

import {
  HISTORY_BOUNDARY_SLACK_PX,
  NEAR_BOTTOM_SLACK_PX,
  VIRTUALIZE_THRESHOLD,
  clearThreadScrollCaches,
  firstVisibleThreadAnchor,
  isNearBottom,
  isNearHistoryStart,
  readThreadMeasurements,
  readThreadScroll,
  saveThreadMeasurements,
  saveThreadScroll,
  threadAnchorScrollTop,
  threadRenderMode,
} from './thread-scroll'

afterEach(() => clearThreadScrollCaches())

describe('isNearBottom — the shared stick rule', () => {
  const box = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 400 })

  it.each([
    // remaining = 1000 - scrollTop - 400; default slack 24 (the tool-output live tail)
    [600, undefined, true], // exactly at the bottom
    [580, undefined, true], // 20 px up — inside the default slack
    [576, undefined, false], // 24 px up — the boundary is exclusive
    [500, undefined, false],
    // the thread scroller's 80 px slack (the research's ~80 px pin rule)
    [521, NEAR_BOTTOM_SLACK_PX, true], // 79 px up
    [520, NEAR_BOTTOM_SLACK_PX, false], // 80 px up
    [0, NEAR_BOTTOM_SLACK_PX, false],
  ])('scrollTop %d, slack %s → %s', (scrollTop, slack, expected) => {
    expect(isNearBottom(box(scrollTop), slack)).toBe(expected)
  })
})

describe('isNearHistoryStart — intent is consumed only near the retained boundary', () => {
  it('uses the larger of one viewport and the fixed history slack', () => {
    expect(isNearHistoryStart({ scrollTop: HISTORY_BOUNDARY_SLACK_PX - 1, clientHeight: 400 })).toBe(true)
    expect(isNearHistoryStart({ scrollTop: HISTORY_BOUNDARY_SLACK_PX, clientHeight: 400 })).toBe(false)
    expect(isNearHistoryStart({ scrollTop: 899, clientHeight: 900 })).toBe(true)
    expect(isNearHistoryStart({ scrollTop: 900, clientHeight: 900 })).toBe(false)
  })
})

describe('stable history anchors', () => {
  const before = [
    { key: 'row-a', top: 80, bottom: 120 },
    { key: 'row-b', top: 120, bottom: 180 },
  ]

  it('captures the first partially visible row and its pixel offset', () => {
    expect(firstVisibleThreadAnchor(100, before)).toEqual({ key: 'row-a', offset: -20 })
  })

  it('restores row identity when tail eviction cancels the total-height delta', () => {
    const anchor = firstVisibleThreadAnchor(100, before)
    const after = [
      { key: 'new-row', top: 60, bottom: 120 },
      { key: 'row-a', top: 200, bottom: 240 },
    ]
    expect(threadAnchorScrollTop(500, 100, anchor, after, 500)).toBe(620)
  })

  it('falls back to height-delta restoration when the anchor row was evicted', () => {
    expect(threadAnchorScrollTop(500, 100, { key: 'gone', offset: 0 }, before, 740)).toBe(740)
  })
})

describe('threadRenderMode — the ~300-row virtualization threshold', () => {
  it.each([
    ['', 0, 'flat'],
    ['', VIRTUALIZE_THRESHOLD, 'flat'], // at the threshold: still flat
    ['', VIRTUALIZE_THRESHOLD + 1, 'virtual'], // beyond it: virtua
    ['', 5000, 'virtual'],
    // The measurement seam: ?thread= forces a mode regardless of size.
    ['?thread=flat', 5000, 'flat'],
    ['?thread=virtual', 3, 'virtual'],
    ['?thread=bogus', 5000, 'virtual'], // unknown values fall back to the rule
  ] as const)('search %j with %d rows → %s', (search, rows, expected) => {
    expect(threadRenderMode(search, rows)).toBe(expected)
  })
})

describe('the per-run scroll cache', () => {
  it('remembers the last position per run id, latest write wins', () => {
    saveThreadScroll('r1', { top: 100, atBottom: false })
    saveThreadScroll('r1', { top: 250, atBottom: false })
    saveThreadScroll('r2', { top: 0, atBottom: true })
    expect(readThreadScroll('r1')).toEqual({ top: 250, atBottom: false })
    expect(readThreadScroll('r2')).toEqual({ top: 0, atBottom: true })
  })

  it('knows nothing about a run never scrolled', () => {
    expect(readThreadScroll('never-seen')).toBeUndefined()
  })
})

describe('the per-run measurement cache', () => {
  const snapshot = { fake: true } as unknown as CacheSnapshot

  it('returns the snapshot only at the row count it was taken at (the virtua caveat)', () => {
    saveThreadMeasurements('r1', { rows: 400, cache: snapshot })
    expect(readThreadMeasurements('r1', 400)).toBe(snapshot)
    // A mid-replay remount sees fewer rows — the stale snapshot must not mis-apply.
    expect(readThreadMeasurements('r1', 120)).toBeUndefined()
    expect(readThreadMeasurements('r2', 400)).toBeUndefined()
  })
})
