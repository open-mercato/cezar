import { Link } from 'react-router'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { managerAttention, managerRowPreview, managerTimeLabel, needsYouCount, MANAGER_ATTENTION_TEXT } from '@/lib/managers'
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
  const status = manager.status === 'working' ? 'Working' : manager.status === 'error' ? 'Check failed' : 'Up to date'
  return (
    <Link to={entry.href} state={FROM_MANAGER_LIST} data-slot="manager-directory-card"
      onClick={() => noteManagerChatSource('list')}
      className="flex min-h-[104px] min-w-0 items-start gap-3 rounded-xl border border-border bg-card p-3 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} className="size-10 shrink-0" sizes="40px" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 flex-1 break-words font-semibold">{manager.name}</span>
          <span className="text-meta text-muted-foreground">{managerTimeLabel(manager.lastActivityAt, new Date(now))}</span>
        </span>
        <span className="block break-words text-meta text-muted-foreground">{entry.deviceLabel} · {status}{attention ? ` · ${MANAGER_ATTENTION_TEXT[attention].replace(/^, /, '')}` : ''}</span>
        <span className="mt-1 block line-clamp-2 break-words text-sm text-muted-foreground">{managerRowPreview(manager)}</span>
        {waiting > 0 ? <span className="mt-1 block text-sm font-semibold text-info">{waiting} need you</span> : null}
      </span>
    </Link>
  )
}
