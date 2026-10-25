import type { ReactNode } from 'react'
import { ArrowDownIcon, ArrowUpIcon, CloudUploadIcon, RefreshCwIcon } from 'lucide-react'

import { ApiError, type RepoSyncAction } from '@/api/client'
import { useRepoSync, useRepoSyncAction } from '@/api/queries'
import type { BranchTracking, RepoSync } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

/**
 * The repo header's Source-Control strip (spec 2026-10-19-repo-git-sync): which upstream the
 * checkout tracks, ↑outgoing ↓incoming as of the last fetch, and Fetch / Pull / Push / Sync.
 * The server never fetches on its own, so "last fetched" is shown rather than implied.
 */
export function RepoSyncBar() {
  const sync = useRepoSync()
  const action = useRepoSyncAction()
  if (!sync.data) return null
  const s = sync.data
  const run = (which: RepoSyncAction) =>
    action.mutate(which, {
      onSuccess: (result) => toast(result.message),
      // A 409 is git's verdict on the checkout — diverged, rejected, an in-place task running —
      // and says what to do; anything else is unexpected and stays reported (telemetry 9202a06a).
      onError: (error) =>
        toast(error.message, { tone: 'danger', expected: error instanceof ApiError && error.status === 409 }),
    })
  const busy = action.isPending
  const pending = action.variables

  return (
    <div data-slot="repo-sync" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
      {s.upstream ? (
        <span data-slot="repo-upstream" className="truncate font-mono text-soft-foreground" title="Upstream">
          → {s.upstream}
        </span>
      ) : s.branch ? (
        <span data-slot="repo-upstream" className="text-soft-foreground">not published</span>
      ) : (
        <span data-slot="repo-upstream" className="text-soft-foreground">detached HEAD</span>
      )}
      {s.upstream ? (
        <SyncCounts ahead={s.ahead} behind={s.behind} />
      ) : s.outgoing.length > 0 ? (
        <SyncCounts ahead={s.outgoing.length} behind={null} />
      ) : null}
      <span data-slot="repo-fetched" className="hidden text-soft-foreground sm:inline">
        {s.lastFetchedAt ? `fetched ${relativeTime(s.lastFetchedAt)}` : 'never fetched'}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <SyncButton which="fetch" label="Fetch" busy={busy} pending={pending} onClick={run} disabled={!s.pushRemote}>
          <RefreshCwIcon aria-hidden="true" className={cn(busy && pending === 'fetch' && 'animate-spin')} />
        </SyncButton>
        {s.upstream ? (
          <>
            <SyncButton which="pull" label="Pull" busy={busy} pending={pending} onClick={run} disabled={!s.behind}>
              <ArrowDownIcon aria-hidden="true" />
            </SyncButton>
            <SyncButton which="push" label="Push" busy={busy} pending={pending} onClick={run} disabled={!s.ahead}>
              <ArrowUpIcon aria-hidden="true" />
            </SyncButton>
            <SyncButton
              which="sync"
              label="Sync"
              busy={busy}
              pending={pending}
              onClick={run}
              disabled={!s.ahead && !s.behind}
              variant="outline"
            >
              <RefreshCwIcon aria-hidden="true" className={cn(busy && pending === 'sync' && 'animate-spin')} />
            </SyncButton>
          </>
        ) : s.branch && s.pushRemote ? (
          <SyncButton which="push" label="Publish branch" busy={busy} pending={pending} onClick={run} variant="outline">
            <CloudUploadIcon aria-hidden="true" />
          </SyncButton>
        ) : null}
      </div>
    </div>
  )
}

function SyncButton({
  which,
  label,
  busy,
  pending,
  onClick,
  disabled,
  variant = 'ghost',
  children,
}: {
  which: RepoSyncAction
  label: string
  busy: boolean
  pending: RepoSyncAction | undefined
  onClick: (which: RepoSyncAction) => void
  disabled?: boolean
  variant?: 'ghost' | 'outline'
  children: ReactNode
}) {
  return (
    <Button
      variant={variant}
      size="sm"
      data-action={`repo-${which}`}
      aria-busy={busy && pending === which}
      disabled={busy || disabled}
      onClick={() => onClick(which)}
    >
      {children}
      {label}
    </Button>
  )
}

/** `↑2 ↓1`, omitting a side that is unknown; `in sync` when both are zero. */
export function SyncCounts({ ahead, behind }: { ahead: number | null; behind: number | null }) {
  if (ahead === null && behind === null) return null
  if (!ahead && !behind) {
    return (
      <span data-slot="sync-counts" className="text-soft-foreground">
        in sync
      </span>
    )
  }
  return (
    <span data-slot="sync-counts" className="flex items-center gap-1 font-mono">
      {ahead ? (
        <span data-sync="ahead" title={`${ahead} to push`} className="text-primary">
          ↑{ahead}
        </span>
      ) : null}
      {behind ? (
        <span data-sync="behind" title={`${behind} to pull`} className="text-warning">
          ↓{behind}
        </span>
      ) : null}
    </span>
  )
}

/** A branch row's tracking state: counts, `upstream gone`, `local only`, or `remote only`. */
export function BranchTrackingBadge({ name, sync }: { name: string; sync: RepoSync | undefined }) {
  if (!sync) return null
  const local: BranchTracking | undefined = sync.branches.find((b) => b.name === name)
  const label = !local
    ? 'remote only'
    : local.gone
      ? 'upstream gone'
      : !local.upstream
        ? 'local only'
        : null
  return (
    <span data-slot="branch-tracking" className="flex shrink-0 items-center gap-1 text-[11px]">
      {label ? <span className="text-soft-foreground">{label}</span> : <SyncCounts ahead={local!.ahead} behind={local!.behind} />}
    </span>
  )
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}
