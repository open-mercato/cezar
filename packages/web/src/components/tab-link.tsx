import type { ReactNode } from 'react'

import { Link } from '@/lib/project-router'

import { cn } from '@/lib/utils'

/** One underline tab (mockup `.tab`) — the segment grammar the run header's
 *  Session | Changes | Files row uses, extracted (R5 1.7) so the repo view's
 *  Changes | Commits | Branches row is the same component rather than a fork.
 *  A real `<Link>` on purpose: every segment is a URL (spec §"Routing"). */
export function TabLink({
  to,
  active = false,
  onClick,
  children,
}: {
  to: string
  active?: boolean
  /** Fires alongside the navigation (e.g. persisting the choice, #417) — it does not
   *  intercept it; `<Link>` still navigates unless the handler itself prevents it. */
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        // The shadcn `line` tab: a quiet label with a 2px ink underline when current.
        'relative -mb-px flex h-9 items-center gap-1.5 px-3 text-[13.5px] font-medium whitespace-nowrap transition-colors outline-none',
        'after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground after:opacity-0 after:transition-opacity',
        'focus-visible:rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active ? 'text-foreground after:opacity-100' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </Link>
  )
}
