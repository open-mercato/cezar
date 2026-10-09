import { GitBranchIcon, TriangleAlertIcon } from 'lucide-react'

import { useRepo } from '@/api/queries'
import type { RepoInfo, RepoResponse } from '@open-mercato/cezar-api-client'
import { Page, PageHeader } from '@/components/page'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Link } from '@/lib/project-router'

import { BranchChip } from '../task-git/diff-controls'
import { RepoBranchesSection } from './repo-branches'
import { RepoChangesSection } from './repo-changes'
import { RepoCommitsSection } from './repo-commits'
import { RepoEmpty } from './repo-empty'
import { RepoGitLoading } from './repo-git-loading'

/**
 * `/git` — the repo view rebuilt on the task git view's own components (spec §"Session git
 * view — Changes & Files tabs (#390)" last bullet, R5 Step 1.7): the MAIN working tree's
 * structured diff through the same `<Diff>` facade and tree, the recent-commit log with a
 * structured per-commit diff, and the branch list with switch/create + the agents'
 * base-branch picker. Forge-specific rows (PR links, checks) render only when
 * `/api/health` says the forge driver is available.
 *
 * The sections are tabs, and each one is a URL (`/git`, `/git/commits[/:sha]`,
 * `/git/branches`), so every surface deep-links and survives a refresh.
 */
export type RepoTab = 'changes' | 'commits' | 'branches'

const TABS: { value: RepoTab; to: string; label: string }[] = [
  { value: 'changes', to: '/git', label: 'Changes' },
  { value: 'commits', to: '/git/commits', label: 'Commits' },
  { value: 'branches', to: '/git/branches', label: 'Branches' },
]

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
  return (
    <Page data-route="repo-git" width="wide">
      <PageHeader
        title="Git"
        description="The main working tree: uncommitted changes, recent commits and branches."
      >
        <div data-slot="repo-header" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <Tabs value={tab}>
            <TabsList data-slot="repo-tabs">
              {TABS.map((entry) => (
                <TabsTrigger key={entry.value} value={entry.value} asChild>
                  <Link to={entry.to} aria-current={tab === entry.value ? 'page' : undefined}>
                    {entry.label}
                  </Link>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex min-w-0 items-center gap-2.5">
            {info.remote ? (
              <span
                data-slot="repo-remote"
                className="hidden max-w-80 min-w-0 truncate text-xs text-muted-foreground md:inline"
              >
                {info.remote}
              </span>
            ) : null}
            <BranchChip branch={info.branch} />
          </div>
        </div>
      </PageHeader>

      {tab === 'changes' ? (
        <RepoChangesSection />
      ) : tab === 'commits' ? (
        <RepoCommitsSection log={repo.log} />
      ) : (
        <RepoBranchesSection repo={repo} info={info} />
      )}
    </Page>
  )
}
