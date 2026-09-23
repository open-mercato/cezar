import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * A machine-ish token in a muted chip (spec 2026-09-14-automations-redesign § Primitives): a
 * branch name, a cron string, a project id. Mono, 11.5px, never wraps.
 */
export function BranchChip({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="branch-chip"
      className={cn(
        'inline-block rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11.5px] leading-[1.3] font-medium whitespace-nowrap text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}
