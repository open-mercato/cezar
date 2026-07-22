import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, GitBranchIcon, GitPullRequestIcon, PlusIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { createRepoBranch, putConfig } from '@/api/client'
import { queryKeys, useGithub, useHealth } from '@/api/queries'
import type { GithubItem, HealthResponse, RepoInfo, RepoResponse } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { cn, isHttpUrl } from '@/lib/utils'

/**
 * The repo view's Branches segment (R5 Step 1.7): the branch list `GET /api/repo` already
 * carries, with switch/create wired to `POST /api/repo/branch` (1.3) — every predictable git
 * refusal (dirty tree, invalid name) comes back as a 409 whose reason surfaces verbatim as a
 * danger toast. The agents' base-branch picker rides the same payload's `baseBranch` +
 * `PUT /api/config`, exactly like the legacy Repo tab did.
 *
 * Forge-specific rows (open PRs with checks badges) render ONLY when `/api/health` reports
 * the forge driver available — no driver, no PR surface, per the forge-seam doctrine. The
 * component gate doubles as the fetch gate: `<ForgePullRequests>` mounts (and so queries
 * `/api/github`) only behind it.
 */
export function RepoBranchesSection({ repo, info }: { repo: RepoResponse; info: RepoInfo }) {
  const health = useHealth()
  const queryClient = useQueryClient()
  const onError = (error: Error) => toast(error.message, { tone: 'danger' })

  const branchAction = useMutation({
    mutationFn: (name: string) => createRepoBranch({ name }),
    onSuccess: async (result) => {
      toast(result.created ? `Created and switched to ${result.branch}` : `Switched to ${result.branch}`)
      // Refresh the rest of both payloads first, then preserve the mutation's authoritative
      // checkout result even if a read races and briefly returns the previous HEAD.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.repo }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ])
      queryClient.setQueryData<RepoResponse>(queryKeys.repo, (current) =>
        current?.info ? { ...current, info: { ...current.info, branch: result.branch } } : current,
      )
      // Health is workspace-level, so only patch it when it describes this repo.
      queryClient.setQueryData<HealthResponse>(queryKeys.health, (current) =>
        current?.repo?.root === info.root
          ? { ...current, repo: { ...current.repo, branch: result.branch } }
          : current,
      )
    },
    onError,
  })

  const setBase = useMutation({
    mutationFn: (baseBranch: string | null) => putConfig({ baseBranch }),
    onSuccess: (result) => {
      toast(
        result.baseBranch
          ? `Agents now branch from ${result.baseBranch}`
          : 'Agents now branch from the current checkout',
      )
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
    },
    onError,
  })

  const [newName, setNewName] = useState('')
  const [branchQuery, setBranchQuery] = useState('')
  const normalizedBranchQuery = branchQuery.trim().toLowerCase()
  const filteredBranches = normalizedBranchQuery
    ? repo.branches.filter((name) => name.toLowerCase().includes(normalizedBranchQuery))
    : repo.branches
  const submitCreate = (event: FormEvent) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name) return
    branchAction.mutate(name, { onSuccess: () => setNewName('') })
  }

  return (
    <section data-slot="repo-branches" className="flex flex-col gap-6 px-4 py-4 md:px-6">
      <div>
        <h2 className="text-xs font-semibold tracking-wide text-soft-foreground uppercase">Branches</h2>
        <Input
          aria-label="Filter branches"
          placeholder="Filter branches…"
          value={branchQuery}
          onChange={(event) => setBranchQuery(event.target.value)}
          className="mt-2 max-w-xl"
        />
        <ul data-slot="repo-branch-list" className="mt-2 flex max-w-xl flex-col divide-y divide-border">
          {filteredBranches.map((name) => {
            const current = name === info.branch
            return (
              <li key={name} data-slot="branch-row" data-branch={name} className="flex min-h-9 items-center gap-2 py-1">
                <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className={cn('min-w-0 truncate font-mono text-xs', current && 'font-semibold')}>{name}</span>
                {current ? (
                  <span
                    data-slot="branch-current"
                    className="flex shrink-0 items-center gap-1 rounded-sm bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"
                  >
                    <CheckIcon aria-hidden="true" className="size-3" />
                    current
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-action="switch-branch"
                    className="ml-auto"
                    disabled={branchAction.isPending}
                    onClick={() => branchAction.mutate(name)}
                  >
                    Switch
                  </Button>
                )}
              </li>
            )
          })}
          {filteredBranches.length === 0 ? (
            <li data-slot="branch-empty" className="py-3 text-xs text-soft-foreground">
              No branches match “{branchQuery.trim()}”.
            </li>
          ) : null}
        </ul>

        <form data-slot="branch-create" className="mt-3 flex max-w-md items-center gap-2" onSubmit={submitCreate}>
          <Input
            aria-label="New branch name"
            placeholder="new-branch-name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            data-action="create-branch"
            disabled={!newName.trim() || branchAction.isPending}
          >
            <PlusIcon aria-hidden="true" />
            Create
          </Button>
        </form>
      </div>

      <div className="max-w-md">
        <label
          htmlFor="base-branch-picker"
          className="text-xs font-semibold tracking-wide text-soft-foreground uppercase"
        >
          Agents’ base branch
        </label>
        {/* A native <select>: a handful of branch names needs no popover machinery, and the
            OS picker is the better control on phones. */}
        <select
          id="base-branch-picker"
          data-slot="base-branch-picker"
          value={repo.baseBranch ?? ''}
          disabled={setBase.isPending}
          onChange={(event) => setBase.mutate(event.target.value === '' ? null : event.target.value)}
          className="mt-1.5 block w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <option value="">current checkout (default)</option>
          {repo.branches.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-soft-foreground">New task worktrees branch from this.</p>
      </div>

      {health.data?.forge?.available ? <ForgePullRequests /> : null}
    </section>
  )
}

