import { describe, expect, it } from 'vitest'

import type { ApiRun, RunEvent } from '@open-mercato/cezar-api-client'

import { liveTurnStart } from './task-thread'
import { reduceThread, type ThreadState } from './thread-state'

const run = { startedAt: '2026-09-23T09:00:00.000Z' } as ApiRun
const event = (seq: number, type: string, sessionKey: string, ts: string): RunEvent =>
  ({ seq, type, sessionKey, ts, turnId: 'turn_1', stepId: 'review' }) as RunEvent
const aStart = '2026-09-23T10:00:00.000Z'
const bStart = '2026-09-23T10:01:00.000Z'
const bEnd = '2026-09-23T10:02:00.000Z'
const aEnd = '2026-09-23T10:03:00.000Z'
const started = [event(1, 'turn.started', 'a', aStart), event(2, 'turn.started', 'b', bStart)]

describe('liveTurnStart — concurrent reviewers', () => {
  it('counts from the earliest reviewer still working', () => {
    expect(liveTurnStart(run, reduceThread(started))).toBe(aStart)
    expect(liveTurnStart(run, reduceThread([...started, event(3, 'turn.completed', 'a', aEnd)]))).toBe(bStart)
  })

  it('keeps counting the open reviewer when the last-started reviewer finishes first', () => {
    expect(liveTurnStart(run, reduceThread([...started, event(3, 'turn.completed', 'b', bEnd)]))).toBe(aStart)
  })

  it('between councils, counts from the latest completion in wall-clock order', () => {
    expect(liveTurnStart(run, reduceThread([
      ...started,
      event(3, 'turn.completed', 'b', bEnd),
      event(4, 'turn.completed', 'a', aEnd),
    ]))).toBe(aEnd)
  })

  it('guard: starts the next unkeyed phase at its own open turn', () => {
    const thread = reduceThread([...started, event(3, 'turn.completed', 'b', bEnd)])
    thread.turns.push({ id: 'next', items: [], startedAt: aEnd })
    expect(liveTurnStart(run, thread)).toBe(aEnd)
  })

  it('guard: ignores an unfinished reviewer from an earlier council phase', () => {
    const thread = reduceThread([...started, event(3, 'turn.completed', 'b', bEnd)])
    thread.turns.push({ id: 'next', items: [], stepId: 'next-review', sessionKey: 'c', startedAt: aEnd })
    expect(liveTurnStart(run, thread)).toBe(aEnd)
  })

  it('guard: keeps the latest-turn rule for an ordinary unkeyed transcript', () => {
    expect(liveTurnStart(run, {
      turns: [
        { id: 'older', items: [], startedAt: aStart },
        { id: 'latest', items: [], startedAt: bStart, completed: { stopReason: 'end_turn', ts: bEnd } },
      ],
    })).toBe(bEnd)
  })
})

describe('restart boundaries', () => {
  const resumedAt = '2026-09-23T11:00:00.000Z'
  const userMessage: RunEvent = { seq: 3, type: 'user-message', text: 'Continue after restart', ts: resumedAt }

  it.each([false, true])('guard: ignores an unclosed pre-crash reviewer (driver tail=%s)', (driverTail) => {
    const thread = reduceThread([
      ...started,
      userMessage,
      event(4, 'turn.started', 'resumed', resumedAt),
      ...(driverTail ? [{ seq: 5, type: 'note', stepId: 'review', message: 'Council resumed', ts: resumedAt } as RunEvent] : []),
    ])
    expect(thread.turns[0]?.completed).toBeUndefined()
    expect(thread.turns[0]?.sessionEnded).toBeUndefined()
    expect(liveTurnStart({ ...run, startedAt: resumedAt }, thread)).toBe(resumedAt)
  })

  it('guard: keeps a live reviewer clock across commentary without a resume', () => {
    const thread = reduceThread([
      ...started,
      { seq: 3, type: 'note', stepId: 'review', message: 'Still reviewing', ts: bEnd },
    ])
    expect(liveTurnStart(run, thread)).toBe(aStart)
  })

  it('guard: excludes compact pre-crash activity after Continue while retaining completed peers', () => {
    const resumedStart = '2026-09-23T11:01:00.000Z'
    const resumedEnd = '2026-09-23T11:02:00.000Z'
    const thread = reduceThread([
      { seq: 1, type: 'session.error', sessionKey: 'old', stepId: 'review', message: 'Retrying', ts: aEnd },
      userMessage,
      event(4, 'turn.started', 'resumed', resumedStart),
      event(5, 'turn.completed', 'resumed', resumedEnd),
      { seq: 6, type: 'note', stepId: 'review', message: 'Council resumed', ts: resumedEnd },
    ])
    expect(thread.turns[0]?.startedAt).toBeUndefined()
    expect(thread.turns[0]?.lastActivityAt).toBe(aEnd)
    expect(liveTurnStart({ ...run, startedAt: resumedAt }, thread)).toBe(resumedEnd)
  })

  it('guard: ordinary user resumes retain the user-message start', () => {
    const thread = reduceThread([
      { seq: 1, type: 'turn.started', turnId: 'old', ts: aStart },
      userMessage,
      { seq: 4, type: 'turn.started', turnId: 'new', ts: '2026-09-23T11:01:00.000Z' },
    ])
    expect(liveTurnStart(run, thread)).toBe(resumedAt)
  })
})

