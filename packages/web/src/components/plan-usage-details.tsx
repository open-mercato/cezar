import { createContext, useContext, type ReactElement, type ReactNode } from 'react'
import { Link as RouterLink } from 'react-router'

import type { PlanUsageAccount } from '@open-mercato/cezar-api-client'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { PHONE_QUERY, useMediaQuery } from '@/lib/use-media-query'

/**
 * The plan-limit breakdown shared by the task chip and the manager chip (spec
 * 2026-11-20-manager-plan-usage-popover): an anchored popover on desktop, a bottom sheet on a phone.
 */

const InSheet = createContext(false)

export function PlanUsageSurface({
  trigger,
  tooltip,
  slot,
  className,
  children,
}: {
  /** One focusable element (a `button`); it becomes the popover's or sheet's trigger. */
  trigger: ReactElement
  tooltip?: string
  slot: string
  className?: string
  children: ReactNode
}) {
  const phone = useMediaQuery(PHONE_QUERY)
  if (phone) {
    return (
      <Sheet>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        {/* pt-15 clears the sheet's 44 px close button (top-4) so no row runs under it. */}
        <SheetContent
          side="bottom"
          data-slot={slot}
          aria-describedby={undefined}
          className={cn('max-h-[85dvh] gap-0 overflow-y-auto rounded-t-xl px-4 pt-15 pb-[max(1rem,env(safe-area-inset-bottom))] text-label', className)}
        >
          <InSheet.Provider value>{children}</InSheet.Provider>
        </SheetContent>
      </Sheet>
    )
  }
  const button = <PopoverTrigger asChild>{trigger}</PopoverTrigger>
  return (
    <Popover>
      {tooltip ? <IconTooltip label={tooltip}>{button}</IconTooltip> : button}
      <PopoverContent align="end" data-slot={slot} className={cn('w-80 p-3 text-label', className)}>
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** The sheet needs a dialog title; the popover keeps a plain line. */
export function PlanUsageTitle({ children }: { children: ReactNode }) {
  return useContext(InSheet) ? (
    <SheetTitle className="text-label font-medium">{children}</SheetTitle>
  ) : (
    <p className="font-medium text-foreground">{children}</p>
  )
}

export interface PlanUsageRow {
  slot: string
  label: ReactNode
  value: string
  /** A sub-row of the one above it. */
  indent?: boolean
}

export function PlanUsageRows({ rows, className }: { rows: PlanUsageRow[]; className?: string }) {
  if (rows.length === 0) return null
  return (
    <dl className={cn('mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 tabular-nums', className)}>
      {rows.map((row) => (
        <PlanUsageRowItem key={row.slot} row={row} />
      ))}
    </dl>
  )
}

function PlanUsageRowItem({ row }: { row: PlanUsageRow }) {
  return (
    <>
      <dt className={cn('min-w-0 text-muted-foreground', row.indent && 'pl-3')}>{row.label}</dt>
      <dd data-slot={row.slot} className="text-right">{row.value}</dd>
    </>
  )
}

/** The figures are estimates; say why, in the provider's own unit. */
export function ApproximateNote({ provider, splitBy }: { provider: PlanUsageAccount['provider']; splitBy: 'task' | 'task and manager' }) {
  const name = provider === 'codex' ? 'Codex' : 'Claude'
  const own = provider === 'codex' ? 'Codex' : 'Claude Code'
  const weight = provider === 'codex' ? 'tokens' : 'cost'
  return (
    <p className="mt-2 text-meta text-muted-foreground">
      Approximate: {name} reports usage per account, so busy periods are split by each {splitBy === 'task' ? "task's" : "task's and manager's"} {weight}, and your
      own {own} sessions can't be told apart.
    </p>
  )
}

export function PlanUsageLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <RouterLink
      to={to}
      data-slot="plan-usage-link"
      className="mt-2 inline-block text-meta text-primary underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
    >
      {children}
    </RouterLink>
  )
}
