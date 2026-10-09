import { ArrowLeftIcon, GitCommitHorizontalIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { ApiError } from '@/api/client'
import { useRepoCommit } from '@/api/queries'
import type { LogEntry } from '@open-mercato/cezar-api-client'
import { Diff, type DiffMode } from '@/components/diff'
import { DiffStatLabel } from '@/components/diff-stat'
import { PageBody, PageToolbar } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useIsDesktop } from '@/lib/use-desktop'

import { DiffViewToggles } from '../task-git/diff-controls'
import { RepoEmpty } from './repo-empty'

/**
 * The repo view's Commits segment (R5 Step 1.7): the recent-commit log the existing
 * `GET /api/repo` already carries, each row deep-linking to `/git/commits/:sha`, where the
 * structured commit diff (`?structured=1` on the legacy commit route) renders through the
 * same `<Diff>` facade as everything else. Same mobile rule: unified+wrap forced below `md`.
 *
 * The log is capped at 20 rows server-side (`getLog`), so this is a plain list — no windowing.
 */
export function RepoCommitsSection({ log }: { log: LogEntry[] }) {
  const { sha } = useParams<{ sha: string }>()
  if (sha) return <CommitDiffView sha={sha} />

  if (log.length === 0) {
    return (
      <RepoEmpty
        icon={<GitCommitHorizontalIcon />}
        title="No commits yet"
        description="The log is empty — this repository has no commits to show."
      />
    )
  }
  return (
    <PageBody>
      <div data-slot="repo-commits" className="divide-y divide-border overflow-hidden rounded-xl border bg-card shadow-xs">
        {log.map((commit) => (
          <Link
            key={commit.hash}
            data-slot="commit-row"
            data-sha={commit.hash}
            to={`/git/commits/${commit.hash}`}
            className="flex min-h-14 min-w-0 items-center gap-3 px-4 py-2.5 outline-none hover:bg-muted/50 focus-visible:bg-muted/50"
          >
            <GitCommitHorizontalIcon aria-hidden="true" className="size-4 shrink-0 text-soft-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium text-foreground">{commit.subject}</span>
              <span className="block truncate text-[13px] text-muted-foreground">
                {commit.author} · {commit.when}
              </span>
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{commit.hash}</span>
          </Link>
        ))}
      </div>
    </PageBody>
  )
}

function CommitDiffView({ sha }: { sha: string }) {
  const commit = useRepoCommit(sha)
  const desktop = useIsDesktop()
  const [mode, setMode] = useState<DiffMode>('unified')
  const [wrap, setWrap] = useState(false)

  // 409 = the server's answer (unknown sha, not a hash) — a dead link, not an outage.
  const refused = commit.isError && commit.error instanceof ApiError && commit.error.status === 409

  const effectiveMode: DiffMode = desktop ? mode : 'unified'
  const effectiveWrap = desktop ? wrap : true

  return (
    <section data-slot="repo-commit" data-sha={sha} className="flex min-h-0 flex-1 flex-col">
      <PageToolbar className="gap-x-3">
        <Button asChild variant="ghost" size="sm" data-slot="commit-back" className="-ml-2">
          <Link to="/git/commits">
            <ArrowLeftIcon aria-hidden="true" />
            All commits
          </Link>
        </Button>
        {commit.data ? <DiffStatLabel stat={commit.data.stat} /> : null}
        <span className="ml-auto hidden items-center gap-1 md:flex">
          <DiffViewToggles mode={mode} wrap={wrap} onModeChange={setMode} onWrapChange={setWrap} />
        </span>
      </PageToolbar>

      {commit.isPending ? (
        <PageBody data-slot="commit-loading" className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
          <Spinner />
          Loading commit…
        </PageBody>
      ) : commit.isError ? (
        <RepoEmpty
          icon={refused ? <SearchXIcon /> : <TriangleAlertIcon />}
          tone={refused ? 'neutral' : 'danger'}
          title={refused ? 'Commit not found' : 'Could not load the commit'}
          description={commit.error.message}
        />
      ) : (
        <PageBody className="[--diff-sticky-top:0rem]">
          <div data-slot="commit-meta" className="pb-5">
            <h2 className="text-[15px] font-semibold text-pretty text-foreground">{commit.data.subject}</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {commit.data.author} · {commit.data.when} ·{' '}
              <span className="font-mono text-[11px] select-all">{commit.data.sha}</span>
            </p>
          </div>
          {commit.data.files.length === 0 ? (
            <RepoEmpty
              icon={<GitCommitHorizontalIcon />}
              title="No file changes"
              description="This commit carries no diff of its own — a merge commit's changes live on the commits it merged."
            />
          ) : (
            <Diff files={commit.data.files} mode={effectiveMode} wrap={effectiveWrap} className="min-w-0" />
          )}
        </PageBody>
      )}
    </section>
  )
}
