import { Link } from 'react-router'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { cn } from '@/lib/utils'
import { isInactive, managerAttention, managerMessageTime, managerRowPreview, managerTimeLabel, needsYouCount, MANAGER_ATTENTION_TEXT } from '@/lib/managers'
import { noteManagerChatSource } from '@/lib/manager-telemetry'
import { ManagerAvatar } from './manager-avatar'
import { FROM_MANAGER_LIST } from './manager-focus'

/** A directory entry has an explicit device boundary. The web page only builds entries for
 * its own server; a future native directory must supply its own composite key and navigation. */
export type ManagerDirectoryEntry = {
  key: string
  deviceLabel: string
  manager: ManagerSummary
  href: string
}

export function ManagerDirectoryCard({ entry, now }: { entry: ManagerDirectoryEntry; now: number }) {
  const { manager } = entry
  const attention = managerAttention(manager)
  const waiting = needsYouCount(manager)
  const inactive = isInactive(manager)
  const since = manager.inactive ? managerMessageTime(manager.inactive.since) : ''
  const status = inactive ? `Inactive${since ? ` since ${since}` : ''}` : manager.status === 'working' ? 'Working' : manager.status === 'error' ? 'Check failed' : 'Up to date'
  // An inactive manager's questions wait without counting; its approvals still need the user (spec 2026-11-19-manager-deactivate).
  const shownAttention = inactive ? null : attention
  const needs = inactive ? manager.pendingActions : waiting
  return (
    <Link to={entry.href} state={FROM_MANAGER_LIST} data-slot="manager-directory-card" data-inactive={inactive || undefined}
      onClick={() => noteManagerChatSource('list')}
      className={cn('flex min-h-[104px] min-w-0 items-start gap-3 rounded-xl border border-border p-3 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50', inactive ? 'bg-card-2' : 'bg-card')}>
      <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} inactive={inactive} className="size-10 shrink-0" sizes="40px" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn('min-w-0 flex-auto break-words font-semibold', inactive && 'text-muted-foreground')}>{manager.name}</span>
          <span className="text-meta text-muted-foreground">{managerTimeLabel(manager.lastActivityAt, new Date(now))}</span>
        </span>
        <span className="block break-words text-meta text-muted-foreground">{entry.deviceLabel} · {status}{shownAttention ? ` · ${MANAGER_ATTENTION_TEXT[shownAttention].replace(/^, /, '')}` : ''}</span>
        {inactive ? null : <span className="mt-1 block line-clamp-2 break-words text-sm text-muted-foreground">{managerRowPreview(manager)}</span>}
        {needs > 0 ? <span className={cn('mt-1 block text-sm font-semibold', inactive ? 'text-muted-foreground' : 'text-info')}>{inactive ? `${needs} ${needs === 1 ? 'approval' : 'approvals'}` : `${needs} ${needs === 1 ? 'needs' : 'need'} you`}</span> : null}
      </span>
    </Link>
  )
}
