import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type CenteredStateTone = 'neutral' | 'primary' | 'danger'

/** The tile carries a border + a solid-enough fill so a muted icon never disappears into the
 *  page — mercato's exact grammar. */
const tileTone: Record<CenteredStateTone, string> = {
  primary: 'border-primary/25 bg-primary/15 text-primary',
  neutral: 'border-border bg-card text-foreground shadow-xs',
  danger: 'border-danger/20 bg-danger/15 text-danger',
}

/**
 * The one template for every loading/paused/error/empty state (spec, "Design system"):
 * a 72px tinted icon tile, a `text-lg` title, a muted subtitle, an actions row. Views never
 * hand-roll a centered message — they say which tone this moment is and what to do next.
 */
export function CenteredState({
  icon,
  tone = 'neutral',
  title,
  subtitle,
  children,
  actions,
  heading: Heading = 'h1',
  className,
}: {
  icon: ReactNode
  tone?: CenteredStateTone
  title: string
  subtitle?: string
  /** Free-form content below the subtitle (the `/new` param echo uses this). */
  children?: ReactNode
  actions?: ReactNode
  /** `h1` when the state IS the page; `h2` when it sits under an existing page heading. */
  heading?: 'h1' | 'h2'
  className?: string
}) {
  return (
    <div
      data-slot="centered-state"
      data-tone={tone}
      className={cn(
        'relative isolate flex min-h-full flex-1 flex-col items-center justify-center px-6 py-12 text-center',
        className
      )}
    >
      <div className="flex w-full max-w-md flex-col items-center gap-4">
        <div
          data-slot="centered-state-tile"
          className={cn(
            "flex size-[72px] items-center justify-center rounded-xl border [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-7",
            tileTone[tone]
          )}
        >
          {icon}
        </div>
        <Heading className="text-lg font-semibold text-balance text-foreground">{title}</Heading>
        {subtitle ? <p className="text-sm text-pretty text-muted-foreground">{subtitle}</p> : null}
        {children ? <div className="w-full pt-2">{children}</div> : null}
        {actions ? <div className="flex items-center justify-center gap-3 pt-2">{actions}</div> : null}
      </div>
    </div>
  )
}
