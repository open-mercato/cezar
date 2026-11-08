import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ApiRun, RunEvent } from '@open-mercato/cezar-api-client'
import { mergeRunHistoryEvents } from '@/api/run-history'
import { readRunHistoryPage } from '../../../../cezar/src/runs/event-history'

import { buildTranscriptRows, mainTranscriptSections } from './session-transcript'
import { reduceThread } from './thread-state'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('explicit phase-queued messages', () => {
  it.each(['stepless note', 'restart lifecycle', 'next-phase note'])(
    'keeps a flagged message separate across every prepended history window with a %s', async (gap) => {
      const events: RunEvent[] = []
      const push = (type: string, rest: Record<string, unknown> = {}) => {
        const seq = events.length + 1
        events.push({ seq, ts: new Date(Date.UTC(2026, 8, 23, 10, 0, seq)).toISOString(), type, ...rest })
      }
      push('turn.started', { stepId: 'review', sessionKey: 'a', turnId: 'review' })
      for (let index = 0; index < 60; index += 1) {
        if (index === 55) {
          push('user-message', { text: 'Also check tests', queued: true })
          push('harness.message.queued')
        }
        push('item.completed', { stepId: 'review', sessionKey: 'a',
          item: { kind: 'message', id: `review-${index}`, role: 'assistant', text: `Finding ${index}` } })
      }
      push('turn.completed', { stepId: 'review', sessionKey: 'a', turnId: 'review' })
      push('harness.phase.updated', { stepId: 'review', phase: { id: 'review', status: 'done' } })
      push(gap === 'restart lifecycle' ? 'lifecycle' : 'note', {
        message: gap === 'restart lifecycle' ? 'cezar restarted — harness run re-queued' : 'Applying operator feedback',
        ...(gap === 'next-phase note' ? { stepId: 'fix-2' } : {}),
      })
      push('harness.phase.updated', { stepId: 'fix-2', phase: { id: 'fix-2', status: 'running' } })
      push('turn.started', { stepId: 'fix-2', turnId: 'fix' })
      for (let index = 0; index < 99; index += 1) push('item.completed', { stepId: 'fix-2',
        item: { kind: 'message', id: `fix-${index}`, role: 'assistant', text: `Fix ${index}` } })
      push('turn.completed', { stepId: 'fix-2', turnId: 'fix' })
      const stepNames = new Map([['review', 'Review'], ['fix-2', 'Fixes']])
      const rows = (thread: ReturnType<typeof reduceThread>) => buildTranscriptRows(mainTranscriptSections({ task: '' } as ApiRun, thread), 'run')
      const full = reduceThread(events, { stepNames, atHistoryStart: true })
      const expected = full.turns.find((turn) => turn.turnId === 'fix')!
      const start = events.find((line) => line.type === 'turn.started' && line.stepId === 'fix-2')!
      expect(expected.id).toBe(`turn-seq-${start.seq}`)
      expect(expected.startedAt).toBe(start.ts)
      expect(expected.userMessage).toBeUndefined()
      const expectedRows = rows(full).filter((row) => row.scope === expected.id)
      const dir = mkdtempSync(join(tmpdir(), 'cez-queued-page-'))
      dirs.push(dir)
      const file = join(dir, 'run.ndjson')
      writeFileSync(file, events.map((line) => JSON.stringify(line)).join('\n') + '\n')
      let page = await readRunHistoryPage(file)
      expect(page.events[0]?.type).toBe('user-message')
      expect(page.events.some((line) => line.sessionKey !== undefined)).toBe(false)
      let window = page.events
      let windows = 0
      for (;;) {
        windows += 1
        const thread = reduceThread(window, { stepNames, atHistoryStart: !page.hasOlder })
        expect(thread.turns.find((turn) => turn.turnId === 'fix'), `paged window ${windows}`).toEqual(expected)
        expect(rows(thread).filter((row) => row.scope === expected.id)).toEqual(expectedRows)
        if (!page.olderCursor) break
        page = await readRunHistoryPage(file, page.olderCursor)
        window = mergeRunHistoryEvents(page.events, window)
      }
      expect(windows).toBeGreaterThan(1)
      // Include every prepend boundary through the message.
      const messageIndex = events.findIndex((line) => line.type === 'user-message')
      for (let cut = 0; cut <= messageIndex; cut += 1) {
        const thread = reduceThread(events.slice(cut), { stepNames, atHistoryStart: cut === 0 })
        expect(thread.turns.find((turn) => turn.turnId === 'fix'), `suffix ${cut}`).toEqual(expected)
        expect(rows(thread).filter((row) => row.scope === expected.id)).toEqual(expectedRows)
      }
    },
  )

  it('keeps a message queued during a sequential phase out of the next phase clock', () => {
    const ts = (seq: number) => new Date(Date.UTC(2026, 8, 23, 10, 0, seq)).toISOString()
    const thread = reduceThread([
      { seq: 1, ts: ts(1), type: 'turn.started', stepId: 'implement', turnId: 'implement' },
      { seq: 2, ts: ts(2), type: 'user-message', text: 'Also check tests', queued: true },
      { seq: 3, ts: ts(3), type: 'turn.completed', stepId: 'implement', turnId: 'implement' },
      { seq: 4, ts: ts(4), type: 'turn.started', stepId: 'fix', turnId: 'fix' },
    ], { stepNames: new Map([['implement', 'Implement'], ['fix', 'Fix']]) })
    expect(thread.turns.at(-1)).toMatchObject({ id: 'turn-seq-4', startedAt: ts(4), turnId: 'fix' })
    expect(thread.turns[1]?.turnId).toBeUndefined()
    expect(thread.turns[1]).not.toHaveProperty('queuedForPhase')
  })

  it.each([undefined, 'fix'])('guard: an unflagged Continue reply still adopts with phase %s', (stepId) => {
    const ts = '2026-09-23T10:00:00.000Z'
    const thread = reduceThread([
      { seq: 1, ts, type: 'user-message', text: 'Continue', ...(stepId ? { stepId } : {}) },
      { seq: 2, ts, type: 'harness.message.queued' },
      { seq: 3, ts, type: 'turn.started', stepId: 'fix', turnId: 'fix' },
    ], { stepNames: new Map([['fix', 'Fix']]) })
    expect(thread.turns).toHaveLength(1)
    expect(thread.turns[0]).toMatchObject({ id: 'turn-seq-1', turnId: 'fix', userMessage: { text: 'Continue' } })
  })

  it('guard: unflagged mid-council messages retain the legacy inference', () => {
    const ts = '2026-09-23T10:00:00.000Z'
    const thread = reduceThread([
      { seq: 1, ts, type: 'user-message', text: 'Also check tests' },
      { seq: 2, ts, type: 'turn.completed', sessionKey: 'a', stepId: 'review', turnId: 'review' },
      { seq: 3, ts, type: 'turn.started', stepId: 'fix', turnId: 'fix' },
    ], { stepNames: new Map([['review', 'Review'], ['fix', 'Fix']]) })
    expect(thread.turns.find((turn) => turn.turnId === 'fix')).toMatchObject({ id: 'turn-seq-3' })
    expect(thread.turns[0]?.turnId).toBeUndefined()
  })

  it.each([false, true])('guard: ordinary messages ignore the queued flag (%s)', (queued) => {
    const ts = '2026-09-23T10:00:00.000Z'
    const events: RunEvent[] = [
      { seq: 1, ts, type: 'user-message', text: 'Follow up', stepId: 'old' },
      { seq: 2, ts, type: 'turn.completed', sessionKey: 'a', stepId: 'review', turnId: 'review' },
      { seq: 3, ts, type: 'turn.started', stepId: 'next', turnId: 'next' },
    ]
    const expected = reduceThread(events)
    const thread = reduceThread(events.map((line) => line.type === 'user-message' ? { ...line, queued } : line))
    expect(thread).toEqual(expected)
    expect(thread.turns[0]).toMatchObject({ id: 'turn-seq-1', turnId: 'next', userMessage: { text: 'Follow up' } })
  })
})

