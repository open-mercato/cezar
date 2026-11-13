import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Family: CHIP (static fact, code value) — an inline chip (h-5, rounded-full) for a machine-ish
 * token (spec 2026-09-14-automations-redesign § Primitives): a branch name, a cron string, a
 * project id. Mono because the value IS code (`text-ui font-mono`, the one mono size); never
 * wraps. A fact in prose that is not code uses plain text, not this.
 */
export function BranchChip({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="branch-chip"
      className={cn(
        'inline-flex h-5 items-center rounded-full bg-muted px-2 font-mono text-ui font-medium whitespace-nowrap text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}
