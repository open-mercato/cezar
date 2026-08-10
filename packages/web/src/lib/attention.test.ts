import { describe, expect, it } from 'vitest'

import type { RunRecord, RunStatus } from '@open-mercato/cezar-api-client'
import type { StatusDotTone } from '@/components/status-dot'
import {
  ATTENTION_RANK,
  deriveAttention,
  wantsAttention,
  type Attention,
  type AttentionTone,
} from '@/lib/attention'

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    title: 'Normalize the agent-event protocol',
    workflow: 'default',
    task: 'normalize the protocol',
    status: 'running',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

/** The whole `RunStatus` union, spelled out. If the server ever adds a status, this array stops
 *  type-checking — which is the point: a new status must get an explicit attention answer rather
 *  than silently falling into the chain's last `return`. */
const ALL_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting',
  'review',
  'done',
  'failed',
  'cancelled',
]

describe('deriveAttention', () => {
  const cases: ReadonlyArray<[RunStatus, Attention]> = [
    ['waiting', { bucket: 'waiting', tone: 'pending', pulse: true, label: 'needs you' }],
    ['review', { bucket: 'waiting', tone: 'violet', pulse: true, label: 'needs review' }],
    ['running', { bucket: 'running', tone: 'violet', pulse: true, label: 'running' }],
    ['queued', { bucket: 'none', tone: 'neutral', pulse: false, label: 'queued' }],
    ['done', { bucket: 'none', tone: 'success', pulse: false, label: 'done' }],
    ['failed', { bucket: 'error', tone: 'danger', pulse: false, label: 'failed' }],
    ['cancelled', { bucket: 'none', tone: 'neutral', pulse: false, label: 'cancelled' }],
  ]

  it.each(cases)('maps %s', (status, expected) => {
    expect(deriveAttention(run({ status }))).toEqual(expected)
  })

  it('answers for every status the API can send', () => {
    expect(cases.map(([status]) => status).sort()).toEqual([...ALL_STATUSES].sort())
  })

  it('pulses exactly the transitioning states', () => {
    // The spec's "pulsing while transitioning": something is happening, or something is waiting
    // on you. A finished or parked run is still — a list where everything pulses says nothing.
    const pulsing = ALL_STATUSES.filter((status) => deriveAttention(run({ status })).pulse)
    expect(pulsing).toEqual(['running', 'waiting', 'review'])
  })

  describe('permutations', () => {
    // `error` is a message, not a state: the server sets it *with* `status: 'failed'` (and with
    // 'cancelled' when a run was interrupted). The dot follows the status, so an error string
    // must not turn a done run red — and must not fail to turn a failed one red either.
    it.each(ALL_STATUSES)('ignores a stray error message on a %s run', (status) => {
      expect(deriveAttention(run({ status, error: 'interrupted — cezar process exited' }))).toEqual(
        deriveAttention(run({ status }))
      )
    })

    it.each(ALL_STATUSES)('is unchanged by archiving a %s run', (status) => {
      // Archiving files a run away; it does not change what happened to it. The list drops
      // archived runs into their own view (lib/task-groups.ts) — that is a list concern, not an
      // attention one, and a notification for an archived run is the list's to suppress.
      expect(deriveAttention(run({ status, archived: true, archivedAt: '2026-07-14T11:00:00.000Z' }))).toEqual(
        deriveAttention(run({ status }))
      )
    })

    it.each(ALL_STATUSES)('is unchanged by an open PR on a %s run', (status) => {
      expect(deriveAttention(run({ status, pullRequestUrl: 'https://github.com/o/r/pull/1' }))).toEqual(
        deriveAttention(run({ status }))
      )
    })

    it('does not read the steps', () => {
      // Attention is a property of the run's own status. A failed *step* inside a run that
      // recovered and finished must not leave a red dot on a green run.
      const withFailedStep = run({
        status: 'done',
        steps: [
          { id: 's1', name: 'implement', kind: 'agent', status: 'failed', iterations: 1, tokensUsed: 10 },
          { id: 's2', name: 'retry', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 10 },
        ],
      })
      expect(deriveAttention(withFailedStep).tone).toBe('success')
    })
  })

  it('is pure — the same record twice is the same answer, and the record is untouched', () => {
    const record = run({ status: 'waiting' })
    const frozen = JSON.stringify(record)
    expect(deriveAttention(record)).toEqual(deriveAttention(record))
    expect(JSON.stringify(record)).toBe(frozen)
  })

  it('never claims a permission prompt — cezar emits none yet', () => {
    // The bucket exists (the spec ranks it first) but R2's `permission.*` events are what will
    // feed it. Until then no record can produce it: this test is the guard that nothing invented
    // a source in the meantime.
    for (const status of ALL_STATUSES) {
      expect(deriveAttention(run({ status })).bucket).not.toBe('permission')
    }
  })

  it('never claims unseen — there is no seen marker to compare against', () => {
    for (const status of ALL_STATUSES) {
      expect(deriveAttention(run({ status })).bucket).not.toBe('unseen')
    }
  })
})

