import { hashKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CircleCheckIcon,
  CheckIcon,
  CircleIcon,
  CircleDotIcon,
  CircleXIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  TagIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useParams } from 'react-router'

import { Link, Navigate } from '@/lib/project-router'

import { getGithub, getGithubComments, getGithubPrChanges, getGithubPrMergeState, mergeGithubPr, putUiState } from '@/api/client'
import { queryKeys, useGithub, useGithubChecks, useGithubComments, useGithubPrChanges, useHealth, useSkills, useUiState, useWorkflows } from '@/api/queries'
import type {
  GithubComment,
  GithubItem,
  GithubTimelineEvent,
  GithubTimelineEventKind,
  GithubMergeMethod,
  GithubPrMergeState,
  UiState,
} from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Diff, type DiffFileChange } from '@/components/diff'
import type { EnginePick } from '@/components/engine-pills'
import { GithubIcon } from '@/components/icons'
import { TabLink } from '@/components/tab-link'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'
import { githubTaskPrompt } from '@/lib/github-task'
import { orderSkillsByUsage } from '@/lib/skills'
import { cn, isHttpUrl } from '@/lib/utils'

import { Markdown } from '../task-thread/markdown'
import { allLabels, filterGithubItems, labelChipStyle } from './github-filter'
import { GithubLoading } from './github-loading'
import { HandToAgent } from './hand-to-agent'
import { readFollowupSelection, writeFollowupSelection } from './hand-to-agent-draft'

/**
 * `/github` — the forge tab rebuilt in React (R6 Step 1.1, spec §"GitHub tab (forge tab)"):
 * functionally the legacy tab — issues/PRs lists, a detail pane with markdown body + label
 * chips + checks badge, drag-to-composer, hand-to-agent — with the chip walls replaced by
 * searchable cmdk dropdowns (#385) and every surface a URL: `/github` (issues),
 * `/github/prs`, `/github/issues/:n`, `/github/prs/:n`. PR rows also carry a compact checks
 * glyph (#400) — the same tones as the detail pane's `ChecksBadge`, just the symbol.
 *
 * Data loads in ONE fast shot (#664): the list call no longer fetches `statusCheckRollup` — the
 * CI rollup for every open PR was the dominant cost and forced the old two-shot `30 → 1000`
 * pattern — so a single `limit`-capped fetch paints the whole open set quickly and search works
 * across it immediately. Each PR row's checks glyph is then hydrated lazily, for the on-screen
 * rows only, via `useGithubChecks` (`GET /api/github/checks`), the same way comment counts fill
 * in a beat later. A cheap React-Query prefetch on row hover/focus warms the thread so an opened
 * item is usually instant. (Cursor pagination + "Load more"/infinite scroll + row virtualization
 * are the Phase 2 follow-up.)
 *
 * Gating: the nav item is hidden by the shell when health reports no forge — but the URL
 * stays reachable (pasted links), so an unavailable payload renders the honest explainer
 * with the server's own reason, never an error.
 */

/** The single fast list fetch (`/api/github` limit). No longer split into a fast batch + a slow
 *  everything-open shot — dropping `statusCheckRollup` from the list made one fetch of the whole
 *  open set cheap. A count AT this cap still reads `N+`, since the open set may exceed it. */
const LIST_LIMIT = 1000

/** How many on-screen PR rows one checks request covers (matches the server's `GH_CHECKS_MAX`).
 *  The visible window is hydrated first; without virtualization (Phase 2) rows past this stay
 *  glyph-less, exactly as a PR with no CI would. */
const CHECKS_WINDOW = 100

export type GithubView = 'issues' | 'prs'

/**
 * `/github`'s index (#417): restores the last-selected sub-tab instead of always defaulting
 * to Issues. Only the bare path redirects — `/github/prs` and the `:n` deep links always
 * render exactly what their URL says, memory or not, so a pasted link never surprises.
 *
 * A one-way check, not a live sync: it reads `ui-state.json` once per mount and either renders
 * Issues or hands off to `/github/prs`. It never redirects back to Issues from `/github/prs` —
 * that URL is authoritative on its own.
 */
export function GithubIndexRoute() {
  const uiState = useUiState()
  if (uiState.data?.githubView === 'prs') {
    return <Navigate to="/github/prs" replace />
  }
  return <GithubRoute view="issues" />
}

