import { ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'

import type { PlanEntry, PlanStatus } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'

/**
 * The plan/todo dock (spec §"Task thread", issue #382; mockup `.plan-dock`): the agent's
 * latest `plan.updated` snapshot, pinned above the composer area — NOT in the thread (the
 * plan-kind tool cards are hidden there; this is their surface). Collapsed it is a one-line
 * "Plan · N/M" odometer plus the current item; expanded it is the checkbox list with the
 * entry states (✓ strikethrough / ◐ pulsing "in progress" / ○ pending / ⊘ cancelled).
 *
 * The caller keys this component by run id, so the collapse default re-derives per task.
 */

/** Collapse memory per run id — a module-level map on purpose (the scroll-cache pattern):
 *  the choice survives route changes for the session without inventing server persistence. */
const openByRun = new Map<string, boolean>()

/** Desktop starts expanded, phones collapsed (the mockup's mobile reflow keeps only the
 *  odometer). jsdom has no matchMedia — that environment counts as desktop. */
function defaultOpen(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 768px)').matches
}

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

export function PlanDock({ runId, entries }: { runId: string; entries: PlanEntry[] }) {
  const [open, setOpen] = useState(() => openByRun.get(runId) ?? defaultOpen())
  if (entries.length === 0) return null // full-replacement can empty the plan — nothing to dock

  const { done, total } = planCounts(entries)
  const active = planActiveEntry(entries)
  const toggle = () =>
    setOpen((value) => {
      openByRun.set(runId, !value)
      return !value
    })

  return (
    <section
      data-slot="plan-dock"
      data-state={open ? 'open' : 'collapsed'}
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-xs"
    >
      {/* The mockup's `.grad-edge` — the brand gradient as a hairline top edge. */}
      <div aria-hidden data-slot="grad-edge" className="h-0.5 md:h-[3px]" style={{ background: 'var(--grad)' }} />
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={cn('flex w-full items-center gap-2 px-3.5 text-left text-[13px]', open ? 'pt-2 pb-1.5' : 'py-2')}
      >
        <span className="shrink-0 font-semibold">Plan</span>
        <span data-slot="plan-count" className="shrink-0 text-muted-foreground tabular-nums">
          · {done}/{total}
        </span>
        {!open && active !== undefined ? (
          <span data-slot="plan-current" className="min-w-0 truncate text-muted-foreground">
            — {active.activeForm ?? active.content}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn('ml-auto size-3.5 shrink-0 text-soft-foreground transition-transform', !open && 'rotate-180')}
        />
      </button>
      {open ? (
        <ul data-slot="plan-list" className="flex flex-col gap-[7px] px-3.5 pb-3">
          {entries.map((entry, index) => (
            <PlanRow key={`${index}:${entry.content}`} entry={entry} />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function PlanRow({ entry }: { entry: PlanEntry }) {
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
      <PlanIcon status={entry.status} />
      <span className="min-w-0 truncate">{entry.content}</span>
      {entry.status === 'in_progress' ? (
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
function PlanIcon({ status }: { status: PlanStatus }) {
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
        className="size-[15px] shrink-0 animate-pulse motion-reduce:animate-none"
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
