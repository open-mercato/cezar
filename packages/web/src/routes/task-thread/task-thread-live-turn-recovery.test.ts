import { describe, expect, it } from 'vitest'

import type { ApiRun, RunEvent } from '@open-mercato/cezar-api-client'

import { buildTranscriptRows, mainTranscriptSections } from './session-transcript'
import { liveTurnStart } from './task-thread'
import { reduceThread } from './thread-state'

const ts = (seconds: number) => new Date(Date.UTC(2026, 9, 27, 8) + seconds * 1000).toISOString()
const harnessRun = { task: '', startedAt: ts(0), harness: { profile: 'multi', workflow: 'harness-fix-issue' } } as ApiRun
const stepNames = new Map([['review', 'Review'], ['implement', 'Implement'], ['stage', 'Stage']])
const lines = (events: Array<Omit<RunEvent, 'seq'>>) => events.map((event, index) => ({ ...event, seq: index + 1 }) as RunEvent)
const reviewer = (key: string, seconds: number, type = 'turn.started') =>
  ({ type, stepId: 'review', sessionKey: key, turnId: 'turn_1', ts: ts(seconds) })
const queuedMessage = (seconds: number) => ({ type: 'user-message', text: 'Also check tests', queued: true, ts: ts(seconds) })
const restart = { type: 'lifecycle', message: 'cezar restarted — harness run re-queued', ts: ts(3590) }
const execute = { type: 'lifecycle', message: 'run started', ts: ts(3600) }
const sequential = { type: 'turn.started', stepId: 'implement', turnId: 'turn_1', ts: ts(10) }
const sequentialEnd = { ...sequential, type: 'turn.completed', ts: ts(30) }
const op = (seconds: number, status: string) => ({ type: 'harness.phase.updated', stepId: 'stage', phase: { id: 'stage', status }, ts: ts(seconds) })

const recoveryCases = [
  { name: 'restartMsgOpen', before: [reviewer('a', 10), reviewer('b', 20), queuedMessage(25)], oldClock: ts(10) },
  { name: 'restartMsgOneDone', before: [reviewer('a', 10), reviewer('b', 20), reviewer('a', 22, 'turn.completed'), queuedMessage(25)], oldClock: ts(20) },
  { name: 'restartMsgQueued', before: [reviewer('a', 10), reviewer('b', 20), { ...restart, ts: ts(3560) }, queuedMessage(3580)], oldClock: ts(10) },
  { name: 'restart mid-sequential phase', before: [sequential], oldClock: ts(10) },
  { name: 'Continue without text after sequential phase and stage op', before: [sequential, sequentialEnd, op(40, 'running'), op(41, 'done')], oldClock: ts(30) },
]

