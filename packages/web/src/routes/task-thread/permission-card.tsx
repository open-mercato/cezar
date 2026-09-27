import { useState } from 'react'

import type { ApiRun, PermissionOption } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { respondPermission } from '@/api/client'

import type { ThreadPermission } from './thread-state'

function outcomeLabel(permission: ThreadPermission): string {
  if (permission.cancelled) return 'cancelled'
  switch (permission.optionId) {
    case 'allow_once':
      return 'allowed once'
    case 'allow_always':
      return 'allowed always'
    case 'reject_once':
      return 'rejected once'
    case 'reject_always':
      return 'rejected always'
    default:
      return 'resolved'
  }
}

function isAllow(kind: PermissionOption['kind']): boolean {
  return kind === 'allow_once' || kind === 'allow_always'
}

/**
 * In-run permission prompt card (#475): the agent needs approval for a tool.
 * Buttons mirror the options the backend offered; after resolve (this tab or
 * any other via SSE) the card collapses to an outcome line.
 */
export function PermissionCard({
  permission,
  run,
}: {
  permission: ThreadPermission
  run: ApiRun
}) {
  if (permission.resolved) {
    const allowed = permission.optionId?.startsWith('allow') === true && !permission.cancelled
    return (
      <div
        data-slot="permission-card"
        data-resolved="true"
        className="rounded-lg border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground"
      >
        <div className="flex items-center gap-2 font-medium text-foreground">
          <span>Permission</span>
          <span className={cn(allowed ? 'text-success' : 'text-muted-foreground')}>
            — {outcomeLabel(permission)}
          </span>
        </div>
        <p className="mt-1.5 break-words font-mono text-[12.5px] text-soft-foreground">
          {permission.title}
        </p>
      </div>
    )
  }
  return <PendingPermission permission={permission} run={run} />
}

function PendingPermission({
  permission,
  run,
}: {
  permission: ThreadPermission
  run: ApiRun
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const answer = async (optionId: string) => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await respondPermission(run.id, permission.id, optionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      data-slot="permission-card"
      data-resolved="false"
      className="rounded-lg border border-primary/40 bg-primary/[0.04] px-4 pt-3.5 pb-3.5"
    >
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          className="size-2 animate-pulse rounded-full bg-primary shadow-[0_0_0_4px] shadow-primary/20"
        />
        <span className="text-xs font-medium text-primary">Permission needed</span>
        {run.status === 'waiting' ? (
          <span className="rounded-full border border-pending-strong/45 px-2.5 py-0.5 text-[11.5px] text-pending-strong">
            run waiting
          </span>
        ) : null}
      </div>
      <p
        data-slot="permission-title"
        className="mb-3 break-words rounded-md border border-border bg-background px-3 py-2 font-mono text-[12.5px] text-foreground"
      >
        {permission.title}
      </p>
      <div className="flex flex-wrap gap-2">
        {permission.options.map((option) => (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant={isAllow(option.kind) ? 'primary' : 'outline'}
            disabled={pending}
            data-slot="permission-option"
            data-kind={option.kind}
            onClick={() => void answer(option.id)}
            className={cn(
              !isAllow(option.kind) && 'border-danger/30 text-danger hover:bg-danger/10',
            )}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <p className="mt-2.5 text-[11.5px] text-soft-foreground">
        The agent is paused until you answer. You can also interrupt the run or take over in the
        terminal.
      </p>
      {error ? (
        <p data-slot="permission-error" role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
