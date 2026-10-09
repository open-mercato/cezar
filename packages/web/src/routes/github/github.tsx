import { hashKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  ArrowUpDownIcon,
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
  MoreHorizontalIcon,
  PlayIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  TagIcon,
  ZapIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useParams } from 'react-router'

import { Link, Navigate } from '@/lib/project-router'

import { getGithub, getGithubComments, getGithubPrChanges, getGithubPrMergeState, mergeGithubPr, putUiState } from '@/api/client'
import { queryKeys, useGithub, useGithubChecks, useGithubComments, useGithubPrChanges, useGithubSearch, useHealth, useSkills, useUiState, useWorkflows } from '@/api/queries'
import type {
  GithubComment,
  GithubItem,
  GithubTimelineEvent,
  GithubTimelineEventKind,
  GithubMergeMethod,
  GithubPrMergeState,
  UiState,
} from '@open-mercato/cezar-api-client'
import { IssueBrowserEmpty, IssueBrowserLayout } from '@/components/issue-browser-layout'
import { Diff, type DiffFileChange } from '@/components/diff'
import { useRememberedEnginePick } from '@/components/engine-pills'
import { GithubIcon } from '@/components/icons'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'
import { githubTaskPrompt } from '@/lib/github-task'
import { orderSkillsByUsage } from '@/lib/skills'
import { cn, isHttpUrl } from '@/lib/utils'

import { Markdown } from '../task-thread/markdown'
import {
  allLabels,
  filterGithubItems,
  labelChipStyle,
  shouldSearchForge,
  sortGithubItems,
  type GithubSort,
} from './github-filter'
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

/** How long the search box must be idle before the cross-state fallback (#730) fires. Every
 *  search is a `gh` subprocess against GitHub's rate-limited search API, so this is a cost
 *  control, not a polish detail. */
const SEARCH_DEBOUNCE_MS = 350

/** `value`, but only after it has stopped changing for `delay` ms. Local to this route — the
 *  search fallback is the one place in the cockpit that pays a subprocess per keystroke. */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return settled
}

export type GithubView = 'issues' | 'prs'

/**
 * The GitHub tab itself, and — under `index` — the bare `/github` entry point.
 *
 * **`index` (#417)** restores the last-selected sub-tab instead of always defaulting to Issues.
 * Only the bare path redirects — `/github/prs` and the `:n` deep links always
 * render exactly what their URL says, memory or not, so a pasted link never surprises.
 *
 * A one-way check, not a live sync: it reads `ui-state.json` once per mount and either renders
 * Issues or hands off to `/github/prs`. It never redirects back to Issues from `/github/prs` —
 * that URL is authoritative on its own.
 *
 * It is an `index` FLAG on this component rather than a wrapper component of its own, and that
 * matters: React reconciles by element TYPE at a position, so a `/github` route rendering some
 * other component unmounts `GithubRoute` on the hop to `/github/issues/:n` and takes its state
 * with it — including the search text, which is the only thing that can resolve a cross-state
 * hit (#730). See the `index` early return below.
 */
