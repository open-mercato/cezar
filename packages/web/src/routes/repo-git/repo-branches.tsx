import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftRightIcon,
  CopyIcon,
  GitBranchIcon,
  GitForkIcon,
  GitPullRequestIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { createRepoBranch, putConfig } from '@/api/client'
import { queryKeys, useGithub, useHealth } from '@/api/queries'
import type { GithubItem, HealthResponse, RepoInfo, RepoResponse } from '@open-mercato/cezar-api-client'
import { PageBody, PageSection, PageToolbar } from '@/components/page'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { cn, isHttpUrl } from '@/lib/utils'

/** Radix Select has no empty-string item: this stands for "no base branch configured". */
const FOLLOW_CHECKED_OUT = '__follow__'

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
          : 'Agents now fork from the checked-out branch',
      )
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
    },
    onError,
  })

  const [newName, setNewName] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [branchQuery, setBranchQuery] = useState('')
  const normalizedBranchQuery = branchQuery.trim().toLowerCase()
  const filteredBranches = normalizedBranchQuery
    ? repo.branches.filter((name) => name.toLowerCase().includes(normalizedBranchQuery))
    : repo.branches
  const submitCreate = (event: FormEvent) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name) return
    branchAction.mutate(name, {
      onSuccess: () => {
        setNewName('')
        setCreateOpen(false)
      },
    })
  }
  const copyName = (name: string) => {
    void navigator.clipboard?.writeText(name).then(() => toast(`Copied ${name}`))
  }

  return (
    <section data-slot="repo-branches" className="flex flex-1 flex-col">
      <PageToolbar>
        <InputGroup className="w-full sm:max-w-xs">
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Filter branches"
            placeholder="Filter branches…"
            value={branchQuery}
            onChange={(event) => setBranchQuery(event.target.value)}
          />
        </InputGroup>
        <span className="text-[13px] text-muted-foreground tabular-nums">
          {filteredBranches.length === repo.branches.length
            ? `${repo.branches.length} branches`
            : `${filteredBranches.length} of ${repo.branches.length}`}
        </span>
        <Popover open={createOpen} onOpenChange={setCreateOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto" data-action="new-branch">
              <PlusIcon aria-hidden="true" />
              New branch
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <form data-slot="branch-create" className="flex flex-col gap-3" onSubmit={submitCreate}>
              <Field>
                <FieldLabel htmlFor="new-branch-name">New branch name</FieldLabel>
                <Input
                  id="new-branch-name"
                  aria-label="New branch name"
                  placeholder="new-branch-name"
                  className="font-mono"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                />
                <FieldDescription>Created from {info.branch} and checked out.</FieldDescription>
              </Field>
              <Button
                type="submit"
                size="sm"
                className="self-end"
                data-action="create-branch"
                disabled={!newName.trim() || branchAction.isPending}
              >
                Create branch
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      </PageToolbar>

      <PageBody className="grid items-start gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <Table data-slot="repo-branch-list">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-10 w-full pl-4 text-xs font-medium text-muted-foreground">Branch</TableHead>
                <TableHead className="h-10 w-12 pr-3">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredBranches.map((name) => {
                const current = name === info.branch
                const base = name === repo.baseBranch
                return (
                  <TableRow key={name} data-slot="branch-row" data-branch={name} className="h-11 hover:bg-muted/50">
                    <TableCell className="max-w-0 pl-4">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className={cn('min-w-0 truncate font-mono text-[12.5px]', current && 'font-semibold')}>
                          {name}
                        </span>
                        {current ? (
                          <Badge variant="outline" data-slot="branch-current" className="gap-1.5 font-normal">
                            <StatusDot tone="success" />
                            Current
                          </Badge>
                        ) : null}
                        {base ? (
                          <Badge variant="secondary" data-slot="branch-base" className="font-normal">
                            Agents’ base
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="pr-3 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`}>
                            <MoreHorizontalIcon aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            data-action="switch-branch"
                            disabled={current || branchAction.isPending}
                            onSelect={() => branchAction.mutate(name)}
                          >
                            <ArrowLeftRightIcon aria-hidden="true" />
                            Switch to this branch
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            data-action="set-base-branch"
                            disabled={base || setBase.isPending}
                            onSelect={() => setBase.mutate(name)}
                          >
                            <GitForkIcon aria-hidden="true" />
                            Use as agents’ base branch
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => copyName(name)}>
                            <CopyIcon aria-hidden="true" />
                            Copy name
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filteredBranches.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={2}
                    data-slot="branch-empty"
                    className="h-20 text-center text-[13px] text-muted-foreground"
                  >
                    No branches match “{branchQuery.trim()}”.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>

        <div className="min-w-0">
          <PageSection title="Agents’ base branch" description="New task worktrees branch from this.">
            <Select
              value={repo.baseBranch ?? FOLLOW_CHECKED_OUT}
              disabled={setBase.isPending}
              onValueChange={(value) => setBase.mutate(value === FOLLOW_CHECKED_OUT ? null : value)}
            >
              <SelectTrigger id="base-branch-picker" data-slot="base-branch-picker" aria-label="Agents’ base branch" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW_CHECKED_OUT}>Follow checked-out branch (default)</SelectItem>
                {repo.branches.map((name) => (
                  <SelectItem key={name} value={name} className="font-mono text-[12.5px]">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PageSection>

          {health.data?.forge?.available ? <ForgePullRequests /> : null}
        </div>
      </PageBody>
    </section>
  )
}

/** Mounted only behind the forge gate, so `/api/github` is fetched only when a driver is
 *  available. The payload itself still degrades (`available:false` + reason) — rendered
 *  honestly rather than hidden, since at this point a forge was detected. */
function ForgePullRequests() {
  const github = useGithub({ limit: 20 })
  const note = 'text-[13px] text-muted-foreground'
  return (
    <PageSection title="Open pull requests">
      <div data-slot="repo-prs">
        {github.isPending ? (
          <p className={note}>Loading pull requests…</p>
        ) : github.isError ? (
          <p className={note}>{github.error.message}</p>
        ) : !github.data.available ? (
          <p data-slot="repo-prs-unavailable" className={note}>
            {github.data.reason ?? 'The forge is unreachable right now.'}
          </p>
        ) : github.data.prs.length === 0 ? (
          <p className={note}>No open pull requests.</p>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {github.data.prs.map((pr) => (
              <PullRequestRow key={pr.number} pr={pr} />
            ))}
          </ul>
        )}
      </div>
    </PageSection>
  )
}

function PullRequestRow({ pr }: { pr: GithubItem }) {
  const inner = (
    <>
      <GitPullRequestIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[13px] text-foreground">{pr.title}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-mono text-[11px]">#{pr.number}</span>
          {pr.checks ? <ChecksBadge checks={pr.checks} /> : null}
        </span>
      </span>
    </>
  )
  const rowClass = 'flex min-w-0 items-start gap-2 rounded-md px-2 py-2'
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
    <span data-slot="pr-checks" data-checks={checks} className="flex items-center gap-1">
      <span aria-hidden="true">·</span>
      <StatusDot tone={checks === 'passing' ? 'success' : checks === 'failing' ? 'danger' : 'pending'} />
      {checks}
    </span>
  )
}
