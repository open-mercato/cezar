import { ArrowLeftIcon, GitCommitHorizontalIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { ApiError } from '@/api/client'
import { useRun, useRunCommit, useRunCommits } from '@/api/queries'
import type { ApiRun, RunCommit } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Diff, type DiffMode } from '@/components/diff'
import { DiffStatLabel } from '@/components/diff-stat'
import { Button } from '@/components/ui/button'
import { useIsDesktop } from '@/lib/use-desktop'

import { isRunActive } from '../task-thread/run-actions'
import { RunHeader } from '../task-thread/run-header'
import { CommitList } from './commit-list'
import { GitTabLoadError, GitTabLoading } from './git-tab-loading'
import { DiffViewToggles } from './diff-controls'

/**
 * `/tasks/:id/commits` — the run's own commits (`<base>..HEAD`), each opening its structured diff
 * at `/tasks/:id/commits/:sha` through the SAME `<Diff>` facade the Changes tab and repo commit
 * view use. Mirrors the repo Commits segment, scoped to the task worktree.
 */
export function TaskCommitsRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)

  if (run.isPending) return <GitTabLoading tab="changes" />
  if (run.isError) return <GitTabLoadError tab="changes" error={run.error} />
  return <CommitsView run={run.data} />
}

function CommitsView({ run }: { run: ApiRun }) {
  const { sha } = useParams<{ sha: string }>()
  const commits = useRunCommits(run.id, isRunActive(run.status))

  return (
    <div data-route="task-commits" className="flex min-h-full flex-col">
      <RunHeader run={run} tab="commits" />
      {sha ? (
        <CommitDiffView runId={run.id} sha={sha} />
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
        />
      )}
    </div>
  )
}

function CommitDiffView({ runId, sha }: { runId: string; sha: string }) {
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
        <Button asChild variant="ghost" size="sm" data-slot="commit-back">
          <Link to={`/tasks/${runId}/commits`}>
            <ArrowLeftIcon aria-hidden="true" />
            All commits
          </Link>
        </Button>
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
            <div className="px-4 py-4 [--diff-sticky-top:10rem] md:px-6">
              <Diff files={commit.data.files} mode={effectiveMode} wrap={effectiveWrap} className="min-w-0" />
            </div>
          )}
        </>
      )}
    </section>
  )
}
