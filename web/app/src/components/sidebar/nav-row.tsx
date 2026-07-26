import * as React from 'react'
import type { To } from 'react-router'

import type { NavItem } from '@/components/nav-items'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * The one nav-row grammar: the flat nav, each project group, and the icon rail's badge dot all
 * import from here, so the measurements cannot drift.
 *
 * A Link, not a NavLink, on purpose. NavLink derives `aria-current` from its own prefix match
 * against `to`, and that rule is wrong here: it would *not* light Tasks on /tasks/:id — which
 * the spec requires. The area rule lives in `activeNavPath`.
 */
export function NavRow({
  item,
  isActive,
  badge = null,
  updateDot = false,
  to,
  onNavigate,
}: {
  item: NavItem
  isActive: boolean
  badge?: number | null
  updateDot?: boolean
  to?: To
  onNavigate?: () => void
}) {
  const Icon = item.icon
  return (
    <Link
      to={to ?? item.to}
      onClick={onNavigate}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset md:h-8',
        isActive && 'bg-muted text-foreground'
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {item.label}
      {badge ? <NavBadge className="ml-auto">{badge}</NavBadge> : null}
      {updateDot ? (
        <span data-slot="nav-update-marker" className="ml-auto flex items-center">
          <UpdateDot />
          <span className="sr-only">Skills update available</span>
        </span>
      ) : null}
    </Link>
  )
}

export function NavBadge({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="nav-badge"
      className={cn('rounded-full bg-violet px-1.5 text-2xs text-violet-foreground', className)}
      {...props}
    />
  )
}

export function UpdateDot({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden="true"
      data-slot="update-dot"
      className={cn('size-1.5 rounded-full bg-violet', className)}
      {...props}
    />
  )
}