describe('ATTENTION_RANK', () => {
  it('is the spec ladder: permission > error > waiting > running > unseen', () => {
    const order = Object.entries(ATTENTION_RANK)
      .sort(([, a], [, b]) => a - b)
      .map(([bucket]) => bucket)
    expect(order).toEqual(['permission', 'error', 'waiting', 'running', 'unseen', 'none'])
  })

  it('ranks error above waiting — an error can never be masked by a gate', () => {
    expect(ATTENTION_RANK.error).toBeLessThan(ATTENTION_RANK.waiting)
    expect(ATTENTION_RANK.permission).toBeLessThan(ATTENTION_RANK.error)
  })
})

describe('a run waiting out a usage limit', () => {
  const scheduled = run({ status: 'failed', autoResumeAt: '2026-08-03T19:33:53.000Z' })

  it('reads as scheduled and parked, never as a red failure', () => {
    // It IS `failed` on the record, but the failure is about to undo itself (spec
    // 2026-08-03-auto-resume-after-usage-limit) — amber and still, like `queued`.
    expect(deriveAttention(scheduled)).toEqual({
      bucket: 'none',
      tone: 'pending',
      pulse: false,
      label: 'scheduled',
    })
  })

  it('asks for nothing — no notification, no attention bucket', () => {
    expect(wantsAttention(scheduled)).toBe(false)
    // …while a failure with no schedule is unchanged.
    expect(deriveAttention(run({ status: 'failed' })).label).toBe('failed')
    expect(wantsAttention(run({ status: 'failed' }))).toBe(true)
  })

  it('only applies to a FAILED run — a live run with a stale stamp is still live', () => {
    expect(deriveAttention(run({ status: 'running', autoResumeAt: '2026-08-03T19:33:53.000Z' })).label)
      .toBe('running')
  })
})

describe('wantsAttention', () => {
  it.each(ALL_STATUSES)('%s', (status) => {
    // The spec's notification trigger (Phase R6): "waiting/review/failed".
    const expected = status === 'waiting' || status === 'review' || status === 'failed'
    expect(wantsAttention(run({ status }))).toBe(expected)
  })
})

describe("running activity: 'monitoring' (#490)", () => {
  it('is a distinct, non-attention sub-state of running', () => {
    expect(deriveAttention(run({ status: 'running', activity: 'monitoring' }))).toEqual({
      bucket: 'running',
      tone: 'violet',
      pulse: true,
      label: 'monitoring',
    })
  })

  it('does not want attention — no notification, not "Needs you"', () => {
    expect(wantsAttention(run({ status: 'running', activity: 'monitoring' }))).toBe(false)
  })

  it('leaves plain running untouched and is inert on non-running statuses', () => {
    expect(deriveAttention(run({ status: 'running' })).label).toBe('running')
    // `activity` is only read while running — a stale value on a terminal record is ignored.
    expect(deriveAttention(run({ status: 'done', activity: 'monitoring' })).label).toBe('done')
  })
})

describe('tone vocabulary', () => {
  it('is exactly the StatusDot tones', () => {
    // attention.ts names its tones itself to stay UI-free, so the two lists can drift. These
    // assignments are the drift alarm: they only compile while the unions are identical.
    const toDot = (tone: AttentionTone): StatusDotTone => tone
    const fromDot = (tone: StatusDotTone): AttentionTone => tone
    expect(toDot('violet')).toBe('violet')
    expect(fromDot('neutral')).toBe('neutral')
  })

  it('every status yields a tone StatusDot can paint', () => {
    const tones = new Set(ALL_STATUSES.map((status) => deriveAttention(run({ status })).tone))
    expect([...tones].sort()).toEqual(['danger', 'neutral', 'pending', 'success', 'violet'])
  })
})