describe('mid-council messages', () => {
  const stepNames = new Map([['review', 'Review'], ['stage', 'Stage']])

  it('keeps the council clock at message arrival and through the next reviewer event', () => {
    const events: RunEvent[] = [
      ...started,
      { seq: 3, type: 'user-message', text: 'Also check tests', ts: bEnd },
      { seq: 4, type: 'harness.message.queued', ts: bEnd, message: { id: 'queued' } },
      { seq: 5, type: 'item.completed', sessionKey: 'b', stepId: 'review', ts: aEnd,
        item: { kind: 'message', id: 'finding', role: 'assistant', text: 'Checking tests' } },
    ]
    for (let end = 2; end <= events.length; end += 1) {
      expect(liveTurnStart(run, reduceThread(events.slice(0, end), { stepNames })), `prefix ${end}`).toBe(aStart)
    }
  })

  it('keeps other open reviewers when a queued-message reviewer is nudged', () => {
    const nudgedAt = '2026-09-23T10:04:00.000Z'
    const events: RunEvent[] = [
      ...started,
      { seq: 3, type: 'user-message', text: 'Also check tests', ts: bEnd },
      event(4, 'turn.completed', 'a', aEnd),
      { ...event(5, 'turn.started', 'a', nudgedAt), turnId: 'turn_2' },
      { seq: 6, type: 'item.completed', sessionKey: 'a', stepId: 'review', ts: nudgedAt,
        item: { kind: 'message', id: 'follow-up', role: 'assistant', text: 'Checking again' } },
    ]
    for (let end = 5; end <= events.length; end += 1) {
      expect(liveTurnStart(run, reduceThread(events.slice(0, end), { stepNames }))).toBe(bStart)
    }
    expect(liveTurnStart(run, reduceThread([...events, event(7, 'turn.completed', 'b', nudgedAt)], { stepNames }))).toBe(nudgedAt)
  })

  it.each([false, true])('uses the council end through a pending-message gap and op phase (note=%s)', (driverNote) => {
    const events: RunEvent[] = [
      ...started,
      { seq: 3, type: 'user-message', text: 'Also check tests', ts: bEnd },
      ...(driverNote ? [{ seq: 4, type: 'note', stepId: 'review', message: 'Still reviewing', ts: bEnd }] : []),
      event(5, 'turn.completed', 'b', bEnd),
      event(6, 'turn.completed', 'a', aEnd),
      { seq: 7, type: 'harness.phase.updated', stepId: 'review', phase: { id: 'review', status: 'done' }, ts: aEnd },
      { seq: 8, type: 'harness.phase.updated', stepId: 'stage', phase: { id: 'stage', status: 'running' }, ts: aEnd },
      { seq: 9, type: 'harness.phase.updated', stepId: 'stage', phase: { id: 'stage', status: 'done' }, ts: aEnd },
    ]
    for (let end = events.findIndex((line) => line.seq === 6) + 1; end <= events.length; end += 1) {
      expect(liveTurnStart(run, reduceThread(events.slice(0, end), { stepNames })), `prefix ${end}`).toBe(aEnd)
    }
  })

  it.each([false, true])('keeps a queued-message council clock with or without a driver note (note=%s)', (driverNote) => {
    const thread = reduceThread([
      ...started,
      { seq: 3, type: 'user-message', text: 'Also check tests', ts: bEnd },
      { seq: 4, type: 'item.completed', stepId: 'review', sessionKey: 'b', ts: aEnd,
        item: { kind: 'message', id: 'finding', role: 'assistant', text: 'Checking tests' } },
      ...(driverNote ? [{ seq: 5, type: 'note', stepId: 'review', message: 'Still reviewing', ts: aEnd }] : []),
    ])
    expect(liveTurnStart(run, thread)).toBe(aStart)
  })

  it.each([false, true])('starts at Continue during durable-ledger reuse notes before a resumed reviewer opens (earlier phase note=%s)', (earlierPhaseNote) => {
    const resumedAt = '2026-09-23T11:00:00.000Z'
    const thread = reduceThread([
      ...started,
      event(3, 'turn.completed', 'a', aEnd),
      { seq: 4, type: 'lifecycle', message: 'cezar restarted', ts: '2026-09-23T10:30:00.000Z' },
      { seq: 5, type: 'user-message', text: 'Continue', ts: resumedAt },
      { seq: 6, type: 'lifecycle', message: 'Harness resumed', ts: resumedAt },
      ...(earlierPhaseNote ? [{ seq: 7, type: 'note', stepId: 'implement', message: 'Reused completed implementer from the durable ledger', ts: resumedAt }] : []),
      { seq: 8, type: 'harness.phase.updated', stepId: 'review', phase: { id: 'review', status: 'running' }, ts: resumedAt },
      { seq: 9, type: 'note', stepId: 'review', message: 'Reused completed reviewer A from the durable ledger', ts: resumedAt },
    ], { stepNames: new Map([['implement', 'Implement'], ['review', 'Review']]) })
    expect(thread.turns.find((turn) => turn.sessionKey === 'b')?.lastActivityAt).toBe(bStart)
    expect(liveTurnStart({ ...run, startedAt: resumedAt }, thread)).toBe(resumedAt)
  })

  it.each(['item.updated', 'item.completed', 'item.delta', 'usage.updated', 'plan.updated'])('uses %s activity on an existing reviewer after a queued message', (type) => {
    const item = { kind: 'message', id: 'finding', role: 'assistant', text: 'Checking' }
    const thread = reduceThread([
      ...started,
      { seq: 3, type: 'item.started', stepId: 'review', sessionKey: 'a', ts: bStart, item },
      { seq: 4, type: 'user-message', text: 'Also check tests', ts: bEnd },
      { seq: 5, type, stepId: 'review', sessionKey: 'a', ts: aEnd, item, itemId: 'finding', field: 'text', delta: ' tests', entries: [], usage: { total: 100 } },
    ])
    expect(thread.turns[0]?.lastActivityAt).toBe(aEnd)
    expect(liveTurnStart(run, thread)).toBe(aStart)
  })

  it('guard: a queued message after a closed council keeps its own clock', () => {
    const messageAt = '2026-09-23T11:00:00.000Z'
    const thread = reduceThread([
      ...started, event(3, 'turn.completed', 'a', aEnd), event(4, 'turn.completed', 'b', bEnd),
      { seq: 5, type: 'user-message', text: 'Continue', ts: messageAt },
    ])
    expect(liveTurnStart(run, thread)).toBe(messageAt)
  })

  it('guard: ordinary queued messages retain identical turns and their message clock', () => {
    const thread = reduceThread([
      { seq: 1, type: 'turn.started', turnId: 'ordinary', ts: aStart },
      { seq: 2, type: 'user-message', text: 'Follow up', ts: bStart },
      { seq: 3, type: 'note', message: 'Queued', ts: bEnd },
    ])
    expect(thread).toEqual({
      turns: [
        { id: 'turn-seq-1', turnId: 'ordinary', startedAt: aStart, items: [] },
        { id: 'turn-seq-2', startedAt: bStart, userMessage: { text: 'Follow up', imageCount: 0, images: [], ts: bStart },
          items: [{ kind: 'note', id: 'v1:3', text: 'Queued', tone: 'dim' }] },
      ],
      lastEventAt: bEnd,
    })
    expect(liveTurnStart(run, thread)).toBe(bStart)
  })

  it('guard: keeps the surviving reviewer clock under commentary without a queued message', () => {
    const thread = reduceThread([
      ...started,
      { ...event(3, 'session.ended', 'a', aEnd), reason: 'error' },
      { seq: 4, type: 'note', stepId: 'review', message: 'Reviewer A failed; B is still reviewing', ts: aEnd },
    ])
    expect(liveTurnStart(run, thread)).toBe(bStart)
  })

  it('keeps the surviving reviewer clock after a queued message and driver note', () => {
    const aStartedAt = '2026-09-23T10:22:00.000Z'
    const bStartedAt = '2026-09-23T10:23:00.000Z'
    const thread = reduceThread([
      event(1, 'turn.started', 'a', aStartedAt),
      event(2, 'turn.started', 'b', bStartedAt),
      { seq: 3, type: 'user-message', text: 'Please also check the tests', ts: '2026-09-23T10:40:00.000Z' },
      { ...event(4, 'session.ended', 'a', '2026-09-23T10:45:00.000Z'), reason: 'error' },
      { seq: 5, type: 'note', stepId: 'review', message: 'Reviewer A failed; B is still reviewing', ts: '2026-09-23T10:45:00.000Z' },
    ])
    expect(liveTurnStart({ startedAt: '2026-09-23T10:00:00.000Z' } as ApiRun, thread)).toBe(bStartedAt)
  })
})

