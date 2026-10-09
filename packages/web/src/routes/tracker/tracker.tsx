import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { AlertTriangleIcon, ArrowLeftIcon, CheckIcon, CircleDotIcon, ExternalLinkIcon, MoreHorizontalIcon, PlayIcon, RefreshCwIcon, SearchIcon, SettingsIcon, TicketIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { useParams } from 'react-router'

import type { TrackerAssociation, TrackerItem, TrackerItemResponse } from '@open-mercato/cezar-api-client'
import { IssueBrowserEmpty, IssueBrowserLayout } from '@/components/issue-browser-layout'
import { useIsDesktop } from '@/lib/use-desktop'
import { shortAge } from '@/lib/format'
import { cn } from '@/lib/utils'
import { TRACKER_PROVIDERS } from '@/lib/tracker-providers'
import { getTrackerItem } from '@/api/client'
import { useTrackerWatch } from '@/api/tracker-watch'
import { useProjectScope } from '@/api/project-scope-context'
import { queryKeys, TRACKER_STALE_TIME, TrackerRefreshError, useSkills, useTrackerConnection, useTrackerAssociation, useTrackerItem, useTrackerItems, useWorkflows } from '@/api/queries'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'
import { trackerLosses, trackerTaskPrompt } from '@/lib/tracker-task'
import { Markdown } from '../task-thread/markdown'
import { TrackerHandoff, type TrackerHandoffSelection, type TrackerDraftCache } from './tracker-handoff'
import { TrackerLabelFilter } from './tracker-label-filter'

const emptySelection = (): TrackerHandoffSelection => ({ workflow: null, selectedSkills: [], engine: { runner: null, model: null, account: null } })

export function TrackerRoute() {
  const { id } = useParams()
  const { projectId } = useProjectScope()
  const association = useTrackerAssociation()
  const connection = useTrackerConnection()
  const associationKey = `${projectId ?? 'default'}:${association.data?.association ? trackerAssociationKey(association.data.association) : 'none'}`
  // Retain drafts across connection request failures, but never across project/source changes.
  const drafts = useMemo<TrackerDraftCache>(() => new Map(), [associationKey])
  const [savedSelection, setSavedSelection] = useState<{ key: string; value: TrackerHandoffSelection } | null>(null)
  const selection = savedSelection?.key === associationKey ? savedSelection.value : emptySelection()
  const setSelection: React.Dispatch<React.SetStateAction<TrackerHandoffSelection>> = update => setSavedSelection(previous => {
    const current = previous?.key === associationKey ? previous.value : emptySelection()
    return { key: associationKey, value: typeof update === 'function' ? update(current) : update }
  })
  if (association.isPending) return <PageState text="Loading tracker…" loading />
  if (association.isError) return (
    <IssueBrowserEmpty
      icon={<AlertTriangleIcon />}
      tone="danger"
      title="Could not load the tracker"
      description={association.error.message}
      actions={<Button asChild variant="outline"><Link to="/settings/tracker">Open tracker settings</Link></Button>}
    />
  )
  if (!association.data.association) return <SetupState />
  // Connection-bound scopes survive disconnect so Settings can display their selection.
  // They must not mount a browser/watch without the corresponding credentials.
  if (association.data.association.connectionId) {
    if (connection.isPending) return <PageState text="Loading tracker…" loading />
    if (connection.isError) return <div role="alert" className="flex min-h-full flex-col">
      <IssueBrowserEmpty
        icon={<AlertTriangleIcon />}
        tone="danger"
        title="Could not verify the tracker connection."
        description="The connection check did not answer. Your tracker settings are unchanged."
        actions={<Button variant="outline" onClick={() => void connection.refetch()}><RefreshCwIcon aria-hidden="true" />Retry connection</Button>}
      />
    </div>
    if (!connection.data.demo && (
      connection.data.connection?.id !== association.data.association.connectionId
      || connection.data.connection?.kind !== association.data.association.kind
    )) return <SetupState />
  }
  return <TrackerBrowse scopePending={association.isFetching || (!!association.data.association.connectionId && connection.isFetching)} key={associationKey} association={association.data.association} selectedId={id} drafts={drafts} selection={selection} setSelection={setSelection} />
}

function trackerAssociationKey(association: TrackerAssociation): string {
  return `${association.kind}:${association.source.id}:${association.source.webUrl}:${association.externalId}:${association.connectionId ?? 'legacy'}`
}

function SetupState() {
  return (
    <IssueBrowserEmpty
      slot="tracker-setup"
      icon={<TicketIcon />}
      title="Connect an issue tracker"
      description="Choose a project or team from your issue tracker in project settings. Its issues then show up here, ready to hand to an agent."
      actions={<Button asChild variant="primary"><Link to="/settings/tracker"><SettingsIcon aria-hidden="true" />Open tracker settings</Link></Button>}
    />
  )
}

function TrackerBrowse({ scopePending, association, selectedId, drafts, selection, setSelection }: { scopePending: boolean; association: TrackerAssociation; selectedId?: string; drafts: TrackerDraftCache; selection: TrackerHandoffSelection; setSelection: React.Dispatch<React.SetStateAction<TrackerHandoffSelection>> }) {
  const queryClient = useQueryClient()
  const desktop = useIsDesktop()
  const listVisible = desktop || selectedId === undefined
  const [initialSelection, setInitialSelection] = useState<{ filter: string; id: string } | null>(null)
  const [queryDraft, setQueryDraft] = useState('')
  const [query, setQuery] = useState('')
  const [state, setState] = useState<'active' | 'all'>('active')
  const [stateExplicit, setStateExplicit] = useState(false)
  const [labels, setLabels] = useState<string[]>([])
  const result = useTrackerItems(association, { state, labels, query }, listVisible)
  const watch = useTrackerWatch({ association, state, labels, query }, result.queryKey, listVisible)
  const pages = result.data?.pages ?? []
  const failure = pages.find((page) => !page.available)
  const items = pages.flatMap((page) => page.available ? page.items : [])

  const filterKey = JSON.stringify([query, state, labels])
  const initialId = initialSelection?.filter === filterKey ? initialSelection.id : null
  useEffect(() => {
    if (initialId === null && items[0]) setInitialSelection({ filter: filterKey, id: items[0].id })
  }, [initialId, items, filterKey])
  // Pin implicit selection across automatic updates, but reset it for explicit filters.
  const detailId = selectedId ?? (desktop ? initialId : null)
  const provider = TRACKER_PROVIDERS[association.kind].label
  // Mirrors GitHub's refresh (`github.tsx`'s `openThreadRef` cascade): a manual refresh must also
  // reach the item on screen, not just the list — otherwise "refresh" is theatre for whoever is
  // currently reading an issue. The detail query always revalidates the vendor server-side
  // (`withSource(..., true, ...)` in jira.ts/linear.ts's `getItem`), so invalidating is enough.
  const refresh = async () => {
    await (watch.ready ? watch.refresh() : result.restart())
    if (detailId) void queryClient.invalidateQueries({ queryKey: queryKeys.tracker.detail(association, detailId) })
  }

  return <IssueBrowserLayout name="tracker" route="tracker" selected={selectedId !== undefined} list={<>
    <header data-slot="tracker-header" className="sticky top-0 z-10 bg-background/95 px-4 pt-5 pb-3 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] leading-7 font-semibold">{provider}</h1>
          <p className="truncate text-[13px] text-muted-foreground" title={association.externalName}>{association.externalName}</p>
        </div>
        <Button variant="ghost" size="sm" aria-label="Refresh" title={`Refresh from ${provider}`} disabled={watch.checking || result.isFetching} onClick={() => void refresh()} className="shrink-0 font-normal tabular-nums">
          <RefreshCwIcon aria-hidden="true" className={cn((watch.checking || result.isFetching) && 'motion-safe:animate-spin')} />
          {watch.checkedAt ? `Synced ${shortAge(watch.checkedAt)} ago` : 'Refresh'}
        </Button>
        <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
          <Link to="/settings/tracker" aria-label="Connection settings" title="Connection settings"><SettingsIcon aria-hidden="true" /></Link>
        </Button>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <Tabs value={state} onValueChange={(next) => { setState(next === 'all' ? 'all' : 'active'); setStateExplicit(true) }}>
          <TabsList aria-label="Issue state">
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="all">All states</TabsTrigger>
          </TabsList>
        </Tabs>
        <h2 className="shrink-0 text-[13px] font-normal text-muted-foreground tabular-nums">{items.length}{result.hasNextPage ? '+' : ''} {items.length === 1 && !result.hasNextPage ? 'issue' : 'issues'}</h2>
      </div>
      <form className="mt-3 flex items-center gap-2" onSubmit={(event) => {
        event.preventDefault()
        const next = queryDraft.trim()
        const nextState = stateExplicit ? state : next ? 'all' : 'active'
        if (next === query && nextState === state) void refresh()
        else { setQuery(next); setState(nextState) }
      }}>
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon>
          <InputGroupInput type="search" aria-label="Search tracker" maxLength={256} value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="Search issues…" />
          <InputGroupAddon align="inline-end">
            <InputGroupButton type="submit" variant="secondary" disabled={result.isFetching}>Search</InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <TrackerLabelFilter options={items.flatMap(item => item.labels)} selected={labels} onChange={setLabels} />
      </form>
    </header>
    {watch.error ? <p role="status" className="px-4 py-2 text-[13px] text-danger">{watch.error} The displayed list may be outdated.</p> : null}
    {watch.hasChanges ? <div className="mx-3 mb-2 flex items-center gap-3 rounded-lg bg-muted/60 px-3 py-2.5 text-[13px]"><p className="min-w-0 flex-1 text-pretty">New changes are available. Your loaded pages have been preserved.</p><Button size="sm" className="shrink-0" variant="outline" onClick={() => void watch.applyChanges()}>Show changes</Button></div> : null}
    {result.isPending && listVisible ? <PageState text="Loading issues…" loading /> : null}
    {result.isError ? <div className="px-3"><Failure reason={result.error.message} generation={result.errorUpdatedAt} retryAfterSeconds={result.error instanceof TrackerRefreshError && result.error.failure.code === 'rate_limited' ? result.error.failure.retryAfterSeconds : undefined} retry={() => void result.restart()} /></div> : null}
    {failure && !failure.available ? <div className="px-3"><Failure reason={failure.reason} generation={result.dataUpdatedAt} retryAfterSeconds={failure.code === 'rate_limited' ? failure.retryAfterSeconds : undefined} retry={() => void result.restart()} /></div> : null}
    {!result.isPending && !result.isError && !failure && items.length === 0 ? <PageState text={query.trim() ? 'No issues match this search.' : 'No issues in this view.'} /> : null}
    <ul data-slot="tracker-rows" className="flex flex-col gap-px px-2 pb-3">{items.map(item => <TrackerRow scopePending={scopePending} key={item.id} association={association} item={item} active={detailId === item.id} />)}</ul>
    {result.hasNextPage ? <Button className="mx-4 mb-4 shrink-0" variant="outline" onClick={() => void result.fetchNextPage()} disabled={result.isFetchingNextPage}>Load more</Button> : null}
  </>} detail={detailId ? <TrackerDetail scopePending={scopePending} key={`${trackerAssociationKey(association)}:${detailId}`} association={association} id={detailId} drafts={drafts} selection={selection} onSelectionChange={setSelection} /> : <IssueBrowserEmpty icon={<CircleDotIcon />} title="Nothing selected" description="Choose an issue from the list." />} />
}

/** How many label chips a list row shows before folding the rest into "+n". */
const ROW_LABELS = 2

function TrackerRow({ scopePending, association, item, active }: { scopePending: boolean; association: TrackerAssociation; item: TrackerItem; active: boolean }) {
  const queryClient = useQueryClient()
  const key = queryKeys.tracker.detail(association, item.id)
  const preload = () => void queryClient.prefetchQuery({ queryKey: key, queryFn: ({ signal }) => getTrackerItem(item.id, { signal, association }), staleTime: TRACKER_STALE_TIME })
  const drag = (event: DragEvent) => {
    if (scopePending) { event.preventDefault(); return }
    const state = queryClient.getQueryState<TrackerItemResponse>(key)
    const detail = trackerDetailReadyForDrag(queryClient, key)
    if (!detail) {
      event.preventDefault()
      preload()
      toast(
        state?.status === 'error'
          ? 'Full issue detail failed to load. Open the issue to retry.'
          : 'Loading fresh issue detail. Drag again when it is ready.',
        state?.status === 'error' ? { tone: 'danger' } : undefined,
      )
      return
    }
    if (trackerLosses(detail.item).length) {
      event.preventDefault()
      toast('Open this issue to acknowledge snapshot limitations before handoff.', { tone: 'danger' })
      return
    }
    event.dataTransfer.setData('text/plain', trackerTaskPrompt(detail.item))
    event.dataTransfer.effectAllowed = 'copy'
  }
  const shownLabels = item.labels.slice(0, ROW_LABELS)
  const hiddenLabels = item.labels.length - shownLabels.length
  return <li><Link to={`/tracker/${encodeURIComponent(item.id)}`} draggable onMouseEnter={preload} onFocus={preload} onDragStart={drag} data-slot="tracker-row" aria-current={active ? 'page' : undefined} title="Drag into the composer to prefill a task" className={cn('flex min-h-14 gap-2.5 rounded-lg px-2.5 py-2.5 transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60', active && 'bg-muted hover:bg-muted')}>
    <CircleDotIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className={cn('line-clamp-2 text-[13.5px] leading-snug font-medium text-pretty', active && 'font-semibold')}>{item.title}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums"><span className="shrink-0">{item.id}</span><span aria-hidden="true">·</span><span className="min-w-0 truncate">{item.author}</span><span aria-hidden="true">·</span><span className="shrink-0" title={new Date(item.updatedAt).toLocaleString()}>{shortAge(item.updatedAt)}</span></span>
      <span className="flex flex-wrap items-center gap-1 pt-0.5"><Badge variant="secondary" className="px-1.5 py-0 font-normal">{item.status}</Badge>{shownLabels.map(label => <LabelChip key={label} label={label} />)}{hiddenLabels > 0 ? <span title={item.labels.slice(ROW_LABELS).join(', ')} className="text-xs text-muted-foreground tabular-nums">+{hiddenLabels}</span> : null}</span>
    </span>
  </Link></li>
}

function LabelChip({ label }: { label: string }) {
  return <Badge variant="outline" className="max-w-40 px-1.5 py-0 font-normal text-muted-foreground"><span className="truncate">{label}</span></Badge>
}

export function trackerDetailReadyForDrag(
  queryClient: QueryClient,
  key: QueryKey,
  now = Date.now(),
): TrackerItemResponse & { available: true } | null {
  const state = queryClient.getQueryState<TrackerItemResponse>(key)
  if (
    state?.status !== 'success'
    || state.fetchStatus !== 'idle'
    || state.isInvalidated
    || state.dataUpdatedAt <= 0
    || now - state.dataUpdatedAt >= TRACKER_STALE_TIME
    || !state.data?.available
  ) return null
  return state.data
}

function TrackerDetail({ scopePending, association, id, selection, onSelectionChange, drafts }: { scopePending: boolean; drafts: TrackerDraftCache; association: TrackerAssociation; id: string; selection: TrackerHandoffSelection; onSelectionChange: React.Dispatch<React.SetStateAction<TrackerHandoffSelection>> }) {
  const detail = useTrackerItem(association, id)
  const workflows = useWorkflows()
  const skills = useSkills()
  const [lastItem, setLastItem] = useState<TrackerItem | null>(null)
  useEffect(() => {
    if (detail.data?.available) setLastItem(detail.data.item)
  }, [detail.data])
  const [handOpen, setHandOpen] = useState(false)
  const [queuedRunId, setQueuedRunId] = useState<string | null>(null)
  const failure = detail.isError
    ? <Failure reason={detail.error.message} generation={detail.errorUpdatedAt} retry={() => void detail.refetch()} />
    : detail.data && !detail.data.available
      ? <Failure reason={detail.data.reason} generation={detail.dataUpdatedAt} retryAfterSeconds={detail.data.code === 'rate_limited' ? detail.data.retryAfterSeconds : undefined} retry={() => void detail.refetch()} />
      : null
  // Keep the composer's context through a failed refresh; retained context is never launchable.
  const item = detail.data?.available ? detail.data.item : lastItem
  if (!item) return <div className="mx-auto w-full max-w-3xl px-4 pt-5 md:px-10 md:pt-8"><DetailBackLink />{detail.isPending ? <PageState text="Loading full issue detail…" loading /> : failure}</div>
  const providerLabel = TRACKER_PROVIDERS[association.kind].label
  const losses = trackerLosses(item)
  return (
    <article data-slot="tracker-detail-inner" className="mx-auto w-full max-w-3xl min-w-0 px-4 pt-5 pb-12 md:px-10 md:pt-8">
      <DetailBackLink />
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-72 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
            <Badge variant="secondary" className="font-medium">{item.status}</Badge>
            <span>Issue <span className="tabular-nums">{item.id}</span></span>
          </div>
          <h2 className="text-[22px] leading-7 font-semibold text-pretty">{item.title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {queuedRunId ? (
            <Button asChild variant="outline">
              <Link to={`/tasks/${queuedRunId}`}><CheckIcon aria-hidden="true" className="text-success" />Queued — view task</Link>
            </Button>
          ) : null}
          <Button variant={queuedRunId ? 'outline' : 'primary'} data-action="tracker-hand-open" onClick={() => setHandOpen(true)}>
            <PlayIcon aria-hidden="true" />
            Hand to agent
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions for this issue"><MoreHorizontalIcon aria-hidden="true" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem asChild>
                <a href={item.url} target="_blank" rel="noopener noreferrer"><ExternalLinkIcon aria-hidden="true" />Open on {providerLabel}</a>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void detail.refetch()}><RefreshCwIcon aria-hidden="true" />Refresh issue</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(item.url).then(() => toast('Link copied'))}>Copy link</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <dl className="mt-5 grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-[13px]">
        <dt className="text-muted-foreground">Author</dt>
        <dd>{item.author}</dd>
        <dt className="text-muted-foreground">Opened</dt>
        <dd title={new Date(item.createdAt).toLocaleString()}>{shortAge(item.createdAt)} ago</dd>
        <dt className="text-muted-foreground">Updated</dt>
        <dd title={new Date(item.updatedAt).toLocaleString()}>{shortAge(item.updatedAt)} ago</dd>
        {item.labels.length > 0 ? <>
          <dt className="text-muted-foreground">Labels</dt>
          <dd className="flex flex-wrap gap-1">{item.labels.map(label => <LabelChip key={label} label={label} />)}</dd>
        </> : null}
      </dl>
      {failure}
      {losses.length ? (
        <Alert className="mt-5">
          <AlertTriangleIcon className="text-pending-strong" />
          <AlertTitle>This snapshot is incomplete.</AlertTitle>
          <AlertDescription>Review the limitations in the handoff panel.</AlertDescription>
        </Alert>
      ) : null}
      <section data-slot="tracker-body" className="mt-6 border-t border-border pt-6 text-sm leading-relaxed"><Markdown>{item.body.trim() || '*No description was provided.*'}</Markdown></section>
      <Dialog open={handOpen} onOpenChange={setHandOpen}>
        <DialogContent data-slot="tracker-hand-dialog" className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Hand to agent</DialogTitle>
            <DialogDescription className="line-clamp-2">{item.id} — {item.title}</DialogDescription>
          </DialogHeader>
          <TrackerHandoff scopePending={scopePending} key={`${trackerAssociationKey(association)}:${item.id}`} item={item} detailUnavailable={detail.isError || !detail.data?.available} drafts={drafts} selection={selection} onSelectionChange={onSelectionChange} workflows={workflows.data?.workflows ?? []} skills={skills.data ?? []} onQueued={(runId) => { setQueuedRunId(runId); if (runId) setHandOpen(false) }} />
        </DialogContent>
      </Dialog>
    </article>
  )
}

