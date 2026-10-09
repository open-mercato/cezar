import type { ReactNode } from 'react'

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

/** The repo view's empty/error template: one icon, one line, one explanation. */
export function RepoEmpty({
  icon,
  title,
  description,
  tone = 'neutral',
  slot,
}: {
  icon: ReactNode
  title: string
  description?: string
  tone?: 'neutral' | 'danger'
  slot?: string
}) {
  return (
    <Empty data-slot={slot ?? 'centered-state'} data-tone={tone} className="flex-1 py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon" className={tone === 'danger' ? 'text-danger' : undefined}>
          {icon}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  )
}
