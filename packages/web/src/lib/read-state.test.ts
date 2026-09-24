import { describe, expect, it } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'
import {
  canBeUnread,
  isDoneItem,
  isReadDoneItem,
  isUnread,
  unreadDoneCount,
  type ReadStateInput,
} from '@/lib/read-state'

/** A finished-run shape for the read/unread rule. Defaults describe a done run that finished at a
 *  fixed instant and has never been opened — i.e. unread — so each case overrides only what it
 *  is about. */
function done(over: Partial<ReadStateInput> = {}): ReadStateInput {
  return {
    status: 'done',
    finishedAt: '2026-08-01T10:00:00.000Z',
    seenAt: undefined,
    archived: false,
    ...over,
  }
}

describe('isDoneItem', () => {
  it('is true for the terminal statuses (the Recent bucket) and false for live ones', () => {
    const terminal: RunRecord['status'][] = ['done', 'failed', 'cancelled']
    const live: RunRecord['status'][] = ['queued', 'running', 'waiting', 'review']
    for (const status of terminal) expect(isDoneItem(status)).toBe(true)
    for (const status of live) expect(isDoneItem(status)).toBe(false)
  })
})

describe('isUnread', () => {
  it('is unread when a done run has never been seen', () => {
    expect(isUnread(done({ seenAt: undefined }))).toBe(true)
  })

  it('is unread when a failed run has never been seen', () => {
    expect(isUnread(done({ status: 'failed', seenAt: undefined }))).toBe(true)
  })

  it('is read once seen at or after it finished', () => {
    // Seen exactly at finish, and seen later — both count as read.
    expect(isUnread(done({ seenAt: '2026-08-01T10:00:00.000Z' }))).toBe(false)
    expect(isUnread(done({ seenAt: '2026-08-01T10:05:00.000Z' }))).toBe(false)
  })

  it('goes unread again when the run re-finished after the last receipt', () => {
    // A resumed-and-re-finished run: finishedAt has moved past the old seenAt.
    expect(
      isUnread(done({ seenAt: '2026-08-01T10:00:00.000Z', finishedAt: '2026-08-01T11:00:00.000Z' })),
    ).toBe(true)
  })

  it('is never unread for a cancelled run — you stopped it yourself', () => {
    expect(isUnread(done({ status: 'cancelled', seenAt: undefined }))).toBe(false)
  })

  it('is never unread for a live (unfinished) run', () => {
    for (const status of ['queued', 'running', 'waiting', 'review'] as RunRecord['status'][]) {
      expect(isUnread(done({ status, finishedAt: undefined }))).toBe(false)
    }
  })

  it('is never unread without a finishedAt, even for a done status caught mid-transition', () => {
    expect(isUnread(done({ finishedAt: undefined }))).toBe(false)
  })

  it('is never unread once archived — archiving is a stronger "handled" than reading', () => {
    expect(isUnread(done({ archived: true, seenAt: undefined }))).toBe(false)
  })
})

describe('canBeUnread — the receipt-independent half (#775)', () => {
  it('is true for a finished done/failed run regardless of its receipt', () => {
    // The whole point of the split: eligibility does NOT look at seenAt, so a run that is
    // currently read still answers true — which is exactly when "Mark unread" is offered.
    expect(canBeUnread(done({ seenAt: undefined }))).toBe(true)
    expect(canBeUnread(done({ seenAt: '2026-08-01T10:05:00.000Z' }))).toBe(true)
    expect(canBeUnread(done({ status: 'failed', seenAt: '2026-08-01T10:05:00.000Z' }))).toBe(true)
  })

  it('is false for the rows that can never wear the marker', () => {
    expect(canBeUnread(done({ status: 'cancelled' }))).toBe(false)
    expect(canBeUnread(done({ archived: true }))).toBe(false)
    expect(canBeUnread(done({ finishedAt: undefined }))).toBe(false)
    for (const status of ['queued', 'running', 'waiting', 'review'] as RunRecord['status'][]) {
      expect(canBeUnread(done({ status, finishedAt: undefined }))).toBe(false)
    }
  })

  it('is implied by isUnread — every unread row is by definition eligible', () => {
    const cases: ReadStateInput[] = [
      done({ seenAt: undefined }),
      done({ status: 'failed', seenAt: undefined }),
      done({ seenAt: '2026-08-01T09:00:00.000Z' }), // stale receipt
      done({ status: 'cancelled' }),
      done({ archived: true }),
      done({ finishedAt: undefined }),
      done({ status: 'running', finishedAt: undefined }),
    ]
    for (const run of cases) {
      if (isUnread(run)) expect(canBeUnread(run)).toBe(true)
    }
  })
})

describe('isReadDoneItem', () => {
  it('is true for a read done item and a cancelled run', () => {
    expect(isReadDoneItem(done({ seenAt: '2026-08-01T10:05:00.000Z' }))).toBe(true)
    expect(isReadDoneItem(done({ status: 'cancelled' }))).toBe(true)
  })

  it('is false for an unread done item (that is promoted, not dimmed)', () => {
    expect(isReadDoneItem(done({ seenAt: undefined }))).toBe(false)
  })

  it('is false for a live run — a working row shows its attention state, not a past outcome', () => {
    expect(isReadDoneItem(done({ status: 'running', finishedAt: undefined }))).toBe(false)
  })
})

describe('a run waiting out a usage limit', () => {
  const scheduled = done({ status: 'failed', autoResumeAt: '2026-08-03T19:33:53.000Z' })

  it('is neither unread nor read history — it is not finished at all', () => {
    // No outcome to have missed, and nothing to dim as history (spec
    // 2026-08-03-auto-resume-after-usage-limit): the row carries its `scheduled` status instead.
    expect(isUnread(scheduled)).toBe(false)
    expect(isReadDoneItem(scheduled)).toBe(false)
    expect(unreadDoneCount([scheduled])).toBe(0)
  })

  it('goes back to the ordinary rule once the schedule is gone', () => {
    expect(isUnread(done({ status: 'failed' }))).toBe(true)
    expect(isUnread({ ...scheduled, autoResumeAt: undefined })).toBe(true)
  })

  it('cannot be put back into unread either — eligibility excludes it, read receipt or not', () => {
    // The seam where #775 (`canBeUnread`) met the auto-resume rule: a scheduled row is not a
    // done item, so "Mark unread" must not be offered for it — otherwise a run with an
    // appointment to continue would be pushed into a list of outcomes to review. Asserted for
    // both receipt states, because eligibility is deliberately receipt-independent.
    expect(canBeUnread(scheduled)).toBe(false)
    expect(canBeUnread({ ...scheduled, seenAt: '2026-08-03T19:00:00.000Z' })).toBe(false)
    expect(canBeUnread({ ...scheduled, autoResumeAt: undefined })).toBe(true)
  })
})

describe('unreadDoneCount', () => {
  it('counts only the unread done items', () => {
    const runs: ReadStateInput[] = [
      done({ seenAt: undefined }), // unread
      done({ status: 'failed', seenAt: undefined }), // unread
      done({ seenAt: '2026-08-01T10:05:00.000Z' }), // read
      done({ status: 'cancelled' }), // never unread
      done({ archived: true, seenAt: undefined }), // archived → not unread
      done({ status: 'running', finishedAt: undefined }), // live → not unread
    ]
    expect(unreadDoneCount(runs)).toBe(2)
  })

  it('is zero for an empty list', () => {
    expect(unreadDoneCount([])).toBe(0)
  })
})
