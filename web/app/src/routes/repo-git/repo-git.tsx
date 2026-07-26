import { GitBranchIcon, TriangleAlertIcon } from 'lucide-react'

import { useRepo } from '@/api/queries'
import type { RepoInfo, RepoResponse } from '@/api/types'
import { CenteredState } from '@/components/centered-state'
import { PageHeader } from '@/components/page-header'
import { TabLink } from '@/components/tab-link'

import { BranchChip } from '../task-git/diff-controls'
import { RepoBranchesSection } from './repo-branches'
import { RepoChangesSection } from './repo-changes'
import { RepoCommitsSection } from './repo-commits'
import { RepoGitLoading } from './repo-git-loading'

/**
 * `/git` — the repo view rebuilt on the task git view's own components (spec §"Session git
 * view — Changes & Files tabs (#390)" last bullet, R5 Step 1.7): the MAIN working tree's
 * structured diff through the same `<Diff>` facade and tree, the recent-commit log with a
 * structured per-commit diff, and the branch list with switch/create + the agents'
 * base-branch picker. Forge-specific rows (PR links, checks) render only when
 * `/api/health` says the forge driver is available.
 *
 * The sections are underline segments — the same `TabLink` grammar as the run header's
 * Session | Changes | Files row — and each one is a URL (`/git`, `/git/commits[/:sha]`,
 * `/git/branches`), so every surface deep-links and survives a refresh.
 */
export type RepoTab = 'changes' | 'commits' | 'branches'

export function RepoGitRoute({ tab }: { tab: RepoTab }) {
  const repo = useRepo()

  if (repo.isPending) return <RepoGitLoading />
  if (repo.isError) {
    return (
      <div data-route="repo-git" className="flex min-h-full flex-col">
        <CenteredState
          icon={<TriangleAlertIcon />}
          tone="danger"
          title="Could not load the repository"
          subtitle={repo.error.message}
        />
      </div>
    )
  }
  const info = repo.data.info
  if (!info) {
    return (
      <div data-route="repo-git" className="flex min-h-full flex-col">
        <CenteredState
          icon={<GitBranchIcon />}
          tone="neutral"
          title="Not a git repository"
          subtitle="cezar is running outside a git repository — start it inside one to browse changes, commits and branches."
        />
      </div>
    )
  }
  return <RepoView repo={repo.data} info={info} tab={tab} />
}

function RepoView({ repo, info, tab }: { repo: RepoResponse; info: RepoInfo; tab: RepoTab }) {
  return (
    <div data-route="repo-git" className="flex min-h-full flex-col">
      <PageHeader
        data-slot="repo-header"
        className="z-20"
        title="Git"
        meta={
          <>
            <BranchChip branch={info.branch} />
            {info.remote ? (
              <span data-slot="repo-remote" className="hidden min-w-0 truncate text-2xs text-soft-foreground md:inline">
                {info.remote}
              </span>
            ) : null}
          </>
        }
        tabs={
          <div data-slot="repo-tabs" className="flex items-end gap-1 px-4 md:px-5">
            <TabLink to="/git" active={tab === 'changes'}>
              Changes
            </TabLink>
            <TabLink to="/git/commits" active={tab === 'commits'}>
              Commits
            </TabLink>
            <TabLink to="/git/branches" active={tab === 'branches'}>
              Branches
            </TabLink>
          </div>
        }
      />

      {tab === 'changes' ? (
        <RepoChangesSection />
      ) : tab === 'commits' ? (
        <RepoCommitsSection log={repo.log} />
      ) : (
        <RepoBranchesSection repo={repo} info={info} />
      )}
    </div>
  )
}
