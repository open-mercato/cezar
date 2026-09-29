import { useMemo, useState } from 'react'

import { useRefreshSelfUpdateDevelopment, useSelfUpdateDevelopment } from '@/api/queries'
import type { CezarCheckout, PullBuild, SelfUpdateStatus } from '@open-mercato/cezar-api-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { shortAge } from '@/lib/format'
import { cn } from '@/lib/utils'

/** The PR number a preview version was cut for (`0.13.0-pr1169.1234` → 1169), else null. */
export function pullOfVersion(version: string): number | null {
  const match = /-pr(\d+)\./.exec(version)
  return match ? Number(match[1]) : null
}

type Tab = 'worktrees' | 'pulls'

/**
 * The development channel: run one of cezar's own worktrees (linked, not copied) or the preview
 * build CI published for an open pull request. Branch names alone do not tell forty task
 * worktrees apart, so every row carries what does: the task's title, the last commit and its
 * age, whether the build predates it, and the PR the branch belongs to.
 */
export function DevelopmentPanel({
  data,
  onApply,
  applying,
}: {
  data: SelfUpdateStatus
  onApply: (target: string) => void
  applying: boolean
}) {
  const dev = useSelfUpdateDevelopment()
  const refresh = useRefreshSelfUpdateDevelopment()
  const [tab, setTab] = useState<Tab>('worktrees')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  // Most open PRs have no build (a fork waiting on CI approval): listing them by default buries
  // the few that can actually be installed.
  const [showUnbuilt, setShowUnbuilt] = useState(false)
  const jobBusy = data.job?.status === 'running' || data.job?.status === 'restarting'
  const active = data.installed.find((entry) => entry.active)
  const checkouts = dev.data?.checkouts ?? []
  const pulls = dev.data?.pulls

  const needle = query.trim().toLowerCase()
  const shownCheckouts = useMemo(
    () =>
      checkouts.filter((checkout) =>
        !needle
          ? true
          : [checkout.branch, checkout.task?.title, checkout.task?.id, checkout.commit?.subject, checkout.worktree, checkout.pr ? `#${checkout.pr}` : '']
              .filter(Boolean)
              .some((field) => field!.toLowerCase().includes(needle)),
      ),
    [checkouts, needle],
  )
  const shownPulls = useMemo(
    () =>
      (pulls?.items ?? []).filter((pull) =>
        !pull.version && !showUnbuilt
          ? false
          : !needle
          ? true
          : [`#${pull.number}`, String(pull.number), pull.title, pull.branch, pull.author ?? ''].some((field) =>
              field.toLowerCase().includes(needle),
            ),
      ),
    [pulls, needle, showUnbuilt],
  )
  const unbuilt = (pulls?.items ?? []).filter((pull) => !pull.version).length

  const pickedCheckout = tab === 'worktrees' ? checkouts.find((checkout) => checkout.id === picked) : undefined
  const pickedPull = tab === 'pulls' ? pulls?.items.find((pull) => pull.version && pull.version === picked) : undefined
  const target = pickedCheckout?.id ?? pickedPull?.version ?? null
  // An unbuilt or stale worktree is built on the server before the switch — even the one that is
  // running, which is how "rebuild what I am on" is spelled.
  const needsBuild = !!pickedCheckout && (!pickedCheckout.built || pickedCheckout.stale)
  const targetIsActive = !!target && target === active?.id && !needsBuild
  const actionLabel = pickedPull && !pickedPull.installed
    ? 'Install & restart'
    : needsBuild
      ? `${pickedCheckout!.built ? 'Rebuild' : 'Build'} & ${pickedCheckout!.id === active?.id ? 'restart' : 'switch'}`
      : 'Switch & restart'

  return (
    <div data-slot="self-update-development" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div role="tablist" aria-label="Development builds" className="flex rounded-md border border-border bg-muted/40 p-0.5">
          {(
            [
              { value: 'worktrees', label: 'Worktrees', count: checkouts.length },
              { value: 'pulls', label: 'Pull requests', count: (pulls?.items.length ?? 0) - unbuilt },
            ] as const
          ).map((entry) => (
            <button
              key={entry.value}
              type="button"
              role="tab"
              aria-selected={tab === entry.value}
              onClick={() => {
                setTab(entry.value)
                setPicked(null)
              }}
              className={cn(
                'rounded-[5px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                tab === entry.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {entry.label}
              {dev.data ? <span className="ml-1.5 font-normal text-muted-foreground">{entry.count}</span> : null}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending || dev.isFetching}>
          {refresh.isPending ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <Input
        aria-label="Filter"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={tab === 'worktrees' ? 'Filter by task, branch, commit or #PR' : 'Filter by #number, title, branch or author'}
        className="h-8 text-[13px]"
      />

      <div role="listbox" aria-label={tab === 'worktrees' ? 'Worktrees' : 'Pull requests'} className="max-h-72 min-h-24 overflow-y-auto rounded-md border border-border">
        {dev.isPending ? (
          <p className="px-3 py-3 text-[12.5px] text-muted-foreground">Looking for worktrees and pull requests…</p>
        ) : dev.error ? (
          <p className="px-3 py-3 text-[12.5px] text-danger">{dev.error.message}</p>
        ) : tab === 'worktrees' ? (
          shownCheckouts.length === 0 ? (
            <p className="px-3 py-3 text-[12.5px] text-muted-foreground">
              {checkouts.length === 0 ? 'No cezar worktree found in the registered projects.' : 'Nothing matches.'}
            </p>
          ) : (
            shownCheckouts.map((checkout) => (
              <CheckoutRow
                key={checkout.worktree}
                checkout={checkout}
                active={checkout.id === active?.id}
                selected={picked === checkout.id}
                onSelect={() => setPicked(checkout.id)}
              />
            ))
          )
        ) : (
          <>
            {pulls && !pulls.available ? <p className="px-3 py-2 text-[12px] text-muted-foreground">{pulls.reason}</p> : null}
            {pulls?.available && shownPulls.length === 0 ? (
              <p className="px-3 py-3 text-[12.5px] text-muted-foreground">
                {pulls.items.length === 0
                  ? `No open pull requests on ${pulls.repo}.`
                  : needle
                    ? 'Nothing matches.'
                    : 'No open pull request has a preview build.'}
              </p>
            ) : null}
            {shownPulls.map((pull) => (
              <PullRow
                key={pull.number}
                pull={pull}
                active={!!pull.version && pull.version === active?.id}
                selected={!!pull.version && picked === pull.version}
                onSelect={() => pull.version && setPicked(pull.version)}
              />
            ))}
            {unbuilt > 0 ? (
              <button
                type="button"
                onClick={() => setShowUnbuilt((value) => !value)}
                className="w-full px-3 py-2 text-left text-[12px] text-muted-foreground hover:text-foreground"
              >
                {showUnbuilt
                  ? `Hide the ${unbuilt} without a preview build`
                  : `${unbuilt} more without a preview build (forks, CI not green yet) — show`}
              </button>
            ) : null}
          </>
        )}
      </div>

      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[11.5px] text-muted-foreground" title={pickedCheckout?.worktree}>
          {pickedCheckout
            ? needsBuild
              ? `${pickedCheckout.built ? 'Built before its last commit' : 'Not built yet'} — runs npm run build in ${pickedCheckout.worktree} first (about a minute).`
              : pickedCheckout.worktree
            : pickedPull
              ? `Installs ${pickedPull.version} from npm.`
              : tab === 'worktrees'
                ? 'Linked, not copied: a worktree that is not built, or built before its last commit, is built before the switch.'
                : 'Preview builds CI publishes for green same-repo pull requests.'}
        </p>
        <Button
          size="sm"
          variant="contrast"
          onClick={() => target && onApply(target)}
          disabled={!target || targetIsActive || !data.canSelfUpdate || applying || jobBusy}
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  )
}

function Row({
  selected,
  disabled,
  onSelect,
  title,
  children,
}: {
  selected: boolean
  disabled: boolean
  onSelect: () => void
  title?: string
  children: React.ReactNode
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      title={title}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(event) => {
        if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'flex min-w-0 flex-col gap-0.5 border-b border-border px-3 py-2 last:border-b-0 outline-none',
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/60',
        selected && 'bg-primary/10 hover:bg-primary/10',
      )}
    >
      {children}
    </div>
  )
}

function CheckoutRow({
  checkout,
  active,
  selected,
  onSelect,
}: {
  checkout: CezarCheckout
  active: boolean
  selected: boolean
  onSelect: () => void
}) {
  const headline = checkout.task?.title ?? checkout.commit?.subject ?? checkout.branch
  return (
    <Row selected={selected} disabled={!checkout.id} onSelect={onSelect} title={checkout.worktree}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{headline}</span>
        {checkout.pr ? <Badge variant="outline">#{checkout.pr}</Badge> : null}
        {active ? <Badge variant="secondary">current</Badge> : null}
        {!checkout.built ? (
          <Badge variant="outline">not built</Badge>
        ) : checkout.stale ? (
          <Badge variant="outline">needs rebuild</Badge>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span className="shrink-0 font-mono">{checkout.branch}</span>
        {checkout.task ? <span className="shrink-0">· {checkout.task.status}</span> : null}
        {checkout.commit ? (
          <span className="min-w-0 truncate">
            · {checkout.commit.sha} {checkout.task ? checkout.commit.subject : ''} · {shortAge(checkout.commit.at)} ago
          </span>
        ) : null}
        {checkout.builtAt ? <span className="shrink-0">· built {shortAge(checkout.builtAt)} ago</span> : null}
      </div>
    </Row>
  )
}

function PullRow({
  pull,
  active,
  selected,
  onSelect,
}: {
  pull: PullBuild
  active: boolean
  selected: boolean
  onSelect: () => void
}) {
  return (
    <Row selected={selected} disabled={!pull.version} onSelect={onSelect} title={pull.url}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[13px] text-muted-foreground">#{pull.number}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{pull.title}</span>
        {pull.draft ? <Badge variant="outline">draft</Badge> : null}
        {active ? (
          <Badge variant="secondary">current</Badge>
        ) : !pull.version ? (
          <Badge variant="outline">no build</Badge>
        ) : pull.installed ? (
          <Badge variant="outline">installed</Badge>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
        {pull.author ? <span className="shrink-0">{pull.author}</span> : null}
        <span className="min-w-0 truncate font-mono">· {pull.branch}</span>
        <span className="shrink-0">· updated {shortAge(pull.updatedAt)} ago</span>
        {pull.version ? (
          <span className="shrink-0">· build {pull.publishedAt ? `${shortAge(pull.publishedAt)} ago` : pull.version}</span>
        ) : null}
      </div>
    </Row>
  )
}
