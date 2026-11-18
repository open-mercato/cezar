import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { AlertTriangleIcon, ArrowLeftIcon, CircleDotIcon, ExternalLinkIcon, LoaderCircleIcon, RefreshCwIcon, SearchIcon, SearchXIcon, SettingsIcon, TicketIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { useParams } from 'react-router'

import type { TrackerAssociation, TrackerItem, TrackerItemResponse } from '@open-mercato/cezar-api-client'
import { IssueBrowserLayout } from '@/components/issue-browser-layout'
import { CenteredState } from '@/components/centered-state'
import { Chip, chipClass } from '@/components/chip'
import { useIsDesktop } from '@/lib/use-desktop'
import { shortAge } from '@/lib/format'
import { cn } from '@/lib/utils'
import { TRACKER_PROVIDERS } from '@/lib/tracker-providers'
import { getTrackerItem } from '@/api/client'
import { useTrackerWatch } from '@/api/tracker-watch'
import { useProjectScope } from '@/api/project-scope-context'
import { queryKeys, TRACKER_STALE_TIME, TrackerRefreshError, useSkills, useTrackerConnection, useTrackerAssociation, useTrackerItem, useTrackerItems, useWorkflows } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
  // Errors are the one template (`CenteredState`): a cause line and one action.
  if (association.isError) return (
    <div data-route="tracker" className="flex min-h-full flex-col">
      <CenteredState
        icon={<TicketIcon />}
        tone="danger"
        title="Could not load the tracker"
        subtitle={association.error.message}
        actions={
          <Button asChild variant="outline">
            <Link to="/settings/integrations">Open tracker settings</Link>
          </Button>
        }
      />
    </div>
  )
  if (!association.data.association) return <SetupState />
  // Connection-bound scopes survive disconnect so Settings can display their selection.
  // They must not mount a browser/watch without the corresponding credentials.
  if (association.data.association.connectionId) {
    if (connection.isPending) return <PageState text="Loading tracker…" loading />
    if (connection.isError) return (
      <div data-route="tracker" role="alert" className="flex min-h-full flex-col">
        <CenteredState
          icon={<TicketIcon />}
          tone="danger"
          title="Could not verify the tracker connection."
          subtitle={connection.error.message}
          actions={<Button variant="outline" onClick={() => void connection.refetch()}>Retry connection</Button>}
        />
      </div>
    )
    if (!connection.data.demo && (
      connection.data.connection?.id !== association.data.association.connectionId
      || connection.data.connection?.kind !== association.data.association.kind
    )) return <SetupState kind={association.data.association.kind} />
  }
  return <TrackerBrowse scopePending={association.isFetching || (!!association.data.association.connectionId && connection.isFetching)} key={associationKey} association={association.data.association} selectedId={id} drafts={drafts} selection={selection} setSelection={setSelection} />
}

/** The provider's own panel in Settings → Integrations. */
function trackerSettingsPath(kind: TrackerAssociation['kind']): string {
  return `/settings/integrations?integration=${kind}`
}

function trackerAssociationKey(association: TrackerAssociation): string {
  return `${association.kind}:${association.source.id}:${association.source.webUrl}:${association.externalId}:${association.connectionId ?? 'legacy'}`
}

function SetupState({ kind }: { kind?: TrackerAssociation['kind'] }) {
  return (
    <div data-route="tracker" className="flex min-h-full flex-col">
      <CenteredState
        icon={<TicketIcon />}
        tone="neutral"
        title="Connect an issue tracker"
        subtitle="Choose a project or team from your issue tracker in project settings."
        actions={
          <Button asChild>
            <Link to={kind ? trackerSettingsPath(kind) : '/settings/integrations'}>Open tracker settings</Link>
          </Button>
        }
      />
    </div>
  )
}

type IssueState = 'active' | 'all'

