import type { ReactNode } from 'react'
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
      'w-full min-h-0 flex-col overflow-y-auto overscroll-contain border-border md:flex md:w-[360px] md:shrink-0 md:border-r',
      selected ? 'hidden' : 'flex',
    )}>{list}</section>
    <section data-slot={`${name}-detail`} className={cn(
      'min-w-0 min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain',
      selected ? 'flex' : 'hidden md:flex',
    )}>{detail}</section>
  </div>
}
