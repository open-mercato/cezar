import type { RunRecord } from '@open-mercato/cezar-api-client'

import { automationIdOf, matchesOrigin, type TaskOrigin } from '@/lib/task-origin'
import { workflowLabel } from '@/lib/tasks-table'

/**
 * The per-project Tasks table's filters — the pure half, tested as a table like
 * `lib/global-tasks.ts`, whose grammar it follows: every facet is a SET, values inside one facet
 * are ORed, facets are ANDed, and an empty set means "no opinion".
 *
 * The facets differ from the global page's on purpose. Inside one project there are no tags and
 * no projects to pick between, but there ARE automations worth telling apart ("what did the
 * nightly triage start?"), and the origin split decides whether those rows show at all.
 *
 * Session-local, like the search box: only the origin is remembered (`lib/task-origin.ts`).
 */

export type TaskFacetId = 'statuses' | 'workflows' | 'automations'

export interface TaskTableFilters {
  /** `RunStatus` values as plain strings, so a newer server's status passes through. */
  statuses: readonly string[]
  /** Workflow LABELS as the table prints them — `quick-task`, `claude`, a chain's name. */
  workflows: readonly string[]
  /** Automation ids. Only meaningful while the origin admits automation tasks. */
  automations: readonly string[]
}

export const NO_TASK_FILTERS: TaskTableFilters = { statuses: [], workflows: [], automations: [] }

export function activeTaskFacetCount(filters: TaskTableFilters): number {
  return filters.statuses.length + filters.workflows.length + filters.automations.length
}

/** Each run's automation, resolved once per list — a dispatched child answers with its root's. */
export function automationIndex(runs: readonly RunRecord[]): Map<string, string | undefined> {
  const byId = new Map(runs.map((run) => [run.id, run]))
  return new Map(runs.map((run) => [run.id, automationIdOf(run, (id) => byId.get(id))]))
}

const matchesFacet = (selected: readonly string[], value: string | undefined): boolean =>
  selected.length === 0 || (value !== undefined && selected.includes(value))

/**
 * The runs an origin and a set of facets leave. Order is preserved; the Active/Archived split and
 * the sort stay `sortRuns`'s job, and the search `filterRuns`'s.
 *
 * The automation facet is ignored under `regular` — a person's tasks have no automation to match,
 * so a selection left over from the Automations view must not quietly empty the list.
 */
export function filterTaskTable(
  runs: readonly RunRecord[],
  origin: TaskOrigin,
  filters: TaskTableFilters,
  automations: ReadonlyMap<string, string | undefined>,
): RunRecord[] {
  return runs.filter((run) => {
    const automationId = automations.get(run.id)
    if (!matchesOrigin(automationId, origin)) return false
    if (!matchesFacet(filters.statuses, run.status)) return false
    if (!matchesFacet(filters.workflows, workflowLabel(run))) return false
    if (origin !== 'regular' && !matchesFacet(filters.automations, automationId)) return false
    return true
  })
}

/** The origin split alone — what the sidebar's quick-lists apply, so the remembered Regular |
 *  Automations | All choice reads the same in the sidebar as in the tables. */
export function filterRunsByOrigin(runs: readonly RunRecord[], origin: TaskOrigin): RunRecord[] {
  return origin === 'all' ? [...runs] : filterTaskTable(runs, origin, NO_TASK_FILTERS, automationIndex(runs))
}

/** How many rows each value of a facet would leave, counted against the list as every OTHER
 *  facet narrows it — so unticking a value promises exactly the rows it gives back. */
export function taskFacetCounts(
  runs: readonly RunRecord[],
  origin: TaskOrigin,
  filters: TaskTableFilters,
  automations: ReadonlyMap<string, string | undefined>,
  facet: TaskFacetId,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const run of filterTaskTable(runs, origin, { ...filters, [facet]: [] }, automations)) {
    const value =
      facet === 'statuses' ? run.status : facet === 'workflows' ? workflowLabel(run) : automations.get(run.id)
    if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

/** How many rows each origin would show under the current facets — the Regular | Automations |
 *  All control's counts. The automation facet does not narrow Regular, so it is not applied to
 *  that count either. */
export function originCounts(
  runs: readonly RunRecord[],
  filters: TaskTableFilters,
  automations: ReadonlyMap<string, string | undefined>,
): Record<TaskOrigin, number> {
  return {
    regular: filterTaskTable(runs, 'regular', filters, automations).length,
    automation: filterTaskTable(runs, 'automation', filters, automations).length,
    all: filterTaskTable(runs, 'all', filters, automations).length,
  }
}

/** Distinct values of one field across the list, sorted — a facet's options are what is actually
 *  there, never a catalog of things that can only produce an empty table. */
export function distinctValues(values: Iterable<string | undefined>): string[] {
  const seen = new Set<string>()
  for (const value of values) if (value !== undefined) seen.add(value)
  return [...seen].sort((a, b) => a.localeCompare(b))
}
