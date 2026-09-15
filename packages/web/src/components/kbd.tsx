import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * A keyboard hint (spec 2026-09-14-automations-redesign § Primitives): the mockup's `kbd` — a
 * 10.5px mono chip with a heavier bottom edge, so it reads as a key. `onContrast` is the
 * variant for a contrast-filled button (the sidebar's "New task C").
 */
export function Kbd({
  onContrast = false,
  className,
  ...props
}: React.ComponentProps<'kbd'> & { onContrast?: boolean }) {
  return (
    <kbd
      aria-hidden="true"
      data-slot="kbd"
      className={cn(
        'inline-block rounded-[5px] border border-b-2 px-[5px] py-px font-mono text-[10.5px] leading-[1.3] font-medium',
        onContrast
          ? 'border-contrast-foreground/25 bg-transparent text-contrast-foreground/60'
          : 'border-border bg-card text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}
