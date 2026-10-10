import { afterEach, describe, expect, it } from 'vitest'

import {
  automationIdOf,
  DEFAULT_TASK_ORIGIN,
  matchesOrigin,
  normalizeTaskOrigin,
  readStoredTaskOrigin,
  TASK_ORIGIN_STORAGE_KEY,
  writeStoredTaskOrigin,
  type OriginInput,
} from './task-origin'

const byId = (runs: OriginInput[]) => {
  const map = new Map(runs.map((run) => [run.id, run]))
  return (id: string) => map.get(id)
}

describe('automationIdOf', () => {
  it('reads every provenance key a run can carry', () => {
    const none = byId([])
    expect(automationIdOf({ id: 'a', automationId: 'idx' }, none)).toBe('idx')
    expect(automationIdOf({ id: 'a', automation: { automationId: 'gh' } }, none)).toBe('gh')
    expect(automationIdOf({ id: 'a', automationTrigger: { automationId: 'cron' } }, none)).toBe('cron')
    expect(automationIdOf({ id: 'a', automationTracker: { automationId: 'jira' } }, none)).toBe('jira')
    expect(automationIdOf({ id: 'a' }, none)).toBeUndefined()
  })

  it('files a dispatched child under its root’s automation', () => {
    const root: OriginInput = { id: 'root', automationTrigger: { automationId: 'nightly' } }
    const child: OriginInput = { id: 'child', dispatch: { rootRunId: 'root' } }
    expect(automationIdOf(child, byId([root, child]))).toBe('nightly')
  })

  it('leaves a child regular when its root is a person’s task, or not in the list', () => {
    const root: OriginInput = { id: 'root' }
    const child: OriginInput = { id: 'child', dispatch: { rootRunId: 'root' } }
    expect(automationIdOf(child, byId([root, child]))).toBeUndefined()
    expect(automationIdOf(child, byId([child]))).toBeUndefined()
  })
})

describe('matchesOrigin', () => {
  it('splits regular from automation, and All admits both', () => {
    expect(matchesOrigin(undefined, 'regular')).toBe(true)
    expect(matchesOrigin('a1', 'regular')).toBe(false)
    expect(matchesOrigin('a1', 'automation')).toBe(true)
    expect(matchesOrigin(undefined, 'automation')).toBe(false)
    expect(matchesOrigin(undefined, 'all')).toBe(true)
    expect(matchesOrigin('a1', 'all')).toBe(true)
  })
})

describe('the remembered origin', () => {
  afterEach(() => localStorage.clear())

  it('defaults to Regular — automation tasks are hidden until asked for', () => {
    expect(DEFAULT_TASK_ORIGIN).toBe('regular')
    expect(readStoredTaskOrigin()).toBe('regular')
  })

  it('round-trips through localStorage', () => {
    writeStoredTaskOrigin('automation')
    expect(localStorage.getItem(TASK_ORIGIN_STORAGE_KEY)).toBe('automation')
    expect(readStoredTaskOrigin()).toBe('automation')
  })

  it('reads a junk value as the default rather than as a filter nobody chose', () => {
    localStorage.setItem(TASK_ORIGIN_STORAGE_KEY, 'everything')
    expect(readStoredTaskOrigin()).toBe('regular')
    expect(normalizeTaskOrigin(null)).toBe('regular')
    expect(normalizeTaskOrigin('all')).toBe('all')
  })
})