describe('harness restart clock floor', () => {
  it.each(recoveryCases)('bounds $name through every recovery prefix', ({ name, before }) => {
    const startedAt = name.startsWith('Continue') ? ts(86400) : ts(3600)
    const events = lines([
      ...before,
      { ...restart, ts: name.startsWith('Continue') ? ts(86399) : restart.ts },
      { ...execute, ts: startedAt },
      { type: 'note', stepId: name.includes('sequential') ? 'implement' : 'review', message: 'Reusing durable ledger', ts: startedAt },
      op(name.startsWith('Continue') ? 86410 : 3610, 'running'),
      op(name.startsWith('Continue') ? 86411 : 3611, 'done'),
    ])
    const run = { ...harnessRun, startedAt }
    for (let end = before.length + 2; end <= events.length; end += 1) {
      const thread = reduceThread(events.slice(0, end), { stepNames })
      expect(liveTurnStart(run, thread), `recovery prefix ${end}`).toBe(startedAt)
    }
  })

  it('retains explicit queue intent on a harness message', () => {
    const thread = reduceThread(lines([queuedMessage(25)]), { stepNames })
    expect(thread.turns[0]?.queued).toBe(true)
  })

  it.each(['open council', 'closed council', 'sequential', 'pending reply'])('guard: keeps a Continue reply just before execute for %s', (kind) => {
    const replyAt = ts(3600 - 0.001)
    const before = kind === 'open council' ? [reviewer('a', 10), reviewer('b', 20)]
      : kind === 'closed council' ? [reviewer('a', 10), reviewer('a', 30, 'turn.completed')]
        : [sequential, sequentialEnd]
    const events = lines([
      ...before,
      { type: 'user-message', text: 'Continue', ts: replyAt },
      { type: 'harness.message.queued', ts: replyAt },
      execute,
      ...(kind === 'sequential' ? [{ ...sequential, ts: ts(3601), turnId: 'resumed' }] : []),
    ])
    const thread = reduceThread(events, { stepNames })
    expect(liveTurnStart({ ...harnessRun, startedAt: ts(3600) }, thread)).toBe(replyAt)
  })

  it.each(recoveryCases)('guard: keeps $name unchanged without run.startedAt', ({ before, oldClock }) => {
    const thread = reduceThread(lines([...before, restart, execute]), { stepNames })
    expect(liveTurnStart({ ...harnessRun, startedAt: undefined }, thread)).toBe(oldClock)
  })

  it('guard: a harness with no run start and no turn timestamps keeps an absent clock', () => {
    for (const events of [[], lines([{ type: 'session.error', sessionKey: 'a', message: 'Retrying' }])]) {
      expect(liveTurnStart({ ...harnessRun, startedAt: undefined }, reduceThread(events, { stepNames }))).toBeUndefined()
    }
  })

  it('guard: queue intent leaves transcript row keys and rendered sections unchanged', () => {
    const events = lines([reviewer('a', 10), queuedMessage(25), restart, execute])
    const flagged = reduceThread(events, { stepNames })
    const unflagged = reduceThread(events.map(({ queued: _queued, ...event }) => event), { stepNames })
    const sections = mainTranscriptSections(harnessRun, flagged)
    expect(sections).toEqual(mainTranscriptSections(harnessRun, unflagged))
    expect(buildTranscriptRows(sections, 'run')).toEqual(buildTranscriptRows(mainTranscriptSections(harnessRun, unflagged), 'run'))
  })

  it.each([
    ['empty thread', []],
    ['unstamped turn', [{ type: 'turn.started' }]],
    ['pending message', [sequential, { type: 'user-message', text: 'Follow up', ts: ts(20) }]],
    ['follow-up turn', [sequential, sequentialEnd, { type: 'user-message', text: 'Continue', ts: ts(40) }, { ...sequential, turnId: 'next', ts: ts(41) }]],
    ['restart with open turn', [sequential, restart, execute]],
    ['restart with completed turn', [sequential, sequentialEnd, restart, execute]],
    ['session end without completion', [sequential, { type: 'session.ended', ts: ts(30), reason: 'error' }]],
    ['completion without timestamp', [sequential, { ...sequentialEnd, ts: undefined }]],
  ] satisfies Array<[string, Array<Omit<RunEvent, 'seq'>>]>)('guard: ordinary %s keeps the original latest-turn clock and reduction', (_name, input) => {
    const events = lines(input)
    for (const startedAt of [ts(0), ts(3600), undefined]) {
      for (let end = 0; end <= events.length; end += 1) {
        const window = events.slice(0, end)
        const thread = reduceThread(window)
        const run = { task: '', startedAt } as ApiRun
        const last = thread.turns.at(-1)
        const expected = last === undefined ? startedAt
          : last.completed === undefined ? last.startedAt ?? startedAt : last.completed.ts ?? startedAt
        expect(liveTurnStart(run, thread)).toBe(expected)
        expect(reduceThread(window.map((event) => event.type === 'user-message' ? { ...event, queued: true } : event))).toEqual(thread)
      }
    }
  })

  it.each([
    ['no turns', []],
    ['unstamped council', [{ type: 'session.error', sessionKey: 'a', stepId: 'review', message: 'Retrying' }]],
    ['current open council', [reviewer('a', 3601), reviewer('b', 3602)]],
    ['current closed council', [reviewer('a', 3601), reviewer('a', 3602, 'turn.completed')]],
    ['current sequential turn', [{ ...sequential, ts: ts(3601) }]],
    ['current sequential completion', [{ ...sequential, ts: ts(3601) }, { ...sequentialEnd, ts: ts(3602) }]],
  ] satisfies Array<[string, Array<Omit<RunEvent, 'seq'>>]>)('guard: retains the existing fallback for %s', (name, input) => {
    const thread = reduceThread(lines(input), { stepNames })
    const expected = name.includes('closed') || name.includes('completion') ? ts(3602)
      : name.includes('current') ? ts(3601) : ts(3600)
    expect(liveTurnStart({ ...harnessRun, startedAt: ts(3600) }, thread)).toBe(expected)
  })

  it('guard: harness clocks never move backward across consecutive seeded transcript prefixes', () => {
    let seed = 925
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 0x100000000
    }
    for (let sample = 0; sample < 100; sample += 1) {
      const events: RunEvent[] = []
      let seconds = 0
      let startedAt = ts(0)
      let previous = -Infinity
      const push = (event: Omit<RunEvent, 'seq' | 'ts'>) => {
        seconds += 1
        events.push({ ...event, seq: events.length + 1, ts: ts(seconds) } as RunEvent)
        const clock = liveTurnStart({ ...harnessRun, startedAt }, reduceThread(events, { stepNames, atHistoryStart: true }))
        const current = Date.parse(clock!)
        expect(current, `sample ${sample}, prefix ${events.length}, ${event.type}`).toBeGreaterThanOrEqual(previous)
        previous = current
      }
      const recover = () => {
        push({ type: 'lifecycle', message: 'cezar restarted — harness run re-queued' })
        if (random() < 0.5) push({ type: 'user-message', text: 'Queued during recovery', queued: true })
        seconds += 3600
        startedAt = ts(seconds)
        push({ type: 'lifecycle', message: 'run started' })
      }
      push({ type: 'lifecycle', message: 'run started' })
      for (let round = 0; round < 4; round += 1) {
        let turnId = `implement-${round}`
        push({ type: 'harness.phase.updated', stepId: 'implement', phase: { id: 'implement', status: 'running' } })
        push({ type: 'turn.started', stepId: 'implement', turnId })
        if (random() < 0.5) {
          recover()
          turnId = `replacement-${round}`
          push({ type: 'turn.started', stepId: 'implement', turnId })
        }
        push({ type: 'turn.completed', stepId: 'implement', turnId })
        push({ type: 'harness.phase.updated', stepId: 'review', phase: { id: 'review', status: 'running' } })
        let keys = [`a-${round}`, `b-${round}`]
        for (const sessionKey of keys) push({ type: 'turn.started', stepId: 'review', sessionKey, turnId: 'turn_1' })
        if (random() < 0.5) push({ type: 'turn.completed', stepId: 'review', sessionKey: keys[0], turnId: 'turn_1' })
        push({ type: 'user-message', text: 'Check the tests', ...(random() < 0.8 ? { queued: true } : {}) })
        if (random() < 0.5) {
          recover()
          keys = keys.map((key) => `${key}-replacement`)
          for (const sessionKey of keys) push({ type: 'turn.started', stepId: 'review', sessionKey, turnId: 'turn_1' })
        }
        push({ type: 'note', stepId: 'review', message: 'Council in progress' })
        for (const sessionKey of keys) {
          push({ type: 'turn.completed', stepId: 'review', sessionKey, turnId: 'turn_1' })
          push({ type: 'session.ended', stepId: 'review', sessionKey, reason: 'end_turn' })
        }
        push({ type: 'harness.phase.updated', stepId: 'stage', phase: { id: 'stage', status: 'running' } })
        if (random() < 0.5) {
          push({ type: 'user-message', text: 'Continue reply' })
          push({ type: 'harness.message.queued' })
        }
        seconds += 86400
        startedAt = ts(seconds)
        push({ type: 'lifecycle', message: 'run started after Continue' })
      }
    }
  })
})
