import { GitBranchIcon, TriangleAlertIcon } from 'lucide-react'
import { useParams } from 'react-router'

import { useRepo } from '@/api/queries'
import type { RepoInfo, RepoResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { TabLink } from '@/components/tab-link'
import { useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { BranchChip } from '../task-git/diff-controls'
import { RepoBranchesSection } from './repo-branches'
import { RepoChangesSection } from './repo-changes'
import { RepoCommitsSection } from './repo-commits'
import { RepoFilesSection } from './repo-files'
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
 * `/git/branches`, `/git/files[/*path]`), so every surface deep-links and survives a refresh.
 *
 * `files` (#1279) is the one segment that is not a view of a diff: the repository's own tree and
 * the file under the cursor, so "what does the rest of this file look like?" stops sending the user
 * to another window.
 */
export type RepoTab = 'changes' | 'commits' | 'branches' | 'files'

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
          subtitle="The cockpit is running outside a git repository — start it inside one to browse changes, commits and branches."
        />
      </div>
    )
  }
  return <RepoView repo={repo.data} info={info} tab={tab} />
}

function RepoView({ repo, info, tab }: { repo: RepoResponse; info: RepoInfo; tab: RepoTab }) {
  return (
    // Changes fills `main` from md up so its tree and diff can be two scrollers of their own
    // (see `RepoChangesSection`); the other tabs scroll with the page.
    <div data-route="repo-git" className={cn('flex min-h-full flex-col', tab === 'changes' && 'md:h-full')}>
      <header
        data-slot="repo-header"
        className="sticky top-0 z-20 border-b border-border bg-background/95 px-4 pt-3 backdrop-blur md:px-6"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="text-lg font-semibold">Git</h1>
          <BranchChip branch={info.branch} />
          {info.remote ? (
            <span data-slot="repo-remote" className="hidden min-w-0 truncate text-[11px] text-soft-foreground md:inline">
              {info.remote}
            </span>
          ) : null}
        </div>

        <div data-slot="repo-tabs" className="mt-2.5 flex items-end gap-1">
          <TabLink to="/git" active={tab === 'changes'}>
            Changes
          </TabLink>
          <TabLink to="/git/commits" active={tab === 'commits'}>
            Commits
          </TabLink>
          <TabLink to="/git/branches" active={tab === 'branches'}>
            Branches
          </TabLink>
          <TabLink to="/git/files" active={tab === 'files'}>
            Files
          </TabLink>
        </div>
      </header>

      {tab === 'changes' ? (
        <RepoChangesSection />
      ) : tab === 'commits' ? (
        <RepoCommitsSection log={repo.log} />
      ) : tab === 'files' ? (
        <RepoFilesPane />
      ) : (
        <RepoBranchesSection repo={repo} info={info} />
      )}
    </div>
  )
}

/**
 * The Files segment's URL binding: `/git/files/<path>` IS the file's address, so a selection
 * survives a refresh and can be pasted to a colleague.
 *
 * Selection REPLACES history rather than pushing it — arrow-keying down a folder would otherwise
 * bury the previous tab under twenty selections, and Back should leave the Files tab, not walk
 * backwards through it.
 */
function RepoFilesPane() {
  const params = useParams()
  const navigate = useNavigate()
  const selected = params['*'] !== undefined && params['*'] !== '' ? params['*'] : null
  return (
    <RepoFilesSection
      selected={selected}
      onSelect={(path) =>
        navigate(path === null ? '/git/files' : `/git/files/${encodePathSegments(path)}`, {
          replace: true,
        })
      }
    />
  )
}

/** Per-SEGMENT encoding, so the slashes stay structural while a `#`, `?` or space in a file name
 *  cannot truncate the URL. React Router decodes the splat on the way back in. */
function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
