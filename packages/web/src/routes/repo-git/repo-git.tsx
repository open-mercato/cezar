import { GitBranchIcon, TriangleAlertIcon } from 'lucide-react'

import { useRepo } from '@/api/queries'
import type { RepoInfo, RepoResponse } from '@open-mercato/cezar-api-client'
import { Page } from '@/components/page'

import { RepoBranchesSection } from './repo-branches'
import { RepoChangesSection } from './repo-changes'
import { RepoCommitsSection } from './repo-commits'
import { RepoEmpty } from './repo-empty'
import { RepoGitLoading } from './repo-git-loading'
import { RepoSidebarHeader, type RepoTab } from './repo-sidebar'

/**
 * `/git` — the repo view rebuilt on the task git view's own components (spec §"Session git
 * view — Changes & Files tabs (#390)" last bullet, R5 Step 1.7): the MAIN working tree's
 * structured diff through the same `<Diff>` facade and tree, the recent-commit log with a
 * structured per-commit diff, and the branch list with switch/create + the agents'
 * base-branch picker. Forge-specific rows (PR links, checks) render only when
 * `/api/health` says the forge driver is available.
 *
 * Master–detail: the contextual sidebar holds the section switch and the section's list (the
 * changed-files tree, the commit log, the branches); the main area is the detail only. Each
 * section is a URL (`/git`, `/git/commits[/:sha]`, `/git/branches`), so every surface
 * deep-links and survives a refresh.
 */
export type { RepoTab }

export function RepoGitRoute({ tab }: { tab: RepoTab }) {
  const repo = useRepo()

  if (repo.isPending) return <RepoGitLoading />
  if (repo.isError) {
    return (
      <Page data-route="repo-git" width="wide">
        <RepoEmpty
          icon={<TriangleAlertIcon />}
          tone="danger"
          title="Could not load the repository"
          description={repo.error.message}
        />
      </Page>
    )
  }
  const info = repo.data.info
  if (!info) {
    return (
      <Page data-route="repo-git" width="wide">
        <RepoEmpty
          icon={<GitBranchIcon />}
          title="Not a git repository"
          description="The cockpit is running outside a git repository — start it inside one to browse changes, commits and branches."
        />
      </Page>
    )
  }
  return <RepoView repo={repo.data} info={info} tab={tab} />
}

function RepoView({ repo, info, tab }: { repo: RepoResponse; info: RepoInfo; tab: RepoTab }) {
  // Each section renders its own `<ContextSidebar>` (list and detail share state), led by this.
  const header = (extra?: React.ReactNode) => (
    <RepoSidebarHeader info={info} tab={tab}>
      {extra}
    </RepoSidebarHeader>
  )
  return (
    <Page data-route="repo-git" width="full">
      {tab === 'changes' ? (
        <RepoChangesSection header={header()} />
      ) : tab === 'commits' ? (
        <RepoCommitsSection log={repo.log} header={header()} />
      ) : (
        <RepoBranchesSection repo={repo} info={info} header={header} />
      )}
    </Page>
  )
}