function TrackerBrowse({ scopePending, association, selectedId, drafts, selection, setSelection }: { scopePending: boolean; association: TrackerAssociation; selectedId?: string; drafts: TrackerDraftCache; selection: TrackerHandoffSelection; setSelection: React.Dispatch<React.SetStateAction<TrackerHandoffSelection>> }) {
  const queryClient = useQueryClient()
  const desktop = useIsDesktop()
  const listVisible = desktop || selectedId === undefined
  const [initialSelection, setInitialSelection] = useState<{ filter: string; id: string } | null>(null)
  const [queryDraft, setQueryDraft] = useState('')
  const [query, setQuery] = useState('')
  const [state, setState] = useState<IssueState>('active')
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
  const refreshing = watch.checking || result.isFetching

  return <IssueBrowserLayout name="tracker" route="tracker" selected={selectedId !== undefined} list={<>
    <header data-slot="tracker-header" className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 pt-3 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="text-lg font-semibold">{provider}</h1>
        <span className="min-w-0 truncate font-mono text-meta text-soft-foreground" title={association.externalName}>{association.externalName}</span>

        {/* Labelled, not icon-only: a secondary action gets a word (checklist, Buttons). Both
            chips share one height and radius — the shared `Chip` grammar. */}
        <Link to={trackerSettingsPath(association.kind)} aria-label="Connection settings" className={cn(chipClass, 'ml-auto shrink-0')}>
          <SettingsIcon aria-hidden="true" className="size-3" />
          Settings
        </Link>
        <IconTooltip label={`Refresh from ${provider}`}>
          <Chip
            data-slot="tracker-refresh"
            aria-label="Refresh"
            disabled={refreshing}
            onClick={() => void refresh()}
            icon={<RefreshCwIcon aria-hidden="true" className={cn('size-3', refreshing && 'motion-safe:animate-spin')} />}
            className="shrink-0"
          >
            {watch.checkedAt ? `synced ${shortAge(watch.checkedAt)} ago` : 'refresh'}
          </Chip>
        </IconTooltip>
      </div>
      <div className="mt-2.5 flex items-center justify-between border-b border-border pb-2">
        <h2 className="text-ui font-medium">Issues · {items.length}{result.hasNextPage ? '+' : ''}</h2>
        {/* The cockpit select (native `<select>` is retired); the same name and semantics. */}
        <Select value={state} onValueChange={(next) => { setState(next as IssueState); setStateExplicit(true) }}>
          <SelectTrigger aria-label="Issue state" data-slot="tracker-state" size="sm" className="text-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="all">All states</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <form className="mt-2.5 flex items-center gap-2 pb-3" onSubmit={(event) => {
        event.preventDefault()
        const next = queryDraft.trim()
        const nextState = stateExplicit ? state : next ? 'all' : 'active'
        if (next === query && nextState === state) void refresh()
        else { setQuery(next); setState(nextState) }
      }}>
        <div className="relative min-w-0 flex-1"><SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-soft-foreground" /><input type="search" aria-label="Search tracker" maxLength={256} className="h-[30px] w-full rounded-md border border-input bg-card pr-2 pl-7 text-ui outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="Search issues…" /></div>
        {/* One height across the row: the field, the button and the filter chip are all 30px. */}
        <Button type="submit" variant="outline" size="sm" disabled={result.isFetching}>Search</Button>
        <TrackerLabelFilter options={items.flatMap(item => item.labels)} selected={labels} onChange={setLabels} />
      </form>
    </header>
    {watch.error ? <p role="status" className="px-4 py-2 text-label text-danger">{watch.error} The displayed list may be outdated.</p> : null}
    {watch.hasChanges ? <div className="m-2 rounded-md border border-border bg-muted/40 p-3 text-label"><p>New changes are available. Your loaded pages have been preserved.</p><Button size="sm" className="mt-2" variant="outline" onClick={() => void watch.applyChanges()}>Show changes</Button></div> : null}
    {result.isPending && listVisible ? <PageState text="Loading issues…" loading /> : null}
    {result.isError ? <Failure kind={association.kind} reason={result.error.message} generation={result.errorUpdatedAt} retryAfterSeconds={result.error instanceof TrackerRefreshError && result.error.failure.code === 'rate_limited' ? result.error.failure.retryAfterSeconds : undefined} retry={() => void result.restart()} /> : null}
    {failure && !failure.available ? <Failure kind={association.kind} reason={failure.reason} generation={result.dataUpdatedAt} retryAfterSeconds={failure.code === 'rate_limited' ? failure.retryAfterSeconds : undefined} retry={() => void result.restart()} /> : null}
    {!result.isPending && !result.isError && !failure && items.length === 0 ? <PageState text={query.trim() ? 'No issues match this search.' : 'No issues in this view.'} empty /> : null}
    <ul data-slot="tracker-rows" className="flex flex-col gap-0.5 px-2 py-2">{items.map(item => <TrackerRow scopePending={scopePending} key={item.id} association={association} item={item} active={detailId === item.id} />)}</ul>
    {result.hasNextPage ? <Button className="mx-4 mb-4 shrink-0" variant="outline" onClick={() => void result.fetchNextPage()} disabled={result.isFetchingNextPage}>Load more</Button> : null}
  </>} detail={detailId ? <TrackerDetail scopePending={scopePending} key={`${trackerAssociationKey(association)}:${detailId}`} association={association} id={detailId} drafts={drafts} selection={selection} onSelectionChange={setSelection} /> : <CenteredState icon={<CircleDotIcon />} tone="neutral" heading="h2" title="Nothing selected" subtitle="Choose an issue from the list." />} />
}

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
  return <li><Link to={`/tracker/${encodeURIComponent(item.id)}`} draggable onMouseEnter={preload} onFocus={preload} onDragStart={drag} data-slot="tracker-row" aria-current={active ? 'page' : undefined} title="Drag into the composer to prefill a task" className={cn('flex flex-col gap-1 rounded-md px-2.5 py-2 transition-colors hover:bg-muted', active && 'bg-muted')}>
    <span className="flex min-w-0 items-center gap-2"><CircleDotIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /><span className={cn('min-w-0 truncate text-ui font-medium', active && 'font-semibold')}>{item.title}</span></span>
    {/* The id is code (mono); the author and age are not. */}
    <span className="flex min-w-0 items-center gap-2 pl-[22px] text-label text-muted-foreground"><span className="shrink-0 font-mono text-micro">{item.id}</span><span className="min-w-0 truncate">{item.author}</span><span className="shrink-0">{shortAge(item.updatedAt)}</span></span>
    <span className="flex flex-wrap gap-1 pl-[22px]"><span className="rounded border border-border px-1.5 py-px text-micro text-muted-foreground">{item.status}</span>{item.labels.map(label => <span key={label} className="rounded-full border border-border px-1.5 py-px text-micro text-muted-foreground">{label}</span>)}</span>
  </Link></li>
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
  const failure = detail.isError
    ? <Failure kind={association.kind} reason={detail.error.message} generation={detail.errorUpdatedAt} retry={() => void detail.refetch()} />
    : detail.data && !detail.data.available
      ? <Failure kind={association.kind} reason={detail.data.reason} generation={detail.dataUpdatedAt} retryAfterSeconds={detail.data.code === 'rate_limited' ? detail.data.retryAfterSeconds : undefined} retry={() => void detail.refetch()} />
      : null
  // Keep the scoped composer mounted through a failed refresh; retained context is never launchable.
  const item = detail.data?.available ? detail.data.item : lastItem
  if (!item) return <div className="p-4"><DetailBackLink />{detail.isPending ? <PageState text="Loading full issue detail…" loading /> : failure}</div>
  return (
    <article data-slot="tracker-detail-inner" className="min-w-0 px-4 py-4 md:px-7 md:py-5">
      <DetailBackLink />
      <p className="flex flex-wrap items-center gap-x-1.5 font-mono text-micro text-soft-foreground">
        <span>{item.id}</span>·<span>issue</span>·<span>opened by {item.author}</span>·
        <IconTooltip label={new Date(item.createdAt).toLocaleString()}>
          <span>{shortAge(item.createdAt)} ago</span>
        </IconTooltip>
        ·
        <a className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline" href={item.url} target="_blank" rel="noopener noreferrer">open on {TRACKER_PROVIDERS[association.kind].label}<ExternalLinkIcon aria-hidden="true" className="size-2.5" /></a>
      </p>
      <h2 className="mt-2 text-xl leading-snug font-semibold">{item.title}</h2>
      <div className="mt-3 flex flex-wrap items-center gap-1.5"><span className="rounded border border-border px-1.5 py-px text-micro text-muted-foreground">{item.status}</span>{item.labels.map(label => <span key={label} className="rounded-full border border-border px-1.5 py-px text-micro text-muted-foreground">{label}</span>)}</div>
      {failure}
      {trackerLosses(item).length ? <div className="mt-4 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"><AlertTriangleIcon className="mr-2 inline size-4" />This snapshot is incomplete. Review the limitations in the handoff panel.</div> : null}
      <section data-slot="tracker-body" className="mt-5 text-sm"><Markdown>{item.body.trim() || '*No description was provided.*'}</Markdown></section>
      <TrackerHandoff scopePending={scopePending} key={`${trackerAssociationKey(association)}:${item.id}`} item={item} detailUnavailable={detail.isError || !detail.data?.available} drafts={drafts} selection={selection} onSelectionChange={onSelectionChange} workflows={workflows.data?.workflows ?? []} skills={skills.data ?? []} />
    </article>
  )
}

