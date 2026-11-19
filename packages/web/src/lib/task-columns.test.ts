import { describe, expect, it } from 'vitest'

import {
  isColumnExpanded,
  normalizeExpandedColumns,
  tableMinWidth,
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
      'planLimit',
      'cpu',
      'memory',
      'started',
    ])
    expect(TASK_COLUMNS.slice(0, 2).map((column) => column.canFold)).toEqual([false, false])
  })

  it('folds only Branch and the optional Plan limit by default — Mem stays open, as existing users have it', () => {
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
      planLimit: false,
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
      'planLimit',
      'cpu',
      'memory',
      'started',
    ])
    expect(TASK_COLUMNS.map((column) => column.id)).toContain('tokens')
  })
})

describe('tableMinWidth', () => {
  // 116 status + 124 workflow + 42 folded branch + 78 diff + 76 ref + 112 tokens + 76 cost + 42 folded plan limit + 68 cpu + 88 mem + 82 started.
  const fixed = 904

  it('keeps the Task column its 220px floor beside every fixed column (iPad portrait gave it 0px)', () => {
    expect(tableMinWidth(TASK_COLUMNS, {}, false)).toBe(fixed + 220)
    expect(tableMinWidth(TASK_COLUMNS, {}, true)).toBe(fixed + 220 + 36)
  })

  it('shrinks with folded columns and the capability-hidden ones, so folding still narrows the table', () => {
    expect(tableMinWidth(TASK_COLUMNS, { workflow: false, memory: false }, false)).toBe(fixed + 220 - (124 - 42) - (88 - 42))
    expect(tableMinWidth(taskColumnsForCapabilities({ tokens: false, cost: false }), {}, false)).toBe(fixed + 220 - 112 - 76)
  })
})
