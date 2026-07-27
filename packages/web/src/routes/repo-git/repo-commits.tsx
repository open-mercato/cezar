import { ArrowLeftIcon, GitCommitHorizontalIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { ApiError } from '@/api/client'
import { useRepoCommit } from '@/api/queries'
import type { LogEntry } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Diff, type DiffMode } from '@/components/diff'
import { DiffStatLabel } from '@/components/diff-stat'
import { Button } from '@/components/ui/button'
import { useIsDesktop } from '@/lib/use-desktop'

import { CommitList } from '../task-git/commit-list'
import { DiffViewToggles } from '../task-git/diff-controls'

/**
 * The repo view's Commits segment (R5 Step 1.7): the recent-commit log the existing
 * `GET /api/repo` already carries, each row deep-linking to `/git/commits/:sha`, where the
 * structured commit diff (`?structured=1` on the legacy commit route) renders through the
 * same `<Diff>` facade as everything else. Same mobile rule: unified+wrap forced below `md`.
 */
export function RepoCommitsSection({ log }: { log: LogEntry[] }) {
  const { sha } = useParams<{ sha: string }>()
  if (sha) return <CommitDiffView sha={sha} />

  if (log.length === 0) {
    return (
      <CenteredState
        icon={<GitCommitHorizontalIcon />}
        tone="neutral"
        heading="h2"
        title="No commits yet"
        subtitle="The log is empty — this repository has no commits to show."
      />
    )
  }
  return (
    <CommitList
      slot="repo-commits"
      commits={log.map((commit) => ({
        sha: commit.hash,
        shaLabel: commit.hash,
        subject: commit.subject,
        author: commit.author,
        when: commit.when,
        href: `/git/commits/${commit.hash}`,
      }))}
    />
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
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border px-4 py-2 md:px-6">
        <Button asChild variant="ghost" size="sm" data-slot="commit-back">
          <Link to="/git/commits">
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
            <div className="px-4 py-4 [--diff-sticky-top:7rem] md:px-6">
              <Diff files={commit.data.files} mode={effectiveMode} wrap={effectiveWrap} className="min-w-0" />
            </div>
          )}
        </>
      )}
    </section>
  )
}
