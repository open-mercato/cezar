import { PlusIcon, ZapIcon } from 'lucide-react'
import { useState } from 'react'
import type { AutomationsResponse } from '@open-mercato/cezar-api-client'

import { CenteredState } from '@/components/centered-state'
import { Segmented, type SegmentedOption } from '@/components/segmented'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'

import { PageState, type AutomationsView } from './automations-route'
import { AutomationsTable } from './automations-table'
import { DayView } from './day-view'
import { NextRunsRail, nextRuns } from './next-runs-rail'
import { StatsStrip } from './stats-strip'
import type { AutomationActions } from './use-automations'
import { WeekView } from './week-view'

function viewOptions(count: number | undefined): SegmentedOption<AutomationsView>[] {
  return [
    { value: 'list', label: 'List', ...(count === undefined ? {} : { count }) },
    { value: 'week', label: 'Week' },
    { value: 'day', label: 'Day' },
  ]
}

/**
 * `/automations` (spec 2026-09-14-automations-redesign § UI/UX 1–3): the header with the
 * List | Week | Day switch, then whichever of the three the `?view=` param names. One header for
 * all three so the switch never jumps; the status trio (scheduler · GitHub · zone) reads from the
 * same payload the table does, so "GitHub unavailable" and the capability-paused rows agree.
 */
export function AutomationsList({
  data,
  error,
  actions,
  view,
  onViewChange,
}: {
  data: AutomationsResponse | undefined
  error?: string
  actions: AutomationActions
  view: AutomationsView
  onViewChange: (view: AutomationsView) => void
}) {
  const [railOpen, setRailOpen] = useState(false)
  const now = Date.now()
  const upcoming = data ? nextRuns(data.automations, now, data.timeZone, 12) : []
  const pollCount = data ? data.automations.filter((automation) => automation.kind === 'github' && automation.enabled).length : 0

  return (
    <div data-route="automations" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5">
        <h1 className="text-base font-semibold">Automations</h1>
        <Segmented<AutomationsView>
          slot="automations-view"
          label="View"
          value={view}
          options={viewOptions(data?.automations.length)}
          onChange={onViewChange}
        />
        <div className="flex-1" />
        {data ? (
          <span
            data-slot="automations-status"
            className="inline-flex min-w-0 items-center gap-2 overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-muted-foreground max-[1280px]:hidden"
          >
            <StatusDot tone={data.scheduler.state === 'scheduled' ? 'success' : 'neutral'} />
            {data.scheduler.state === 'scheduled' ? 'Scheduler running' : 'Scheduler idle'}
            <span className="text-soft-foreground">·</span>
            {data.available ? 'GitHub available' : `GitHub unavailable${data.reason ? ` · ${data.reason}` : ''}`}
            <span className="text-soft-foreground">·</span>
            <span className="font-mono text-xs">{data.timeZone}</span>
          </span>
        ) : null}
        <Button asChild className="shrink-0">
          <Link to="/automations/new">
            <PlusIcon className="size-[15px]" />
            New automation
          </Link>
        </Button>
      </header>

      {error !== undefined ? (
        <div className="p-5">
          <PageState text={error} />
        </div>
      ) : !data ? (
        <div className="p-5">
          <PageState text="Loading automations…" />
        </div>
      ) : data.automations.length === 0 ? (
        <CenteredState
          icon={<ZapIcon />}
          tone="neutral"
          title="No automations yet"
          subtitle="Create one paused, preview it, then enable it."
          heading="h2"
          actions={
            <Button asChild>
              <Link to="/automations/new">
                <PlusIcon className="size-[15px]" />
                New automation
              </Link>
            </Button>
          }
        />
      ) : view === 'week' ? (
        <WeekView data={data} />
      ) : view === 'day' ? (
        <DayView data={data} />
      ) : (
        <div data-slot="automations-list" className="flex flex-col gap-3 p-5">
          <StatsStrip
            stats={data.stats}
            pollCount={pollCount}
            upcoming={upcoming}
            timeZone={data.timeZone}
            railOpen={railOpen}
            onOpenRail={() => setRailOpen(true)}
          />
          <AutomationsTable data={data} actions={actions} now={now} />
          <NextRunsRail
            open={railOpen}
            onOpenChange={setRailOpen}
            upcoming={upcoming}
            pollCount={pollCount}
            timeZone={data.timeZone}
            now={now}
          />
        </div>
      )}
    </div>
  )
}
