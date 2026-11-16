import { ArrowLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Link, useLocation } from 'react-router'

import { RESTORE_SCROLL_STATE } from '@/lib/global-tasks'
import { resolveManagerOrigin } from '@/lib/managers'
import { noteManagerChatSource, noteManagerEntry } from '@/lib/manager-telemetry'

const LINK = 'min-h-11 inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'

/** The way home from a task opened off a session card or a manager's Tasks table (spec 2026-10-31-managers). */
export function ManagerBackLink({ runId }: { runId: string }) {
  const { state } = useLocation()
  const origin = resolveManagerOrigin(runId, state)
  if (!origin) return null
  const manager = (
    <Link
      to={`/manager/${encodeURIComponent(origin.id)}${origin.decision ? `#decision-${encodeURIComponent(origin.decision)}` : ''}`}
      data-slot="manager-back-link"
      aria-label={`Back to ${origin.name}`}
      onClick={() => {
        noteManagerEntry('task_card')
        noteManagerChatSource('task_card')
      }}
      className={LINK}
    >
      <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
      {origin.tasks ? origin.name : `Back to ${origin.name}`}
    </Link>
  )
  const className = 'mb-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground'
  if (!origin.tasks) return <span className={className}>{manager}</span>
  // Opened from the manager's filtered Tasks table: Manager › Tasks started › this task.
  return (
    <nav aria-label="Breadcrumb" data-slot="manager-breadcrumb" className={className}>
      {manager}
      <ChevronRightIcon aria-hidden="true" className="size-3" />
      <Link
        to={origin.tasks}
        state={RESTORE_SCROLL_STATE}
        data-slot="manager-tasks-back-link"
        aria-label={`Back to tasks started by ${origin.name}`}
        className={LINK}
      >
        Tasks started
      </Link>
    </nav>
  )
}
