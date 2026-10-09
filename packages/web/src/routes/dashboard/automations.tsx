import { useState } from 'react'
import { Link } from 'react-router'
import { CalendarClock } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAutomationsGate } from '@/routes/automations/use-automations'
import { useNow } from '@/lib/use-now'
import { dayTime, relativeIn } from '@/lib/automation-format'
import { enabledAutomations, useDashboardAutomations } from './automations-data'
import { ExportRows } from './export-rows'
import { DisclosureChevron, disclosureSummary, Freshness, Notice, WidgetEmpty, WidgetSkeleton, widgetHeader, widgetHeading, widgetMeta } from './presentation'

export function DashboardAutomations() {
  const gate = useAutomationsGate()
  const query = useDashboardAutomations(gate.known && !gate.off)
  const now = useNow(30_000)
  const [all, setAll] = useState(false)
  const rows = enabledAutomations(query.data ?? [])
  const visible = all ? rows : rows.slice(0, 3)
  const errors = query.data?.filter((p) => p.error) ?? []
  const pending =
    !gate.known || (!query.registry.isError && (query.registry.isPending || query.isPending))
  const failed = query.isError || query.registry.isError || errors.length > 0
  return (
    <Card
      data-export-context={`Enabled automations · showing ${visible.length} of ${rows.length} loaded · ${failed ? 'partial coverage' : 'available projects'}`}
      className="min-w-0 gap-0 py-0"
    >
      <div className={`${widgetHeader} pb-3`}>
        <h2 className={widgetHeading}>Automations</h2>
        {!gate.off && query.data && (
          <p className={widgetMeta}>
            {rows.length} enabled{failed ? ' · partial' : ''}
            {query.dataUpdatedAt > 0 && (
              <>
                {' · '}
                <Freshness at={new Date(query.dataUpdatedAt).toISOString()} />
              </>
            )}
          </p>
        )}
      </div>
      {!gate.off && query.data && (
        <>
          <ExportRows
            rows={[
              {
                section: 'automations',
                metric: 'enabled',
                value: rows.length,
                unit: 'automations',
                note: failed ? 'Partial project coverage' : 'Loaded projects',
              },
            ]}
          />
        </>
      )}
      {gate.off ? (
        <WidgetEmpty icon={CalendarClock} title="Automations are disabled in this workspace." />
      ) : (
        <>
          {pending && <WidgetSkeleton label="Loading automations…" className="px-5 pb-5" />}
          {failed && (
            <Notice
              className="mx-3 mb-3"
              action={
                <Button variant="outline" size="sm" onClick={query.retry}>
                  Retry automations
                </Button>
              }
            >
              <span className="block">
                Some automation data could not be refreshed. Available results are shown.
              </span>
              {errors.map((p) => (
                <span key={p.id} className="block text-muted-foreground">
                  {p.name}: {p.error}
                </span>
              ))}
            </Notice>
          )}
          {!pending && !failed && rows.length === 0 && (
            <WidgetEmpty icon={CalendarClock} title="No enabled automations.">
              Enable one in a project's Automations page.
            </WidgetEmpty>
          )}
          {visible.map(({ project, automation: a, at }) => {
            const warning =
              (a.state?.consecutiveFailures ?? 0) > 0 ? 'Recent checks failed' : undefined
            const timing =
              at === null
                ? 'Next time not available'
                : at <= now
                  ? 'Due — awaiting scheduler'
                  : relativeIn(at, now)
            const action = a.kind !== 'schedule' ? 'Next check' : 'Next run'
            return (
              <div
                key={`${project.id}:${a.id}`}
                data-export-row
                className="border-t border-border/70 px-5 py-3 transition-colors hover:bg-muted/50"
              >
                <Link
                  className="block text-sm font-medium leading-relaxed underline-offset-4 hover:underline no-hover:min-h-11"
                  to={`/p/${encodeURIComponent(project.id)}/automations/${encodeURIComponent(a.id)}`}
                >
                  {a.name}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {project.name} · {action}: {timing}
                </p>
                {at !== null && (
                  <p className="mt-0.5 text-xs text-soft-foreground">
                    <time dateTime={new Date(at).toISOString()}>
                      {dayTime(at, project.data!.timeZone)} · {project.data!.timeZone}
                    </time>
                  </p>
                )}
                {a.kind !== 'schedule' && (
                  <p className="mt-0.5 text-xs text-soft-foreground">
                    Checks for matching events; a task may not be started.
                  </p>
                )}
                {warning && <p className="mt-1 text-xs text-pending-strong">{warning}</p>}
                <ExportRows
                  rows={[
                    {
                      section: 'automation',
                      entity: `${project.id}:${a.id}`,
                      metric: 'name',
                      value: a.name,
                    },
                    {
                      section: 'automation',
                      entity: `${project.id}:${a.id}`,
                      metric: a.kind !== 'schedule' ? 'nextCheckAt' : 'nextRunAt',
                      value: at === null ? null : new Date(at).toISOString(),
                      note: [timing, warning].filter(Boolean).join(' · '),
                    },
                  ]}
                />
              </div>
            )
          })}
          {rows.length > 3 && (
            <Button
              variant="ghost"
              size="sm"
              className="mx-3 my-2 text-muted-foreground"
              onClick={() => setAll(!all)}
            >
              {all ? 'Show fewer' : `Show all ${rows.length} enabled`}
            </Button>
          )}
          {!pending && (
            <details className="border-t border-border/70 px-5 py-3 text-[13px] text-muted-foreground">
              <summary
                className={`${disclosureSummary} py-1 no-hover:min-h-11`}
                data-export-heading="Project automations"
              >
                <DisclosureChevron />
                Manage automations by project
              </summary>
              {query.data?.map((p) => (
                <Link
                  key={p.id}
                  className="block py-1.5 pl-5 text-foreground underline-offset-4 hover:underline no-hover:min-h-11"
                  to={`/p/${encodeURIComponent(p.id)}/automations`}
                >
                  {p.name}
                </Link>
              ))}
            </details>
          )}
        </>
      )}
    </Card>
  )
}