/** A failed list or detail read: the one error template — the vendor's reason as the cause
 *  line, Retry as the action (with its rate-limit cooldown), and the settings door underneath. */
function Failure({ kind, reason, retry, retryAfterSeconds = 0, generation }: { kind: TrackerAssociation['kind']; reason: string; retry: () => void; retryAfterSeconds?: number; generation: number }) {
  const [cooldown, setCooldown] = useState(retryAfterSeconds)
  useEffect(() => setCooldown(retryAfterSeconds), [reason, retryAfterSeconds, generation])
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1_000)
    return () => window.clearInterval(timer)
  }, [cooldown > 0])
  return (
    <CenteredState
      heading="h2"
      icon={<AlertTriangleIcon />}
      tone="danger"
      title="Could not reach the tracker"
      subtitle={reason}
      className="py-6"
      actions={
        <Button variant="outline" disabled={cooldown > 0} onClick={retry}>
          <RefreshCwIcon className="size-3.5" />
          {cooldown > 0 ? `Retry in ${cooldown}s` : 'Retry'}
        </Button>
      }
    >
      <Link className="text-label text-violet underline underline-offset-4" to={trackerSettingsPath(kind)}>Tracker settings</Link>
    </CenteredState>
  )
}

/** Loading and empty moments inside the list pane, through the one template. */
function PageState({ text, loading = false, empty = false }: { text: string; loading?: boolean; empty?: boolean }) {
  return (
    <CenteredState
      heading="h2"
      icon={loading ? <LoaderCircleIcon className="motion-safe:animate-spin" /> : empty ? <SearchXIcon /> : <CircleDotIcon />}
      tone="neutral"
      title={text}
      className="py-6"
    />
  )
}

function DetailBackLink() {
  return <Link className="mb-3 inline-flex items-center gap-1.5 text-label font-medium text-muted-foreground hover:text-foreground md:hidden" to="/tracker"><ArrowLeftIcon aria-hidden="true" className="size-3.5" />Back to the list</Link>
}
