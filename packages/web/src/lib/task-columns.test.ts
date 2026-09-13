import { describe, expect, it } from 'vitest'

import {
  isColumnExpanded,
  normalizeExpandedColumns,
  TASK_COLUMNS,
  taskColumnsForCapabilities,
  toggleExpandedColumn,
} from './task-columns'

describe('TASK_COLUMNS', () => {
  it('keeps a stable order with Status and Task fixed first', () => {
    expect(TASK_COLUMNS.map((column) => column.id)).toEqual([
      'status',
      'task',
      'workflow',
      'branch',
      'diff',
      'reference',
      'tokens',
      'cost',
      'cpu',
      'memory',
      'started',
    ])
    expect(TASK_COLUMNS.slice(0, 2).map((column) => column.canFold)).toEqual([false, false])
  })

  it('folds only Branch by default', () => {
    const normalized = normalizeExpandedColumns(undefined)
    expect(
      Object.fromEntries(TASK_COLUMNS.map((column) => [column.id, isColumnExpanded(column.id, normalized)])),
    ).toEqual({
      status: true,
      task: true,
      workflow: true,
      branch: false,
      diff: true,
      reference: true,
      tokens: true,
      cost: true,
      cpu: true,
      memory: true,
      started: true,
    })
  })

  it('uses stored foldable overrides but ignores Status, Task, unknown ids, and malformed values', () => {
    const normalized = normalizeExpandedColumns({
      workflow: false,
      branch: true,
      status: false,
      task: false,
      future: false,
      cpu: 'no',
    })
    expect(normalized).toEqual({ workflow: false, branch: true })
    expect(isColumnExpanded('status', normalized)).toBe(true)
    expect(isColumnExpanded('task', normalized)).toBe(true)
    expect(isColumnExpanded('workflow', normalized)).toBe(false)
    expect(isColumnExpanded('branch', normalized)).toBe(true)
    expect(isColumnExpanded('cpu', normalized)).toBe(true)
    expect(normalizeExpandedColumns(null)).toEqual({})
    expect(normalizeExpandedColumns([])).toEqual({})
  })

  it('toggles immutably, preserves valid future ids, and refuses fixed columns', () => {
    const raw = { branch: false, future: true, malformed: 'drop-me' }
    const next = toggleExpandedColumn(raw, 'branch')
    expect(next).toEqual({ branch: true, future: true })
    expect(raw).toEqual({ branch: false, future: true, malformed: 'drop-me' })
    expect(toggleExpandedColumn(raw, 'status')).toEqual({ branch: false, future: true })
  })

  it('removes capability-hidden metrics without changing the saved registry', () => {
    expect(taskColumnsForCapabilities({ tokens: false, cost: true }).map((column) => column.id)).toEqual([
      'status',
      'task',
      'workflow',
      'branch',
      'diff',
      'reference',
      'cost',
      'cpu',
      'memory',
      'started',
    ])
    expect(TASK_COLUMNS.map((column) => column.id)).toContain('tokens')
  })
})
