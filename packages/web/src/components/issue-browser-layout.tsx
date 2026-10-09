import type { ReactNode } from 'react'

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { cn } from '@/lib/utils'

/** Shared forge/tracker navigation: independently scrolling panes, one surface on phones. */
export function IssueBrowserLayout({ name, route, selected, list, detail }: {
  name: string
  route: string
  selected: boolean
  list: ReactNode
  detail: ReactNode
}) {
  return <div data-route={route} className="flex h-full min-h-0 items-stretch">
    <section data-slot={`${name}-list`} className={cn(
      'w-full min-h-0 flex-col overflow-y-auto overscroll-contain border-border md:flex md:w-[380px] md:shrink-0 md:border-r',
      selected ? 'hidden' : 'flex',
    )}>{list}</section>
    <section data-slot={`${name}-detail`} className={cn(
      'min-w-0 min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain',
      selected ? 'flex' : 'hidden md:flex',
    )}>{detail}</section>
  </div>
}

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
