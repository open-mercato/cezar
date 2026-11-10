import { describe, expect, it } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'

import { stepTaskRing, taskRing } from './task-ring'
import { taskSwitchFromEvent } from './use-task-switch-shortcut'

function run(id: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    title: id,
    workflow: 'quick-task',
    task: id,
    status: 'done',
    createdAt: '2026-10-21T08:00:00Z',
    finishedAt: '2026-10-21T08:05:00Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...extra,
  }
}

const RUNS = [
  run('done-old', { finishedAt: '2026-10-21T07:00:00Z' }),
  run('waiting', { status: 'waiting' }),
  run('pinned-done', { pinned: true }),
  run('running', { status: 'running', finishedAt: undefined }),
  run('review', { status: 'review' }),
  run('archived', { status: 'waiting', archived: true }),
]

describe('taskRing', () => {
  it('is the sidebar order: pinned, needs you, working, recent — never archived', () => {
    expect(taskRing(RUNS, false)).toEqual(['pinned-done', 'waiting', 'review', 'running', 'done-old'])
  })

  it('with ⇧ keeps only the tasks that need you, pinned or not', () => {
    expect(taskRing([...RUNS, run('pinned-waiting', { pinned: true, status: 'waiting' })], true)).toEqual([
      'pinned-waiting',
      'waiting',
      'review',
    ])
  })
})

describe('stepTaskRing', () => {
  const ring = ['a', 'b', 'c']

  it('steps and wraps at both ends', () => {
    expect(stepTaskRing(ring, 'a', 'next')).toBe('b')
    expect(stepTaskRing(ring, 'c', 'next')).toBe('a')
    expect(stepTaskRing(ring, 'a', 'previous')).toBe('c')
  })

  it('off the ring, ↓ starts at the top and ↑ at the bottom', () => {
    expect(stepTaskRing(ring, undefined, 'next')).toBe('a')
    expect(stepTaskRing(ring, 'elsewhere', 'previous')).toBe('c')
  })

  it('has nowhere to go on an empty ring or alone on it', () => {
    expect(stepTaskRing([], undefined, 'next')).toBeNull()
    expect(stepTaskRing(['a'], 'a', 'next')).toBeNull()
    expect(stepTaskRing(['a'], undefined, 'next')).toBe('a')
  })
})

describe('taskSwitchFromEvent', () => {
  const key = (key: string, mods: Partial<KeyboardEvent> = {}) => ({
    key,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    ...mods,
  })

  it('reads ⌥↑/⌥↓ and the ⇧ ring', () => {
    expect(taskSwitchFromEvent(key('ArrowDown'))).toEqual({ direction: 'next', needsYouOnly: false })
    expect(taskSwitchFromEvent(key('ArrowUp', { shiftKey: true }))).toEqual({ direction: 'previous', needsYouOnly: true })
  })

  it('ignores other chords, horizontal arrows and auto-repeat', () => {
    expect(taskSwitchFromEvent(key('ArrowDown', { altKey: false }))).toBeNull()
    expect(taskSwitchFromEvent(key('ArrowDown', { metaKey: true }))).toBeNull()
    expect(taskSwitchFromEvent(key('ArrowLeft'))).toBeNull()
    expect(taskSwitchFromEvent(key('ArrowDown', { repeat: true }))).toBeNull()
  })
})
