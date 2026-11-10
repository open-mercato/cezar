import { QueryClientContext } from '@tanstack/react-query'
import { useContext } from 'react'
import { Link, useLocation } from 'react-router'

import { useManagers } from '@/api/managers'
import { noteManagerEntry } from '@/lib/manager-telemetry'
import { MANAGER_ATTENTION_DOT, MANAGER_ATTENTION_TEXT, managersAttention, type ManagerAttention } from '@/lib/managers'
import { cn } from '@/lib/utils'

const SEGMENT =
  'relative flex h-9 flex-1 items-center justify-center rounded-[5px] text-ui font-semibold outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50'
const ACTIVE = 'bg-foreground text-background'
const IDLE = 'text-foreground hover:bg-background/60'

const LAST_MANAGER_KEY = 'cez-last-manager'

/** Per tab, like the browser's own history: two windows keep their own last chat. */
export function rememberManagerLocation(location: string): void {
  // Setup is a door, not a place to come back to.
  if (location.startsWith('/manager/new')) return
  try {
    sessionStorage.setItem(LAST_MANAGER_KEY, location)
  } catch {
    // Private mode: Manager falls back to `/manager`.
  }
}

/**
 * Where Manager leads from Tasks: the chat or list this tab left, else `/manager`. A remembered chat
 * whose manager is gone from a loaded list falls back too, so the switch never opens a dead end.
 */
export function managerHref(managerIds: readonly string[] | undefined): string {
  let remembered: string | null = null
  try {
    remembered = sessionStorage.getItem(LAST_MANAGER_KEY)
  } catch {
    return '/manager'
  }
  if (remembered === null || !/^\/manager(?:[/?]|$)/.test(remembered)) return '/manager'
  const id = /^\/manager\/([^/?#]+)/.exec(remembered)?.[1]
  if (id !== undefined && managerIds !== undefined && !managerIds.includes(decodeURIComponent(id))) return '/manager'
  return remembered
}

/** The sidebar's colours: needs-you when an approval or question waits, else plain unread. Reads
 *  the list the shell already fetched; it never asks for one itself. */
function CachedAttentionDot() {
  return <AttentionDot kind={managersAttention(useManagers(false).data?.managers) ?? 'needs-you'} />
}

function AttentionDot({ kind }: { kind: ManagerAttention }) {
  return (
    <span data-slot="manager-attention" data-attention={kind} className="absolute top-1.5 right-2 flex">
      <span className={cn('size-1.5 rounded-full', MANAGER_ATTENTION_DOT[kind])} aria-hidden="true" />
      <span className="sr-only">{MANAGER_ATTENTION_TEXT[kind]}</span>
    </span>
  )
}

/**
 * The Tasks | Manager switch (spec 2026-10-31-managers). The mode IS the URL: Tasks goes to the bare
 * root, which restores the last project page this browser was on; Manager to `managerTo`.
 */
export function ModeSwitch({
  manager,
  attention,
  managerTo = '/manager',
  onNavigate,
}: {
  manager: boolean
  attention: boolean
  managerTo?: string
  onNavigate?: () => void
}) {
  const { pathname, search } = useLocation()
  const hasQueryClient = useContext(QueryClientContext) !== undefined
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
        to={manager ? `${pathname}${search}` : managerTo}
        aria-current={manager ? 'page' : undefined}
        onClick={() => {
          if (!manager) noteManagerEntry('sidebar')
          onNavigate?.()
        }}
        className={cn(SEGMENT, manager ? ACTIVE : IDLE)}
      >
        Manager
        {/* No query client (a bare shell test): the stronger reading. */}
        {attention ? (hasQueryClient ? <CachedAttentionDot /> : <AttentionDot kind="needs-you" />) : null}
      </Link>
    </nav>
  )
}