describe('compact council fallback', () => {
  it('uses a finished peer start when compact context leaves open peers without starts', () => {
    const thread = reduceThread([
      event(1, 'turn.started', 'b', bStart),
      event(2, 'turn.completed', 'b', bEnd),
      { seq: 3, type: 'item.completed', sessionKey: 'a', stepId: 'review', ts: aEnd, item: { kind: 'message', id: 'answer', role: 'assistant', text: 'A is still reviewing' } },
      { seq: 4, type: 'session.error', sessionKey: 'c', stepId: 'review', ts: aEnd, message: 'Retrying C' },
    ])
    expect(thread.turns.slice(1).map((turn) => turn.startedAt)).toEqual([undefined, undefined])
    expect(liveTurnStart(run, thread)).toBe(bStart)
  })

  it('uses a peer start when every closure lacks a timestamp', () => {
    expect(liveTurnStart(run, { turns: [{
      id: 'b', items: [], sessionKey: 'b', stepId: 'review', startedAt: bStart,
      completed: { stopReason: 'end_turn' },
    }] })).toBe(bStart)
  })

  it('guard: a defined open-peer start wins over an earlier closed peer', () => {
    expect(liveTurnStart(run, reduceThread([
      ...started, event(3, 'turn.completed', 'a', aEnd),
    ]))).toBe(bStart)
  })

  it('guard: a fully closed council still uses its latest completion', () => {
    expect(liveTurnStart(run, reduceThread([
      ...started, event(3, 'turn.completed', 'a', aEnd), event(4, 'turn.completed', 'b', bEnd),
    ]))).toBe(aEnd)
  })

  it('guard: ordinary compact turns still fall back to the run start', () => {
    expect(liveTurnStart(run, { turns: [{ id: 'lazy', items: [] }] })).toBe(run.startedAt)
  })

  it('guard: retains compact reviewer activity without inventing a turn start', () => {
    const thread = reduceThread([
      event(1, 'turn.started', 'b', bStart),
      event(2, 'turn.completed', 'b', bEnd),
      { seq: 3, type: 'usage.updated', sessionKey: 'a', stepId: 'review', ts: aStart, usage: { total: 100 } },
      { seq: 4, type: 'session.error', sessionKey: 'a', stepId: 'review', ts: aEnd, message: 'Retrying' },
    ])
    expect(thread.turns[1]?.startedAt).toBeUndefined()
    expect(thread.turns[1]?.lastActivityAt).toBe(aEnd)
    expect(liveTurnStart(run, thread)).toBe(bStart)
  })

  it.each<[string, ThreadState, string | undefined]>([
    ['no turns', { turns: [] }, run.startedAt],
    ['ordinary open turn', { turns: [{ id: 'a', items: [], startedAt: aStart }] }, aStart],
    ['ordinary completion without a stamp', { turns: [{ id: 'a', items: [], completed: { stopReason: 'end_turn' } }] }, run.startedAt],
    ['unstamped open peers', { turns: [{ id: 'a', items: [], stepId: 'review', sessionKey: 'a' }] }, run.startedAt],
    ['unstamped closed peers', { turns: [{ id: 'a', items: [], stepId: 'review', sessionKey: 'a', completed: { stopReason: 'end_turn' } }] }, run.startedAt],
    ['pending message with no stamp after unstamped closures', { turns: [
      { id: 'a', items: [], stepId: 'review', sessionKey: 'a', completed: { stopReason: 'end_turn' } },
      { id: 'm', items: [], userMessage: { text: 'Continue', images: [], imageCount: 0 } },
    ] }, run.startedAt],
  ])('guard: preserves the clock fallback for %s', (_name, thread, expected) => {
    expect(liveTurnStart(run, thread)).toBe(expected)
  })

  it('guard: uses peer clocks without a run start and keeps an entirely unstamped clock absent', () => {
    expect(liveTurnStart({} as ApiRun, reduceThread(started))).toBe(aStart)
    expect(liveTurnStart({} as ApiRun, { turns: [
      { id: 'a', items: [], stepId: 'review', sessionKey: 'a', completed: { stopReason: 'end_turn' } },
      { id: 'm', items: [], userMessage: { text: 'Continue', images: [], imageCount: 0 } },
    ] })).toBeUndefined()
    expect(liveTurnStart({} as ApiRun, { turns: [
      { id: 'a', items: [], stepId: 'review', sessionKey: 'a' },
    ] })).toBeUndefined()
  })
})

