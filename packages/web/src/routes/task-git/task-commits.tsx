import { ArrowLeftIcon, GitCommitHorizontalIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { useParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { ApiError } from '@/api/client'
import { useRun, useRunCommit, useRunCommits } from '@/api/queries'
import type { ApiRun, RunCommit } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Diff, type DiffMode } from '@/components/diff'
import { DiffStatLabel } from '@/components/diff-stat'
import { Button } from '@/components/ui/button'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { useIsDesktop } from '@/lib/use-desktop'
import { useRememberedState } from '@/lib/view-memory'
import { cn } from '@/lib/utils'

import { isRunActive } from '../task-thread/run-actions'
import { RunHeader } from '../task-thread/run-header'
import { CommitList } from './commit-list'
import { GitTabLoadError, GitTabLoading } from './git-tab-loading'
import { BranchChip, DiffViewToggles } from './diff-controls'
import { FullViewExit } from '../task-workspace/maximize'

/**
 * `/tasks/:id/commits` — the run's own commits (`<base>..HEAD`), each opening its structured diff
 * at `/tasks/:id/commits/:sha` through the SAME `<Diff>` facade the Changes tab and repo commit
 * view use. Mirrors the repo Commits segment, scoped to the task worktree.
 */
/** NOTE: no longer mounted by the router — `/tasks/:id/commits` renders the workspace
 *  (`routes/task-workspace/task-workspace.tsx`), which embeds `CommitsView` as a column. Kept as
 *  the standalone entry point its own suite drives, and as the revert target while the
 *  workspace is new; delete both together once the workspace has settled. */
export function TaskCommitsRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)

  if (run.isPending) return <GitTabLoading tab="changes" />
  if (run.isError) return <GitTabLoadError tab="changes" error={run.error} />
  return <CommitsView run={run.data} />
}

/**
 * `embedded` drops the run header for a workspace column — see `FilesView`.
 *
 * `stateKey` makes the SELECTION the column's own (spec §5.4: each layout's view state comes
 * back when you switch to it). Without it the selected commit is the URL's, which two Commits
 * columns cannot each have — they would show the same diff, and switching layouts would not
 * restore what each was looking at. The standalone route passes no key and keeps its URL, so a
 * commit link stays shareable.
 */
export function CommitsView({
  run,
  embedded = false,
  stateKey,
}: {
  run: ApiRun
  embedded?: boolean
  stateKey?: string
}) {
  const { sha: shaFromUrl } = useParams<{ sha: string }>()
  const [picked, setPicked] = useRememberedState<string | null>(stateKey, shaFromUrl ?? null)
  /**
   * The URL wins whenever it CHANGES, and the column owns the selection the rest of the time.
   *
   * Seeding only the initial value was not enough: a second `/commits/:sha` link, and Back or
   * Forward between two commit URLs, reuse the same card and therefore the same memory key, so
   * the column kept showing the first commit (§10 — deep links and browser history keep their
   * existing semantics). Tracking the last sha the URL carried is what tells a new URL from a
   * re-render.
   */
  const lastUrlSha = useRef(shaFromUrl)
  if (stateKey !== undefined && shaFromUrl !== lastUrlSha.current) {
    lastUrlSha.current = shaFromUrl
    if (shaFromUrl !== undefined && shaFromUrl !== picked) setPicked(shaFromUrl)
  }
  const sha = stateKey === undefined ? shaFromUrl : (picked ?? undefined)
  const commits = useRunCommits(run.id, isRunActive(run.status))

  // In a workspace column on a wide screen the view is a two-pane reader: the commits down the
  // left, the picked one's diff beside it. A phone keeps the list-then-detail flow below.
  const desktop = useIsDesktop()
  if (embedded && desktop) {
    return <CommitsReader run={run} commits={commits} picked={sha ?? null} onPick={setPicked} />
  }

  return (
    <div data-route="task-commits" className="flex min-h-full flex-col">
      {embedded ? null : <RunHeader run={run} tab="commits" />}
      {sha ? (
        <CommitDiffView
          runId={run.id}
          sha={sha}
          embedded={embedded}
          // In a column the selection is the column's, so "All commits" clears it rather than
          // navigating — a URL change here would move every other column's view too.
          onBack={stateKey === undefined ? undefined : () => setPicked(null)}
        />
      ) : commits.isPending ? (
        <p data-slot="commits-loading" className="px-4 py-6 text-center text-xs text-soft-foreground md:px-6">
          Loading commits…
        </p>
      ) : commits.isError ? (
        <CenteredState
          icon={<GitCommitHorizontalIcon />}
          tone={commits.error instanceof ApiError && commits.error.status === 409 ? 'neutral' : 'danger'}
          heading="h2"
          title={
            commits.error instanceof ApiError && commits.error.status === 409
              ? 'No commits to show'
              : 'Could not load the commits'
          }
          subtitle={commits.error.message}
        />
      ) : commits.data.commits.length === 0 ? (
        <CenteredState
          icon={<GitCommitHorizontalIcon />}
          tone="neutral"
          heading="h2"
          title="No commits yet"
          subtitle="This task hasn't committed anything on its branch. Autosave commits and any the agent makes appear here."
        />
      ) : (
        <CommitList
          slot="task-commits"
          className="mx-auto w-full max-w-[var(--measure)]"
          commits={commits.data.commits.map((commit: RunCommit) => ({
            ...commit,
            shaLabel: commit.sha.slice(0, 8),
            href: `/tasks/${run.id}/commits/${commit.sha}`,
          }))}
          onSelect={stateKey === undefined ? undefined : setPicked}
        />
      )}
    </div>
  )
}

