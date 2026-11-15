import { ClockIcon, PlusIcon } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router'

import { useProjects, useRunsIndex } from '@/api/queries'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import {
  everyLabel,
  lastCheckResult,
  managerMessageTime,
  nextCheckLabel,
  cardedTasks,
  type ManagerOrigin,
} from '@/lib/managers'
import { runTitle } from '@/lib/task-groups'
import { useNow } from '@/lib/use-now'
import { managerAccessOf, type ManagerMessage, type ManagerSummary, type RunRecord } from '@open-mercato/cezar-api-client'

import { ProjectsPicker, type ManagerPatch } from './manager-pickers'
import { taskPath } from './manager-session-card'

const STARTED_LIMIT = 6

const RESULT_LABEL = { reported: 'Reported', quiet: 'Quiet', failed: 'Failed' } as const

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section data-slot="manager-watching-section" aria-label={title} className="flex flex-col gap-1.5">
      <h3 className="flex min-h-6 items-center text-meta font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {title}
        {action ? <span className="ml-auto">{action}</span> : null}
      </h3>
      <div className="overflow-hidden rounded-lg border border-border bg-card">{children}</div>
    </section>
  )
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`flex min-h-8 items-center gap-2 border-b border-border px-2.5 py-1.5 text-xs last:border-b-0 ${className ?? ''}`}>{children}</div>
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border px-2.5 py-1.5 text-xs last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  )
}

/**
 * The right column (design, Proposal 10): what the gear hid, read-only. Every section shows only
 * when the data behind it exists: the summary has no spend per day, no attention counts, and a
 * run record carries no manager origin, so cost and "Tasks it started" come from what is here.
 */
export function WatchingPanel({
  manager,
  messages,
  loadedAll,
  onPatch,
  onAddJob,
  id,
}: {
  manager: ManagerSummary
  messages: readonly ManagerMessage[]
  /** No older page is left: a quiet check can then be told from one not loaded yet. */
  loadedAll: boolean
  onPatch: (patch: ManagerPatch) => void
  onAddJob: () => void
  id: string
}) {
  const now = useNow(30_000)
  const registry = useProjects().data?.projects
  const runs = useRunsIndex().data?.runs
  const connected = useMemo(
    () => (registry ?? []).filter((project) => manager.connectedProjectIds.includes(project.id)),
    [registry, manager.connectedProjectIds],
  )
  const runningBy = useMemo(() => {
    const counts = new Map<string, number>()
    for (const run of runs ?? []) {
      if (run.status === 'running' && !run.archived) counts.set(run.projectId, (counts.get(run.projectId) ?? 0) + 1)
    }
    return counts
  }, [runs])
  const started = useMemo(() => cardedTasks(messages).slice(0, STARTED_LIMIT), [messages])
  const result = lastCheckResult(messages, manager.lastCheckAt, loadedAll)
  const next = manager.cronMinutes > 0 ? nextCheckLabel(manager.nextCheckAt, new Date(now)) : ''
  const origin: ManagerOrigin = { id: manager.id, name: manager.name }
  return (
    <aside
      id={id}
      data-slot="manager-watching"
      aria-label="Watching"
      className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain border-l border-border bg-card-2 p-3.5 max-lg:hidden"
    >
      <Section
        title="Watching"
        action={(
          <ProjectsPicker
            value={manager.projects}
            access={manager.access}
            projectAccess={manager.projectAccess}
            onAccess={onPatch}
            onChange={(projects) => onPatch({ projects })}
            trigger={<Button variant="ghost" size="xs" aria-label="Edit connected projects" data-slot="manager-watching-edit">Edit</Button>}
          />
        )}
      >
        {connected.length === 0 ? (
          <Row className="text-muted-foreground">No project connected</Row>
        ) : connected.map((project) => {
          const running = runningBy.get(project.id) ?? 0
          const access = managerAccessOf(manager, project.id)
          return (
            <Row key={project.id}>
              <StatusDot tone={project.status === 'ok' ? 'success' : 'danger'} />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="shrink-0 text-muted-foreground">
                {access === 'read' ? 'read-only' : 'write'}
                {running > 0 ? ` · ${running} running` : ''}
              </span>
            </Row>
          )
        })}
      </Section>

      {manager.lastCheckAt ? (
        <Section title="Last check">
          <dl>
            <Pair label="Ran"><time dateTime={manager.lastCheckAt}>{managerMessageTime(manager.lastCheckAt, new Date(now))}</time></Pair>
            {result ? <Pair label="Result">{RESULT_LABEL[result]}</Pair> : null}
            {next ? <Pair label="Next">{next}</Pair> : null}
          </dl>
        </Section>
      ) : null}

      <Section
        title="Jobs"
        action={(
          <Button variant="ghost" size="icon-xs" aria-label="Add job" data-slot="manager-watching-add-job" onClick={onAddJob}>
            <PlusIcon aria-hidden="true" />
          </Button>
        )}
      >
        {manager.jobs.length === 0 ? (
          <Row className="text-muted-foreground">No jobs yet</Row>
        ) : manager.jobs.map((job) => (
          <Row key={job.id}>
            <ClockIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{job.name}</span>
            <span className="shrink-0 text-muted-foreground">{job.enabled ? everyLabel(job.everyMinutes) : 'paused'}</span>
          </Row>
        ))}
      </Section>

      {started.length > 0 ? (
        <Section title="Tasks it started">
          {started.map(({ projectId, runId }) => {
            const run = runs?.find((entry) => entry.projectId === projectId && entry.id === runId)
            const attention = run ? deriveAttention(run as unknown as RunRecord) : undefined
            return (
              <Link
                key={`${projectId}/${runId}`}
                to={taskPath(projectId, runId)}
                state={{ manager: origin }}
                data-slot="manager-watching-task"
                className="flex min-h-8 items-center gap-2 border-b border-border px-2.5 py-1.5 text-xs no-underline outline-none last:border-b-0 hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                <StatusDot tone={attention?.tone ?? 'neutral'} pulse={attention?.pulse ?? false} />
                <span className="min-w-0 flex-1 truncate">{run ? runTitle(run as unknown as RunRecord) : `Task ${runId.slice(0, 8)}`}</span>
                {run ? <span className="shrink-0 text-muted-foreground">{shortAge(run.lastActivityAt, now)}</span> : null}
              </Link>
            )
          })}
        </Section>
      ) : null}
    </aside>
  )
}