describe('compact council clocks and session closure', () => {
  it('uses the earliest defined open-peer start after reloading compact context', () => {
    const thread = reduceThread([
      { seq: 1, ts: aStart, type: 'item.completed', stepId: 'review', sessionKey: 'a', item: { kind: 'message', id: 'm', role: 'assistant', text: 'A' } },
      event(2, 'turn.started', 'b', bStart),
      { seq: 3, ts: aEnd, type: 'session.error', stepId: 'review', sessionKey: 'c', message: 'C failed' },
    ] as RunEvent[])
    expect(thread.turns[0]?.startedAt).toBeUndefined()
    expect(liveTurnStart(run, thread)).toBe(bStart)
  })

  it('closes a dead reviewer on session.ended without inventing a reply', () => {
    const thread = reduceThread([
      ...started,
      event(3, 'turn.completed', 'b', bEnd),
      { ...event(4, 'session.ended', 'a', aEnd), reason: 'error' },
    ])
    expect(liveTurnStart(run, thread)).toBe(aEnd)
    expect(thread.turns[0]?.sessionEnded).toMatchObject({ reason: 'error', ts: aEnd })
    expect(thread.turns[0]?.completed).toBeUndefined()
  })

  it('guard: leaves sessionless session.ended on the ordinary latest-turn clock', () => {
    const thread = reduceThread([
      { seq: 1, type: 'turn.started', ts: aStart, turnId: 'ordinary' },
      { seq: 2, type: 'session.ended', ts: aEnd, reason: 'error' },
    ])
    expect(liveTurnStart(run, thread)).toBe(aStart)
    expect(thread.turns[0]?.sessionEnded).toBeUndefined()
    expect(thread.sessionEnded).toEqual({ reason: 'error' })
  })
})


