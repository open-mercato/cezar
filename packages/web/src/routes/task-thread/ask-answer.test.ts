import { describe, expect, it } from 'vitest'

import type { RunRecord, RunStatus, StepState } from '@open-mercato/cezar-api-client'

import { askDeliveryMode } from './ask-answer'

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

const run = (status: RunStatus, extra: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1',
  title: 'Do the thing',
  workflow: 'quick-task',
  task: 'Do the thing',
  status,
  createdAt: '2026-07-24T12:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [step({ sessionId: 'sess-1' })],
  ...extra,
})

describe('askDeliveryMode — where an ask answer goes, per run status', () => {
  // The engine still owns the run: the answer rides the live reply seam, exactly as the
  // ask card has always done. `queued` is here because the ladder in POST /messages folds
  // a message into a not-yet-started prompt — an ask can't reach that state, but routing
  // it anywhere else would be a lie about what the endpoint does.
  it.each(['queued', 'running', 'waiting'] as const)('%s → live', (status) => {
    expect(askDeliveryMode(run(status))).toBe('live')
  })

  // The session ended with the question still on the table (idle timeout, restart, Finish,
  // cancel). The answer reopens it instead of hitting `409 session closed`.
  it.each(['review', 'done', 'failed', 'cancelled'] as const)('%s with a session → resume', (status) => {
    expect(askDeliveryMode(run(status))).toBe('resume')
  })

  // Nothing to reopen: the card must say so rather than offer chips that cannot deliver.
  it.each(['review', 'done', 'failed', 'cancelled'] as const)(
    '%s without a recorded session → unavailable',
    (status) => {
      expect(askDeliveryMode(run(status, { steps: [step()] }))).toBe('unavailable')
    },
  )

  it('reads the LAST session across steps, so a multi-step run resumes its newest one', () => {
    const record = run('done', { steps: [step({ id: 'a' }), step({ id: 'b', sessionId: 'sess-2' })] })
    expect(askDeliveryMode(record)).toBe('resume')
  })

  it('an archived run is still answerable — archiving hides a run, it does not close the question', () => {
    expect(askDeliveryMode(run('done', { archived: true }))).toBe('resume')
  })
})
