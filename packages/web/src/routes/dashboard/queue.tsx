import { CircleCheck } from 'lucide-react'
import { Notice, WidgetEmpty, widgetHeader, widgetHeading, widgetMeta } from './presentation'
import { cn } from '@/lib/utils'
import { useDashboardLive } from '@/api/dashboard-live'
import { useRef } from 'react'
import type { DashboardSnapshot } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useDashboardPage, useDisplacedRows } from './pages'
import { TaskRow, taskKey } from './rows'
import { useStagedRows } from './state'
export function Queue({
  snapshot,
  questions,
  reviews,
  more,
  healthy = true,
}: {
  healthy?: boolean
  snapshot: DashboardSnapshot
  questions: number
  reviews: number
  more: (group: 'questions' | 'reviews', count: number) => void
}) {
  const live = useDashboardLive()
  return (
    <Card className="min-w-0 gap-0 overflow-hidden py-0">
      <div className={`${widgetHeader} pb-3`}>
        <h2 id="dashboard-needs-you" tabIndex={-1} className={`${widgetHeading} outline-none`}>
          Needs you{' '}
          <span
            className={cn(
              'font-normal tabular-nums',
              snapshot.counts.questions + snapshot.counts.reviews
                ? 'text-violet'
                : 'text-soft-foreground',
            )}
          >
            · {snapshot.counts.questions + snapshot.counts.reviews}
          </span>
        </h2>
        <p className={widgetMeta}>
          {snapshot.counts.questions} questions · {snapshot.counts.reviews} reviews
        </p>
      </div>
      {healthy &&
      live.connected &&
      snapshot.counts.questions + snapshot.counts.reviews === 0 &&
      snapshot.coverage.projects.every((p) => p.state === 'complete') ? (
        <WidgetEmpty icon={CircleCheck} title="All caught up — no tasks need your input" />
      ) : null}
      <QueueSection snapshot={snapshot} group="questions" count={questions} more={more} />
      <QueueSection snapshot={snapshot} group="reviews" count={reviews} more={more} />
    </Card>
  )
}
function QueueSection({
  snapshot,
  group,
  count,
  more,
}: {
  snapshot: DashboardSnapshot
  group: 'questions' | 'reviews'
  count: number
  more: (group: 'questions' | 'reviews', count: number) => void
}) {
  const initial = snapshot[group]
  const wanted = Math.max(count, initial.rows.length)
  const query = useDashboardPage(snapshot, group, wanted, wanted > initial.rows.length)
  const current = wanted > initial.rows.length ? query.data : initial.rows
  const staged = useStagedRows(current, taskKey, group, count)
  const displaced = useDisplacedRows(
    snapshot,
    group,
    wanted,
    staged.rows.filter((r) => r.removed).map((r) => r.row),
  )
  const heading = useRef<HTMLHeadingElement>(null)
  if (!initial.total && !staged.rows.length) return null
  return (
    <section>
      <h3
        ref={heading}
        tabIndex={-1}
        className="border-t border-border/70 px-5 pt-3 pb-1 text-[13px] font-medium text-muted-foreground outline-none"
      >
        {group === 'questions' ? 'Questions' : 'Reviews'} · {initial.total}
      </h3>
      {staged.updates > 0 && (
        <Button
          variant="secondary"
          size="sm"
          className="mx-5 my-2"
          onClick={() => {
            staged.show()
            heading.current?.focus()
          }}
        >
          {staged.updates} updates — Show
        </Button>
      )}
      {staged.rows.map(({ row, removed }) => (
        <TaskRow
          key={taskKey(row)}
          row={displaced.data?.get(taskKey(row)) ?? row}
          removed={removed && !!displaced.data && !displaced.data.has(taskKey(row))}
          checking={current === undefined || (removed && !displaced.data)}
          checkFailed={
            (current === undefined && query.isError) ||
            (removed && !displaced.data && displaced.isError)
          }
          queue
        />
      ))}
      {(query.isError || displaced.isError) && (
        <Notice
          className="m-3"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void query.refetch()
                void displaced.refetch()
              }}
            >
              Retry
            </Button>
          }
        >
          Could not check current task state.
        </Notice>
      )}
      {wanted < initial.total && (
        <Button
          variant="ghost"
          size="sm"
          className="mx-3 my-2 text-muted-foreground"
          disabled={query.isFetching}
          onClick={() => more(group, wanted + Math.min(20, initial.total - wanted))}
        >
          Show {Math.min(20, initial.total - wanted)} more {group}
        </Button>
      )}
    </section>
  )
}
