import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type { ApiRun, RunEvent } from '@open-mercato/cezar-api-client'

import {
  liveSessionSeq,
  settledSessionSeq,
  STALE_RECORD_GRACE_MS,
  useRunRecordReconcile,
} from './run-reconcile'

/**
 * The stale-record healer (run-reconcile.ts): the transcript's session boundaries arbitrate a
 * record that disagrees with them, in both directions. One reported shape is the thread showing
 * "goal achieved — session closed" / "run finished" while the record says `running`, so Working…
 * spins forever and the composer sends into a session that 409s. The mirror is the thread reading
 * as done while the task is running — the composer then aims at `POST /continue`, which answers
 * "run is still active", and every reply bounces until the page is reloaded.
 */

const line = (seq: number, type: string, extra: Record<string, unknown> = {}): RunEvent => ({
  seq,
  ts: '2026-07-25T10:43:36.000Z',
  type,
  ...extra,
})

const run = (over: Partial<ApiRun> = {}): ApiRun =>
  ({ id: 'r1', status: 'running', ...over }) as ApiRun

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('settledSessionSeq', () => {
  it('no events → 0', () => {
    expect(settledSessionSeq([])).toBe(0)
  })

  it('a session.ended with nothing after it is the settle signal', () => {
    const events = [line(1, 'step-start'), line(5, 'lifecycle'), line(8, 'session.ended')]
    expect(settledSessionSeq(events)).toBe(8)
  })

  it('a session opening after the end (Continue) makes the end history, not news', () => {
    const events = [
      line(1, 'step-start', { kind: 'agent' }),
      line(8, 'session.ended'),
      line(9, 'step-start', { kind: 'agent' }),
    ]
    expect(settledSessionSeq(events)).toBe(0)
  })

  it('a check step after the end does not hide the settled agent session', () => {
    const events = [
      line(1, 'step-start', { kind: 'agent' }),
      line(8, 'session.ended'),
      line(9, 'step-start', { kind: 'check' }),
    ]
    expect(settledSessionSeq(events)).toBe(8)
  })

  it('session.started counts as an opening too', () => {
    const events = [line(8, 'session.ended'), line(9, 'session.started')]
    expect(settledSessionSeq(events)).toBe(0)
  })

  it('across several sessions the LAST boundary decides', () => {
    const events = [
      line(1, 'step-start', { kind: 'agent' }),
      line(8, 'session.ended'),
      line(9, 'step-start', { kind: 'agent' }),
      line(20, 'session.ended'),
    ]
    expect(settledSessionSeq(events)).toBe(20)
  })

  it('a malformed line without a numeric seq is skipped, not fatal', () => {
    const bad = { ts: '', type: 'session.ended' } as unknown as RunEvent
    expect(settledSessionSeq([bad])).toBe(0)
  })
})

describe('liveSessionSeq', () => {
  it('no events → 0', () => {
    expect(liveSessionSeq([])).toBe(0)
  })

  it('an opening with nothing after it is the live signal', () => {
    const events = [line(8, 'session.ended'), line(9, 'step-start', { kind: 'agent' })]
    expect(liveSessionSeq(events)).toBe(9)
  })

  it('session.started counts as an opening too', () => {
    expect(liveSessionSeq([line(8, 'session.ended'), line(9, 'session.started')])).toBe(9)
  })

  it('an end after the opening means settled, not live', () => {
    const events = [line(9, 'step-start', { kind: 'agent' }), line(20, 'session.ended')]
    expect(liveSessionSeq(events)).toBe(0)
  })

  it('a check step is not a session opening', () => {
    const events = [line(8, 'session.ended'), line(9, 'step-start', { kind: 'check' })]
    expect(liveSessionSeq(events)).toBe(0)
  })

  it('the two readings are mutually exclusive', () => {
    const live = [line(8, 'session.ended'), line(9, 'session.started')]
    const settled = [line(9, 'session.started'), line(20, 'session.ended')]
    expect([liveSessionSeq(live), settledSessionSeq(live)]).toEqual([9, 0])
    expect([liveSessionSeq(settled), settledSessionSeq(settled)]).toEqual([0, 20])
  })
})

function renderReconcile(record: ApiRun | undefined, events: RunEvent[]) {
  const client = createQueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const view = renderHook(
    ({ r, e }: { r: ApiRun | undefined; e: RunEvent[] }) => useRunRecordReconcile(r, e),
    {
      initialProps: { r: record, e: events },
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    },
  )
  return { ...view, invalidate }
}

