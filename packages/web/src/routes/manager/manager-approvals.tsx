import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCheckIcon } from 'lucide-react'
import { useCallback, useRef, type RefObject } from 'react'
import { Link } from 'react-router'

import { decideManagerAction, getPendingManagerActions, managerKeys, orderManagers, refreshManagerChat, useManagers } from '@/api/managers'
import { useHealth } from '@/api/queries'
import { CacheStatusChip } from '@/components/cache-status'
import { CenteredState } from '@/components/centered-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { ActionCard, useDismissStaleMerges, type DecideAction } from './manager-approval'
import { ManagerAvatar } from './manager-avatar'

function ManagerApprovals({ manager, heading }: { manager: ManagerSummary; heading: RefObject<HTMLHeadingElement | null> }) {
  const client = useQueryClient()
  const pending = useQuery({
    queryKey: managerKeys.approvals(manager.id),
    queryFn: ({ signal }) => getPendingManagerActions(manager.id, signal),
  })
  const onDecide = useCallback<DecideAction>(async (actionId, decision, opts) => {
    const active = document.activeElement
    const startedHere = active?.closest('[data-action-id]')?.getAttribute('data-action-id') === actionId
      || (!opts?.onlyIfStale && Boolean(active?.closest('[data-slot="manager-action-sheet"]')))
    const result = await decideManagerAction(manager.id, actionId, decision, opts)
    // The resolved card leaves this pending-only list. Keep keyboard focus on the page instead
    // of losing it to <body>, without stealing focus from a reader who moved elsewhere.
    const card = document.activeElement?.closest('[data-slot="manager-action"]')
    // SSE may remove the card before its decision response reaches the browser.
    if (card?.getAttribute('data-action-id') === actionId || (startedHere && document.activeElement === document.body)) {
      heading.current?.focus({ preventScroll: true })
    }
    await Promise.allSettled([
      client.invalidateQueries({ queryKey: managerKeys.approvals(manager.id) }),
      client.invalidateQueries({ queryKey: managerKeys.list }),
      refreshManagerChat(client, manager.id),
    ])
    return result
  }, [client, manager.id, heading])
  useDismissStaleMerges(pending.data ?? [], onDecide)
  return (
    <section aria-label={manager.name} className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} className="size-8" />
        <h2 className="min-w-0 flex-1 truncate font-semibold">{manager.name}</h2>
        <Button asChild variant="outline" className="shrink-0 max-md:min-h-11">
          <Link to={`/manager/${encodeURIComponent(manager.id)}#needs-you`} aria-label={`Open chat with ${manager.name}`}>Open chat</Link>
        </Button>
      </div>
      <CacheStatusChip queryKey={managerKeys.approvals(manager.id)} isFetching={pending.isFetching} isError={pending.isError} className="self-start" />
      {pending.isPending ? <LoadingState label={`Loading approvals from ${manager.name}…`} /> : null}
      {pending.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
          <p>Couldn’t load approvals from {manager.name}.</p>
          <Button variant="outline" onClick={() => void pending.refetch()}>Retry</Button>
        </div>
      ) : null}
      {pending.data?.map((message) => message.kind === 'action' && message.status === 'pending' ? (
        <ActionCard key={message.id} origin={{ id: manager.id, name: manager.name }} message={message} onDecide={onDecide} />
      ) : null)}
      {pending.data?.length === 0 && !pending.isError ? <p className="text-sm text-muted-foreground">No pending approvals from this manager.</p> : null}
    </section>
  )
}

/** Global pending action cards, independent of any chat's loaded history or unread state. */
export function ManagerApprovalsRoute() {
  const enabled = useHealth().data?.capabilities.managers === true
  const managers = useManagers(enabled)
  const heading = useRef<HTMLHeadingElement>(null)
  const waiting = orderManagers(managers.data?.managers ?? []).filter((manager) => manager.pendingActions > 0)
  const count = waiting.reduce((sum, manager) => sum + manager.pendingActions, 0)
  return (
    <div data-route="manager-approvals" className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-6">
      <header className="flex flex-col gap-1">
        <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">Approvals</h1>
        <p role="status" className="text-sm text-muted-foreground">{managers.data ? `${count} pending ${count === 1 ? 'approval' : 'approvals'} across all managers` : managers.isError ? 'Pending approvals across all managers' : 'Loading approvals…'}</p>
      </header>
      <CacheStatusChip queryKey={managerKeys.list} isFetching={managers.isFetching} isError={managers.isError} className="self-start" />
      {managers.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
          <p>Couldn’t load managers.</p>
          <Button variant="outline" onClick={() => void managers.refetch()}>Retry</Button>
        </div>
      ) : null}
      {!managers.data && managers.isPending ? <LoadingState label="Loading managers…" /> : null}
      {managers.data && count === 0 ? (
        <CenteredState heading="h2" icon={<CheckCheckIcon aria-hidden="true" />} title="No pending approvals" subtitle="Approval requests from all your managers appear here. Questions stay in each manager’s chat." />
      ) : null}
      {waiting.map((manager) => <ManagerApprovals key={manager.id} manager={manager} heading={heading} />)}
    </div>
  )
}
