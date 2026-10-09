import { ArrowLeftIcon, GitCommitHorizontalIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { ApiError } from '@/api/client'
import { useRepoCommit } from '@/api/queries'
import type { LogEntry } from '@open-mercato/cezar-api-client'
import { ContextSidebar } from '@/components/context-sidebar'
import { Diff, type DiffMode } from '@/components/diff'
import { DiffStatLabel } from '@/components/diff-stat'
import { PageBody, PageToolbar } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Spinner } from '@/components/ui/spinner'
import { useIsDesktop } from '@/lib/use-desktop'

import { DiffViewToggles } from '../task-git/diff-controls'
import { RepoEmpty } from './repo-empty'
import { OpenSidebarButton } from './repo-sidebar'

/**
 * The repo view's Commits segment (R5 Step 1.7): the recent-commit log the existing
 * `GET /api/repo` already carries, each row deep-linking to `/git/commits/:sha`, where the
 * structured commit diff (`?structured=1` on the legacy commit route) renders through the
 * same `<Diff>` facade as everything else. Same mobile rule: unified+wrap forced below `md`.
 *
 * The log is the contextual sidebar's list; the main area is the picked commit, or a prompt to
 * pick one. On a phone the sidebar is a sheet, so with nothing picked the main area carries the
 * list itself. The log is capped at 20 rows server-side (`getLog`) — a plain list, no windowing.
 */
export function RepoCommitsSection({ log, header }: { log: LogEntry[]; header: ReactNode }) {
  const { sha } = useParams<{ sha: string }>()

  return (
    <>
      <ContextSidebar>
        {header}
        <SidebarContent>
          <SidebarGroup className="pt-0">
            <SidebarGroupContent>
              {log.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No commits yet.</p>
              ) : (
                <SidebarMenu data-slot="repo-commits">
                  {log.map((commit) => (
                    <SidebarMenuItem key={commit.hash}>
                      <SidebarMenuButton asChild isActive={sameCommit(commit.hash, sha)} className="h-auto py-2">
                        <Link data-slot="commit-row" data-sha={commit.hash} to={`/git/commits/${commit.hash}`}>
                          <CommitLines commit={commit} />
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </ContextSidebar>

      {sha ? (
        <CommitDiffView sha={sha} />
      ) : log.length === 0 ? (
        <RepoEmpty
          icon={<GitCommitHorizontalIcon />}
          title="No commits yet"
          description="The log is empty — this repository has no commits to show."
        />
      ) : (
        <>
          <Empty data-slot="commit-pick" className="hidden flex-1 py-16 md:flex">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GitCommitHorizontalIcon />
              </EmptyMedia>
              <EmptyTitle>Pick a commit</EmptyTitle>
              <EmptyDescription>Choose a commit from the list to see what it changed.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <OpenSidebarButton>Show commits</OpenSidebarButton>
            </EmptyContent>
          </Empty>
          {/* Phones: the sidebar is a closed sheet, so the list is the page. */}
          <PageBody className="pt-4 md:hidden">
            <h1 className="pb-3 text-[15px] font-semibold text-foreground">Commits</h1>
            <div className="divide-y divide-border overflow-hidden rounded-xl border bg-card shadow-xs">
              {log.map((commit) => (
                <Link
                  key={commit.hash}
                  data-slot="commit-row"
                  data-sha={commit.hash}
                  to={`/git/commits/${commit.hash}`}
                  className="flex min-h-14 min-w-0 items-center px-4 py-2.5 outline-none hover:bg-muted/50 focus-visible:bg-muted/50"
                >
                  <CommitLines commit={commit} />
                </Link>
              ))}
            </div>
          </PageBody>
        </>
      )}
    </>
  )
}

/** The log abbreviates hashes; a pasted URL may carry the full one. */
function sameCommit(hash: string, sha: string | undefined): boolean {
  return sha !== undefined && sha.length >= 4 && (hash.startsWith(sha) || sha.startsWith(hash))
}

/** A commit row's two lines: the subject, then the muted `sha · author · age`. */
function CommitLines({ commit }: { commit: LogEntry }) {
  return (
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="truncate text-[13px] font-medium text-foreground">{commit.subject}</span>
      <span className="truncate text-xs font-normal text-muted-foreground">
        <span className="font-mono">{commit.hash}</span> · {commit.author} · {commit.when}
      </span>
    </span>
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
      <PageToolbar className="gap-x-3 pt-4">
        {/* The way back to the list on a phone; on desktop the list is beside the detail. */}
        <Button asChild variant="ghost" size="sm" data-slot="commit-back" className="-ml-2 md:hidden">
          <Link to="/git/commits">
            <ArrowLeftIcon aria-hidden="true" />
            All commits
          </Link>
        </Button>
        <span className="hidden text-[13px] font-medium text-foreground md:inline">
          Commit <span className="font-mono text-xs text-muted-foreground">{sha.slice(0, 12)}</span>
        </span>
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
            <h1 className="text-[17px] font-semibold text-pretty text-foreground">{commit.data.subject}</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {commit.data.author} · {commit.data.when} ·{' '}
              <span className="font-mono text-xs select-all">{commit.data.sha}</span>
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
