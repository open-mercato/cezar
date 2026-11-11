import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** Which edge the card leads with (design, Proposal 10): a waiting approval is info blue, a
 *  failed check red, the rest plain. */
export type ManagerCardTone = 'plain' | 'info' | 'danger'

const TONE: Record<ManagerCardTone, string> = {
  plain: 'border-border',
  info: 'border-info/50',
  danger: 'border-danger/45',
}

/**
 * The one card shape every chat card shares (design, Proposal 10): a header row with an icon, a
 * title and a status at the right; a body; an actions row. Decision, approval, session and
 * check-failed cards differ only in what they put in each.
 */
export function ManagerCard({
  tone = 'plain',
  icon,
  title,
  status,
  actions,
  className,
  children,
  ...props
}: Omit<ComponentProps<'section'>, 'title'> & {
  tone?: ManagerCardTone
  icon?: ReactNode
  title: ReactNode
  status?: ReactNode
  actions?: ReactNode
}) {
  return (
    <section
      tabIndex={-1}
      {...props}
      data-tone={tone}
      className={cn('w-full overflow-hidden rounded-xl border bg-card text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', TONE[tone], className)}
    >
      <div data-slot="manager-card-header" className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 font-semibold">
        {icon}
        <span className="min-w-0 truncate">{title}</span>
        {status ? (
          <span data-slot="manager-card-status" className="ml-auto flex shrink-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">{status}</span>
        ) : null}
      </div>
      <div data-slot="manager-card-body" className="flex flex-col gap-2 px-3.5 py-2.5">{children}</div>
      {actions ? (
        <div data-slot="manager-card-actions" className="flex gap-2 px-3.5 pt-0.5 pb-3">{actions}</div>
      ) : null}
    </section>
  )
}
