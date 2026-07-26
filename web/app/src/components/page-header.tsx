import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  meta,
  actions,
  tabs,
  className,
  ...props
}: Omit<ComponentProps<'header'>, 'title'> & {
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  tabs?: ReactNode
}) {
  return (
    <header
      data-slot="page-header"
      className={cn('sticky top-0 z-10 shrink-0 border-b border-border bg-background', className)}
      {...props}
    >
      <div className="flex h-14 min-w-0 items-center gap-3 px-4 md:px-5">
        <h1 className="min-w-0 text-base font-semibold">{title}</h1>
        {meta}
        {actions ? (
          <div data-slot="page-header-actions" className="ml-auto flex shrink-0 items-center gap-1.5">
            {actions}
          </div>
        ) : null}
      </div>
      {tabs}
    </header>
  )
}
