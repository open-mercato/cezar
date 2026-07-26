import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

export function PageBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="page-body"
      className={cn(
        'flex min-w-0 flex-1 flex-col p-3 pb-[calc(var(--dock-clearance)+env(safe-area-inset-bottom))] md:p-5 md:pb-5',
        className,
      )}
      {...props}
    />
  )
}