function Failure({ reason, retry, retryAfterSeconds = 0, generation }: { reason: string; retry: () => void; retryAfterSeconds?: number; generation: number }) {
  const [cooldown, setCooldown] = useState(retryAfterSeconds)
  useEffect(() => setCooldown(retryAfterSeconds), [reason, retryAfterSeconds, generation])
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1_000)
    return () => window.clearInterval(timer)
  }, [cooldown > 0])
  return <Alert variant="destructive" className="mt-5">
    <AlertTriangleIcon />
    <AlertTitle>{reason}</AlertTitle>
    <AlertDescription>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={cooldown > 0} onClick={retry}><RefreshCwIcon aria-hidden="true" />{cooldown > 0 ? `Retry in ${cooldown}s` : 'Retry'}</Button>
        <Button asChild variant="ghost" size="sm"><Link to="/settings/tracker">Tracker settings</Link></Button>
      </div>
    </AlertDescription>
  </Alert>
}

function PageState({ text, danger = false, loading = false }: { text: string; danger?: boolean; loading?: boolean }) {
  return <div className={cn('flex items-center justify-center gap-2 p-8 text-center text-[13px]', danger ? 'text-danger' : 'text-muted-foreground')}>{loading ? <Spinner /> : null}{text}</div>
}

function DetailBackLink() {
  return <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2.5 md:hidden"><Link to="/tracker"><ArrowLeftIcon aria-hidden="true" />Back to the list</Link></Button>
}