describe('no current council peers', () => {
  const resumedAt = '2026-09-23T11:00:00.000Z'
  const stepNames = new Map([['review', 'Review'], ['fix', 'Fix']])

  it.each([false, true])('starts at recovery before a replacement reviewer opens (closed=%s)', (closed) => {
    const thread = reduceThread([
      ...started,
      ...(closed ? [event(3, 'turn.completed', 'a', aEnd), event(4, 'turn.completed', 'b', bEnd)] : []),
      { seq: 5, type: 'lifecycle', message: 'cezar restarted — harness run re-queued', ts: resumedAt },
      { seq: 6, type: 'lifecycle', message: 'run started', ts: resumedAt },
    ], { stepNames })
    expect(thread.turns.at(-1)?.sessionKey).toBe('b')
    expect(liveTurnStart({ ...run, startedAt: resumedAt }, thread)).toBe(resumedAt)
  })

  it.each(['restart', 'stepped note'])('does not fall back to a mid-council message after %s', (gap) => {
    const thread = reduceThread([
      ...started,
      { seq: 3, type: 'user-message', text: 'Also check tests', queued: true, ts: bStart },
      event(4, 'turn.completed', 'a', aEnd),
      event(5, 'turn.completed', 'b', bEnd),
      ...(gap === 'restart' ? [
        { seq: 6, type: 'lifecycle', message: 'cezar restarted — harness run re-queued', ts: resumedAt },
        { seq: 7, type: 'lifecycle', message: 'run started', ts: resumedAt },
      ] : [{ seq: 6, type: 'note', stepId: 'fix', message: 'Skills installed', ts: resumedAt }]),
    ], { stepNames })
    expect(thread.turns.at(-1)?.userMessage?.text).toBe('Also check tests')
    expect(liveTurnStart(gap === 'restart' ? { ...run, startedAt: resumedAt } : run, thread)).toBe(
      gap === 'restart' ? resumedAt : aEnd,
    )
  })

  it.each(['turn.completed', 'session.ended'])('uses the later unfiltered %s end when recovery predates it', (type) => {
    const thread = reduceThread([
      ...started,
      { seq: 3, type: 'user-message', text: 'Also check tests', queued: true, ts: bStart },
      { ...event(4, type, 'a', aEnd), reason: 'error' },
      { ...event(5, type, 'b', bEnd), reason: 'error' },
      { seq: 6, type: 'note', stepId: 'fix', message: 'Preparing next phase', ts: aEnd },
    ], { stepNames })
    expect(liveTurnStart({ ...run, startedAt: bEnd }, thread)).toBe(aEnd)
  })

  it('guard: Continue after a closed council keeps its message clock even before the run restart', () => {
    const messageAt = '2026-09-23T10:59:00.000Z'
    const thread = reduceThread([
      ...started, event(3, 'turn.completed', 'a', aEnd), event(4, 'turn.completed', 'b', bEnd),
      { seq: 5, type: 'user-message', text: 'Continue', ts: messageAt },
      { seq: 6, type: 'lifecycle', message: 'Harness resumed', ts: resumedAt },
      { seq: 7, type: 'note', stepId: 'review', message: 'Reusing durable ledger', ts: resumedAt },
    ], { stepNames })
    expect(liveTurnStart({ ...run, startedAt: resumedAt }, thread)).toBe(messageAt)
  })

  it('guard: keeps the message clock when no old reviewer has a timestamped end', () => {
    const thread = reduceThread([
      ...started,
      { seq: 3, type: 'user-message', text: 'Continue', ts: bEnd },
      { seq: 4, type: 'lifecycle', message: 'Harness resumed', ts: resumedAt },
    ], { stepNames })
    expect(liveTurnStart({ ...run, startedAt: resumedAt }, thread)).toBe(bEnd)
  })

  it('guard: without a run start, keyed peers retain their existing clocks', () => {
    const thread = reduceThread([
      ...started,
      { seq: 3, type: 'user-message', text: 'Also check tests', queued: true, ts: bStart },
      event(4, 'turn.completed', 'a', aEnd), event(5, 'turn.completed', 'b', bEnd),
      { seq: 6, type: 'lifecycle', message: 'Harness resumed', ts: resumedAt },
    ], { stepNames })
    expect(liveTurnStart({} as ApiRun, thread)).toBe(aEnd)
    expect(liveTurnStart({} as ApiRun, reduceThread(started))).toBe(aStart)
  })

  it('guard: a pending ordinary message and a stepped note keep the latest-turn rule after restart', () => {
    const thread = reduceThread([
      { seq: 1, type: 'turn.started', turnId: 'ordinary', ts: aStart },
      { seq: 2, type: 'user-message', text: 'Continue', ts: bStart },
      { seq: 3, type: 'note', stepId: 'fix', message: 'Preparing', ts: resumedAt },
      { seq: 4, type: 'lifecycle', message: 'run started', ts: resumedAt },
    ])
    expect(liveTurnStart({ ...run, startedAt: resumedAt }, thread)).toBe(bStart)
  })
})
