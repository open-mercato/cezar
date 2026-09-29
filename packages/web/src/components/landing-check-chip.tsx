import { StatusDot } from '@/components/status-dot'
import { landingCheckChip } from '@/lib/landing-check'
import { cn } from '@/lib/utils'

/**
 * The landing check's state chip (spec `.ai/specs/2026-09-29-landing-check.md` § UI/UX).
 *
 * One component paints every surface that has to answer "what did the combined check say?":
 * the task row (`tasks-overview.tsx`), the invoking run's header link and the check card. It is
 * deliberately a `<span>` — the row surfaces wrap it in their own link, so the chip itself must
 * not nest an anchor (the reason the reference chips and the status dot are siblings too).
 *
 * State is addressable (`data-state`) for tests and stylesheets: `checking`, the five verdicts,
 * or `stale` when the server marked the recorded subject moved. A stale verdict keeps its
 * verdict label — the stored text is never rewritten — with the `stale` marker beside it.
 */
export function LandingCheckChip({
  landingCheck,
  stale = false,
  status,
  className,
  marker = true,
}: {
  landingCheck: Parameters<typeof landingCheckChip>[0]['landingCheck']
  stale?: boolean
  /** The run's status, so a terminal check without a verdict does not pulse `checking` forever. */
  status?: Parameters<typeof landingCheckChip>[0]['status']
  className?: string
  /** Render the `stale` word next to the verdict. The card sets it false where its own header
   *  already says it. */
  marker?: boolean
}) {
  const chip = landingCheckChip({ landingCheck, landingCheckStale: stale, status })
  if (chip === undefined) return null
  return (
    <span
      data-slot="landing-check-chip"
      data-state={chip.state}
      title={chip.title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      <StatusDot tone={chip.tone} pulse={chip.pulse} />
      {chip.label}
      {chip.stale && marker ? (
        <span data-slot="landing-check-stale" className="border-l border-border pl-1 text-soft-foreground">
          stale
        </span>
      ) : null}
    </span>
  )
}