export function GithubRoute({ view, changes = false }: { view: GithubView; changes?: boolean }) {
  const { n } = useParams()
  // One fast shot now that the list dropped `statusCheckRollup` (#664) — no more fast/full swap.
  const list = useGithub({ limit: LIST_LIMIT })
  // #801: automations are opt-in, so the cross-link into them exists exactly while the server
  // says the feature does — otherwise this tab would advertise a page that only says "off".
  // `capabilities?.` because this tab renders against minimal health payloads too; absent is
  // fail-closed, which is the honest answer while the server has not spoken.
  const automationsAvailable = useHealth().data?.capabilities?.automations === true
  const gh = list.data

  // Lazy checks glyphs for the on-screen PR window (#664). Hooks must run before the early
  // returns below, so derive the PR numbers straight from the list payload rather than the
  // post-filter `items`. The URL-selected PR is pinned into the window so the detail badge
  // hydrates even when it sits past the row cap.
  const selectedNumber = n === undefined ? null : Number.parseInt(n, 10)
  const checkPrNumbers = useMemo(() => {
    if (!gh?.available) return []
    const nums = new Set<number>()
    if (view === 'prs' && selectedNumber !== null && Number.isInteger(selectedNumber)) {
      nums.add(selectedNumber)
    }
    for (const pr of gh.prs) {
      if (nums.size >= CHECKS_WINDOW) break
      nums.add(pr.number)
    }
    return [...nums]
  }, [gh, view, selectedNumber])
  const checksQuery = useGithubChecks(checkPrNumbers, view === 'prs')
  const checksMap = checksQuery.data?.available ? checksQuery.data.checks : undefined

  const queryClient = useQueryClient()

  // Persist the tab choice (#417), mirroring the appearance provider's read-then-write
  // pattern. The cache is patched BEFORE the PUT resolves — not just for optimism, but so
  // `GithubIndexRoute`'s check (which reads the same cache) sees the new choice immediately
  // if the click just navigated `/github/prs` → `/github`: without the eager patch it would
  // still read the stale "prs" and bounce the Issues tab straight back.
  const saveGithubView = (next: GithubView) => {
    queryClient.setQueryData<UiState>(queryKeys.uiState, (prev) => ({ ...prev, githubView: next }))
    putUiState({ githubView: next })
      .then((merged) => queryClient.setQueryData(queryKeys.uiState, merged))
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        // The write failed — fall back to the server's truth rather than keep the tab
        // claiming a persistence it never got.
        void queryClient.invalidateQueries({ queryKey: queryKeys.uiState })
      })
  }

  // The thread actually ON SCREEN, so a manual refresh can bust its SERVER cache.
  //
  // Deliberately a ref fed from the rendered `selected`, NOT derived from the `:n` route param.
  // With no `:n` the tab still renders a thread — `selected` falls back to `items[0]` (see below,
  // legacy behavior) — so keying off the URL would leave the bare `/github` and `/github/prs`
  // routes, i.e. the default landing pages, refreshing nothing. A ref because this mutation is
  // defined before `selected` exists and reads it at click time, not render time.
  const openThreadRef = useRef<{ kind: 'issue' | 'pr'; number: number } | null>(null)

  const refresh = useMutation({
    mutationFn: () => getGithub({ refresh: true, limit: LIST_LIMIT }),
    onSuccess: (data) => {
      // One list query now (#664) — patch it directly, then re-hydrate the visible checks window
      // so glyphs track the fresh rows (they carry their own ≤60 s cache server-side).
      queryClient.setQueryData(queryKeys.github({ limit: LIST_LIMIT }), data)
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubChecks(checkPrNumbers) })

      // The open thread must be re-fetched with `refresh: true` (#525). Invalidating its key is
      // NOT enough, and was the bug in the first attempt: an invalidate re-requests
      // `/api/github/comments/…` WITHOUT `refresh=1`, and the route only busts `commentsCache`
      // when that param is present — so the client dutifully refetched and was handed the same
      // ≤60 s-old object. Pressing refresh has to reach `gh`, or it is theatre.
      const open = openThreadRef.current
      if (!open) {
        // No thread on screen (the unavailable branch) — nothing mounted, so clearing is free.
        void queryClient.removeQueries({ queryKey: ['github', 'comments'] })
        return
      }
      const openKey = queryKeys.githubComments(open.kind, open.number)
      // Fire-and-forget rather than awaited in `mutationFn`: a thread fetch that fails must not
      // discard an already-successful list refresh.
      void getGithubComments(open.kind, open.number, { refresh: true })
        .then((thread) => queryClient.setQueryData(openKey, thread))
        .catch(() => {
          /* the list refresh still landed; leave the thread showing what it has */
        })
      // Every OTHER cached thread is now suspect but not on screen — drop it so it refetches when
      // next opened. The open one MUST be excluded: removing a mounted query resets it to pending
      // and flashes the loading skeleton under the user.
      void queryClient.removeQueries({
        queryKey: ['github', 'comments'],
        predicate: (q) => q.queryHash !== hashKey(openKey),
      })
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

  // Pickers + queued-run bookkeeping live at the route so they survive switching items
  // (legacy parity) — see HandToAgent's doc block. Initial value comes from the localStorage
  // "remembered last selection" (#408): a repeat hand-off is one action, and it now survives a
  // page reload too — previously this was plain route state, gone on refresh.
  const workflows = useWorkflows()
  const skills = useSkills()
  const uiState = useUiState()
  const [workflow, setWorkflow] = useState<string | null>(() => readFollowupSelection().workflow)
  const [selectedSkills, setSelectedSkills] = useState<readonly string[]>(
    () => readFollowupSelection().skills,
  )
  // The backend choice (#401) is a way of working too, so it lives here beside the pickers —
  // and it must, because HandToAgent is keyed by item and would otherwise reset on every hop.
  // The agent account rides along on the same footing: a per-hand-off choice, route state rather
  // than a persisted one, exactly like the runner and the model beside it.
  const [engine, setEngine] = useState<EnginePick>({ runner: null, model: null, account: null })
  useEffect(() => {
    writeFollowupSelection({ workflow, skills: [...selectedSkills] })
  }, [workflow, selectedSkills])
  // A workflow that no longer exists must not reach the server — the same legacy rule
  // `validSkills` applies to skills (hand-to-agent.tsx). Remembering the pick (#408) gave this
  // state a lifetime beyond the `.ai/workflows/` file that justified it: rename the workflow and
  // every reload restores a name the server 404s on, with no obvious way to clear it. Cockpits
  // for different repos also share one `localhost:<port>` origin (`pickPort`, src/index.ts) and
  // therefore this localStorage key, so the name can arrive from a repo where it does exist.
  // Drop it only once the list has LOADED — an in-flight fetch is not evidence of absence.
  const workflowDefs = workflows.data?.workflows
  useEffect(() => {
    if (!workflowDefs) return
    if (workflow !== null && !workflowDefs.some((def) => def.name === workflow)) setWorkflow(null)
  }, [workflowDefs, workflow])
  // Frequency sort (#408, shared with /new's SourcePill): project-first, then most-selected.
  // Memoized so the picker gets a STABLE array identity across renders that don't actually
  // change the catalog or the usage stats (e.g. toggling a skill re-renders this route).
  const skillsData = skills.data
  const skillUsage = uiState.data?.skillUsage
  const skillList = useMemo(
    () => orderSkillsByUsage(skillsData ?? [], skillUsage),
    [skillsData, skillUsage],
  )
  const [queued, setQueued] = useState<ReadonlyMap<string, string>>(new Map())
  // List filtering (#gh-filter): free-text search (by #id or any text) + a label narrow.
  const [query, setQuery] = useState('')
  const [labelFilter, setLabelFilter] = useState<readonly string[]>([])

  if (!gh) {
    if (list.isError) {
      return (
        <div data-route="github" className="flex min-h-full flex-col">
          <CenteredState
            icon={<TriangleAlertIcon />}
            tone="danger"
            title="Could not load GitHub"
            subtitle={list.error.message}
          />
        </div>
      )
    }
    return <GithubLoading />
  }

  // No thread is mounted on the unavailable path — keep the ref honest rather than stale.
  openThreadRef.current = null

  if (!gh.available) {
    return (
      <div data-route="github" className="flex min-h-full flex-col">
        <CenteredState
          icon={<GithubIcon />}
          tone="neutral"
          title="GitHub is unavailable here"
          subtitle={gh.reason ?? 'unknown reason'}
          actions={
            <Button
              variant="outline"
              data-action="gh-retry"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              Try again
            </Button>
          }
        >
          <p className="text-xs leading-relaxed text-soft-foreground">
            The tab needs the <span className="font-mono">gh</span> CLI, logged in (
            <span className="font-mono">gh auth login</span>), and a repo with a GitHub remote.
            Everything else in cezar works without it.
          </p>
        </CenteredState>
      </div>
    )
  }

  const allItems = view === 'issues' ? gh.issues : gh.prs
  const labelColors = gh.labelColors ?? {}
  const labelOptions = allLabels(allItems)
  const items = filterGithubItems(allItems, { query, labels: labelFilter })
  const filtering = query.trim() !== '' || labelFilter.length > 0
  const number = n === undefined ? null : Number.parseInt(n, 10)
  // No URL selection → the first item, like the legacy tab (rendered, not navigated-to). The
  // selection may point at an item outside the current filter — keep resolving it from the full
  // list so a deep link to #N still opens even while a filter is active.
  const selected =
    number === null ? (items[0] ?? null) : (allItems.find((item) => item.number === number) ?? null)
  // Feed the refresh mutation the thread that is genuinely rendered — including the no-`:n`
  // fallback to items[0], which is what the bare /github and /github/prs routes show.
  openThreadRef.current = selected ? { kind: selected.kind, number: selected.number } : null

  const listPath = view === 'issues' ? '/github' : '/github/prs'

  return (
    // Bounded to the viewport (`h-full min-h-0`) so the PAGE never scrolls — each pane owns its
    // own scroll (`overflow-y-auto`), so scrolling starts inside the issues/PR list (and the
    // detail), and the list header stays pinned. `overscroll-contain` keeps a pane's scroll from
    // chaining out to the shell.
    <div data-route="github" className="flex h-full min-h-0 items-stretch">
      {/* List pane. Below md it IS the page when no item is in the URL, and yields entirely
          to the detail when one is — the same two-surfaces-one-URL rule the git tabs use. */}
      <section
        data-slot="gh-list"
        className={cn(
          'w-full min-h-0 flex-col overflow-y-auto overscroll-contain border-border md:flex md:w-[360px] md:shrink-0 md:border-r',
          n === undefined ? 'flex' : 'hidden',
        )}
      >
        <header data-slot="gh-header" className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 pt-3 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="text-lg font-semibold">GitHub</h1>
            {gh.repo ? (
              <span data-slot="gh-repo" className="min-w-0 truncate font-mono text-[11px] text-soft-foreground">
                {gh.repo}
              </span>
            ) : null}
            {automationsAvailable ? (
              <Link
                to="/automations/new"
                className="ml-auto shrink-0 text-[10px] font-medium text-primary hover:underline"
              >
                Set up automations
              </Link>
            ) : null}
            <button
              type="button"
              data-slot="gh-refresh"
              title="Refresh from GitHub"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
              // The automations link owns the `ml-auto` that pushes this cluster right; with the
              // link gated away this button inherits it, so the header does not re-flow.
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-[10px] font-medium text-soft-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-55',
                !automationsAvailable && 'ml-auto',
              )}
            >
              <RefreshCwIcon
                aria-hidden="true"
                className={cn('size-[9px]', refresh.isPending && 'motion-safe:animate-spin')}
              />
              {gh.syncedAt ? `synced ${shortAge(gh.syncedAt)} ago` : 'refresh'}
            </button>
          </div>
          <div data-slot="gh-tabs" className="mt-2.5 flex items-end gap-1">
            <TabLink to="/github" active={view === 'issues'} onClick={() => saveGithubView('issues')}>
              Issues · {countLabel(gh.issues.length)}
            </TabLink>
            <TabLink to="/github/prs" active={view === 'prs'} onClick={() => saveGithubView('prs')}>
              Pull requests · {countLabel(gh.prs.length)}
            </TabLink>
          </div>
          <div className="mt-2.5 flex items-center gap-2 pb-3">
            <div className="relative min-w-0 flex-1">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-soft-foreground"
              />
              <input
                type="search"
                data-slot="gh-search"
                aria-label={`Search ${view}`}
                placeholder="Search #id, title, author…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-full rounded-md border border-input bg-card py-1 pr-2 pl-7 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>
            <LabelFilter
              options={labelOptions}
              colors={labelColors}
              selected={labelFilter}
              onChange={setLabelFilter}
            />
          </div>
        </header>

        {items.length === 0 ? (
          <p className="px-4 py-4 text-sm text-soft-foreground">
            {filtering
              ? `No ${view === 'issues' ? 'issues' : 'pull requests'} match your filter.`
              : `No open ${view === 'issues' ? 'issues' : 'pull requests'}.`}
          </p>
        ) : (
          <ul data-slot="gh-rows" className="flex flex-col gap-0.5 px-2 py-2">
            {items.map((item) => (
              <GithubRow
                key={item.url}
                item={item}
                view={view}
                colors={labelColors}
                active={selected?.url === item.url}
                queued={queued.has(item.url)}
                checks={item.kind === 'pr' ? checksMap?.[item.number] ?? item.checks : item.checks}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Detail pane. Hidden below md until an item is in the URL. */}
      <section
        data-slot="gh-detail"
        className={cn(
          'min-w-0 min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain',
          n === undefined ? 'hidden md:flex' : 'flex',
        )}
      >
        {selected ? (
          <GithubDetail
            item={selected}
            listPath={listPath}
            colors={labelColors}
            changes={changes}
            checks={selected.kind === 'pr' ? checksMap?.[selected.number] ?? selected.checks : selected.checks}
          >
            <HandToAgent
              key={selected.url}
              item={selected}
              workflows={workflows.data?.workflows ?? []}
              skills={skillList}
              workflow={workflow}
              onWorkflowChange={setWorkflow}
              selectedSkills={selectedSkills}
              onSkillsChange={setSelectedSkills}
              engine={engine}
              onEngineChange={setEngine}
              queuedRunId={queued.get(selected.url) ?? null}
              onQueued={(url, runId) => setQueued((current) => new Map(current).set(url, runId))}
            />
          </GithubDetail>
        ) : (
          <CenteredState
            icon={view === 'issues' ? <CircleDotIcon /> : <GitPullRequestIcon />}
            tone="neutral"
            heading="h2"
            title={number === null ? 'Nothing selected' : 'Not in the open list'}
            subtitle={
              number === null
                ? `No open ${view === 'issues' ? 'issues' : 'pull requests'} to show.`
                : `#${number} is not among the open ${view === 'issues' ? 'issues' : 'pull requests'} — it may be closed, or still outside the fetched batch.`
            }
          />
        )}
      </section>
    </div>
  )
}

/** The exact open count from the single fast fetch — with a `+` only when it hit the list cap, so
 *  a repo with more than `LIST_LIMIT` open items reads honestly as "at least this many". */
function countLabel(count: number): string {
  return `${count}${count >= LIST_LIMIT ? '+' : ''}`
}

function GithubRow({
  item,
  view,
  colors,
  active,
  queued,
  checks,
}: {
  item: GithubItem
  view: GithubView
  colors: Record<string, string>
  active: boolean
  queued: boolean
  /** Resolved checks glyph — the lazily-hydrated value overrides the list's `null` (#664). */
  checks?: GithubItem['checks']
}) {
  const Icon = item.kind === 'issue' ? CircleDotIcon : GitPullRequestIcon
  const queryClient = useQueryClient()

  // Warm the thread on hover/focus (#664) so opening the row is usually instant — best-effort,
  // deduped by React Query, and it re-uses the mounted detail's exact query key/staleTime.
  const prefetchThread = () => {
    void queryClient.prefetchQuery({
      queryKey: queryKeys.githubComments(item.kind, item.number),
      queryFn: ({ signal }) => getGithubComments(item.kind, item.number, {}, { signal }),
      staleTime: 60_000,
    })
  }

  // Drag an issue/PR row into the composer — it prefills the same prompt "Run agent on this
  // issue" uses (legacy parity); a textarea accepts the text/plain payload natively.
  const onDragStart = (event: DragEvent) => {
    try {
      event.dataTransfer.setData('text/plain', githubTaskPrompt(item))
      event.dataTransfer.effectAllowed = 'copy'
    } catch {
      // older engines — the drag just won't carry the prompt
    }
  }

  return (
    <li>
      <Link
        to={`${view === 'issues' ? '/github/issues' : '/github/prs'}/${item.number}`}
        draggable
        onDragStart={onDragStart}
        onMouseEnter={prefetchThread}
        onFocus={prefetchThread}
        data-slot="gh-row"
        data-number={item.number}
        aria-current={active ? 'page' : undefined}
        title="Drag into the composer to prefill a task"
        className={cn(
          'flex flex-col gap-1 rounded-md px-2.5 py-2 transition-colors hover:bg-muted',
          active && 'bg-muted',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon
            aria-hidden="true"
            className={cn('size-3.5 shrink-0', item.kind === 'issue' ? 'text-success' : 'text-violet')}
          />
          <span className={cn('min-w-0 truncate text-[13px] font-medium', active && 'font-semibold')}>
            {item.title}
          </span>
        </span>
        <span className="flex items-center gap-2 pl-[22px] font-mono text-[10.5px] text-muted-foreground">
          <span>#{item.number}</span>
          <span className="min-w-0 truncate">{item.author}</span>
          <span>{shortAge(item.createdAt)}</span>
          <CommentCount count={item.comments} />
          {checks ? <ChecksGlyph checks={checks} /> : null}
          {queued ? (
            <span data-slot="gh-queued-flag" className="font-sans font-medium text-violet">
              ↗ run queued
            </span>
          ) : null}
        </span>
        {item.labels.length > 0 ? (
          <span className="flex flex-wrap gap-1 pl-[22px]">
            {item.labels.map((label) => (
              <LabelChip key={label} label={label} color={colors[label]} />
            ))}
          </span>
        ) : null}
      </Link>
    </li>
  )
}

/** The label narrow: a searchable multi-select of the labels present in the current list. Selected
 *  labels AND together (GitHub semantics), handled by `filterGithubItems`. */
function LabelFilter({
  options,
  colors,
  selected,
  onChange,
}: {
  options: readonly string[]
  colors: Record<string, string>
  selected: readonly string[]
  onChange: (labels: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const toggle = (label: string) =>
    onChange(selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="gh-label-filter"
          disabled={options.length === 0}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md border border-input bg-card px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50',
            selected.length > 0 && 'border-primary/60 text-foreground',
          )}
        >
          <TagIcon aria-hidden="true" className="size-3.5" />
          {selected.length > 0 ? `Labels · ${selected.length}` : 'Labels'}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-60 p-0">
        <Command>
          <CommandInput placeholder="Filter labels…" />
          <CommandList className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height)-3rem))]">
            <CommandEmpty>No labels.</CommandEmpty>
            {selected.length > 0 ? (
              <CommandItem value="__clear__" onSelect={() => onChange([])} className="text-soft-foreground">
                Clear {selected.length} filter{selected.length > 1 ? 's' : ''}
              </CommandItem>
            ) : null}
            {options.map((label) => {
              const on = selected.includes(label)
              return (
                <CommandItem key={label} value={label} onSelect={() => toggle(label)}>
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full border"
                    style={labelChipStyle(colors[label])}
                  />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {on ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : null}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** A single label pill, tinted with its GitHub color (or neutral when unknown). */
function LabelChip({ label, color }: { label: string; color: string | undefined }) {
  return (
    <span
      data-slot="gh-label"
      data-label={label}
      style={labelChipStyle(color)}
      className="rounded-full border px-1.5 py-px text-[10px] font-medium"
    >
      {label}
    </span>
  )
}

function GithubDetail({
  item,
  listPath,
  colors,
  children,
  changes,
  checks,
}: {
  item: GithubItem
  listPath: string
  colors: Record<string, string>
  children: ReactNode
  changes: boolean
  /** Resolved checks glyph — the lazily-hydrated value overrides the list's `null` (#664). */
  checks?: GithubItem['checks']
}) {
  const kindWord = item.kind === 'pr' ? 'pull request' : 'issue'
  const hasDiffStat = item.kind === 'pr' && Boolean(item.additions || item.deletions)
  return (
    <article data-slot="gh-detail-inner" className="min-w-0 px-4 py-4 md:px-7 md:py-5">
      <Link
        to={listPath}
        data-slot="gh-back"
        className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground md:hidden"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
        Back to the list
      </Link>

      <p data-slot="gh-meta" className="flex flex-wrap items-center gap-x-1.5 font-mono text-[10.5px] text-soft-foreground">
        <span>#{item.number}</span>·<span>{kindWord}</span>·<span>opened by {item.author}</span>·
        <span>{shortAge(item.createdAt)} ago</span>
        {item.comments ? (
          <>
            ·<CommentCount count={item.comments} />
          </>
        ) : null}
        {hasDiffStat ? (
          <>
            ·
            <span data-slot="gh-diffstat">
              <span className="text-success">+{item.additions ?? 0}</span>{' '}
              <span className="text-danger">−{item.deletions ?? 0}</span>
            </span>
          </>
        ) : null}
        ·
        {/* href protocol guard (#431): link only for http(s) URLs. */}
        {isHttpUrl(item.url) ? (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            data-slot="gh-open-link"
            className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
          >
            open on GitHub
            <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
          </a>
        ) : (
          <span data-slot="gh-open-link" className="text-muted-foreground">
            open on GitHub
          </span>
        )}
      </p>

      <h2 className="mt-2 text-xl leading-snug font-semibold">{item.title}</h2>

      {item.kind === 'pr' ? (
        <nav aria-label="Pull request detail" className="mt-4 flex border-b border-border">
          <TabLink to={`/github/prs/${item.number}`} active={!changes}>Conversation</TabLink>
          <TabLink to={`/github/prs/${item.number}/changes`} active={changes}>Changes</TabLink>
        </nav>
      ) : null}

      {item.labels.length > 0 || checks ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {item.labels.map((label) => (
            <LabelChip key={label} label={label} color={colors[label]} />
          ))}
          {checks ? <ChecksBadge checks={checks} url={item.url} /> : null}
        </div>
      ) : null}

      {changes && item.kind === 'pr' ? <GithubPrChanges item={item} /> : <>
      <div data-slot="gh-body" className="mt-5 text-sm">
        {item.body ? (
          <Markdown>{item.body}</Markdown>
        ) : (
          <p className="text-soft-foreground">(no description)</p>
        )}
      </div>

      <GithubThread item={item} colors={colors} />

      {item.kind === 'pr' ? <GithubMergeBox number={item.number} /> : null}

      {children}
      </>}
    </article>
  )
}

const mergeLabels: Record<GithubMergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
}

type MergeRequirementState = 'passing' | 'failing' | 'pending' | 'unknown'

function MergeRequirementIcon({ state }: { state: MergeRequirementState }) {
  const iconClass = 'size-4 shrink-0'
  if (state === 'passing') return <CircleCheckIcon aria-hidden="true" data-slot="gh-merge-status-passing" className={cn(iconClass, 'text-success')} />
  if (state === 'failing') return <CircleXIcon aria-hidden="true" data-slot="gh-merge-status-failing" className={cn(iconClass, 'text-danger')} />
  if (state === 'pending') return <LoaderCircleIcon aria-hidden="true" data-slot="gh-merge-status-pending" className={cn(iconClass, 'animate-spin text-warning')} />
  return <CircleIcon aria-hidden="true" data-slot="gh-merge-status-unknown" className={cn(iconClass, 'text-soft-foreground')} />
}

function GithubMergeBox({ number }: { number: number }) {
  const queryClient = useQueryClient()
  const mergeState = useQuery({
    queryKey: queryKeys.githubMergeState(number),
    queryFn: ({ signal }) => getGithubPrMergeState(number, {}, { signal }),
    retry: false,
  })
  const state = mergeState.data?.available ? mergeState.data.mergeState : null
  const [method, setMethod] = useState<GithubMergeMethod | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [overrideRules, setOverrideRules] = useState(false)
  const refreshMergeState = useMutation({
    mutationFn: () => getGithubPrMergeState(number, { refresh: true }),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.githubMergeState(number), data),
    onError: (error) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }),
  })
  const selectedMethod = method && state?.methods.includes(method)
    ? method
    : state?.defaultMethod ?? state?.methods[0] ?? null
  const merge = useMutation({
    mutationFn: () => {
      if (!state || !selectedMethod) throw new Error('No merge method is available.')
      return mergeGithubPr(number, {
        method: selectedMethod,
        expectedHeadSha: state.headSha,
        ...(overrideRules && state.canOverride ? { overrideRules: true } : {}),
      })
    },
    onSuccess: () => {
      setConfirming(false)
      toast(`Pull request #${number} merged`)
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubMergeState(number) })
      // The single list query (#664) — a merged PR drops out of the open set on the next fetch.
      void queryClient.invalidateQueries({ queryKey: queryKeys.github({ limit: LIST_LIMIT }) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubComments('pr', number) })
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubMergeState(number) })
    },
  })

  if (mergeState.isPending) {
    return <Skeleton data-slot="gh-merge-loading" className="mt-6 h-32 w-full" />
  }
  if (!state) {
    return (
      <section data-slot="gh-merge-unavailable" className="mt-6 rounded-lg border border-border bg-card p-4 text-sm">
        <p className="font-medium">Merge status unavailable</p>
        <p className="mt-1 text-xs text-soft-foreground">
          {mergeState.data?.available === false ? mergeState.data.reason : 'GitHub could not load merge requirements.'}
        </p>
      </section>
    )
  }

  const title =
    state.state === 'merged' ? 'Merged'
      : state.state === 'closed' ? 'Closed'
        : state.isDraft ? 'Draft'
          : state.mergeable === 'conflicting' ? 'Conflicts must be resolved'
            : state.canMerge ? 'Ready to merge'
              : 'Merge blocked'
  const reviewState: MergeRequirementState =
    state.reviewDecision === 'approved' ? 'passing'
      : state.reviewDecision === 'unknown' ? 'unknown'
        : 'failing'
  const conflictState: MergeRequirementState =
    state.mergeable === 'mergeable' ? 'passing'
      : state.mergeable === 'conflicting' ? 'failing'
        : 'unknown'
  const mergeEnabled = Boolean(selectedMethod && (state.canMerge || (state.canOverride && overrideRules)))

  return (
    <section data-slot="gh-merge-box" aria-live="polite" className="mt-6 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        {state.canMerge ? (
          <CheckIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />
        ) : (
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{title}</h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={refreshMergeState.isPending}
              onClick={() => refreshMergeState.mutate()}
            >
              <RefreshCwIcon aria-hidden="true" className={cn('size-3.5', refreshMergeState.isPending && 'animate-spin')} />
              Refresh
            </Button>
          </div>
          <p className="mt-1 font-mono text-[11px] text-soft-foreground">
            {state.headRef} ({state.headSha.slice(0, 7)}) → {state.baseRef}
          </p>
          <ul className="mt-3 space-y-2 text-xs">
            <li className="flex items-center gap-2">
              <MergeRequirementIcon state={reviewState} />
              <span>Reviews: {state.reviewDecision.replaceAll('-', ' ')}</span>
            </li>
            <li className="flex items-center gap-2">
              <MergeRequirementIcon state={conflictState} />
              <span>Conflicts: {state.mergeable === 'conflicting' ? 'present' : state.mergeable === 'mergeable' ? 'none' : 'unknown'}</span>
            </li>
            {state.checks.length === 0 ? <li>No checks configured</li> : state.checks.map((check) => (
              <li key={check.name} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <MergeRequirementIcon state={check.state} />
                  <span>{check.name} · {check.state}{check.required === true ? ' · required' : check.required === null ? ' · requiredness unknown' : ''}</span>
                </span>
                {check.url && isHttpUrl(check.url) ? <a href={check.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground underline">details</a> : null}
              </li>
            ))}
            {state.blockers.map((blocker) => <li key={blocker.code} className="text-soft-foreground">{blocker.message}</li>)}
          </ul>
          {state.canOverride ? (
            <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
              <input
                type="checkbox"
                checked={overrideRules}
                onChange={(event) => setOverrideRules(event.target.checked)}
                className="mt-0.5 size-4 accent-primary"
              />
              <span>
                <span className="block font-medium">Merge without waiting for requirements</span>
                <span className="mt-0.5 block text-soft-foreground">GitHub will allow this only if your permissions can bypass the repository rules.</span>
              </span>
            </label>
          ) : null}
          {state.state === 'open' && state.methods.length > 0 ? (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <select
                aria-label="Merge method"
                value={selectedMethod ?? ''}
                onChange={(event) => setMethod(event.target.value as GithubMergeMethod)}
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
              >
                {state.methods.map((candidate) => <option key={candidate} value={candidate}>{mergeLabels[candidate]}</option>)}
              </select>
              <Button disabled={!mergeEnabled} onClick={() => setConfirming(true)}>
                {selectedMethod ? mergeLabels[selectedMethod] : 'Merge'}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent data-slot="gh-merge-confirm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{selectedMethod ? mergeLabels[selectedMethod] : 'Merge'} pull request #{number}?</DialogTitle>
            <DialogDescription>
              This will merge “{state.title}” into {state.baseRef}. GitHub will re-check the exact reviewed head before changing the repository.
              {overrideRules && state.canOverride ? ' You are asking GitHub to bypass unmet repository requirements; GitHub may refuse if your permissions do not allow it.' : ''}
            </DialogDescription>
          </DialogHeader>
          {merge.error ? <p className="text-sm text-danger">{merge.error.message}</p> : null}
          <DialogFooter>
            <Button variant="outline" disabled={merge.isPending} onClick={() => setConfirming(false)}>Cancel</Button>
            <Button disabled={merge.isPending} onClick={() => merge.mutate()}>
              {merge.isPending ? 'Merging…' : selectedMethod ? mergeLabels[selectedMethod] : 'Merge'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function GithubPrChanges({ item }: { item: GithubItem }) {
  const queryClient = useQueryClient()
  const query = useGithubPrChanges(item.number)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const data = query.data
  const files = data?.available
    ? data.files.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase()))
    : []
  const current = files.findIndex((file) => file.path === selected)
  useEffect(() => {
    if (files.length > 0 && !files.some((file) => file.path === selected)) setSelected(files[0]!.path)
  }, [data?.available ? data.headSha : '', filter])
  const refresh = async () => {
    const oldHead = data?.available ? data.headSha : null
    const next = await getGithubPrChanges(item.number, { refresh: true })
    queryClient.setQueryData(['github', 'pr-changes', item.number], next)
    if (next.available && oldHead && oldHead !== next.headSha) {
      setSelected(next.files[0]?.path ?? null)
      toast('The reviewed revision changed.')
    }
  }
  if (query.isPending) return <p aria-live="polite" className="mt-6 text-sm text-muted-foreground">Loading changed files…</p>
  if (query.isError || !data) return <p className="mt-6 text-sm text-danger">Changed files could not be loaded.</p>
  if (!data.available) return <p className="mt-6 text-sm text-muted-foreground">{data.reason}</p>
  const diffFiles: DiffFileChange[] = files.map((file) => ({
    path: file.path,
    ...(file.previousPath ? { oldPath: file.previousPath } : {}),
    status: file.status === 'removed' ? 'deleted' : file.status === 'changed' ? 'modified' : file.status,
    adds: file.additions,
    dels: file.deletions,
    binary: file.patchUnavailableReason === 'binary',
    patch: file.patch ?? '',
  }))
  const fallback = isHttpUrl(item.url) ? `${item.url}/files` : null
  const active = files.find((file) => file.path === selected)
  return (
    <section data-slot="gh-pr-changes" className="mt-5 min-w-0">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <strong>{data.files.length} changed files</strong>
        <span className="text-success">+{data.additions}</span>
        <span className="text-danger">−{data.deletions}</span>
        <span className="font-mono text-muted-foreground" title={data.headSha}>head {data.headSha.slice(0, 8)}</span>
        <Button type="button" variant="outline" size="sm" className="ml-auto min-h-11" onClick={() => void refresh()}>Refresh</Button>
      </div>
      {data.truncated ? <p role="status" className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">{data.reason ?? 'This response is incomplete.'} {fallback ? <a href={fallback} target="_blank" rel="noopener noreferrer" className="underline">Open all files on GitHub</a> : null}</p> : null}
      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="min-w-0">
          <input aria-label="Filter changed files" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm" />
          <select aria-label="Select changed file" value={selected ?? ''} onChange={(e) => setSelected(e.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm lg:hidden">
            {files.map((file) => <option key={file.path}>{file.path}</option>)}
          </select>
          <ul className="mt-2 hidden max-h-[60vh] overflow-auto lg:block">
            {files.map((file) => <li key={file.path}><button type="button" onClick={() => setSelected(file.path)} className={cn('min-h-11 w-full truncate rounded px-2 text-left text-xs', selected === file.path && 'bg-muted font-medium')} title={file.path}>{file.status} · {file.path} <span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span></button></li>)}
          </ul>
        </aside>
        <div className="min-w-0">
          <div className="mb-2 flex justify-end gap-1">
            <Button aria-label="Previous file" variant="outline" size="icon" className="min-h-11 min-w-11" disabled={current <= 0} onClick={() => setSelected(files[current - 1]?.path ?? null)}><ChevronLeftIcon /></Button>
            <Button aria-label="Next file" variant="outline" size="icon" className="min-h-11 min-w-11" disabled={current < 0 || current >= files.length - 1} onClick={() => setSelected(files[current + 1]?.path ?? null)}><ChevronRightIcon /></Button>
          </div>
          {files.length === 0 ? <p className="text-sm text-muted-foreground">No changed files match this filter.</p> : <>
            <Diff files={diffFiles.filter((file) => file.path === selected)} wrap className="min-w-0" />
            {active && !active.patch ? <p className="rounded-b border border-border p-3 text-xs text-muted-foreground">Patch unavailable: {active.patchUnavailableReason ?? 'not-provided'}.</p> : null}
          </>}
        </div>
      </div>
    </section>
  )
}

/** The conversation thread (#499): comments (+ PR review summaries) rendered under the body, each
 *  body through the shared `Markdown` component so images and code fences render exactly as the
 *  issue body does. Lazy — only fetched while this detail view is mounted. Everything degrades:
 *  loading → skeleton, unreachable → one-line reason + "open on GitHub", empty → nothing (the
 *  count badge already said there were none). */
function GithubThread({ item, colors }: { item: GithubItem; colors: Record<string, string> }) {
  const thread = useGithubComments(item.kind, item.number)
  const data = thread.data

  // Interleave client-side (#525): the server returns comments and events as two independently
  // capped arrays and deliberately does NOT merge them — ordering is presentation, and a
  // server-side merge would either reshape the §2-protected response or force a combined cap.
  const entries = useMemo(() => {
    const merged: ThreadRow[] = [
      ...(data?.comments ?? []).map((comment) => ({ row: 'comment' as const, comment })),
      ...(data?.events ?? []).map((event) => ({ row: 'event' as const, event })),
    ]
    // Compare parsed instants, not the raw strings. Both streams are UTC, but at DIFFERENT
    // precisions: events go through `toISOString()` (always milliseconds, `…00.000Z`) while
    // comments keep GitHub's second-precision `…00Z`. A string compare puts `.` (46) before `Z`
    // (90), so an event would always sort above a comment made in the same second — not a
    // tie-break, a systematic bias. Array.prototype.sort is stable, so equal instants keep
    // insertion order (comments first, matching pre-#525 behavior).
    //
    // `normalizeReviews` emits `createdAt: ''` for a review with no `submitted_at` (a pending
    // one), and `Date.parse('')` is NaN. An NaN comparator result coerces to +0, which makes the
    // sort inconsistent rather than crashing — so those rows are pinned to the top explicitly
    // instead of landing wherever the engine happens to leave them.
    const key = (entry: ThreadRow): number => {
      const parsed = Date.parse(at(entry))
      return Number.isNaN(parsed) ? -Infinity : parsed
    }
    return merged.sort((a, b) => key(a) - key(b))
  }, [data?.comments, data?.events])

  if (thread.isPending) {
    return (
      <section data-slot="gh-thread-loading" className="mt-6 border-t border-border pt-5">
        <Skeleton className="mb-3 h-3 w-24" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </section>
    )
  }

  if (!data || !data.available) {
    const reason = data?.reason ?? (thread.error instanceof Error ? thread.error.message : 'could not load comments')
    return (
      <section data-slot="gh-thread-error" className="mt-6 border-t border-border pt-5 text-xs text-soft-foreground">
        <span>Couldn’t load comments — {reason}. </span>
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
        >
          open on GitHub
          <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
        </a>
      </section>
    )
  }

  // An empty thread renders nothing: the count badge already communicated "no discussion", and an
  // empty "Activity" section would be noise on the many quiet issues/PRs. Counts BOTH streams
  // (#525) — keyed on comments alone this would hide the whole feature on its motivating case, a
  // merged PR with commits, labels and a merge event but no conversation.
  if (entries.length === 0) return null

  return (
    <section data-slot="gh-thread" className="mt-6 border-t border-border pt-5">
      <h3
        data-slot="gh-thread-header"
        className="mb-4 text-[11px] font-semibold tracking-wide text-soft-foreground uppercase"
      >
        {/* "Activity", not "Comments": heading a twenty-row list `Comments · 2` would be
            incoherent once events render. The comment count stays as a secondary. This is a
            different surface from the row badge, which still counts comments only. */}
        Activity · {data.comments.length} comment{data.comments.length === 1 ? '' : 's'}
      </h3>
      <ul className="flex flex-col gap-5">
        {groupCommitRuns(entries).map((grouped) =>
          grouped.group === 'commits' ? (
            <CommitGroup key={grouped.commits[0]!.id} commits={grouped.commits} colors={colors} />
          ) : grouped.entry.row === 'comment' ? (
            <ThreadEntry
              key={`${grouped.entry.comment.kind}-${grouped.entry.comment.id}`}
              comment={grouped.entry.comment}
            />
          ) : (
            <EventRow key={grouped.entry.event.id} event={grouped.entry.event} colors={colors} />
          ),
        )}
      </ul>
      {data.truncated ? (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          data-slot="gh-thread-truncated"
          className="mt-4 inline-flex items-center gap-0.5 text-xs text-soft-foreground hover:text-foreground hover:underline"
        >
          thread truncated — open on GitHub
          <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
        </a>
      ) : null}
    </section>
  )
}

/** One row in the interleaved thread (#525) — a conversation comment/review, or a timeline event.
 *  A discriminated union rather than a widened `GithubComment['kind']`, so each branch keeps its
 *  own narrowing. */
export type ThreadRow =
  | { row: 'comment'; comment: GithubComment }
  | { row: 'event'; event: GithubTimelineEvent }

/** Sort key for either row shape. */
const at = (entry: ThreadRow): string =>
  entry.row === 'comment' ? entry.comment.createdAt : entry.event.createdAt

/** A rendered row after commit-run grouping: either a single row, or a run of consecutive commits
 *  by one author that collapses behind an expander. */
export type GroupedRow =
  | { group: 'single'; entry: ThreadRow }
  | { group: 'commits'; commits: GithubTimelineEvent[] }

/**
 * Collapse runs of consecutive `committed` events by the same author (#525), the way github.com
 * does — otherwise a 40-commit PR buries the discussion.
 *
 * Entirely client-side and purely presentational: the wire stays a flat list where every commit
 * keeps its own message and CI glyph, so nothing is lost to a collapse and the heuristic can
 * change without a §2 conversation.
 *
 * A run ends at an author change or at any non-commit row. A run of one is not a group — a lone
 * commit should render as a plain row, not a "1 commit" expander. Exported for unit tests.
 */
export function groupCommitRuns(entries: ThreadRow[]): GroupedRow[] {
  const out: GroupedRow[] = []
  let run: GithubTimelineEvent[] = []

  const flush = () => {
    if (run.length === 0) return
    // A single commit is not a group.
    if (run.length === 1) out.push({ group: 'single', entry: { row: 'event', event: run[0]! } })
    else out.push({ group: 'commits', commits: run })
    run = []
  }

  for (const entry of entries) {
    const isCommit = entry.row === 'event' && entry.event.kind === 'committed'
    if (isCommit && entry.row === 'event') {
      const prev = run[run.length - 1]
      if (prev && prev.actor !== entry.event.actor) flush() // author change ends the run
      run.push(entry.event)
      continue
    }
    flush() // any non-commit row interrupts the run
    out.push({ group: 'single', entry })
  }
  flush()
  return out
}

/** A collapsed run of consecutive commits — `{actor} added {n} commits`, expanding to the
 *  individual rows, each of which keeps its own message and CI glyph. */
function CommitGroup({ commits, colors }: { commits: GithubTimelineEvent[]; colors: Record<string, string> }) {
  const [open, setOpen] = useState(false)
  const actor = commits[0]?.actor ?? '?'

  if (open) {
    return (
      <>
        <li data-slot="gh-commit-group" data-open="true" className="min-w-0">
          <button
            type="button"
            aria-expanded={true}
            onClick={() => setOpen(false)}
            className="flex items-center gap-1.5 font-mono text-[11px] text-soft-foreground hover:text-foreground"
          >
            <span aria-hidden="true">{EVENT_GLYPH.committed}</span>
            <span className="font-sans font-medium text-foreground">{actor}</span>
            <span>added {commits.length} commits</span>
          </button>
        </li>
        {commits.map((commit) => (
          <EventRow key={commit.id} event={commit} colors={colors} />
        ))}
      </>
    )
  }

  return (
    <li data-slot="gh-commit-group" data-open="false" className="min-w-0">
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 font-mono text-[11px] text-soft-foreground hover:text-foreground"
      >
        <span aria-hidden="true">{EVENT_GLYPH.committed}</span>
        <span className="font-sans font-medium text-foreground">{actor}</span>
        <span>added {commits.length} commits</span>
        <span className="shrink-0">{shortAge(commits[commits.length - 1]!.createdAt)}</span>
      </button>
    </li>
  )
}

/** Per-kind glyph. Deliberately text glyphs rather than icon components: `EventRow` is a single
 *  muted line and an icon set would pull it visually level with the comment cards it sits
 *  between. */
const EVENT_GLYPH: Record<GithubTimelineEventKind, string> = {
  committed: '⚙',
  labeled: '◆',
  unlabeled: '◇',
  assigned: '◍',
  unassigned: '◌',
  merged: '⑃',
  closed: '⊘',
  reopened: '⊙',
  head_ref_force_pushed: '↻',
  'cross-referenced': '↗',
  renamed: '✎',
}

/**
 * One timeline event — deliberately NOT a `ThreadEntry`: single line, muted, no card, no avatar
 * block, so events read as connective tissue between comments rather than competing with them.
 * Mirrors github.com's density.
 */
function EventRow({ event, colors }: { event: GithubTimelineEvent; colors: Record<string, string> }) {
  return (
    <li
      data-slot="gh-event-row"
      data-kind={event.kind}
      className={cn(
        'flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-soft-foreground',
        event.kind === 'merged' && 'text-accent-foreground',
      )}
    >
      <span aria-hidden="true" className="shrink-0">
        {EVENT_GLYPH[event.kind]}
      </span>
      <span className="font-sans font-medium text-foreground">{event.actor}</span>
      <EventPhrase event={event} colors={colors} />
      <span className="shrink-0">{shortAge(event.createdAt)}</span>
      {event.url ? (
        <a
          href={event.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`open ${event.kind} on GitHub`}
          className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
        </a>
      ) : null}
    </li>
  )
}

/** The kind-specific middle of an event row. Split out so `EventRow` stays a layout shell and
 *  each phrase can be asserted on its own in tests. */
function EventPhrase({ event, colors }: { event: GithubTimelineEvent; colors: Record<string, string> }) {
  switch (event.kind) {
    case 'committed':
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">committed</span>
          {event.sha ? <span className="shrink-0 text-muted-foreground">{event.sha.slice(0, 7)}</span> : null}
          {event.message ? (
            <span className="truncate font-sans text-foreground">{event.message}</span>
          ) : null}
          <CommitChecks checks={event.checks} />
        </span>
      )
    case 'labeled':
    case 'unlabeled':
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">{event.kind === 'labeled' ? 'added the' : 'removed the'}</span>
          {event.label ? (
            <span
              data-slot="gh-event-label"
              style={labelChipStyle(event.label.color ?? colors[event.label.name])}
              className="max-w-[12rem] truncate rounded-full border px-1.5 py-px font-sans text-[10px]"
            >
              {event.label.name}
            </span>
          ) : null}
          <span className="shrink-0">label</span>
        </span>
      )
    case 'assigned':
    case 'unassigned':
      return (
        <span className="truncate">
          {event.kind === 'assigned' ? 'assigned' : 'unassigned'} {event.subject ?? 'someone'}
        </span>
      )
    case 'merged':
      return <span>merged this</span>
    case 'closed':
      return <span>closed this</span>
    case 'reopened':
      return <span>reopened this</span>
    case 'head_ref_force_pushed':
      return <span>force-pushed</span>
    case 'renamed':
      return <span className="truncate">renamed this to {event.subject ?? '—'}</span>
    case 'cross-referenced':
      return (
        <span className="truncate">
          referenced this in {event.refNumber ? `#${event.refNumber}` : 'another thread'}
          {event.refTitle ? ` ${event.refTitle}` : ''}
        </span>
      )
  }
}

/** The rolled-up CI glyph on a commit row (#525) — reuses `CHECKS_GLYPH`/`CHECKS_TONE`, the same
 *  source of truth as the list row's indicator and the detail pane's badge.
 *
 *  Renders nothing for BOTH `null` (the commit has no CI configured) and `undefined` (the rollup
 *  query failed or was skipped). The two are deliberately distinct values on the wire even though
 *  they look identical here — absence of a glyph should not have to mean "we know there is no CI". */
function CommitChecks({ checks }: { checks: GithubTimelineEvent['checks'] }) {
  if (!checks) return null
  return (
    <span
      data-slot="gh-commit-checks"
      data-checks={checks}
      aria-label={`checks ${checks}`}
      className={cn('shrink-0', CHECKS_TONE[checks])}
    >
      {CHECKS_GLYPH[checks]}
    </span>
  )
}

/** Review-state chip tones — the same success/danger/muted vocabulary the checks badge uses, so
 *  approved reads green and changes-requested reads red without a new color system. */
const REVIEW_CHIP: Record<NonNullable<GithubComment['reviewState']>, { label: string; tone: string }> = {
  approved: { label: 'approved', tone: 'border-success/40 text-success' },
  changes_requested: { label: 'changes requested', tone: 'border-danger/40 text-danger' },
  commented: { label: 'commented', tone: 'border-border text-muted-foreground' },
  dismissed: { label: 'dismissed', tone: 'border-border text-muted-foreground' },
}

/** One thread entry: avatar (letter fallback), author, age, an optional review-state chip, and the
 *  body via the shared `Markdown` component (images/code fences render as in the issue body). */
function ThreadEntry({ comment }: { comment: GithubComment }) {
  const chip = comment.reviewState ? REVIEW_CHIP[comment.reviewState] : null
  return (
    <li data-slot="gh-thread-entry" data-kind={comment.kind} className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] text-soft-foreground">
        <Avatar url={comment.avatarUrl} login={comment.author} />
        <span className="font-sans font-medium text-foreground">{comment.author}</span>
        <span>{shortAge(comment.createdAt)}</span>
        {chip ? (
          <span
            data-slot="gh-review-chip"
            data-review-state={comment.reviewState}
            className={cn('rounded-full border px-1.5 py-px font-sans text-[10px] font-medium', chip.tone)}
          >
            {chip.label}
          </span>
        ) : null}
        <a
          href={comment.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="open comment on GitHub"
          className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
        </a>
      </div>
      <div data-slot="gh-thread-body" className="text-sm">
        {comment.body ? <Markdown>{comment.body}</Markdown> : <p className="text-soft-foreground">(no body)</p>}
      </div>
    </li>
  )
}

/** A 16 px comment avatar. Falls back to a letter block when no URL is known or the image fails to
 *  load (private-repo attachments, deleted avatars) — never a broken-image glyph. */
function Avatar({ url, login }: { url?: string; login: string }) {
  const [failed, setFailed] = useState(false)
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        width={16}
        height={16}
        loading="lazy"
        onError={() => setFailed(true)}
        data-slot="gh-avatar"
        className="size-4 shrink-0 rounded-full"
      />
    )
  }
  return (
    <span
      data-slot="gh-avatar-fallback"
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-semibold text-muted-foreground uppercase"
    >
      {login.slice(0, 1) || '?'}
    </span>
  )
}

/** Glyph + tone shared by the list row's compact indicator and the detail pane's full badge
 *  (#400) — one source of truth so the two surfaces can't drift out of sync. */
type Checks = NonNullable<GithubItem['checks']>
const CHECKS_GLYPH: Record<Checks, string> = { passing: '✓', failing: '✗', pending: '○' }
const CHECKS_TONE: Record<Checks, string> = {
  passing: 'text-success',
  failing: 'text-danger',
  pending: 'text-muted-foreground',
}

/** The comment-count badge (#499): a muted speech-bubble glyph + count, shown on issue/PR rows
 *  and in the detail meta line. Renders nothing for a zero (or absent) count, so quiet items look
 *  exactly as they did before real counts arrived. Shared so the row and detail can't drift. */
function CommentCount({ count }: { count: number }) {
  if (!count) return null
  return (
    <span
      data-slot="gh-comment-count"
      data-count={count}
      aria-label={`${count} comment${count === 1 ? '' : 's'}`}
      className="inline-flex shrink-0 items-center gap-0.5"
    >
      <MessageSquareIcon aria-hidden="true" className="size-3" />
      {count}
    </span>
  )
}

/** The checks badge — the legacy tab's three phrases, tinted by outcome. Links out
 *  to the PR's checks tab on GitHub (issue #415) when a URL is available. */
function ChecksBadge({ checks, url }: { checks: Checks; url?: string }) {
  const className = cn('text-[11px] font-medium', CHECKS_TONE[checks], url && 'hover:underline')
  const label = `${CHECKS_GLYPH[checks]} checks ${checks}`

  if (!url) {
    return (
      <span data-slot="gh-checks" data-checks={checks} className={className}>
        {label}
      </span>
    )
  }

  return (
    <a
      href={`${url}/checks`}
      target="_blank"
      rel="noopener noreferrer"
      data-slot="gh-checks"
      data-checks={checks}
      className={className}
    >
      {label}
    </a>
  )
}

/** The PR row's compact checks indicator (#400) — same tones as `ChecksBadge`, just the glyph
 *  (the row is too narrow for the full phrase). Issues never have `checks`, so this only ever
 *  shows up on PR rows. */
function ChecksGlyph({ checks }: { checks: Checks }) {
  return (
    <span
      data-slot="gh-row-checks"
      data-checks={checks}
      title={`checks ${checks}`}
      aria-label={`checks ${checks}`}
      className={cn('shrink-0 font-sans text-[11px] font-semibold', CHECKS_TONE[checks])}
    >
      {CHECKS_GLYPH[checks]}
    </span>
  )
}
