import { FoldersIcon, PlusIcon, SlidersHorizontalIcon } from 'lucide-react'
import * as React from 'react'
import { Link as RouterLink } from 'react-router'

import { useProjects, useRunsIndex } from '@/api/queries'
import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'
import { AddProjectMenu } from '@/components/app-shell'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { shortAge } from '@/lib/format'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * `/projects` — the workspace's projects as a LIST OF PLACES TO GO (user decision: the registry
 * page in global settings is where projects are managed; this is where they are reached).
 *
 * One row per registered project, by last use: the name opens the project's tasks, and the
 * row says the three things a person scanning for where to go next wants — what needs them,
 * what is running, and how long ago they were there. Nothing here writes; "Manage" links to
 * the registry for tags, limits and removal.
 */
export function ProjectsRoute() {
  const projects = useProjects()
  const index = useRunsIndex(true)
  const now = useNow(30_000)

  const rows = React.useMemo(() => {
    const registry = projects.data?.projects ?? []
    const counts = new Map<string, { needsYou: number; running: number; total: number }>()
    for (const entry of index.data?.runs ?? []) {
      if (entry.archived) continue
      const c = counts.get(entry.projectId) ?? { needsYou: 0, running: 0, total: 0 }
      c.total += 1
      if (needsYou(entry)) c.needsYou += 1
      else if (entry.status === 'running' || entry.status === 'queued') c.running += 1
      counts.set(entry.projectId, c)
    }
    return [...registry]
      .sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''))
      .map((project) => ({ project, counts: counts.get(project.id) ?? { needsYou: 0, running: 0, total: 0 } }))
  }, [projects.data, index.data])

  if (projects.isError) {
    return (
      <div data-route="projects" className="flex min-h-full flex-col">
        <CenteredState icon={<FoldersIcon />} tone="danger" title="Could not load projects" subtitle={projects.error.message} />
      </div>
    )
  }

  return (
    <div data-route="projects" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Projects</h1>
        {projects.data ? (
          <span className="text-[12.5px] text-soft-foreground tabular-nums">{projects.data.projects.length}</span>
        ) : null}
        <div className="flex-1" />
        {/* Adding a project moved here from the app bar (user decision): a rare action beside
            the list it extends, not next to the thing you do a hundred times a day. */}
        <AddProjectMenu />
        <Button asChild variant="ghost" size="sm">
          <RouterLink to="/settings/global/projects" data-slot="projects-manage">
            <SlidersHorizontalIcon className="size-3.5" aria-hidden="true" />
            Manage
          </RouterLink>
        </Button>
      </header>

      <div className="flex flex-1 flex-col p-3 md:p-5">
        {projects.data && rows.length === 0 ? (
          <CenteredState
            icon={<FoldersIcon />}
            tone="neutral"
            title="No projects yet"
            subtitle="Add a local folder or clone from GitHub — the + Add project button on the bar above."
          />
        ) : (
          <div data-slot="projects-list" className="overflow-hidden rounded-lg border border-border bg-card">
            {rows.map(({ project, counts }) => (
              <ProjectRow key={project.id} project={project} counts={counts} now={now} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function needsYou(entry: RunIndexEntry): boolean {
  if (entry.status === 'waiting' || entry.status === 'review') return true
  return entry.status === 'failed' && !entry.autoResumeAt
}

function ProjectRow({
  project,
  counts,
  now,
}: {
  project: ProjectListEntry
  counts: { needsYou: number; running: number; total: number }
  now: number
}) {
  const missing = project.status === 'missing'
  return (
    <div
      data-slot="project-row"
      data-project-id={project.id}
      className="flex min-h-12 items-center gap-4 border-b border-border px-4 py-2 last:border-0"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        {missing ? (
          <span className="truncate text-[13.5px] font-medium text-muted-foreground" title="Folder not found">
            {project.name}
          </span>
        ) : (
          <RouterLink
            to={`/p/${project.id}/`}
            data-slot="project-open"
            className="truncate text-[13.5px] font-semibold text-foreground underline-offset-2 hover:underline"
          >
            {project.name}
          </RouterLink>
        )}
        <span className="flex min-w-0 items-center gap-2.5 text-[11px] leading-none text-soft-foreground">
          {project.branch ? <span className="truncate font-mono">{project.branch}</span> : null}
          {project.status === 'not-git' ? <span>not a git repo</span> : null}
          {missing ? <span className="text-danger">folder missing</span> : null}
          <span className="shrink-0 tabular-nums">{project.lastOpenedAt ? `opened ${shortAge(project.lastOpenedAt, now)} ago` : 'never opened'}</span>
        </span>
      </div>
      {/* The two numbers worth a glance: what waits on a person, and what is in motion. Blank
          when zero — a column of zeros says nothing. */}
      <span className="flex shrink-0 items-center gap-3 text-[12px] tabular-nums">
        {counts.needsYou > 0 ? (
          <span data-slot="project-needs-you" className="font-medium text-pending-strong">
            {counts.needsYou} need{counts.needsYou === 1 ? 's' : ''} you
          </span>
        ) : null}
        {counts.running > 0 ? (
          <span data-slot="project-running" className="font-medium text-violet-strong">
            {counts.running} running
          </span>
        ) : null}
        <span className={cn('text-soft-foreground', counts.total === 0 && 'opacity-60')}>
          {counts.total} task{counts.total === 1 ? '' : 's'}
        </span>
      </span>
      {!missing ? (
        <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
          <RouterLink to={`/p/${project.id}/new`} aria-label={`New task in ${project.name}`} title={`New task in ${project.name}`}>
            <PlusIcon className="size-3.5" aria-hidden="true" />
          </RouterLink>
        </Button>
      ) : null}
    </div>
  )
}
