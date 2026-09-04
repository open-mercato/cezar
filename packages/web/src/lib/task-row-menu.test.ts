import { describe, expect, it } from 'vitest'

import type { RunRecord, RunStatus } from '@open-mercato/cezar-api-client'

import { taskRowMenuItems, type TaskRowAction } from './task-row-menu'

const run = (status: RunStatus, extra: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1',
  title: 'Do the thing',
  workflow: 'quick-task',
  task: 'Do the thing',
  status,
  createdAt: '2026-08-24T12:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...extra,
})

/** A run that finished at a known instant — the shape the read/unread half of the menu needs. */
const finished = (extra: Partial<RunRecord> = {}): RunRecord =>
  run('done', { finishedAt: '2026-08-24T13:00:00.000Z', ...extra })

const actionsOf = (record: RunRecord): TaskRowAction[] =>
  taskRowMenuItems(record).map((item) => item.action)

describe('taskRowMenuItems', () => {
  const cases: Array<{ name: string; record: RunRecord; expected: TaskRowAction[] }> = [
    // Finished and already read: everything a terminal row offers.
    {
      name: 'a read, finished run',
      record: finished({ seenAt: '2026-08-24T13:05:00.000Z' }),
      expected: ['rename', 'mark-unread', 'archive', 'delete'],
    },
    // The inverse receipt, which is the pairing the run header does not have.
    {
      name: 'an unread, finished run offers Mark read instead',
      record: finished(),
      expected: ['rename', 'mark-read', 'archive', 'delete'],
    },
    // Archiving is a stronger "done with this" than reading, so neither receipt action applies.
    {
      name: 'an archived run offers Unarchive and no read action',
      record: finished({ archived: true, seenAt: '2026-08-24T13:05:00.000Z' }),
      expected: ['rename', 'unarchive', 'delete'],
    },
    // Active runs: the engine still owns them, so Cancel replaces Delete and nothing is filed.
    {
      name: 'a running run',
      record: run('running'),
      expected: ['rename', 'cancel'],
    },
    {
      name: 'a queued run',
      record: run('queued'),
      expected: ['rename', 'cancel'],
    },
    {
      name: 'a waiting run',
      record: run('waiting'),
      expected: ['rename', 'cancel'],
    },
    // `review` is deliberately not active (run-actions.ts) — a parked review files like any
    // finished run. It has not FINISHED, though, so it carries no receipt either.
    {
      name: 'a run parked at the review gate',
      record: run('review'),
      expected: ['rename', 'archive', 'delete'],
    },
    // Cancelled is never unread: you stopped it yourself, so there is nothing you missed.
    {
      name: 'a cancelled run',
      record: run('cancelled', { finishedAt: '2026-08-24T13:00:00.000Z' }),
      expected: ['rename', 'archive', 'delete'],
    },
    // A usage-limit failure with a resume booked is not a done item at all — no receipt actions.
    {
      name: 'a failed run with a resume already scheduled',
      record: run('failed', {
        finishedAt: '2026-08-24T13:00:00.000Z',
        autoResumeAt: '2026-08-24T18:00:00.000Z',
      }),
      expected: ['rename', 'archive', 'delete'],
    },
  ]

  for (const { name, record, expected } of cases) {
    it(`offers ${expected.join(', ')} for ${name}`, () => {
      expect(actionsOf(record)).toEqual(expected)
    })
  }

  it('always offers Rename first — the one action every run can take', () => {
    const statuses: RunStatus[] = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']
    for (const status of statuses) {
      expect(taskRowMenuItems(run(status))[0]).toMatchObject({ action: 'rename', startsGroup: false })
    }
  })

  it('labels the archive by what the record already is', () => {
    const live = taskRowMenuItems(finished()).find((item) => item.action === 'archive')
    const filed = taskRowMenuItems(finished({ archived: true })).find((item) => item.action === 'unarchive')
    expect(live?.label).toBe('Archive')
    expect(filed?.label).toBe('Unarchive')
  })

  it('marks exactly Cancel and Delete destructive', () => {
    const destructive = (record: RunRecord) =>
      taskRowMenuItems(record)
        .filter((item) => item.destructive)
        .map((item) => item.action)
    expect(destructive(run('running'))).toEqual(['cancel'])
    expect(destructive(finished())).toEqual(['delete'])
  })

  it('never opens two groups in a row — the separator has something above it', () => {
    // The archive is the first item of its group only when no read action took that slot; a row
    // with both would otherwise paint a rule between Mark read and Archive, which belong together.
    expect(taskRowMenuItems(finished()).map((item) => item.startsGroup)).toEqual([
      false, // rename
      true, // mark-read — opens the "file it away" group
      false, // archive — same group
      true, // delete — opens the destructive group
    ])
    expect(taskRowMenuItems(run('review')).map((item) => item.startsGroup)).toEqual([
      false, // rename
      true, // archive — no read action here, so it opens the group itself
      true, // delete
    ])
  })
})
