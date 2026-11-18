import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCheckIcon } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import { Link } from 'react-router'

import { decideManagerAction, getManagerActionResult, getPendingManagerActions, managerKeys, orderManagers, refreshManagerChat, useManagers } from '@/api/managers'
import { useHealth, useProjects } from '@/api/queries'
import { CacheStatusChip } from '@/components/cache-status'
import { CenteredState } from '@/components/centered-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { actionTitle } from '@/lib/managers'
import type { ManagerMessage, ManagerSummary } from '@open-mercato/cezar-api-client'

import { ActionCard, useDismissStaleMerges, type DecideAction } from './manager-approval'
import { ManagerAvatar } from './manager-avatar'
import { ManagerProjectsContext } from './manager-reference'

type Action = Extract<ManagerMessage, { kind: 'action' }>
type DecisionResult = { managerId: string; message: Action; readError?: string }
type SaveResult = (managerId: string, actionId: string, message?: Action, readError?: string) => void

function ManagerApprovals({ manager, heading, results, saveResult }: {
  manager: ManagerSummary
  heading: RefObject<HTMLHeadingElement | null>
  results: DecisionResult[]
  saveResult: SaveResult
}) {
  const client = useQueryClient()
  // The chat's connected projects, so an action reason's references paint as chips here too.
  const registry = useProjects().data?.projects
  const connected = useMemo(
    () => (registry ?? []).filter((project) => manager.connectedProjectIds.includes(project.id)),
    [registry, manager.connectedProjectIds],
  )
  const pending = useQuery({
    queryKey: managerKeys.approvals(manager.id),
    queryFn: ({ signal }) => getPendingManagerActions(manager.id, signal),
    enabled: manager.pendingActions > 0,
  })
  const messages = [
    ...(manager.pendingActions > 0 ? pending.data ?? [] : []).filter((message) => !results.some((row) => row.message.id === message.id)),
    ...results.map((row) => row.message),
  ]
  const readResult = useCallback(async (message: Action) => {
    const ownsFocus = document.activeElement?.closest('[data-result-id]')?.getAttribute('data-result-id') === message.id
    saveResult(manager.id, message.id, { ...message, status: 'running', result: undefined })
    try {
      saveResult(manager.id, message.id, await getManagerActionResult(manager.id, message))
    } catch (error) {
      saveResult(manager.id, message.id, { ...message, status: 'running', result: undefined }, error instanceof Error ? error.message : String(error))
    }
    if (ownsFocus && document.activeElement === document.body) heading.current?.focus({ preventScroll: true })
  }, [manager.id, saveResult, heading])
  const onDecide = useCallback<DecideAction>(async (actionId, decision, opts) => {
    const message = messages.find((message) => message.id === actionId)
    if (message?.kind !== 'action') throw new Error('This approval is no longer available. Refresh the page.')
    const active = document.activeElement
    const startedHere = active?.closest('[data-action-id]')?.getAttribute('data-action-id') === actionId
      || (!opts?.onlyIfStale && Boolean(active?.closest('[data-slot="manager-action-sheet"]')))
    const restoreFocus = () => {
      const card = document.activeElement?.closest('[data-slot="manager-action"]')
      if (card?.getAttribute('data-action-id') === actionId || (startedHere && document.activeElement === document.body)) {
        heading.current?.focus({ preventScroll: true })
      }
    }
    // Keep decisions at page scope: the summary can reach zero and unmount the pending list
    // before the HTTP response or its final failed/done message arrives.
    if (!opts?.onlyIfStale) saveResult(manager.id, actionId, { ...message, status: 'running', result: undefined })
    const result = await decideManagerAction(manager.id, actionId, decision, opts).catch((error: unknown) => {
      // A stale check's 409 means "still open": the card stays, so focus inside it stays too.
      if (!opts?.onlyIfStale) {
        saveResult(manager.id, actionId)
        restoreFocus()
      }
      throw error
    })
    // The resolved card leaves this pending-only list. Keep keyboard focus on the page instead
    // of losing it to <body>, without stealing focus from a reader who moved elsewhere.
    // SSE may remove the card before its decision response reaches the browser.
    restoreFocus()
    if (!opts?.onlyIfStale) await readResult(message)
    await Promise.allSettled([
      client.invalidateQueries({ queryKey: managerKeys.approvals(manager.id) }),
      client.invalidateQueries({ queryKey: managerKeys.list }),
      refreshManagerChat(client, manager.id),
    ])
    return result
  }, [client, manager.id, heading, messages, saveResult, readResult])
  useDismissStaleMerges(manager.pendingActions > 0 ? pending.data ?? [] : [], onDecide)
  if (manager.pendingActions === 0 && results.length === 0) return null
  return (
    <ManagerProjectsContext.Provider value={connected}>
      <section aria-label={manager.name} className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} className="size-8" />
          <h2 className="min-w-0 flex-1 truncate font-semibold">{manager.name}</h2>
          <Button asChild variant="outline" className="shrink-0 max-md:min-h-11">
            <Link to={`/manager/${encodeURIComponent(manager.id)}#needs-you`} aria-label={`Open chat with ${manager.name}`}>Open chat</Link>
          </Button>
        </div>
        {manager.pendingActions > 0 ? <CacheStatusChip queryKey={managerKeys.approvals(manager.id)} isFetching={pending.isFetching} isError={pending.isError} className="self-start" /> : null}
        {manager.pendingActions > 0 && pending.isPending ? <LoadingState label={`Loading approvals from ${manager.name}…`} /> : null}
        {manager.pendingActions > 0 && pending.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
            <p>Couldn’t load approvals from {manager.name}.</p>
            <Button variant="outline" onClick={() => void pending.refetch()}>Retry</Button>
          </div>
        ) : null}
        {messages.map((message) => {
          if (message.kind !== 'action') return null
          const error = results.find((row) => row.message.id === message.id)?.readError
          return error ? (
            <div key={message.id} data-result-id={message.id} role="alert" className="flex flex-col gap-2 rounded-xl border border-danger/45 bg-card p-3.5 text-sm">
              <p>Couldn’t load the result for {actionTitle(message.action)}. Your decision may have completed.</p>
              <p>{error}</p>
              <Button variant="outline" className="self-start max-md:min-h-11" onClick={() => void readResult(message)}>Retry result</Button>
            </div>
          ) : <ActionCard key={message.id} origin={{ id: manager.id, name: manager.name }} message={message} onDecide={onDecide} />
        })}
        {pending.data?.length === 0 && results.length === 0 && !pending.isError ? <p className="text-sm text-muted-foreground">No pending approvals from this manager.</p> : null}
      </section>
    </ManagerProjectsContext.Provider>
  )
}

