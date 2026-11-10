import { beforeEach, describe, expect, it } from 'vitest'

import { orderByRecency, readRecentTasks, RECENT_TASKS_CAP, recordTaskVisit, resetRecentTasks } from './recent-tasks'

beforeEach(() => {
  localStorage.clear()
  resetRecentTasks()
})

describe('recent tasks', () => {
  it('records newest first, without duplicates, and survives a reload', () => {
    recordTaskVisit('a')
    recordTaskVisit('b')
    recordTaskVisit('a')
    expect(readRecentTasks()).toEqual(['a', 'b'])
    resetRecentTasks()
    expect(readRecentTasks()).toEqual(['a', 'b'])
  })

  it('is capped', () => {
    for (let index = 0; index < RECENT_TASKS_CAP + 5; index += 1) recordTaskVisit(`t${index}`)
    expect(readRecentTasks()).toHaveLength(RECENT_TASKS_CAP)
  })

  it('a corrupt entry reads as empty instead of throwing', () => {
    localStorage.setItem('cezar:recent-tasks:v1', '{nope')
    expect(readRecentTasks()).toEqual([])
  })

  it('orderByRecency leads with visited items in recency order and keeps the rest in place', () => {
    const items = ['a', 'b', 'c', 'd']
    expect(orderByRecency(items, (item) => item, ['c', 'a'])).toEqual(['c', 'a', 'b', 'd'])
  })
})