describe('useRunRecordReconcile', () => {
  it('a record still claiming `running` over a settled transcript refetches after the grace', () => {
    vi.useFakeTimers()
    const { invalidate } = renderReconcile(run(), [line(8, 'session.ended')])
    expect(invalidate).not.toHaveBeenCalled()

    vi.advanceTimersByTime(STALE_RECORD_GRACE_MS)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.detail('r1') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.list() })
  })

  it('`waiting` is a live-session claim too', () => {
    vi.useFakeTimers()
    const { invalidate } = renderReconcile(run({ status: 'waiting' }), [line(8, 'session.ended')])
    vi.advanceTimersByTime(STALE_RECORD_GRACE_MS)
    expect(invalidate).toHaveBeenCalled()
  })

  it('the healthy path stays quiet: the record settles within the grace and cancels the refetch', () => {
    vi.useFakeTimers()
    const { rerender, invalidate } = renderReconcile(run(), [line(8, 'session.ended')])
    rerender({ r: run({ status: 'done' }), e: [line(8, 'session.ended')] })
    vi.advanceTimersByTime(STALE_RECORD_GRACE_MS * 2)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('a live session (no settle signal) never refetches', () => {
    vi.useFakeTimers()
    const { invalidate } = renderReconcile(run(), [line(1, 'step-start'), line(5, 'text')])
    vi.advanceTimersByTime(STALE_RECORD_GRACE_MS * 2)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('a settled record over a settled transcript is consistent — no refetch', () => {
    vi.useFakeTimers()
    const { invalidate } = renderReconcile(run({ status: 'done' }), [line(8, 'session.ended')])
    vi.advanceTimersByTime(STALE_RECORD_GRACE_MS * 2)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('a Continue reopening the session (step-start after the end) stops a pending refetch', () => {
    vi.useFakeTimers()
    const events = [line(8, 'session.ended')]
    const { rerender, invalidate } = renderReconcile(run(), events)
    rerender({ r: run(), e: [...events, line(9, 'step-start', { kind: 'agent' })] })
    vi.advanceTimersByTime(STALE_RECORD_GRACE_MS * 2)
    expect(invalidate).not.toHaveBeenCalled()
  })

  // The mirror: the record says the run is finished while the transcript has it live again.
  it('a `done` record over a reopened session refetches after the grace', () => {
    vi.useFakeTimers()
    const { invalidate } = renderReconcile(run({ status: 'done' }), [
      line(8, 'session.ended'),
      line(9, 'step-start', { kind: 'agent' }),
    ])
    expect(invalidate).not.toHaveBeenCalled()

    vi.advanceTimersByTime(STALE_RECORD_GRACE_MS)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.detail('r1') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.list() })
  })

  it('`review` and `failed` are settled claims too — an auto-resume heals either', () => {
    for (const status of ['review', 'failed', 'cancelled'] as const) {
      vi.useFakeTimers()
      const { invalidate } = renderReconcile(run({ status }), [line(9, 'session.started')])
      vi.advanceTimersByTime(STALE_RECORD_GRACE_MS)
      expect(invalidate, status).toHaveBeenCalled()
      cleanup()
      vi.useRealTimers()
    }
  })

  it('the healthy Continue stays quiet: the record flips to running within the grace', () => {
    vi.useFakeTimers()
    const events = [line(8, 'session.ended'), line(9, 'step-start', { kind: 'agent' })]
    const { rerender, invalidate } = renderReconcile(run({ status: 'done' }), events)
    rerender({ r: run({ status: 'running' }), e: events })
    vi.advanceTimersByTime(STALE_RECORD_GRACE_MS * 2)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('a queued run is neither claim — a deferred continuation parks with its step already open', () => {
    vi.useFakeTimers()
    const { invalidate } = renderReconcile(run({ status: 'queued' }), [
      line(9, 'step-start', { kind: 'agent' }),
    ])
    vi.advanceTimersByTime(STALE_RECORD_GRACE_MS * 2)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('a settled record over a transcript with no boundary at all stays quiet', () => {
    vi.useFakeTimers()
    const { invalidate } = renderReconcile(run({ status: 'done' }), [line(5, 'text')])
    vi.advanceTimersByTime(STALE_RECORD_GRACE_MS * 2)
    expect(invalidate).not.toHaveBeenCalled()
  })
})
