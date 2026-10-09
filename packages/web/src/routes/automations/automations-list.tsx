import { CalendarClockIcon, PlusIcon, ZapIcon } from 'lucide-react'
import { useState } from 'react'
import type { AutomationsResponse } from '@open-mercato/cezar-api-client'

import { Page, PageBody, PageHeader, PageToolbar } from '@/components/page'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Link } from '@/lib/project-router'

import { PageState, type AutomationsView } from './automations-route'
import { AutomationsTable } from './automations-table'
import { DayView } from './day-view'
import { NextRunsRail, nextRuns } from './next-runs-rail'
import { StatsStrip } from './stats-strip'
import type { AutomationActions } from './use-automations'
import { WeekView } from './week-view'

const VIEWS: { value: AutomationsView; label: string }[] = [
  { value: 'list', label: 'List' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
]

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
    <Page data-route="automations" width="wide">
      <PageHeader
        title="Automations"
        description="Run tasks on a schedule, or when something happens on GitHub or in your tracker."
        actions={
          <Button asChild variant="primary" className="shrink-0">
            <Link to="/automations/new">
              <PlusIcon aria-hidden="true" />
              New automation
            </Link>
          </Button>
        }
      />
      <PageToolbar className="gap-x-4">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          data-slot="automations-view"
          aria-label="View"
          value={view}
          onValueChange={(next) => {
            // Radio semantics: re-clicking the pressed view keeps it.
            if (next === 'list' || next === 'week' || next === 'day') onViewChange(next)
          }}
        >
          {VIEWS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value} data-value={option.value}>
              {option.label}
              {option.value === 'list' && data ? (
                <span className="text-xs font-normal text-muted-foreground tabular-nums">{data.automations.length}</span>
              ) : null}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {data ? (
          <span
            data-slot="automations-status"
            className="ml-auto inline-flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground max-lg:hidden"
          >
            <StatusDot tone={data.scheduler.state === 'scheduled' ? 'success' : 'neutral'} />
            {data.scheduler.state === 'scheduled' ? 'Scheduler running' : 'Scheduler idle'}
            <span aria-hidden="true">·</span>
            <span className="max-w-72 truncate">
              {data.available ? 'GitHub available' : `GitHub unavailable${data.reason ? ` · ${data.reason}` : ''}`}
            </span>
            <span aria-hidden="true">·</span>
            <span>{data.timeZone}</span>
          </span>
        ) : null}
        {data && data.automations.length > 0 && view === 'list' ? (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={railOpen}
            className="shrink-0 max-lg:ml-auto"
            onClick={() => setRailOpen(true)}
          >
            <CalendarClockIcon aria-hidden="true" />
            Next runs
            <span className="text-xs font-normal text-muted-foreground tabular-nums">{upcoming.length}</span>
          </Button>
        ) : null}
      </PageToolbar>

      {error !== undefined ? (
        <PageBody>
          <PageState text={error} />
        </PageBody>
      ) : !data ? (
        <PageBody>
          <PageState text="Loading automations…" loading />
        </PageBody>
      ) : data.automations.length === 0 ? (
        <Empty data-slot="centered-state" className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ZapIcon /></EmptyMedia>
            <EmptyTitle>No automations yet</EmptyTitle>
            <EmptyDescription>Create one paused, preview it, then enable it.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="primary">
              <Link to="/automations/new">
                <PlusIcon aria-hidden="true" />
                New automation
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : view === 'week' ? (
        <WeekView data={data} />
      ) : view === 'day' ? (
        <DayView data={data} />
      ) : (
        <PageBody data-slot="automations-list" className="flex flex-col gap-4">
          <AutomationsTable data={data} actions={actions} now={now} />
          <StatsStrip
            stats={data.stats}
            pollCount={pollCount}
            upcoming={upcoming}
            timeZone={data.timeZone}
          />
          <NextRunsRail
            open={railOpen}
            onOpenChange={setRailOpen}
            upcoming={upcoming}
            pollCount={pollCount}
            timeZone={data.timeZone}
            now={now}
          />
        </PageBody>
      )}
    </Page>
  )
}