/**
 * The Commits view of a workspace column: a toolbar that stays put (branch, count, diff
 * toggles), the commits as a list on the left with its own scroll, and the selected commit —
 * subject, author, sha, then its diff — on the right. The newest commit is selected until the
 * user picks another, so the view never opens as one line on an empty page.
 */
function CommitsReader({
  run,
  commits,
  picked,
  onPick,
}: {
  run: ApiRun
  commits: ReturnType<typeof useRunCommits>
  picked: string | null
  onPick: (sha: string | null) => void
}) {
  const [mode, setMode] = useState<DiffMode>('unified')
  const [wrap, setWrap] = useState(false)
  const list = commits.data?.commits ?? []
  const sha = picked ?? list[0]?.sha ?? null
  const refused = commits.isError && commits.error instanceof ApiError && commits.error.status === 409

  return (
    <div data-route="task-commits" className="flex min-h-full flex-col">
      <div
        data-slot="commits-toolbar"
        className="sticky top-0 z-20 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/70 bg-background px-4 py-1.5 sm:px-6"
      >
        {run.branch ? <BranchChip branch={run.branch} /> : null}
        {commits.data ? (
          <span className="text-[13px] text-muted-foreground tabular-nums">
            {list.length} {list.length === 1 ? 'commit' : 'commits'}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {sha ? <DiffViewToggles mode={mode} wrap={wrap} onModeChange={setMode} onWrapChange={setWrap} /> : null}
          <FullViewExit />
        </span>
      </div>

      {commits.isPending ? (
        <div className="flex gap-5 px-6 py-4" aria-busy="true">
          <div className="w-72 shrink-0 space-y-2">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-14 w-full rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-64 flex-1 rounded-lg" />
        </div>
      ) : commits.isError ? (
        <CenteredState
          icon={<GitCommitHorizontalIcon />}
          tone={refused ? 'neutral' : 'danger'}
          heading="h2"
          title={refused ? 'No commits to show' : 'Could not load the commits'}
          subtitle={commits.error.message}
        />
      ) : list.length === 0 ? (
        <CenteredState
          icon={<GitCommitHorizontalIcon />}
          tone="neutral"
          heading="h2"
          title="No commits yet"
          subtitle="This task hasn't committed anything on its branch. Autosave commits and any the agent makes appear here."
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-start gap-5 px-4 py-4 [--diff-sticky-top:2.75rem] md:px-6">
          <aside
            data-slot="commits-pane"
            className="sticky top-[calc(2.75rem+1rem)] max-h-[calc(100dvh_-_var(--diff-sticky-top)_-_1rem)] w-64 shrink-0 overflow-y-auto overscroll-contain lg:w-80"
          >
            <ItemGroup data-slot="task-commits" className="gap-1">
              {list.map((commit: RunCommit) => {
                const active = commit.sha === sha
                return (
                  <Item
                    key={commit.sha}
                    asChild
                    size="sm"
                    data-slot="commit-row"
                    data-sha={commit.sha}
                    data-active={active ? '' : undefined}
                    className={cn('items-start gap-2.5 border-transparent', active ? 'bg-muted' : 'hover:bg-muted/60')}
                  >
                    <Button
                      variant="ghost"
                      aria-pressed={active}
                      onClick={() => onPick(commit.sha)}
                      className="h-auto w-full justify-start px-2.5 py-2 text-left font-normal whitespace-normal active:translate-y-0"
                    >
                      <ItemMedia className="mt-0.5 text-muted-foreground">
                        <GitCommitHorizontalIcon className="size-4" aria-hidden="true" />
                      </ItemMedia>
                      <ItemContent className="min-w-0 gap-0.5">
                        <ItemTitle className={cn('line-clamp-2 w-full text-[13px] leading-snug', active ? 'font-semibold' : 'font-medium')}>
                          {commit.subject}
                        </ItemTitle>
                        <ItemDescription className="truncate text-xs">
                          <span className="font-mono">{commit.sha.slice(0, 8)}</span> · {commit.author} · {commit.when}
                        </ItemDescription>
                      </ItemContent>
                    </Button>
                  </Item>
                )
              })}
            </ItemGroup>
          </aside>
          <div className="min-w-0 flex-1">
            {sha ? <CommitDetail runId={run.id} sha={sha} mode={mode} wrap={wrap} /> : null}
          </div>
        </div>
      )}
    </div>
  )
}

/** The picked commit: what it says, who made it, and its diff. */
function CommitDetail({ runId, sha, mode, wrap }: { runId: string; sha: string; mode: DiffMode; wrap: boolean }) {
  const commit = useRunCommit(runId, sha)
  if (commit.isPending) return <Skeleton className="h-64 w-full rounded-lg" />
  if (commit.isError) {
    const missing = commit.error instanceof ApiError && commit.error.status === 409
    return (
      <CenteredState
        icon={missing ? <SearchXIcon /> : <TriangleAlertIcon />}
        tone={missing ? 'neutral' : 'danger'}
        heading="h2"
        title={missing ? 'Commit not found' : 'Could not load the commit'}
        subtitle={commit.error.message}
      />
    )
  }
  return (
    <section data-slot="task-commit" data-sha={sha} className="flex min-w-0 flex-col gap-4">
      <div data-slot="commit-meta" className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 space-y-1">
          <h2 className="text-[15px] font-semibold text-foreground">{commit.data.subject}</h2>
          <p className="text-[13px] text-muted-foreground">
            {commit.data.author} · {commit.data.when} ·{' '}
            <span className="font-mono text-xs select-all">{commit.data.sha.slice(0, 12)}</span>
          </p>
        </div>
        <DiffStatLabel stat={commit.data.stat} />
      </div>
      {commit.data.files.length === 0 ? (
        <CenteredState
          icon={<GitCommitHorizontalIcon />}
          tone="neutral"
          heading="h2"
          title="No file changes"
          subtitle="This commit carries no diff of its own — a merge commit's changes live on the commits it merged."
        />
      ) : (
        <Diff files={commit.data.files} mode={mode} wrap={wrap} className="min-w-0" />
      )}
    </section>
  )
}

function CommitDiffView({
  runId,
  sha,
  embedded,
  onBack,
}: {
  runId: string
  sha: string
  /** Shortens the diff's sticky pin for a workspace column — see `CommitsView`. */
  embedded: boolean
  /** Clear the column's own selection instead of navigating — see the call site. */
  onBack?: () => void
}) {
  const commit = useRunCommit(runId, sha)
  const desktop = useIsDesktop()
  const [mode, setMode] = useState<DiffMode>('unified')
  const [wrap, setWrap] = useState(false)

  const refused = commit.isError && commit.error instanceof ApiError && commit.error.status === 409
  const effectiveMode: DiffMode = desktop ? mode : 'unified'
  const effectiveWrap = desktop ? wrap : true

  return (
    <section data-slot="task-commit" data-sha={sha} className="mx-auto flex min-h-0 w-full max-w-[var(--measure)] flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border px-4 py-2 md:px-6">
        {onBack ? (
          <Button variant="ghost" size="sm" data-slot="commit-back" onClick={onBack}>
            <ArrowLeftIcon aria-hidden="true" />
            All commits
          </Button>
        ) : (
          <Button asChild variant="ghost" size="sm" data-slot="commit-back">
            <Link to={`/tasks/${runId}/commits`}>
              <ArrowLeftIcon aria-hidden="true" />
              All commits
            </Link>
          </Button>
        )}
        {commit.data ? <DiffStatLabel stat={commit.data.stat} /> : null}
        <span className="ml-auto hidden items-center gap-1 md:flex">
          <DiffViewToggles mode={mode} wrap={wrap} onModeChange={setMode} onWrapChange={setWrap} />
        </span>
      </div>

      {commit.isPending ? (
        <p data-slot="commit-loading" className="px-4 py-6 text-center text-xs text-soft-foreground md:px-6">
          Loading commit…
        </p>
      ) : commit.isError ? (
        <CenteredState
          icon={refused ? <SearchXIcon /> : <TriangleAlertIcon />}
          tone={refused ? 'neutral' : 'danger'}
          heading="h2"
          title={refused ? 'Commit not found' : 'Could not load the commit'}
          subtitle={commit.error.message}
        />
      ) : (
        <>
          <div data-slot="commit-meta" className="border-b border-border px-4 py-3 md:px-6">
            <h2 className="text-sm font-semibold">{commit.data.subject}</h2>
            <p className="mt-0.5 text-[11px] text-soft-foreground">
              {commit.data.author} · {commit.data.when} ·{' '}
              <span className="font-mono select-all">{commit.data.sha}</span>
            </p>
          </div>
          {commit.data.files.length === 0 ? (
            <CenteredState
              icon={<GitCommitHorizontalIcon />}
              tone="neutral"
              heading="h2"
              title="No file changes"
              subtitle="This commit carries no diff of its own — a merge commit's changes live on the commits it merged."
            />
          ) : (
            <div className={cn('px-4 py-4 md:px-6', embedded ? '[--diff-sticky-top:2.5rem]' : '[--diff-sticky-top:10rem]')}>
              <Diff files={commit.data.files} mode={effectiveMode} wrap={effectiveWrap} className="min-w-0" />
            </div>
          )}
        </>
      )}
    </section>
  )
}