/** Global pending action cards, independent of any chat's loaded history or unread state. */
export function ManagerApprovalsRoute() {
  const enabled = useHealth().data?.capabilities.managers === true
  const managers = useManagers(enabled)
  const heading = useRef<HTMLHeadingElement>(null)
  const [results, setResults] = useState<DecisionResult[]>([])
  const saveResult = useCallback<SaveResult>((managerId, actionId, message, readError) => {
    setResults((rows) => {
      const others = rows.filter((row) => row.managerId !== managerId || row.message.id !== actionId)
      return message ? [...others, { managerId, message, ...(readError ? { readError } : {}) }] : others
    })
  }, [])
  const ordered = orderManagers(managers.data?.managers ?? [])
  const visibleResults = results.filter((row) => ordered.some((manager) => manager.id === row.managerId))
  const count = ordered.reduce((sum, manager) => sum + manager.pendingActions, 0)
  return (
    <div data-route="manager-approvals" className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-6">
      <header className="flex flex-col gap-1">
        <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">Approvals</h1>
        <p role="status" className="text-sm text-muted-foreground">{managers.data ? `${count} pending ${count === 1 ? 'approval' : 'approvals'} across all managers` : managers.isError ? 'Pending approvals across all managers' : 'Loading approvals…'}</p>
        {visibleResults.some((row) => row.message.status !== 'running' || row.readError) ? (
          <Button variant="ghost" className="mt-1 self-start max-md:min-h-11" onClick={() => {
            setResults((rows) => rows.filter((row) => row.message.status === 'running' && !row.readError))
            heading.current?.focus({ preventScroll: true })
          }}>Clear results</Button>
        ) : null}
      </header>
      <CacheStatusChip queryKey={managerKeys.list} isFetching={managers.isFetching} isError={managers.isError} className="self-start" />
      {managers.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
          <p>Couldn’t load managers.</p>
          <Button variant="outline" onClick={() => void managers.refetch()}>Retry</Button>
        </div>
      ) : null}
      {!managers.data && managers.isPending ? <LoadingState label="Loading managers…" /> : null}
      {managers.data && count === 0 && visibleResults.length === 0 ? (
        <CenteredState heading="h2" icon={<CheckCheckIcon aria-hidden="true" />} title="No pending approvals" subtitle="Approval requests from all your managers appear here. Questions stay in each manager’s chat." />
      ) : null}
      {ordered.map((manager) => <ManagerApprovals key={manager.id} manager={manager} heading={heading} results={results.filter((row) => row.managerId === manager.id)} saveResult={saveResult} />)}
    </div>
  )
}
