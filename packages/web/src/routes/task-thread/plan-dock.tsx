import { CircleCheckIcon, CircleIcon, CircleSlashIcon, LoaderCircleIcon } from 'lucide-react'

import type { PlanEntry, PlanStatus } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'

/**
 * The plan/todo checklist (spec §"Task thread", issue #382): the agent's latest `plan.updated`
 * snapshot as a checkbox list — ✓ strikethrough / ◐ pulsing "in progress" / ○ pending /
 * ⊘ cancelled. It is NOT rendered in the thread (the plan-kind tool cards are hidden there);
 * its home is the Plan popover on the thread context bar (see thread-context-bar.tsx).
 */

/** The "N/M" odometer math: completed entries over all entries the agent still
 *  intends to do. `cancelled` entries leave the denominator — they are work that
 *  was dropped on purpose, so counting them would strand the odometer below N/N
 *  for the rest of the run. They stay in the list (struck through), just not in
 *  the score. */
export function planCounts(entries: PlanEntry[]): { done: number; total: number } {
  return {
    done: entries.filter((entry) => entry.status === 'completed').length,
    total: entries.filter((entry) => entry.status !== 'cancelled').length,
  }
}

/** What the collapsed head names: the in-progress entry, else the next pending one. A fully
 *  completed plan has no current item — the odometer alone says it all. (`cancelled` is
 *  neither, so it is never named as the current item.) */
export function planActiveEntry(entries: PlanEntry[]): PlanEntry | undefined {
  return entries.find((entry) => entry.status === 'in_progress') ?? entries.find((entry) => entry.status === 'pending')
}

/**
 * `settled` (audit A2): once the run is no longer producing output, the agent's last plan
 * snapshot is frozen, not live. A snapshot that still held an `in_progress` entry when the run
 * ended would otherwise pulse and read in the present tense ("Summarizing…") forever. When
 * settled the dock drops the present-tense current line and stops the in-progress entry pulsing
 * and claiming activity — the odometer and the struck-through completions tell the real story.
 */
/** The checklist itself — the Plan popover's body. Owns no open state; the context-bar chip
 *  drives visibility. `settled` freezes the live styling once the run stops (audit A2). */
export function PlanList({ entries, settled = false }: { entries: PlanEntry[]; settled?: boolean }) {
  return (
    <ul data-slot="plan-list" className="flex flex-col gap-[7px]">
      {entries.map((entry, index) => (
        <PlanRow key={`${index}:${entry.content}`} entry={entry} settled={settled} />
      ))}
    </ul>
  )
}

function PlanRow({ entry, settled = false }: { entry: PlanEntry; settled?: boolean }) {
  return (
    <li
      data-slot="plan-item"
      data-status={entry.status}
      className={cn(
        'flex min-h-5 min-w-0 items-center gap-2.5 text-[13px]',
        entry.status === 'completed' && 'text-soft-foreground line-through',
        entry.status === 'in_progress' && 'font-medium',
        entry.status === 'pending' && 'text-muted-foreground',
        // Struck through like a done row, but faded further: abandoned, not achieved.
        entry.status === 'cancelled' && 'text-soft-foreground/70 line-through',
      )}
    >
      <PlanIcon status={entry.status} settled={settled} />
      <span className="min-w-0 truncate">{entry.content}</span>
      {/* The present-tense tag is a live-run signal — a frozen snapshot must not keep claiming it. */}
      {entry.status === 'in_progress' && !settled ? (
        <span
          data-slot="plan-tag"
          className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold tracking-[0.05em] text-muted-foreground uppercase"
        >
          in progress
        </span>
      ) : null}
    </li>
  )
}

/** The mockup's three checkbox glyphs, verbatim paths: ✓ in a faint circle / a pulsing
 *  half-filled ◐ / an empty ○ — plus a ⊘ for `cancelled`, which the mockup predates.
 *  Inline because lucide has no half-filled circle. */
// The SAME lucide glyph set the workflow rail uses (step-rail.tsx RailIcon) — one done-check
// everywhere, no hand-drawn variants. Plan statuses map onto the rail's done/active/pending set,
// with `cancelled` as a slashed circle.
function PlanIcon({ status, settled = false }: { status: PlanStatus; settled?: boolean }) {
  const base = 'size-[15px] shrink-0'
  if (status === 'completed') {
    return <CircleCheckIcon aria-hidden className={cn(base, 'text-success')} />
  }
  if (status === 'in_progress') {
    return (
      <LoaderCircleIcon
        role="status"
        aria-label="In progress"
        // stroke-pending, not text-*: amber is a dot & spinner color only (guardian rule).
        // A frozen snapshot doesn't spin — the animation is a live-run signal (audit A2).
        className={cn(base, 'stroke-pending', !settled && 'animate-spin motion-reduce:animate-none')}
      />
    )
  }
  if (status === 'cancelled') {
    return <CircleSlashIcon aria-hidden className={cn(base, 'text-soft-foreground/70')} />
  }
  return <CircleIcon aria-hidden className={cn(base, 'text-soft-foreground')} />
}