export function GithubRoute({
  view,
  changes = false,
  index = false,
}: {
  view: GithubView
  changes?: boolean
  /** This is the bare `/github` index (#417): restore the remembered sub-tab before rendering. */
  index?: boolean
}) {
  const { n } = useParams()
  // One fast shot now that the list dropped `statusCheckRollup` (#664) — no more fast/full swap.
  const list = useGithub({ limit: LIST_LIMIT })
  // #801: automations are opt-in, so the cross-link into them exists exactly while the server
  // says the feature does — otherwise this tab would advertise a page that only says "off".
  // `capabilities?.` because this tab renders against minimal health payloads too; absent is
  // fail-closed, which is the honest answer while the server has not spoken.
  const automationsAvailable = useHealth().data?.capabilities?.automations === true
  const gh = list.data

  // The remembered list order (#gh-sort). Read up here, above the checks window below, because
  // that window is "the PRs the user can see" and flipping to oldest-first changes which ones
  // those are. Anything but the stored `oldest` — absent key, old ui-state.json, a value from a
  // newer cockpit — means the default, which is the order `gh` already returns.
  const uiState = useUiState()
  const sort: GithubSort = uiState.data?.githubSort === 'oldest' ? 'oldest' : 'newest'
  const sortedPrs = useMemo(
    () => (gh?.available ? sortGithubItems(gh.prs, sort) : []),
    [gh, sort],
  )

  // Lazy checks glyphs for the on-screen PR window (#664). Hooks must run before the early
  // returns below, so derive the PR numbers from the sorted list payload rather than the
  // post-filter `items`. The URL-selected PR is pinned into the window so the detail badge
  // hydrates even when it sits past the row cap.
  const selectedNumber = n === undefined ? null : Number.parseInt(n, 10)
  const checkPrNumbers = useMemo(() => {
    if (!gh?.available) return []
    const nums = new Set<number>()
    if (view === 'prs' && selectedNumber !== null && Number.isInteger(selectedNumber)) {
      nums.add(selectedNumber)
    }
    for (const pr of sortedPrs) {
      if (nums.size >= CHECKS_WINDOW) break
      nums.add(pr.number)
    }
    return [...nums]
  }, [gh, sortedPrs, view, selectedNumber])
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

  // The list order (#gh-sort), remembered the same way the sub-tab is. A presentation pref, not a
  // fetch parameter: `LIST_LIMIT` pulls the whole open set in one shot, so flipping the order
  // re-renders what is already in hand and never re-slices which items were fetched.
  //
  // Same read-then-write shape as `saveGithubView`, including the eager cache patch — without it
  // the toggle would render the OLD order until the PUT resolved, which on a slow write reads as
  // a click that did nothing.
  const saveGithubSort = (next: GithubSort) => {
    queryClient.setQueryData<UiState>(queryKeys.uiState, (prev) => ({ ...prev, githubSort: next }))
    putUiState({ githubSort: next })
      .then((merged) => queryClient.setQueryData(queryKeys.uiState, merged))
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
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
  const [workflow, setWorkflow] = useState<string | null>(() => readFollowupSelection().workflow)
  const [selectedSkills, setSelectedSkills] = useState<readonly string[]>(
    () => readFollowupSelection().skills,
  )
  // The backend choice (#401) is a way of working too, so it lives here beside the pickers —
  // and it must, because HandToAgent is keyed by item and would otherwise reset on every hop.
  // It is remembered on the same footing as the workflow (#906): route state alone reset it to
  // "never touched" on every mount, and "never touched" is what lets the coding agent's OWN
  // settings file outvote a pick the user makes over and over. The agent ACCOUNT stays per
  // hand-off — its `null` follows the project's selection rather than a native default.
  const [engine, setEngine] = useRememberedEnginePick()
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
  // The hand-off composer opens over the detail; keyed by item url so a hop to another item
  // never carries an open dialog with it.
  const [handFor, setHandFor] = useState<string | null>(null)
  // List filtering (#gh-filter): free-text search (by #id or any text) + a label narrow.
  const [query, setQuery] = useState('')
  const [labelFilter, setLabelFilter] = useState<readonly string[]>([])

  // Cross-state search fallback (#730). The list tier only ever holds OPEN items, so a closed or
  // merged issue/PR is not "past the fetched window" — it was never fetched, and no amount of
  // in-memory filtering reaches it. When the local narrow comes up empty for a non-empty query we
  // ask the forge instead. Like the checks window above, these hooks must sit ABOVE the early
  // returns, so the open set is derived from the payload rather than from the post-filter `items`.
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS)
  // Sorted here rather than at render time so every consumer below — the filter, the row list,
  // the checks window — agrees on one order, and so the up-to-`LIST_LIMIT` sort is paid once per
  // (payload, view, order) instead of on every keystroke.
  const openItems = useMemo(
    () => (gh?.available ? (view === 'issues' ? sortGithubItems(gh.issues, sort) : sortedPrs) : []),
    [gh, view, sort, sortedPrs],
  )
  // Evaluated against the DEBOUNCED query, not the live one: the fallback must be decided by the
  // same text the request will carry, or a fast typist fires a `gh` subprocess per keystroke.
  // Memoized because this walks the whole open set — up to `LIST_LIMIT` rows — and only its three
  // inputs can change the answer; unmemoized it re-filtered that set on every unrelated render,
  // doubling the filtering the render body below already does for the live query (#838).
  const localMatches = useMemo(
    () => filterGithubItems(openItems, { query: debouncedQuery, labels: labelFilter }).length,
    [openItems, debouncedQuery, labelFilter],
  )
  const searchWanted = shouldSearchForge(debouncedQuery, localMatches)
  const forgeSearch = useGithubSearch(view === 'issues' ? 'issue' : 'pr', debouncedQuery, searchWanted)

  // The bare `/github` restores the remembered sub-tab (#417). It lives HERE rather than in a
  // wrapper component so `/github` and `/github/issues/:n` render the same element type: React
  // reconciles by type, so a wrapper made the hop between them a full remount, resetting `query`
  // to '' — and with the query gone, `searchHits` is empty and the cross-state item the user just
  // clicked resolves to "not among the open issues". `/github/prs` and `/github/prs/:n` never had
  // the bug precisely because they already shared one element type. Below the hooks, like every
  // other early return in this component.
  if (index && uiState.data?.githubView === 'prs') {
    return <Navigate to="/github/prs" replace />
  }

  if (!gh) {
    if (list.isError) {
      return (
        <div data-route="github" className="flex min-h-full flex-col">
          <IssueBrowserEmpty
            icon={<TriangleAlertIcon />}
            tone="danger"
            title="Could not load GitHub"
            description={list.error.message}
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
        <IssueBrowserEmpty
          icon={<GithubIcon />}
          title="GitHub is unavailable here"
          description={gh.reason ?? 'unknown reason'}
          actions={
            <Button
              variant="outline"
              data-action="gh-retry"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCwIcon aria-hidden="true" className={cn(refresh.isPending && 'motion-safe:animate-spin')} />
              Try again
            </Button>
          }
        >
          <p className="text-[13px] leading-relaxed text-pretty text-muted-foreground">
            The tab needs the <span className="font-mono text-xs">gh</span> CLI, logged in (
            <span className="font-mono text-xs">gh auth login</span>), and a repo with a GitHub remote.
            Everything else in the cockpit works without it.
          </p>
        </IssueBrowserEmpty>
      </div>
    )
  }

  const allItems = openItems
  const items = filterGithubItems(allItems, { query, labels: labelFilter })
  const filtering = query.trim() !== '' || labelFilter.length > 0
  // Gated on `searchWanted`, not just on the payload: the query key is (kind, text), so flipping
  // `enabled` off does not evict what a previous run cached under the same text. Reading `data`
  // alone therefore kept the hits on screen after the local narrow started matching again —
  // rendering an open item twice, once per list (#856).
  const searchPayload = searchWanted && forgeSearch.data?.available ? forgeSearch.data : null
  // Hits are narrowed by the label filter too — it reads as "narrow whatever is on screen". They
  // also drop anything the list above already shows: `gh search` returns OPEN matches alongside
  // closed and merged ones, and during the debounce window the payload belongs to the previous
  // query text, so without this an open item could occupy both lists at once (#856). "Found on
  // GitHub" only ever means "past the open list", so an overlap is never information.
  const listedNumbers = new Set(items.map((item) => item.number))
  // Sorted by the same control as the list above: the two lists sit one under the other, and an
  // order the user chose that visibly stops applying halfway down the page reads as a bug.
  const searchHits = searchPayload
    ? sortGithubItems(
        filterGithubItems(searchPayload.items, { labels: labelFilter }).filter(
          (item) => !listedNumbers.has(item.number),
        ),
        sort,
      )
    : []
  // "A search is coming or running" — the debounce window counts. Without it, the moment between
  // the last keystroke and the request firing would render the definitive "nothing anywhere",
  // which is the same lie #730 set out to remove, just half a second long.
  const searching =
    (query.trim() !== '' && query.trim() !== debouncedQuery.trim()) ||
    (searchWanted && forgeSearch.isPending)
  // A closed item often wears labels no open one does; its own colors win nothing over the repo
  // map, they only fill the gaps.
  const labelColors = { ...(searchPayload?.labelColors ?? {}), ...(gh.labelColors ?? {}) }
  const labelOptions = allLabels(allItems)
  const number = n === undefined ? null : Number.parseInt(n, 10)
  // No URL selection → the first item, like the legacy tab (rendered, not navigated-to). The
  // selection may point at an item outside the current filter — keep resolving it from the full
  // list so a deep link to #N still opens even while a filter is active. Search hits are the last
  // resort so a found-on-GitHub row is openable in the detail pane like any other.
  const selected =
    number === null
      ? (items[0] ?? searchHits[0] ?? null)
      : (allItems.find((item) => item.number === number) ??
        searchHits.find((item) => item.number === number) ??
        null)
  // Feed the refresh mutation the thread that is genuinely rendered — including the no-`:n`
  // fallback to items[0], which is what the bare /github and /github/prs routes show.
  openThreadRef.current = selected ? { kind: selected.kind, number: selected.number } : null

  const listPath = view === 'issues' ? '/github' : '/github/prs'

  // The forge was asked and could not answer. Two ways that happens, and only the first used to
  // be handled: the driver degraded in-payload (`available: false` + a reason), or the request
  // never landed at all — a 400 on an over-long `q`, a 5xx, a dropped connection. Without the
  // `isError` half a failed request fell through to the definitive "nothing in any state", which
  // is precisely the claim #730 exists to stop the tab from making.
  const searchFailed = searchWanted && (forgeSearch.data?.available === false || forgeSearch.isError)
  const searchFailureReason =
    forgeSearch.data?.available === false
      ? (forgeSearch.data.reason ?? 'unknown reason')
      : forgeSearch.error instanceof Error
        ? forgeSearch.error.message
        : 'the search request failed'
  // What the empty list has to say for itself, or `null` when the "Found on GitHub" section below
  // already says it. Resolved BEFORE the wrapper rather than inside it (#838): as the contents of
  // a padded `<div>`, a null verdict still rendered the padding, leaving an empty ~2rem gap above
  // that heading. The search-hits case stays below `searching` in the chain on purpose — while a
  // new query is in flight over stale hits, the spinner is the honest thing to show.
  const emptyState = !filtering ? (
    <p>No open {view === 'issues' ? 'issues' : 'pull requests'}.</p>
  ) : searching ? (
    <p className="flex items-center gap-2">
      <Spinner />
      Searching GitHub for “{query.trim()}”…
    </p>
  ) : searchHits.length > 0 ? null : searchFailed ? (
    <p>
      No open {view === 'issues' ? 'issues' : 'pull requests'} match your filter, and GitHub could
      not be searched: {searchFailureReason}.
    </p>
  ) : searchPayload ? (
    // Earned, not assumed: only a search that actually answered for THIS narrow licenses the
    // cross-state verdict. A label-only filter never asks the forge at all (`shouldSearchForge`
    // requires a non-empty query), so claiming "closed or merged" there would be the same
    // unfounded certainty in a different costume.
    <p>
      No {view === 'issues' ? 'issues' : 'pull requests'} match your filter — open, closed or
      merged.
    </p>
  ) : (
    <p>No open {view === 'issues' ? 'issues' : 'pull requests'} match your filter.</p>
  )

  return (
    <IssueBrowserLayout name="gh" route="github" selected={n !== undefined} list={<>
        <header data-slot="gh-header" className="sticky top-0 z-10 bg-background/95 px-4 pt-5 pb-3 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] leading-7 font-semibold">GitHub</h1>
              {gh.repo ? (
                <p data-slot="gh-repo" className="truncate text-[13px] text-muted-foreground">
                  {gh.repo}
                </p>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="sm"
              data-slot="gh-refresh"
              title="Refresh from GitHub"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
              className="shrink-0 font-normal tabular-nums"
            >
              <RefreshCwIcon aria-hidden="true" className={cn(refresh.isPending && 'motion-safe:animate-spin')} />
              {gh.syncedAt ? `Synced ${shortAge(gh.syncedAt)} ago` : 'Refresh'}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="List options" data-slot="gh-list-menu" className="shrink-0">
                  <MoreHorizontalIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {/* One click to work the backlog from the long-waiting end instead of the newest.
                    There is no third "unordered" state — the payload's incoming order is `newest`. */}
                <DropdownMenuLabel>Sort order</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  data-slot="gh-sort"
                  value={sort}
                  onValueChange={(next) => saveGithubSort(next === 'oldest' ? 'oldest' : 'newest')}
                >
                  <DropdownMenuRadioItem value="newest">Newest first</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="oldest">Oldest first</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                {automationsAvailable ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link to="/automations/new">
                        <ZapIcon aria-hidden="true" />
                        Set up automations
                      </Link>
                    </DropdownMenuItem>
                  </>
                ) : null}
                {gh.repo ? (
                  <DropdownMenuItem asChild>
                    <a href={`https://github.com/${gh.repo}`} target="_blank" rel="noopener noreferrer">
                      <ExternalLinkIcon aria-hidden="true" />
                      Open repository on GitHub
                    </a>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Tabs value={view} className="mt-4">
            <TabsList data-slot="gh-tabs" className="w-full">
              <TabsTrigger value="issues" asChild>
                <Link to="/github" aria-current={view === 'issues' ? 'page' : undefined} onClick={() => saveGithubView('issues')}>
                  Issues
                  <span className="font-normal text-muted-foreground tabular-nums">{countLabel(gh.issues.length)}</span>
                </Link>
              </TabsTrigger>
              <TabsTrigger value="prs" asChild>
                <Link to="/github/prs" aria-current={view === 'prs' ? 'page' : undefined} onClick={() => saveGithubView('prs')}>
                  Pull requests
                  <span className="font-normal text-muted-foreground tabular-nums">{countLabel(gh.prs.length)}</span>
                </Link>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="mt-3 flex items-center gap-2">
            <InputGroup className="min-w-0 flex-1">
              <InputGroupAddon>
                <SearchIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                data-slot="gh-search"
                aria-label={`Search ${view}`}
                placeholder="Search #id, title, author…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </InputGroup>
            <LabelFilter
              options={labelOptions}
              colors={labelColors}
              selected={labelFilter}
              onChange={setLabelFilter}
            />
            {sort === 'oldest' ? (
              <Button
                variant="ghost"
                size="icon"
                title="Oldest first — click for newest first"
                aria-label="Sorted oldest first. Switch to newest first"
                className="shrink-0 text-foreground"
                onClick={() => saveGithubSort('newest')}
              >
                <ArrowUpDownIcon aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </header>

        {items.length === 0 ? (
          // Nothing in the OPEN list matched. Rather than the old flat "no match" — which was a
          // lie whenever the item existed but was closed or merged (#730) — report what the forge
          // search found, is finding, or could not do. No verdict to report (the hits below are
          // the answer) means no wrapper at all, so its padding cannot leave a gap.
          emptyState && (
            <div data-slot="gh-empty" className="px-4 py-6 text-[13px] text-muted-foreground">
              {emptyState}
            </div>
          )
        ) : (
          <ul data-slot="gh-rows" className="flex flex-col gap-px px-2 pb-3">
            {items.map((item) => (
              <GithubRow
                key={item.url}
                item={item}
                view={view}
                colors={labelColors}
                active={selected?.url === item.url}
                queued={queued.has(item.url)}
                checks={item.kind === 'pr' ? checksMap?.[item.number] ?? item.checks : item.checks}
                open
              />
            ))}
          </ul>
        )}

        {/* Cross-state hits (#730) — rendered under their own heading so it is never ambiguous
            whether a row came from the open list or from a search that reached past it. */}
        {searchHits.length > 0 ? (
          <div data-slot="gh-search-hits">
            <p className="px-4 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">
              Found on GitHub{searchPayload?.truncated ? ' (first matches)' : ''}
            </p>
            <ul className="flex flex-col gap-px px-2 pb-3">
              {searchHits.map((item) => (
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
          </div>
        ) : null}
    </>} detail={<>
        {selected ? (
          <GithubDetail
            item={selected}
            listPath={listPath}
            colors={labelColors}
            changes={changes}
            checks={selected.kind === 'pr' ? checksMap?.[selected.number] ?? selected.checks : selected.checks}
            open={allItems.some((item) => item.url === selected.url)}
            queuedRunId={queued.get(selected.url) ?? null}
            handOpen={handFor === selected.url}
            onHandOpenChange={(next) => setHandFor(next ? selected.url : null)}
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
              onQueued={(url, runId) => {
                setQueued((current) => new Map(current).set(url, runId))
                setHandFor(null)
              }}
            />
          </GithubDetail>
        ) : (
          <IssueBrowserEmpty
            icon={view === 'issues' ? <CircleDotIcon /> : <GitPullRequestIcon />}
            title={number === null ? 'Nothing selected' : 'Not found'}
            description={
              number === null
                ? `No open ${view === 'issues' ? 'issues' : 'pull requests'} to show.`
                : // Since #730 a closed or merged item IS reachable — type its number into the
                  // search box and the tab asks GitHub directly — so the honest advice is to
                  // search, not the old "it may be closed" shrug.
                  `#${number} is not among the open ${view === 'issues' ? 'issues' : 'pull requests'}. Search for ${number} in the list to look it up on GitHub, closed and merged included.`
            }
            actions={
              number === null ? undefined : (
                <Button asChild variant="outline" size="sm">
                  <Link to={listPath}>Back to the list</Link>
                </Button>
              )
            }
          />
        )}
    </>} />
  )
}

/** The exact open count from the single fast fetch — with a `+` only when it hit the list cap, so
 *  a repo with more than `LIST_LIMIT` open items reads honestly as "at least this many". */
function countLabel(count: number): string {
  return `${count}${count >= LIST_LIMIT ? '+' : ''}`
}

/** How many label chips a list row shows before folding the rest into "+n". */
const ROW_LABELS = 2

function GithubRow({
  item,
  view,
  colors,
  active,
  queued,
  checks,
  open = false,
}: {
  item: GithubItem
  view: GithubView
  colors: Record<string, string>
  active: boolean
  queued: boolean
  /** Resolved checks glyph — the lazily-hydrated value overrides the list's `null` (#664). */
  checks?: GithubItem['checks']
  /** The row comes from the open list (a search hit's state is not known here). */
  open?: boolean
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

  const shownLabels = item.labels.slice(0, ROW_LABELS)
  const hiddenLabels = item.labels.length - shownLabels.length

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
          'flex min-h-14 gap-2.5 rounded-lg px-2.5 py-2.5 transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60',
          active && 'bg-muted hover:bg-muted',
        )}
      >
        <Icon
          aria-hidden="true"
          className={cn(
            'mt-0.5 size-4 shrink-0',
            !open ? 'text-muted-foreground' : item.isDraft ? 'text-muted-foreground' : 'text-success',
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={cn('line-clamp-2 text-[13.5px] leading-snug font-medium text-pretty', active && 'font-semibold')}>
            {item.title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            <span className="shrink-0">#{item.number}</span>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">{item.author}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{shortAge(item.createdAt)}</span>
            <CommentCount count={item.comments} />
            {checks ? <ChecksGlyph checks={checks} /> : null}
            {item.isDraft ? (
              <Badge variant="outline" className="px-1.5 py-0 font-normal text-muted-foreground">
                Draft
              </Badge>
            ) : null}
          </span>
          {shownLabels.length > 0 || queued ? (
            <span className="flex flex-wrap items-center gap-1 pt-0.5">
              {queued ? (
                <Badge data-slot="gh-queued-flag" variant="secondary" className="bg-violet/12 px-1.5 py-0 font-medium text-violet">
                  Run queued
                </Badge>
              ) : null}
              {shownLabels.map((label) => (
                <LabelChip key={label} label={label} color={colors[label]} />
              ))}
              {hiddenLabels > 0 ? (
                <span
                  data-slot="gh-label-more"
                  title={item.labels.slice(ROW_LABELS).join(', ')}
                  className="text-xs text-muted-foreground tabular-nums"
                >
                  +{hiddenLabels}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
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
        <Button
          variant="outline"
          data-slot="gh-label-filter"
          disabled={options.length === 0}
          className={cn('shrink-0 px-2.5 font-normal text-muted-foreground', selected.length > 0 && 'text-foreground')}
        >
          <TagIcon aria-hidden="true" />
          Labels
          {selected.length > 0 ? (
            <Badge variant="secondary" className="px-1.5 py-0 tabular-nums">
              {selected.length}
            </Badge>
          ) : null}
        </Button>
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
                  {on ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary-strong" /> : null}
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
      className="max-w-40 truncate rounded-full border px-1.5 py-px text-[11px] leading-4 font-medium"
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
  open,
  queuedRunId,
  handOpen,
  onHandOpenChange,
}: {
  item: GithubItem
  listPath: string
  colors: Record<string, string>
  /** The hand-off composer — rendered inside the "Hand to agent" dialog. */
  children: ReactNode
  changes: boolean
  /** Resolved checks glyph — the lazily-hydrated value overrides the list's `null` (#664). */
  checks?: GithubItem['checks']
  /** The item is in the open list (a search hit's state is not known here). */
  open: boolean
  queuedRunId: string | null
  handOpen: boolean
  onHandOpenChange: (open: boolean) => void
}) {
  const kindWord = item.kind === 'pr' ? 'pull request' : 'issue'
  const kindLabel = item.kind === 'pr' ? 'Pull request' : 'Issue'
  const hasDiffStat = item.kind === 'pr' && Boolean(item.additions || item.deletions)
  const linkable = isHttpUrl(item.url)
  const copyLink = () => {
    void navigator.clipboard?.writeText(item.url).then(() => toast('Link copied'))
  }
  return (
    <article
      data-slot="gh-detail-inner"
      className={cn('mx-auto w-full min-w-0 px-4 pt-5 pb-12 md:px-10 md:pt-8', changes ? 'max-w-[1400px]' : 'max-w-3xl')}
    >
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2.5 md:hidden">
        <Link to={listPath} data-slot="gh-back">
          <ArrowLeftIcon aria-hidden="true" />
          Back to the list
        </Link>
      </Button>

      <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-72 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
            {open ? (
              <Badge variant="outline" data-slot="gh-state" className="gap-1.5 font-medium">
                <StatusDot tone={item.isDraft ? 'neutral' : 'success'} />
                {item.isDraft ? 'Draft' : 'Open'}
              </Badge>
            ) : (
              <Badge variant="secondary" data-slot="gh-state" className="font-medium">
                Found on GitHub
              </Badge>
            )}
            <span>
              {kindLabel} <span className="tabular-nums">#{item.number}</span>
            </span>
          </div>
          <h2 className="text-[22px] leading-7 font-semibold text-pretty">{item.title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {queuedRunId ? (
            <Button asChild variant="outline" data-slot="gh-view-run">
              <Link to={`/tasks/${queuedRunId}`}>
                <CheckIcon aria-hidden="true" className="text-success" />
                <span data-slot="gh-queued">Queued — view task</span>
              </Link>
            </Button>
          ) : null}
          <Button
            variant={queuedRunId ? 'outline' : 'primary'}
            data-action="gh-hand-open"
            onClick={() => onHandOpenChange(true)}
          >
            <PlayIcon aria-hidden="true" />
            Hand to agent
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label={`More actions for this ${kindWord}`}>
                <MoreHorizontalIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {/* href protocol guard (#431): link only for http(s) URLs. */}
              {linkable ? (
                <DropdownMenuItem asChild>
                  <a href={item.url} target="_blank" rel="noopener noreferrer" data-slot="gh-open-link">
                    <ExternalLinkIcon aria-hidden="true" />
                    Open on GitHub
                  </a>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled data-slot="gh-open-link">
                  <ExternalLinkIcon aria-hidden="true" />
                  Open on GitHub
                </DropdownMenuItem>
              )}
              {linkable && item.kind === 'pr' ? (
                <DropdownMenuItem asChild>
                  <a href={`${item.url}/checks`} target="_blank" rel="noopener noreferrer">
                    <CircleCheckIcon aria-hidden="true" />
                    Open checks on GitHub
                  </a>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={copyLink}>Copy link</DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void navigator.clipboard?.writeText(githubTaskPrompt(item)).then(() => toast('Task prompt copied'))}
              >
                Copy as task prompt
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <dl
        data-slot="gh-meta"
        className="mt-5 grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-[13px]"
      >
        <dt className="text-muted-foreground">Author</dt>
        <dd>{item.author}</dd>
        <dt className="text-muted-foreground">Opened</dt>
        <dd>{shortAge(item.createdAt)} ago</dd>
        {item.comments ? (
          <>
            <dt className="text-muted-foreground">Comments</dt>
            <dd>
              <CommentCount count={item.comments} />
            </dd>
          </>
        ) : null}
        {hasDiffStat ? (
          <>
            <dt className="text-muted-foreground">Changes</dt>
            <dd data-slot="gh-diffstat" className="font-mono text-xs tabular-nums">
              <span className="text-success">+{item.additions ?? 0}</span>{' '}
              <span className="text-danger">−{item.deletions ?? 0}</span>
            </dd>
          </>
        ) : null}
        {checks ? (
          <>
            <dt className="text-muted-foreground">Checks</dt>
            <dd>
              <ChecksBadge checks={checks} url={item.url} />
            </dd>
          </>
        ) : null}
        {item.labels.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Labels</dt>
            <dd className="flex flex-wrap gap-1">
              {item.labels.map((label) => (
                <LabelChip key={label} label={label} color={colors[label]} />
              ))}
            </dd>
          </>
        ) : null}
      </dl>

      {item.kind === 'pr' ? (
        <Tabs value={changes ? 'changes' : 'conversation'} className="mt-6">
          <TabsList aria-label="Pull request detail">
            <TabsTrigger value="conversation" asChild>
              <Link to={`/github/prs/${item.number}`} aria-current={!changes ? 'page' : undefined}>
                Conversation
              </Link>
            </TabsTrigger>
            <TabsTrigger value="changes" asChild>
              <Link to={`/github/prs/${item.number}/changes`} aria-current={changes ? 'page' : undefined}>
                Changes
              </Link>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}

      {changes && item.kind === 'pr' ? <GithubPrChanges item={item} /> : <>
      <div data-slot="gh-body" className="mt-6 border-t border-border pt-6 text-sm leading-relaxed">
        {item.body ? (
          <Markdown>{item.body}</Markdown>
        ) : (
          <p className="text-muted-foreground">No description.</p>
        )}
      </div>

      <GithubThread item={item} colors={colors} />

      {item.kind === 'pr' ? <GithubMergeBox number={item.number} /> : null}
      </>}

      <Dialog open={handOpen} onOpenChange={onHandOpenChange}>
        <DialogContent data-slot="gh-hand-dialog" className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Hand to agent</DialogTitle>
            <DialogDescription className="line-clamp-2">
              {kindLabel} #{item.number} — {item.title}
            </DialogDescription>
          </DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
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
  if (state === 'pending') return <LoaderCircleIcon aria-hidden="true" data-slot="gh-merge-status-pending" className={cn(iconClass, 'animate-spin text-pending-strong')} />
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
    return <Skeleton data-slot="gh-merge-loading" className="mt-8 h-32 w-full rounded-xl" />
  }
  if (!state) {
    return (
      <section data-slot="gh-merge-unavailable" className="mt-8 rounded-xl border bg-card p-5 text-sm shadow-xs">
        <p className="font-medium">Merge status unavailable</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
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
    <section data-slot="gh-merge-box" aria-live="polite" className="mt-8 rounded-xl border bg-card p-5 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {state.canMerge ? (
            <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0 text-success" />
          ) : (
            <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-pending-strong" />
          )}
          <h3 className="text-[15px] font-semibold">{title}</h3>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={refreshMergeState.isPending}
          onClick={() => refreshMergeState.mutate()}
        >
          <RefreshCwIcon aria-hidden="true" className={cn(refreshMergeState.isPending && 'animate-spin')} />
          Refresh
        </Button>
      </div>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
        {state.headRef} ({state.headSha.slice(0, 7)}) → {state.baseRef}
      </p>
      <ul className="mt-4 space-y-2.5 text-[13px]">
        <li className="flex items-center gap-2">
          <MergeRequirementIcon state={reviewState} />
          <span>Reviews: {state.reviewDecision.replaceAll('-', ' ')}</span>
        </li>
        <li className="flex items-center gap-2">
          <MergeRequirementIcon state={conflictState} />
          <span>Conflicts: {state.mergeable === 'conflicting' ? 'present' : state.mergeable === 'mergeable' ? 'none' : 'unknown'}</span>
        </li>
        {state.checks.length === 0 && state.checksTier !== 'none' ? <li className="text-muted-foreground">No checks configured</li> : state.checks.map((check) => (
          <li key={check.name} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <MergeRequirementIcon state={check.state} />
              <span>{check.name} · {check.state}{check.required === true ? ' · required' : check.required === null ? ' · requiredness unknown' : ''}</span>
            </span>
            {check.url && isHttpUrl(check.url) ? <a href={check.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Details</a> : null}
          </li>
        ))}
        {/* What the token could NOT read (#969). A fine-grained PAT cannot expand
            `statusCheckRollup` into CheckRun contexts — there is no permission to grant — so
            the panel says which tier it is showing instead of passing a degraded read off as
            the whole truth, or (tier `none`) an empty list off as "no CI". */}
        {state.checksTier === 'aggregate' || state.checksTier === 'none' ? (
          <li data-slot="gh-merge-checks-degraded" className="flex items-start gap-2">
            <MergeRequirementIcon state="unknown" />
            <span className="min-w-0">
              {state.checksTier === 'aggregate'
                ? 'Only the rolled-up check state is readable here — per-check detail is not.'
                : 'This token cannot read the checks on this pull request.'}
              {state.checksReason ? <span className="mt-0.5 block break-words text-muted-foreground">{state.checksReason}</span> : null}
            </span>
          </li>
        ) : null}
        {/* The row above already said `checks-unknown`, with the reason — don't say it twice. */}
        {state.blockers
          .filter((blocker) => !(blocker.code === 'checks-unknown' && state.checksTier === 'none'))
          .map((blocker) => <li key={blocker.code} className="text-muted-foreground">{blocker.message}</li>)}
      </ul>
      {state.canOverride ? (
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg bg-pending/10 p-3 text-[13px]">
          <Checkbox
            checked={overrideRules}
            onCheckedChange={(checked) => setOverrideRules(checked === true)}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium">Merge without waiting for requirements</span>
            <span className="mt-0.5 block text-muted-foreground">GitHub will allow this only if your permissions can bypass the repository rules.</span>
          </span>
        </label>
      ) : null}
      {state.state === 'open' && state.methods.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Select value={selectedMethod ?? undefined} onValueChange={(value) => setMethod(value as GithubMergeMethod)}>
            <SelectTrigger aria-label="Merge method" className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {state.methods.map((candidate) => <SelectItem key={candidate} value={candidate}>{mergeLabels[candidate]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="contrast" disabled={!mergeEnabled} onClick={() => setConfirming(true)}>
            {selectedMethod ? mergeLabels[selectedMethod] : 'Merge'}
          </Button>
        </div>
      ) : null}
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
  if (query.isPending) return <p aria-live="polite" className="mt-6 flex items-center gap-2 text-[13px] text-muted-foreground"><Spinner />Loading changed files…</p>
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
        <span className="font-medium">{data.files.length} changed files</span>
        <span className="font-mono text-xs tabular-nums">
          <span className="text-success">+{data.additions}</span> <span className="text-danger">−{data.deletions}</span>
        </span>
        <span className="font-mono text-[11px] text-muted-foreground" title={data.headSha}>head {data.headSha.slice(0, 8)}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button aria-label="Previous file" variant="outline" size="icon-sm" disabled={current <= 0} onClick={() => setSelected(files[current - 1]?.path ?? null)}><ChevronLeftIcon /></Button>
          <Button aria-label="Next file" variant="outline" size="icon-sm" disabled={current < 0 || current >= files.length - 1} onClick={() => setSelected(files[current + 1]?.path ?? null)}><ChevronRightIcon /></Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}><RefreshCwIcon aria-hidden="true" />Refresh</Button>
        </div>
      </div>
      {data.truncated ? <p role="status" className="mt-3 rounded-lg bg-pending/10 p-3 text-[13px]">{data.reason ?? 'This response is incomplete.'} {fallback ? <a href={fallback} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Open all files on GitHub</a> : null}</p> : null}
      <div className="mt-4 grid min-w-0 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="min-w-0">
          <InputGroup>
            <InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon>
            <InputGroupInput aria-label="Filter changed files" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" />
          </InputGroup>
          <select aria-label="Select changed file" value={selected ?? ''} onChange={(e) => setSelected(e.target.value)} className="mt-2 h-10 w-full rounded-md border border-input bg-card px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:hidden">
            {files.map((file) => <option key={file.path}>{file.path}</option>)}
          </select>
          <ul className="mt-2 hidden max-h-[60vh] flex-col gap-px overflow-auto lg:flex">
            {files.map((file) => <li key={file.path}><button type="button" onClick={() => setSelected(file.path)} className={cn('flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-muted/60', selected === file.path && 'bg-muted font-medium text-foreground')} title={`${file.status} · ${file.path}`}><span className="min-w-0 flex-1 truncate [direction:rtl]"><bdi>{file.path}</bdi></span><span className="sr-only">{file.status}</span><span className="shrink-0 font-mono text-[11px] tabular-nums"><span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span></span></button></li>)}
          </ul>
        </aside>
        <div className="min-w-0">
          {files.length === 0 ? <p className="text-[13px] text-muted-foreground">No changed files match this filter.</p> : <>
            <Diff files={diffFiles.filter((file) => file.path === selected)} wrap className="min-w-0" />
            {active && !active.patch ? <p className="rounded-b-md border border-border p-3 text-xs text-muted-foreground">Patch unavailable: {active.patchUnavailableReason ?? 'not-provided'}.</p> : null}
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
      <section data-slot="gh-thread-loading" className="mt-8 border-t border-border pt-6">
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
      <section data-slot="gh-thread-error" className="mt-8 border-t border-border pt-6 text-[13px] text-muted-foreground">
        <span>Couldn’t load comments — {reason}. </span>
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
        >
          Open on GitHub
          <ExternalLinkIcon aria-hidden="true" className="size-3" />
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
    <section data-slot="gh-thread" className="mt-8 border-t border-border pt-6">
      <h3 data-slot="gh-thread-header" className="mb-5 flex items-baseline gap-2 text-[15px] font-semibold">
        {/* "Activity", not "Comments": heading a twenty-row list `Comments · 2` would be
            incoherent once events render. The comment count stays as a secondary. This is a
            different surface from the row badge, which still counts comments only. */}
        Activity
        <span className="text-[13px] font-normal text-muted-foreground">
          {data.comments.length} comment{data.comments.length === 1 ? '' : 's'}
        </span>
      </h3>
      {/* A simple timeline: one rail down the avatar column, comments and events hung off it. */}
      <ul className="relative flex flex-col gap-5 before:absolute before:top-2 before:bottom-2 before:left-3 before:w-px before:bg-border">
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
          className="mt-5 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground hover:underline"
        >
          Thread truncated — open on GitHub
          <ExternalLinkIcon aria-hidden="true" className="size-3" />
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
            className="relative flex items-center gap-2 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <EventMarker kind="committed" />
            <span className="font-medium text-foreground">{actor}</span>
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
        className="relative flex items-center gap-2 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <EventMarker kind="committed" />
        <span className="font-medium text-foreground">{actor}</span>
        <span>added {commits.length} commits</span>
        <span className="shrink-0 text-xs tabular-nums">{shortAge(commits[commits.length - 1]!.createdAt)}</span>
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
/** The event's glyph, seated on the timeline rail (same 24px column as a comment's avatar). */
function EventMarker({ kind }: { kind: GithubTimelineEventKind }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-xs text-muted-foreground"
    >
      {EVENT_GLYPH[kind]}
    </span>
  )
}

function EventRow({ event, colors }: { event: GithubTimelineEvent; colors: Record<string, string> }) {
  return (
    <li
      data-slot="gh-event-row"
      data-kind={event.kind}
      className={cn(
        'relative flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground',
        event.kind === 'merged' && 'text-foreground',
      )}
    >
      <EventMarker kind={event.kind} />
      <span className="shrink-0 font-medium text-foreground">{event.actor}</span>
      <EventPhrase event={event} colors={colors} />
      <span className="shrink-0 text-xs tabular-nums">{shortAge(event.createdAt)}</span>
      {event.url ? (
        <a
          href={event.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`open ${event.kind} on GitHub`}
          className="ml-auto shrink-0 text-soft-foreground hover:text-foreground"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
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
          {event.sha ? <span className="shrink-0 font-mono text-[11px]">{event.sha.slice(0, 7)}</span> : null}
          {event.message ? (
            <span className="truncate text-foreground">{event.message}</span>
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
              className="max-w-[12rem] truncate rounded-full border px-1.5 py-px text-[11px] leading-4 font-medium"
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
  approved: { label: 'Approved', tone: 'border-success/40 text-success' },
  changes_requested: { label: 'Changes requested', tone: 'border-danger/40 text-danger' },
  commented: { label: 'Commented', tone: 'border-border text-muted-foreground' },
  dismissed: { label: 'Dismissed', tone: 'border-border text-muted-foreground' },
}

/** One thread entry: avatar (letter fallback), author, age, an optional review-state chip, and the
 *  body via the shared `Markdown` component (images/code fences render as in the issue body). */
function ThreadEntry({ comment }: { comment: GithubComment }) {
  const chip = comment.reviewState ? REVIEW_CHIP[comment.reviewState] : null
  return (
    <li data-slot="gh-thread-entry" data-kind={comment.kind} className="relative flex min-w-0 gap-3">
      <Avatar url={comment.avatarUrl} login={comment.author} />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex min-h-6 items-center gap-2 text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">{comment.author}</span>
          <span className="text-xs tabular-nums">{shortAge(comment.createdAt)}</span>
          {chip ? (
            <Badge
              variant="outline"
              data-slot="gh-review-chip"
              data-review-state={comment.reviewState}
              className={cn('px-1.5 py-0 font-medium', chip.tone)}
            >
              {chip.label}
            </Badge>
          ) : null}
          <a
            href={comment.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="open comment on GitHub"
            className="ml-auto shrink-0 text-soft-foreground hover:text-foreground"
          >
            <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          </a>
        </div>
        <div data-slot="gh-thread-body" className="text-sm leading-relaxed">
          {comment.body ? <Markdown>{comment.body}</Markdown> : <p className="text-muted-foreground">No body.</p>}
        </div>
      </div>
    </li>
  )
}

/** A 24 px comment avatar, seated on the timeline rail. Falls back to a letter block when no URL is known or the image fails to
 *  load (private-repo attachments, deleted avatars) — never a broken-image glyph. */
function Avatar({ url, login }: { url?: string; login: string }) {
  const [failed, setFailed] = useState(false)
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        width={24}
        height={24}
        loading="lazy"
        onError={() => setFailed(true)}
        data-slot="gh-avatar"
        className="size-6 shrink-0 rounded-full bg-background ring-4 ring-background"
      />
    )
  }
  return (
    <span
      data-slot="gh-avatar-fallback"
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground uppercase ring-4 ring-background"
    >
      {login.slice(0, 1) || '?'}
    </span>
  )
}

/** Glyph + tone shared by the list row's compact indicator and the detail pane's full badge
 *  (#400) — one source of truth so the two surfaces can't drift out of sync. */
type Checks = NonNullable<GithubItem['checks']>
const CHECKS_GLYPH: Record<Checks, string> = { passing: '✓', failing: '✗', pending: '○' }
const CHECKS_DOT: Record<Checks, 'success' | 'danger' | 'pending'> = {
  passing: 'success',
  failing: 'danger',
  pending: 'pending',
}
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
      className="inline-flex shrink-0 items-center gap-1 tabular-nums"
    >
      <MessageSquareIcon aria-hidden="true" className="size-3.5" />
      {count}
    </span>
  )
}

/** The checks badge — the legacy tab's three phrases, tinted by outcome. Links out
 *  to the PR's checks tab on GitHub (issue #415) when a URL is available. */
function ChecksBadge({ checks, url }: { checks: Checks; url?: string }) {
  const className = cn('inline-flex items-center gap-1.5 text-[13px]', url && 'underline-offset-4 hover:underline')
  const label = (
    <>
      <StatusDot tone={CHECKS_DOT[checks]} />
      Checks {checks}
    </>
  )

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
      className={cn('shrink-0 text-xs font-semibold', CHECKS_TONE[checks])}
    >
      {CHECKS_GLYPH[checks]}
    </span>
  )
}
