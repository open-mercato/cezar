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
          className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase"
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
function PlanIcon({ status, settled = false }: { status: PlanStatus; settled?: boolean }) {
  if (status === 'cancelled') {
    return (
      <svg
        aria-hidden
        className="size-[15px] shrink-0 text-soft-foreground/70"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="8.5" opacity=".5" />
        <path d="m8.5 15.5 7-7" />
      </svg>
    )
  }
  if (status === 'completed') {
    return (
      <svg
        aria-hidden
        className="size-[15px] shrink-0 text-success"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" opacity=".35" />
        <path d="m8.5 12.2 2.4 2.4 4.6-5" />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <svg
        aria-hidden
        // A frozen snapshot doesn't pulse — the animation is a live-run signal (audit A2).
        className={cn('size-[15px] shrink-0', !settled && 'animate-pulse motion-reduce:animate-none')}
        viewBox="0 0 24 24"
        fill="none"
      >
        {/* stroke/fill-pending, not text-*: amber is a dot & spinner color only (guardian rule). */}
        <circle className="stroke-pending" cx="12" cy="12" r="8.5" strokeWidth="2" />
        <path className="fill-pending" d="M12 3.5 A8.5 8.5 0 0 1 12 20.5 Z" />
      </svg>
    )
  }
  return (
    <svg
      aria-hidden
      className="size-[15px] shrink-0 text-soft-foreground"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="8.5" />
    </svg>
  )
}
