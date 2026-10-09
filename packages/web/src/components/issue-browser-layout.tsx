import type { ReactNode } from 'react'

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

/** The browsers' empty / unavailable / error template: an icon, one line, and the next step. */
export function IssueBrowserEmpty({ icon, title, description, tone = 'neutral', children, actions, slot }: {
  icon: ReactNode
  title: string
  description?: ReactNode
  tone?: 'neutral' | 'danger'
  /** Extra explanation under the description. */
  children?: ReactNode
  actions?: ReactNode
  slot?: string
}) {
  return (
    <Empty data-slot={slot ?? 'centered-state'} data-tone={tone} className="min-h-full flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon" className={tone === 'danger' ? 'text-danger' : undefined}>{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {children || actions ? (
        <EmptyContent>
          {children}
          {actions ? <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
        </EmptyContent>
      ) : null}
    </Empty>
  )
}