/** Mounted only behind the forge gate, so `/api/github` is fetched only when a driver is
 *  available. The payload itself still degrades (`available:false` + reason) — rendered
 *  honestly rather than hidden, since at this point a forge was detected. */
function ForgePullRequests() {
  const github = useGithub({ limit: 20 })
  return (
    <div data-slot="repo-prs" className="max-w-xl">
      <h2 className="text-xs font-semibold tracking-wide text-soft-foreground uppercase">Open pull requests</h2>
      {github.isPending ? (
        <p className="mt-2 text-xs text-soft-foreground">Loading pull requests…</p>
      ) : github.isError ? (
        <p className="mt-2 text-xs text-soft-foreground">{github.error.message}</p>
      ) : !github.data.available ? (
        <p data-slot="repo-prs-unavailable" className="mt-2 text-xs text-soft-foreground">
          {github.data.reason ?? 'The forge is unreachable right now.'}
        </p>
      ) : github.data.prs.length === 0 ? (
        <p className="mt-2 text-xs text-soft-foreground">No open pull requests.</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-border">
          {github.data.prs.map((pr) => (
            <PullRequestRow key={pr.number} pr={pr} />
          ))}
        </ul>
      )}
    </div>
  )
}

function PullRequestRow({ pr }: { pr: GithubItem }) {
  const inner = (
    <>
      <GitPullRequestIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{pr.number}</span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{pr.title}</span>
      {pr.checks ? <ChecksBadge checks={pr.checks} /> : null}
    </>
  )
  const rowClass = 'flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-2'
  return (
    <li data-slot="pr-row" data-number={pr.number}>
      {/* href protocol guard (#431): link only for http(s) URLs, else inert row. */}
      {isHttpUrl(pr.url) ? (
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className={cn(rowClass, 'hover:bg-muted')}>
          {inner}
        </a>
      ) : (
        <span className={rowClass}>{inner}</span>
      )}
    </li>
  )
}

/** The checks badge — the same three words the GitHub tab uses, tinted by outcome. */
function ChecksBadge({ checks }: { checks: 'passing' | 'failing' | 'pending' }) {
  return (
    <span
      data-slot="pr-checks"
      data-checks={checks}
      className={cn(
        'shrink-0 text-[10px] font-medium',
        checks === 'passing' && 'text-success',
        checks === 'failing' && 'text-danger',
        checks === 'pending' && 'text-muted-foreground',
      )}
    >
      {checks}
    </span>
  )
}
