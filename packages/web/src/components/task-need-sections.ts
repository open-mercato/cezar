import * as React from 'react'
import type { RunRecord } from '@open-mercato/cezar-api-client'

import { isNeedsYouStatus, wantsAttention } from '@/lib/attention'
import { bucketOf, type QuickListBucket, type QuickListRow } from '@/lib/task-groups'

/**
 * The Tasks sidebar's sections: the same rows `groupRuns` already filtered, sorted and
 * variant-collapsed, re-filed by WHAT THE TASK NEEDS rather than by the three status buckets.
 *
 * No second classification lives here — every rule is one the status model already owns:
 *  - `wantsAttention` (`lib/attention.ts`) is the predicate notifications gate on: a permission
 *    prompt, an error, or a waiting/review gate. Review is split off into its own section, the
 *    rest is "Needs attention".
 *  - `bucketOf` (`lib/task-groups.ts`) says what is `Working`: running, queued, and a usage-limit
 *    failure with a resume already scheduled.
 */
export type NeedSectionId = 'pinned' | 'attention' | 'progress' | 'review' | 'other'

export interface NeedSection {
  id: NeedSectionId
  label: string
  rows: QuickListRow[]
}

/** Rendering order. `pinned` leads only when something is pinned (#935) — a pin is an explicit
 *  request for a row to stay on top, so it keeps the bucket it already had. */
const SECTION_ORDER: readonly NeedSectionId[] = ['pinned', 'attention', 'progress', 'review', 'other']

const SECTION_LABEL: Record<NeedSectionId, string> = {
  pinned: 'Pinned',
  attention: 'Needs attention',
  progress: 'In progress',
  review: 'Ready for review',
  other: 'Done / other',
}

/** Sections that start collapsed until the viewer says otherwise. */
const COLLAPSED_BY_DEFAULT: ReadonlySet<NeedSectionId> = new Set<NeedSectionId>(['other'])

/** Where one run files, ignoring its pin (the caller handles `Pinned` as a bucket). */
export function needSectionOf(run: RunRecord): FiledSection {
  if (run.status === 'review') return 'review'
  if (wantsAttention(run)) return 'attention'
  if (bucketOf({ ...run, pinned: false }, 'active') === 'Working') return 'progress'
  return 'other'
}

/** A collapsed variant tile files where its most demanding member does, so it moves as a unit —
 *  the same best-ranked-member rule `groupRuns` uses between buckets. */
function sectionOfRow(row: QuickListRow): FiledSection {
  if (row.kind === 'run') return needSectionOf(row.run)
  const ranks = row.members.map((member) => SECTION_ORDER.indexOf(needSectionOf(member)))
  return SECTION_ORDER[Math.min(...ranks)] as FiledSection
}

type FiledSection = Exclude<NeedSectionId, 'pinned'>

/**
 * Re-file bucketed rows into need sections. Order inside a section is the order the rows arrived
 * in (`sortRuns`: status weight, then most recent first). Empty sections are omitted.
 *
 * A DISPATCHED task files with the task that ordered it, so the pair still nests ("Just a test"
 * with its three reviewers underneath) instead of the reviewers scattering into another section
 * under titles — `Security`, `Tests` — that mean nothing without their parent. The one exception
 * is the rule the bucketed list already had: a child that is itself asking for you
 * (`isNeedsYouStatus` — waiting, in review, awaiting an answer) surfaces in its own right, because
 * tucking it under a parent in a section nobody is reading would hide the question.
 */
export function needSections(buckets: readonly QuickListBucket[]): NeedSection[] {
  const rows = buckets.flatMap((bucket) =>
    bucket.rows.map((row) => ({ row, pinned: bucket.label === 'Pinned' })),
  )
  // Where every run in view files on its own — a variant member answers with its tile's section.
  const own = new Map<string, NeedSectionId>()
  const parents = new Map<string, string>()
  for (const { row, pinned } of rows) {
    const section: NeedSectionId = pinned ? 'pinned' : sectionOfRow(row)
    for (const run of row.kind === 'run' ? [row.run] : row.members) {
      own.set(run.id, section)
      const parentId = run.dispatch?.parentRunId
      if (parentId !== undefined && parentId !== run.id) parents.set(run.id, parentId)
    }
  }
  /** The section of the topmost ancestor in view; the run's own when it has none. */
  const inherited = (runId: string): NeedSectionId | undefined => {
    const seen = new Set<string>()
    let cursor = runId
    for (;;) {
      seen.add(cursor)
      const parentId = parents.get(cursor)
      if (parentId === undefined || seen.has(parentId) || !own.has(parentId)) return own.get(cursor)
      cursor = parentId
    }
  }

  const bySection = new Map<NeedSectionId, QuickListRow[]>()
  for (const { row, pinned } of rows) {
    let id: NeedSectionId = pinned ? 'pinned' : sectionOfRow(row)
    if (!pinned && row.kind === 'run' && !isNeedsYouStatus(row.run)) {
      id = inherited(row.run.id) ?? id
    }
    const filed = bySection.get(id)
    if (filed) filed.push(row)
    else bySection.set(id, [row])
  }
  return SECTION_ORDER.filter((id) => bySection.has(id)).map((id) => ({
    id,
    label: SECTION_LABEL[id],
    rows: bySection.get(id) as QuickListRow[],
  }))
}

/** Does this section hold the given run — as a row, or inside a variant tile? */
export function sectionHasRun(section: NeedSection, runId: string | null): boolean {
  if (runId === null) return false
  return section.rows.some((row) =>
    row.kind === 'run' ? row.run.id === runId : row.members.some((member) => member.id === runId),
  )
}

const STORAGE_KEY = 'cezar:tasks-sidebar:sections'

type StoredSections = Partial<Record<NeedSectionId, boolean>>

function readStored(): StoredSections {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as StoredSections) : {}
  } catch {
    return {}
  }
}

/**
 * Which sections are open, remembered per browser. A per-viewer convenience and nothing more:
 * storage that is blocked, full or corrupt degrades to the defaults for this page load.
 *
 * `isOpen` takes a `fallback` for a section the viewer has never toggled, so the caller can keep
 * the open task's section visible even when that section starts collapsed.
 */
export function useSectionOpenState() {
  const [stored, setStored] = React.useState<StoredSections>(readStored)
  const isOpen = (id: NeedSectionId, holdsCurrent = false): boolean =>
    stored[id] ?? (holdsCurrent || !COLLAPSED_BY_DEFAULT.has(id))
  const setOpen = (id: NeedSectionId, open: boolean) =>
    setStored((current) => {
      const next = { ...current, [id]: open }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Private window / blocked storage: the choice still holds until the page reloads.
      }
      return next
    })
  return { isOpen, setOpen }
}
