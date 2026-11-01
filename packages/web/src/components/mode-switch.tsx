import { Link, useLocation } from 'react-router'

import { cn } from '@/lib/utils'

const SEGMENT =
  'relative flex h-9 flex-1 items-center justify-center rounded-[5px] text-ui font-semibold outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50'
const ACTIVE = 'bg-foreground text-background'
const IDLE = 'text-foreground hover:bg-background/60'

/**
 * The Tasks | Manager switch (spec 2026-10-31-managers). The mode IS the URL: Tasks goes to the bare
 * root, which restores the last project page this browser was on.
 */
export function ModeSwitch({
  manager,
  attention,
  onNavigate,
}: {
  manager: boolean
  attention: boolean
  onNavigate?: () => void
}) {
  const { pathname, search } = useLocation()
  return (
    <nav aria-label="Mode" data-slot="mode-switch" className="mx-2.5 mb-2 flex gap-0.5 rounded-md bg-muted-foreground/20 p-[3px]">
      <Link
        to={manager ? '/' : `${pathname}${search}`}
        aria-current={manager ? undefined : 'page'}
        onClick={onNavigate}
        className={cn(SEGMENT, manager ? IDLE : ACTIVE)}
      >
        Tasks
      </Link>
      <Link
        to="/manager"
        aria-current={manager ? 'page' : undefined}
        onClick={onNavigate}
        className={cn(SEGMENT, manager ? ACTIVE : IDLE)}
      >
        Manager
        {attention ? (
          <span data-slot="manager-attention" className="absolute top-1.5 right-2 flex">
            <span className="size-1.5 rounded-full bg-info" aria-hidden="true" />
            <span className="sr-only">, needs you</span>
          </span>
        ) : null}
      </Link>
    </nav>
  )
}