describe('council history row stability', () => {
  it.each([
    ['keeps the next phase identity without council notes', false],
    ['guard: keeps the next phase identity with council notes', true],
  ])('%s across every prepended history window', async (_name, driverNotes) => {
    const events: RunEvent[] = []
    const push = (type: string, rest: Record<string, unknown> = {}) => {
      const seq = events.length + 1
      events.push({ seq, ts: new Date(Date.UTC(2026, 8, 23, 10, 0, seq)).toISOString(), type, ...rest })
    }
    const phase = (stepId: string, status = 'running') => push('harness.phase.updated', { stepId, phase: { id: stepId, status } })
    phase('review')
    for (const sessionKey of ['a', 'b']) push('turn.started', { stepId: 'review', sessionKey, turnId: 'turn_1' })
    for (let index = 0; index < 160; index += 1) {
      if (index === 50) push('user-message', { text: 'Also check tests' })
      if (index === 70 && driverNotes) push('note', { stepId: 'review', origin: 'driver', message: 'Still reviewing' })
      push('item.completed', { stepId: 'review', sessionKey: index % 2 === 0 ? 'a' : 'b',
        item: { kind: 'message', id: `review-${index}`, role: 'assistant', text: `Finding ${index}` } })
    }
    for (const sessionKey of ['a', 'b']) push('turn.completed', { stepId: 'review', sessionKey, turnId: 'turn_1' })
    phase('review', 'done')
    if (driverNotes) push('note', { stepId: 'review', origin: 'driver', message: 'Council found blocking issues' })
    phase('fix-2')
    push('session.started', { stepId: 'fix-2', backend: 'claude' })
    push('turn.started', { stepId: 'fix-2', turnId: 'fix-turn' })
    for (let index = 0; index < 125; index += 1) push('item.completed', { stepId: 'fix-2',
      item: { kind: 'message', id: `fix-${index}`, role: 'assistant', text: `Fix ${index}` } })
    push('turn.completed', { stepId: 'fix-2', turnId: 'fix-turn' })
    const stepNames = new Map([['review', 'Review'], ['fix-2', 'Fixes']])
    const reduce = (lines: RunEvent[], hasOlder: boolean) => reduceThread(lines, { stepNames, atHistoryStart: !hasOlder })
    const full = reduce(events, false)
    const expected = full.turns.find((turn) => turn.turnId === 'fix-turn')!
    const phaseStart = events.find((event) => event.type === 'turn.started' && event.stepId === 'fix-2')!
    expect(expected.userMessage).toBeUndefined()
    expect(expected.id).toBe(`turn-seq-${phaseStart.seq}`)
    expect(expected.startedAt).toBe(phaseStart.ts)
    const rows = (thread: ReturnType<typeof reduceThread>) => buildTranscriptRows(mainTranscriptSections({ task: '' } as ApiRun, thread), 'run')
    const expectedRows = rows(full)
    const dir = mkdtempSync(join(tmpdir(), 'cez-phase-page-'))
    dirs.push(dir)
    const file = join(dir, 'run.ndjson')
    writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    let page = await readRunHistoryPage(file)
    let window = page.events
    let windows = 0
    for (;;) {
      windows += 1
      const thread = reduce(window, page.hasOlder)
      const actual = thread.turns.find((turn) => turn.turnId === 'fix-turn')!
      expect({ id: actual.id, startedAt: actual.startedAt, userMessage: actual.userMessage }).toEqual({
        id: expected.id, startedAt: expected.startedAt, userMessage: undefined,
      })
      const visible = new Set(window.filter((event) => event.stepId === 'fix-2' && event.type === 'item.completed')
        .map((event) => (event.item as { id: string }).id))
      const visibleNotes = new Set(window.filter((event) => event.type === 'note' && event.stepId === 'review').map((event) => `v1:${event.seq}`))
      const visibleHeadings = new Set(window.filter((event) => event.type === 'harness.phase.updated' && event.stepId === 'fix-2').map((event) => `step-start:${event.seq}`))
      const phaseRows = (entries: typeof expectedRows) => entries.filter((row) => row.content.kind === 'block' &&
        row.content.block.kind === 'entry' && (visible.has(row.content.block.entry.id) || visibleNotes.has(row.content.block.entry.id) ||
          visibleHeadings.has(row.content.block.entry.id))).map((row) => row.key)
      expect(phaseRows(rows(thread))).toEqual(phaseRows(expectedRows))
      const phaseTimes = (entries: typeof expectedRows) => entries.filter((row) => row.content.kind === 'turn-time' && row.scope === expected.id)
      expect(phaseTimes(rows(thread))).toEqual(phaseTimes(expectedRows))
      const bubble = rows(thread).findIndex((row) => row.content.kind === 'user-message')
      if (bubble !== -1) {
        const fixRow = rows(thread).findIndex((row) => row.content.kind === 'block' && row.content.block.kind === 'entry' && row.content.block.entry.id === 'fix-0')
        expect(bubble).toBeLessThan(fixRow)
      }
      if (!page.olderCursor) break
      page = await readRunHistoryPage(file, page.olderCursor)
      window = mergeRunHistoryEvents(page.events, window)
    }
    expect(windows).toBeGreaterThan(2)
  })

  // Without later council activity, Continue keeps the reply and phase together.
  it.each<[string, string | undefined, boolean]>([
    ['adopts a Continue reply with an unset phase', undefined, true],
    ['adopts a Continue reply with a matching phase', 'fix-2', true],
    ['guard: keeps a Continue reply separate from a different phase', 'review', false],
  ])('%s', (_name, stepId, adopted) => {
    const ts = '2026-09-23T10:00:00.000Z'
    const thread = reduceThread([
      { seq: 1, ts, type: 'user-message', text: 'Continue' },
      { seq: 2, ts, type: 'harness.message.queued' },
      ...(stepId ? [{ seq: 3, ts, type: 'note', stepId, message: 'Preparing' }] : []),
      { seq: 4, ts, type: 'turn.started', stepId: 'fix-2', turnId: 'next' },
    ], { stepNames: new Map([['fix-2', 'Fixes']]) })
    expect(thread.turns).toHaveLength(adopted ? 1 : 2)
    expect(thread.turns[0]).toMatchObject({ id: 'turn-seq-1', startedAt: ts, userMessage: { text: 'Continue' } })
    expect(thread.turns[0]?.turnId).toBe(adopted ? 'next' : undefined)
    expect(thread.turns.at(-1)).toMatchObject({ id: adopted ? 'turn-seq-1' : 'turn-seq-4', turnId: 'next', stepId: 'fix-2', startedAt: ts })
    const rows = buildTranscriptRows(mainTranscriptSections({ task: '' } as ApiRun, thread), 'run')
    expect(rows[0]?.content.kind).toBe('user-message')
    expect(rows.map((row) => row.key)).toEqual([
      'turn-seq-1:user',
      ...(stepId ? ['turn-seq-1:v1:3'] : []),
      ...(!adopted ? ['turn-seq-1:step-start:4'] : []),
    ])
  })

  describe.each<[string, string | undefined]>([
    ['an unset', undefined],
    ['a matching', 'fix-2'],
  ])('mid-council message with %s phase', (_name, stepId) => {
    it.each<[string, Record<string, unknown>]>([
      ['reviewer output', { type: 'item.completed', item: { kind: 'message', id: 'review', role: 'assistant', text: 'Finding' } }],
      ['a reviewer delta', { type: 'item.delta', itemId: 'review', field: 'text', delta: ' more' }],
      ['a reviewer completion', { type: 'turn.completed', turnId: 'review' }],
      ['a reviewer nudge', { type: 'note', message: 'Still reviewing' }],
      ['a session closure', { type: 'session.ended', reason: 'end_turn' }],
      ['a session start', { type: 'session.started', backend: 'claude' }],
      ['an ignored event', { type: 'harness.invocation.updated' }],
      ['a malformed item', { type: 'item.completed', item: { kind: 'message' } }],
    ])('keeps the message separate after %s without a stepped driver note', (_activity, activity) => {
      const at = (seq: number, type: string, rest: Record<string, unknown> = {}): RunEvent => ({
        seq, ts: new Date(Date.UTC(2026, 8, 23, 10, 0, seq)).toISOString(), type, ...rest,
      })
      const events = [
        at(1, 'turn.started', { stepId: 'review', sessionKey: 'a', turnId: 'review' }),
        at(2, 'item.started', { stepId: 'review', sessionKey: 'a', item: { kind: 'message', id: 'review', role: 'assistant', text: 'Reviewing' } }),
        at(3, 'user-message', { text: 'Also check tests', ...(stepId !== undefined ? { stepId } : {}) }),
        at(4, 'harness.message.queued'),
        at(5, 'note', { stepId: 'review', sessionKey: 'a', ...activity }),
        at(6, 'turn.started', { stepId: 'fix-2', turnId: 'next' }),
        at(7, 'item.completed', { stepId: 'fix-2', item: { kind: 'message', id: 'fix', role: 'assistant', text: 'Fixed' } }),
        at(8, 'turn.completed', { stepId: 'fix-2', turnId: 'next' }),
      ]
      const options = { stepNames: new Map([['review', 'Review'], ['fix-2', 'Fixes']]) }
      const thread = reduceThread(events, options)
      const message = thread.turns.find((turn) => turn.userMessage !== undefined)!
      const phase = thread.turns.find((turn) => turn.turnId === 'next')!
      expect(message.turnId).toBeUndefined()
      expect(phase).toMatchObject({ id: 'turn-seq-6', stepId: 'fix-2', startedAt: events[5]!.ts, completed: { ts: events[7]!.ts } })
      expect(phase.userMessage).toBeUndefined()
      expect(message.startedAt).toBe(events[2]!.ts)
      const rows = buildTranscriptRows(mainTranscriptSections({ task: '' } as ApiRun, thread), 'run')
      expect(rows.filter((row) => row.scope === phase.id).map((row) => row.key)).toEqual(['turn-seq-6:fix', 'turn-seq-6:turn-time'])
      expect(reduceThread(JSON.parse(JSON.stringify(events)) as RunEvent[], options)).toEqual(thread)
    })
  })

  it('adopts a fresh Continue reply after an earlier mid-council message', () => {
    const ts = '2026-09-23T10:00:00.000Z'
    const thread = reduceThread([
      { seq: 1, ts, type: 'turn.started', sessionKey: 'a', stepId: 'review', turnId: 'review' },
      { seq: 2, ts, type: 'user-message', text: 'Also check tests' },
      { seq: 3, ts, type: 'turn.completed', sessionKey: 'a', stepId: 'review', turnId: 'review' },
      { seq: 4, ts, type: 'user-message', text: 'Continue' },
      { seq: 5, ts, type: 'harness.feedback.applied', stepId: 'fix-2' },
      { seq: 6, ts, type: 'turn.started', stepId: 'fix-2', turnId: 'next' },
    ], { stepNames: new Map([['review', 'Review'], ['fix-2', 'Fixes']]) })
    expect(thread.turns).toHaveLength(3)
    expect(thread.turns[1]?.turnId).toBeUndefined()
    expect(thread.turns[2]).toMatchObject({ id: 'turn-seq-4', userMessage: { text: 'Continue' }, turnId: 'next' })
  })

  it('guard: ordinary messages still adopt after keyed activity with a different phase', () => {
    const ts = '2026-09-23T10:00:00.000Z'
    const thread = reduceThread([
      { seq: 1, ts, type: 'turn.started', stepId: 'review', sessionKey: 'a', turnId: 'review' },
      { seq: 2, ts, type: 'user-message', stepId: 'old-step', text: 'Continue' },
      { seq: 3, ts, type: 'turn.completed', stepId: 'review', sessionKey: 'a', turnId: 'review' },
      { seq: 4, ts, type: 'turn.started', stepId: 'next-step', turnId: 'next' },
    ])
    expect(thread.turns[1]).toEqual({
      id: 'turn-seq-2', stepId: 'old-step', turnId: 'next', startedAt: ts,
      userMessage: { text: 'Continue', imageCount: 0, images: [], ts }, items: [],
    })
  })

  it('guard: harness lazy commentary still attaches before any council exists', () => {
    const thread = reduceThread([
      { seq: 1, type: 'note', stepId: 'fix-2', message: 'Preparing', ts: '2026-09-23T09:59:00.000Z' },
      { seq: 2, type: 'turn.started', stepId: 'fix-2', turnId: 'next', ts: '2026-09-23T10:00:00.000Z' },
    ], { stepNames: new Map([['fix-2', 'Fixes']]) })
    expect(thread.turns).toHaveLength(1)
    expect(thread.turns[0]).toMatchObject({ id: 'turn-fallback-1', turnId: 'next', stepId: 'fix-2', startedAt: '2026-09-23T10:00:00.000Z' })
  })

  const at = (seq: number, type: string, rest: Record<string, unknown> = {}): RunEvent => ({
    seq, type, ts: '2026-09-23T10:00:00.000Z', stepId: 'fix-2', ...rest,
  })
  const note = { message: 'Preparing' }
  const item = { item: { kind: 'message', id: 'answer', role: 'assistant', text: 'Working' } }
  it.each<[string, RunEvent[], string | undefined, string]>([
    ['no current turn', [], undefined, 'turn-seq-10'],
    ['a turn already started', [at(1, 'turn.started', { turnId: 'old' })], undefined, 'turn-seq-10'],
    ['a v2-covered lazy turn', [at(1, 'item.completed', item)], undefined, 'turn-seq-10'],
    ['a keyed current turn', [at(1, 'turn.started', { sessionKey: 'a', turnId: 'old' })], undefined, 'turn-seq-10'],
    ['council commentary', [at(1, 'turn.started', { sessionKey: 'a', turnId: 'old' }), at(2, 'note', note)], undefined, 'turn-seq-10'],
    ['a keyed lazy turn', [at(1, 'note', { ...note, sessionKey: 'a' })], 'a', 'turn-seq-1'],
    ['a keyed turn already started', [at(1, 'turn.started', { sessionKey: 'a', turnId: 'old' })], 'a', 'turn-seq-10'],
    ['a keyed v2-covered turn', [at(1, 'item.completed', { ...item, sessionKey: 'a' })], 'a', 'turn-seq-10'],
    ['a closed keyed lazy turn', [at(1, 'note', { ...note, sessionKey: 'a' }), at(2, 'session.ended', { sessionKey: 'a', reason: 'error' })], 'a', 'turn-seq-10'],
  ])('guard: retains turn.started routing after %s', (_name, before, sessionKey, id) => {
    const thread = reduceThread([
      ...before,
      at(10, 'turn.started', { turnId: 'next', ...(sessionKey !== undefined ? { sessionKey } : {}) }),
    ], { stepNames: new Map([['fix-2', 'Fixes']]) })
    expect(thread.turns.at(-1)).toMatchObject({ id, turnId: 'next', stepId: 'fix-2', startedAt: '2026-09-23T10:00:00.000Z' })
  })

  it('guard: ordinary phases still attach to their message even when its step differs', () => {
    const ts = '2026-09-23T10:00:00.000Z'
    const thread = reduceThread([
      { seq: 1, ts, type: 'user-message', text: 'Continue' },
      { seq: 2, ts, type: 'note', stepId: 'old-step', message: 'Preparing' },
      { seq: 3, ts, type: 'turn.started', stepId: 'next-step', turnId: 'next' },
      { seq: 4, ts, type: 'item.completed', stepId: 'next-step', item: { kind: 'message', id: 'answer', role: 'assistant', text: 'Working' } },
    ])
    expect(thread).toEqual({ turns: [{
      id: 'turn-seq-1', stepId: 'old-step', turnId: 'next', startedAt: ts,
      userMessage: { text: 'Continue', imageCount: 0, images: [], ts },
      items: [
        { kind: 'note', id: 'v1:2', text: 'Preparing', tone: 'dim' },
        { kind: 'message', id: 'answer', role: 'assistant', text: 'Working' },
      ],
    }], lastEventAt: ts })
  })

  it.each(['newest', 'forward'])('keeps reviewer row keys and order after Load earlier from the %s page', async (direction) => {
    const ts = '2026-09-23T10:00:00.000Z'
    const events: RunEvent[] = [
      { seq: 1, ts, type: 'turn.started', stepId: 'review', sessionKey: 'a', turnId: 'turn_1' },
      { seq: 2, ts, type: 'item.completed', stepId: 'review', sessionKey: 'a', item: { kind: 'message', id: 'a-intro', role: 'assistant', text: 'Starting review' } },
      { seq: 3, ts, type: 'turn.started', stepId: 'review', sessionKey: 'b', turnId: 'turn_1' },
      { seq: 4, ts, type: 'user-message', text: 'Please also review the tests' },
      ...Array.from({ length: 151 }, (_, index) => ({
        seq: index + 5, ts, type: 'item.completed', stepId: 'review', sessionKey: index % 2 === 0 ? 'a' : 'b',
        item: { kind: 'message', id: `answer-${index}`, role: 'assistant', text: `Review ${index}` },
      })),
    ]
    const dir = mkdtempSync(join(tmpdir(), 'cez-council-page-'))
    dirs.push(dir)
    const file = join(dir, 'run.ndjson')
    writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    const newest = await readRunHistoryPage(file)
    expect(newest.hasOlder).toBe(true)
    const older = await readRunHistoryPage(file, newest.olderCursor)
    const page = direction === 'newest' ? newest : await readRunHistoryPage(file, older.newerCursor)
    const visibleItems = new Set(page.events.filter((event) => event.type === 'item.completed').map((event) => (event.item as { id: string }).id))
    const rowKeys = (lines: RunEvent[]) => buildTranscriptRows(mainTranscriptSections(
      { task: '' } as ApiRun, reduceThread(lines),
    ), 'run').flatMap((row) =>
      row.content.kind === 'block' && row.content.block.kind === 'entry' && row.content.block.entry.kind === 'message' && visibleItems.has(row.content.block.entry.id)
        ? [row.key] : [],
    )
    const before = rowKeys(page.events)
    const after = rowKeys(mergeRunHistoryEvents(older.events, page.events))
    expect(visibleItems.size).toBeGreaterThan(0)
    expect(before).toHaveLength(visibleItems.size)
    expect(before).toEqual(after)
    expect(reduceThread(page.events).turns.filter((turn) => turn.sessionKey !== undefined).map((turn) => [turn.id, turn.sessionKey])).toEqual([
      ['turn-seq-1', 'a'], ['turn-seq-3', 'b'],
    ])
  })
})
