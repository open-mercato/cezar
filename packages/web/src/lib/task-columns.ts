/** Stable ids persisted in `~/.cezar/ui-state.json`; never derive them from labels. */
export const TASK_COLUMN_IDS = [
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
] as const

export type TaskColumnId = (typeof TASK_COLUMN_IDS)[number]
export type TaskColumnIcon =
  | 'workflow'
  | 'branch'
  | 'diff'
  | 'reference'
  | 'tokens'
  | 'cost'
  | 'planLimit'
  | 'cpu'
  | 'memory'
  | 'started'

export interface TaskColumnDefinition {
  id: TaskColumnId
  label: string
  canFold: boolean
  defaultExpanded: boolean
  align: 'left' | 'right'
  /** Preferred expanded width. Task deliberately has none and receives the flexible remainder. */
  width?: string
  icon?: TaskColumnIcon
  capability?: 'tokens' | 'cost'
  /** One-line explanation behind an ⓘ beside the expanded header. */
  hint?: string
}

/**
 * The one ordered description of the desktop Tasks table. Header, colgroup, and every row consume
 * this list so capability-hidden and folded columns cannot drift structurally.
 */
export const TASK_COLUMNS = [
  // A dot, or a dot and a short word: 116px is "needs review" in its pill plus the cell's padding
  // (measured in Inter 500/12px), the widest of the common open labels — narrower clips it.
  { id: 'status', label: 'Status', canFold: false, defaultExpanded: true, align: 'left', width: '116px' },
  { id: 'task', label: 'Task', canFold: false, defaultExpanded: true, align: 'left' },
  {
    id: 'workflow',
    label: 'Workflow',
    canFold: true,
    defaultExpanded: true,
    align: 'left',
    width: '124px',
    icon: 'workflow',
  },
  {
    id: 'branch',
    label: 'Branch',
    canFold: true,
    defaultExpanded: false,
    align: 'left',
    width: '128px',
    icon: 'branch',
  },
  { id: 'diff', label: '±', canFold: true, defaultExpanded: true, align: 'left', width: '78px', icon: 'diff' },
  {
    id: 'reference',
    label: 'Ref',
    canFold: true,
    defaultExpanded: true,
    align: 'left',
    width: '76px',
    icon: 'reference',
  },
  {
    id: 'tokens',
    label: 'IN / OUT',
    canFold: true,
    defaultExpanded: true,
    align: 'right',
    width: '112px',
    icon: 'tokens',
    capability: 'tokens',
  },
  {
    id: 'cost',
    label: 'Cost',
    canFold: true,
    defaultExpanded: true,
    align: 'right',
    width: '76px',
    icon: 'cost',
    capability: 'cost',
  },
  // Optional (plan-usage design, screen 4): folded until chosen, and only then is the ledger asked.
  {
    id: 'planLimit',
    label: 'Plan limit',
    canFold: true,
    defaultExpanded: false,
    align: 'right',
    width: '144px',
    icon: 'planLimit',
    hint: "Each task's estimated share of its Claude or Codex account's 5-hour limit. Providers report usage per account, so busy periods are split by each task's cost.",
  },
  { id: 'cpu', label: 'CPU', canFold: true, defaultExpanded: true, align: 'right', width: '68px', icon: 'cpu' },
  {
    id: 'memory',
    label: 'Mem',
    canFold: true,
    // Expanded, as on main: a stored choice only exists for columns a user toggled, so flipping
    // the default would fold Mem for every existing user too.
    defaultExpanded: true,

    align: 'right',
    width: '88px',
    icon: 'memory',
  },
  {
    id: 'started',
    label: 'Started',
    canFold: true,
    defaultExpanded: true,
    align: 'right',
    width: '82px',
    icon: 'started',
  },
] as const satisfies readonly TaskColumnDefinition[]

export type NormalizedExpandedColumns = Partial<Record<TaskColumnId, boolean>>

const TASK_COLUMN_BY_ID = new Map<TaskColumnId, TaskColumnDefinition>(
  TASK_COLUMNS.map((column) => [column.id, column]),
)

function booleanEntries(raw: unknown): Record<string, boolean> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
  )
}

/** Rendering reads known, foldable booleans only; malformed user-edited state acts as absent. */
export function normalizeExpandedColumns(raw: unknown): NormalizedExpandedColumns {
  const normalized: NormalizedExpandedColumns = {}
  for (const [id, expanded] of Object.entries(booleanEntries(raw))) {
    const column = TASK_COLUMN_BY_ID.get(id as TaskColumnId)
    if (column?.canFold) normalized[column.id] = expanded
  }
  return normalized
}

/** Status and Task are immutable even if a user manually writes false for either id. */
export function isColumnExpanded(
  id: TaskColumnId,
  normalized: NormalizedExpandedColumns,
): boolean {
  const column = TASK_COLUMN_BY_ID.get(id)
  if (!column) return true
  if (!column.canFold) return true
  return normalized[id] ?? column.defaultExpanded
}

/**
 * Compose one toggle from the raw cache value. Valid unknown ids survive for forward
 * compatibility; malformed values are omitted so this bounded map can pass the PUT contract.
 */
export function toggleExpandedColumn(raw: unknown, id: TaskColumnId): Record<string, boolean> {
  const current = booleanEntries(raw)
  const column = TASK_COLUMN_BY_ID.get(id)
  if (!column?.canFold) return current
  return {
    ...current,
    [id]: !isColumnExpanded(id, normalizeExpandedColumns(raw)),
  }
}

/** A folded column's width in the colgroup. */
export const FOLDED_COLUMN_WIDTH_PX = 42
/** The controls (checkbox) column's width in the colgroup. */
export const CONTROLS_COLUMN_WIDTH_PX = 36
/** The Task column's floor for a root row; `taskCellMinWidth` in tasks-table.ts adds the indent. */
export const TASK_COLUMN_MIN_PX = 220

/** The narrowest the fixed-layout table may get before the Task column would drop under its floor. */
export function tableMinWidth(
  columns: readonly TaskColumnDefinition[],
  normalized: NormalizedExpandedColumns,
  controls: boolean,
): number {
  let total = (controls ? CONTROLS_COLUMN_WIDTH_PX : 0) + TASK_COLUMN_MIN_PX
  for (const column of columns) {
    if (column.width === undefined) continue
    total += isColumnExpanded(column.id, normalized) ? Number.parseFloat(column.width) : FOLDED_COLUMN_WIDTH_PX
  }
  return total
}

export function taskColumnsForCapabilities(capabilities: {
  tokens: boolean
  cost: boolean
}): readonly TaskColumnDefinition[] {
  return TASK_COLUMNS.filter((column: TaskColumnDefinition) => {
    return column.capability === undefined || capabilities[column.capability]
  })
}
