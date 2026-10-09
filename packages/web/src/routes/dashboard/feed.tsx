import { Inbox } from 'lucide-react'
import { Disclosure, Notice, WidgetEmpty, WidgetSkeleton, widgetHeading, widgetMeta } from './presentation'
import { ExportRows } from './export-rows'
import { useContext, useLayoutEffect, useMemo, useRef } from 'react'
import type { DashboardFeed, DashboardFeedRow } from '@open-mercato/cezar-api-client'
import { useDashboardFeed } from '@/api/dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { SegmentedControl } from '@/components/facet-filter'
import { shortAge } from '@/lib/format'
import { TaskRow, Coverage } from './rows'
import { DashboardEntryContext, readPanel, savePanel, useStagedRows } from './state'
function sourceLabel(key: string) {
  if (!key.startsWith('github:')) return key === 'tasks' ? 'Task results' : key
  const parts = key.slice(7).split(':')
  const kind = parts.pop() === 'pr' ? 'Pull requests' : 'Issues'
  const name = parts
    .join(':')
    .replace(/^project:/, 'Project ')
    .replace(/^github.com\//, '')
  return `${name} · ${kind}`
}
const feedKey = (row: DashboardFeedRow) => row.key
export function Feed({
  filter,
  setFilter,
  count,
  more,
}: {
  filter: DashboardFeed['filter']
  setFilter: (value: DashboardFeed['filter']) => void
  count: number
  more: () => void
}) {
  const query = useDashboardFeed(filter, true)
  const staged = useStagedRows(
    query.data?.rows, feedKey, `feed:${filter}`, 0,
    (row) => row.kind === 'task-result',
  )
  // Detached GitHub rows disappear immediately; task results retain reconciliation labels.
  const rows = staged.rows
  const updates = staged.updates
  const entry = useContext(DashboardEntryContext)
  const list = useRef<HTMLDivElement>(null)
  const scrollKey = `feed:${filter}`
  const restore = useMemo(() => ({
    scroll: readPanel(entry, scrollKey)?.scroll ?? 0,
    done: false,
  }), [entry, scrollKey])
  useLayoutEffect(() => {
    if (!list.current || restore.done) return
    list.current.scrollTop = restore.scroll
    // Cached rows may arrive after mounting; retry once the list can reach its position.
    restore.done = Math.abs(list.current.scrollTop - restore.scroll) < 1 ||
      (!!query.data && !query.isPending && !query.isFetching)
  }, [restore, rows.length, count, query.data, query.isPending, query.isFetching])
  const heading = useRef<HTMLHeadingElement>(null)
  const github = query.data?.sources.filter((s) => s.key.startsWith('github:')) ?? []
  const fetched = github.flatMap((s) => (s.fetchedAt ? [s.fetchedAt] : [])).sort()[0]
  const githubFailed = query.githubError
  const unconfigured = github.filter((s) => s.reason === 'No GitHub remote')
  const loading = github.some((s) => s.reason === 'Still loading GitHub')
  const noGithub = github.length > 0 && unconfigured.length === github.length && !githubFailed
  const errors = github.filter(
    (s) =>
      s.state !== 'ready' &&
      s.reason !== 'No GitHub remote' &&
      s.reason !== 'Still loading GitHub',
  )
  const tasksOnly = noGithub && filter === 'all'
  return (
    <Card
      data-export-context={`Results source: ${filter}; Last 7 days; loaded ${Math.min(count, rows.length)} rows`}
      className="min-w-0 gap-0 overflow-hidden py-0"
    >
      <div className="space-y-2 px-5 pt-4 pb-3">
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
          <h2 ref={heading} tabIndex={-1} className={widgetHeading}>
            {tasksOnly ? 'Recent results' : 'Recent results & GitHub'}
          </h2>
          <span className={widgetMeta}>Last 7 days</span>
        </div>
        {!tasksOnly && (
          <SegmentedControl
            slot="dashboard-feed"
            label="Results source"
            value={filter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'tasks', label: 'Tasks' },
              { value: 'github', label: 'GitHub' },
            ]}
            onChange={setFilter}
          />
        )}
        {tasksOnly && (
          <p className="text-[13px] text-muted-foreground">
            Task results · No GitHub repositories configured
          </p>
        )}
        {filter !== 'tasks' && !tasksOnly && (
          <Disclosure
            className="text-xs text-muted-foreground"
            forceOpen={!!(errors.length || githubFailed)}
            summaryClassName="py-1 no-hover:min-h-11"
            summary={
              errors.length || githubFailed
                ? 'GitHub needs attention'
                : loading
                  ? 'Checking GitHub…'
                  : noGithub
                    ? 'GitHub not configured'
                    : fetched
                      ? `GitHub checked ${shortAge(fetched)} ago`
                      : 'GitHub source'
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-x-3 pl-5 text-[13px]">
              <p>
                {errors.length || githubFailed
                  ? fetched
                    ? `Could not refresh GitHub. Showing results from ${new Date(fetched).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
                    : 'Could not load one or more GitHub sources.'
                  : loading
                    ? 'Checking repository sources. Available results remain visible.'
                    : noGithub
                      ? 'No GitHub repositories configured. Select Tasks to see task results.'
                      : fetched
                        ? `GitHub checked ${shortAge(fetched)} ago`
                        : 'GitHub snapshot'}
              </p>
              {!noGithub && (
                <Button
                  variant="link"
                  size="sm"
                  className="px-0 no-hover:min-h-11"
                  disabled={query.githubFetching}
                  onClick={() => {
                    void query.refetch()
                  }}
                >
                  {query.githubFetching
                    ? 'Refreshing…'
                    : errors.length || githubFailed
                      ? 'Retry GitHub'
                      : 'Refresh GitHub'}
                </Button>
              )}
            </div>
          </Disclosure>
        )}
      </div>
      <div
        role="region"
        aria-label="Recent results list"
        ref={list}
        onWheel={() => { restore.done = true }}
        onTouchStart={() => { restore.done = true }}
        onKeyDown={() => { restore.done = true }}
        onScroll={(event) => {
          if (entry && restore.done)
            savePanel(entry, scrollKey, { count, scroll: event.currentTarget.scrollTop })
        }}
        tabIndex={0}
        className="max-h-96 overflow-y-auto overscroll-contain border-t border-border/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      >
        {query.isError && (
          <Notice
            className="m-3"
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void query.retryFailed()
                }}
              >
                Retry
              </Button>
            }
          >
            Could not load results.
          </Notice>
        )}
        {query.isPending && <WidgetSkeleton label="Loading results…" className="p-5" />}
        {updates > 0 && (
          <Button
            variant="secondary"
            size="sm"
            className="mx-5 my-2"
            onClick={() => {
              staged.show()
              heading.current?.focus()
            }}
          >
            {updates} updates — Show
          </Button>
        )}
        {rows.slice(0, count).map(({ row, removed }) =>
          row.kind === 'task-result' ? (
            <TaskRow
              key={row.key}
              row={row.run}
              kicker={
                removed
                  ? 'Outside current results'
                  : `Latest result: ${row.run.status === 'failed' ? 'Failed' : 'Completed'}`
              }
            />
          ) : (
            <div key={row.key} className="border-b border-border/70 px-5 py-3 transition-colors last:border-0 hover:bg-muted/50">
              <ExportRows
                rows={[
                  {
                    section: 'github',
                    entity: `${row.repo}#${row.number}`,
                    metric: row.itemKind,
                    value: row.title,
                    asOf: row.at,
                    note: row.url,
                  },
                ]}
              />
              <a
                className="block break-words text-sm font-medium leading-relaxed underline-offset-4 hover:underline no-hover:min-h-11"
                href={row.url}
                target="_blank"
                rel="noreferrer"
              >
                {row.title}
              </a>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {row.repo} · {row.itemKind === 'pr' ? 'PR' : 'Issue'} #{row.number} created ·{' '}
                {shortAge(row.at)}
              </p>
            </div>
          ),
        )}
        {query.data &&
          !query.data.rows.length &&
          !rows.length &&
          !query.isFetching &&
          !query.isError &&
          !errors.length &&
          !loading &&
          query.data.coverage.projects.every((p) => p.state === 'complete') && (
            <WidgetEmpty icon={Inbox} title="No results in the last 7 days" />
          )}
        {count < rows.length && (
          <Button variant="ghost" size="sm" className="mx-3 my-2 text-muted-foreground" onClick={more}>
            Show {Math.min(20, rows.length - count)} more results
          </Button>
        )}
        {query.data?.truncated && (
          <p className="px-5 py-3 text-xs text-soft-foreground">Showing the latest 60 results</p>
        )}
        {query.data && query.data.coverage.projects.some((p) => p.state !== 'complete') && (
          <div className="p-3">
            <Coverage
              coverage={query.data.coverage}
              retry={() => {
                void query.retryTasks()
              }}
            />
          </div>
        )}
        {!tasksOnly && query.data?.sources.some((s) => s.state !== 'ready' || s.truncated) && (
          <Disclosure
            className="px-5 py-3 text-xs text-muted-foreground"
            summaryClassName="py-1 no-hover:min-h-11"
            summary="Source details"
          >
            {query.data.sources.map((s) => (
              <p className="break-words py-1 pl-5" key={s.key}>
                {sourceLabel(s.key)}:{' '}
                {s.reason === 'No GitHub remote'
                  ? 'Not configured'
                  : s.reason === 'Still loading GitHub'
                    ? 'Checking…'
                    : (s.reason ?? (s.state === 'ready' ? 'Up to date' : s.state))}
                {s.truncated ? ' · capped' : ''}
                {s.fetchedAt ? ` · checked ${shortAge(s.fetchedAt)}` : ''}
              </p>
            ))}
          </Disclosure>
        )}
      </div>
    </Card>
  )
}
