import { ArrowLeftIcon } from 'lucide-react'
import { Link, useLocation } from 'react-router'

import { resolveManagerOrigin } from '@/lib/managers'

/** The way home from a task opened off a session card (spec 2026-10-31-managers). */
export function ManagerBackLink({ runId }: { runId: string }) {
  const { state } = useLocation()
  const origin = resolveManagerOrigin(runId, state)
  if (!origin) return null
  return (
    <Link
      to={`/manager/${encodeURIComponent(origin.id)}`}
      data-slot="manager-back-link"
      className="mb-1 inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
      Back to {origin.name}
    </Link>
  )
}
