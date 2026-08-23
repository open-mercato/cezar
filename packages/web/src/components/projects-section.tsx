import * as React from 'react'
import { ChevronDownIcon, FolderPlusIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import { Link as RouterLink } from 'react-router'

import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'
import { rememberReferenceStatuses, useRunsIndex } from '@/api/queries'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { IndexRunRow, IndexVariantTile, compareEntries, foldVariants } from '@/components/task-quick-list'
import { useProjectMatch } from '@/lib/project-router'
import { taskReference } from '@/lib/tasks-table'
import { useNow } from '@/lib/use-now'
import { AddProjectDialog } from '@/components/add-project-dialog'
import { useSidebarNavigate } from '@/components/app-shell'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { GithubIcon } from '@/components/icons'
import { orderForSwitcher } from '@/components/project-switcher'
import { ATTENTION_RANK, deriveAttention } from '@/lib/attention'
import { cn } from '@/lib/utils'

/** How many projects the section shows before "Load more" — and how many each load adds. */
const PAGE = 10
/** How many tasks a project lists before folding the rest behind "Show N more". */
const TASK_PREVIEW = 5

const ICON_BUTTON =
  'flex size-6 shrink-0 items-center justify-center rounded-sm text-soft-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none'

/**
 * The sidebar's Projects section (user decision): the ten most recently used projects as rows,
 * each with ITS tasks beneath (needs-you, working, finished; five, then Show N more; variant
 * groups folded), "Load more" for the rest, and the section's verbs as icons on its header —
 * search (an inline filter), add a local folder, clone from GitHub, manage the registry. A
 * project's name opens its tasks; on hover or focus the row shows its settings and a + for a
 * new task there.
 * One source, the workspace runs index, feeds every project's list.
 */
export function ProjectsSection({
  projects,
  activeId,
}: {
  projects: readonly ProjectListEntry[]
  activeId: string | null
}) {
  const [limit, setLimit] = React.useState(PAGE)
  const [browsing, setBrowsing] = React.useState(false)
  const [cloning, setCloning] = React.useState(false)
  const onNavigate = useSidebarNavigate()
  const now = useNow(30_000)
  const index = useRunsIndex(true)
  const match = useProjectMatch('/tasks/:id/*')
  const exact = useProjectMatch('/tasks/:id')
  const currentRunId = match?.params.id ?? exact?.params.id ?? null
  const indexedStatuses = index.data?.referenceStatuses
  React.useEffect(() => {
    if (indexedStatuses) rememberReferenceStatuses(indexedStatuses)
  }, [indexedStatuses])
  const entriesByProject = React.useMemo(() => {
    const map = new Map<string, RunIndexEntry[]>()
    for (const entry of index.data?.runs ?? []) {
      if (entry.archived) continue
      const list = map.get(entry.projectId)
      if (list) list.push(entry)
      else map.set(entry.projectId, [entry])
    }
    for (const list of map.values()) list.sort(compareEntries)
    return map
  }, [index.data])
  const referenceRequests = React.useMemo(
    () =>
      [...entriesByProject.entries()].flatMap(([projectId, entries]) =>
        entries.flatMap((entry) => {
          const reference = taskReference(entry)
          return reference ? [{ projectId, kind: reference.kind, number: reference.number }] : []
        }),
      ),
    [entriesByProject],
  )

  const ordered = orderForSwitcher(projects, activeId)
  const shown = ordered.slice(0, limit)
  const hidden = ordered.length - shown.length

  return (
    <section data-slot="projects-section" className="flex flex-col gap-0.5">
      <div className="flex h-7 items-center pr-1 pl-3">
        {/* The heading IS the way to the full registry (user decision) — no sidebar search;
            the projects screen carries the browsing. */}
        <RouterLink
          to="/settings/global/projects"
          data-slot="projects-heading"
          title="All projects"
          onClick={onNavigate}
          className="text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase transition-colors hover:text-foreground"
        >
          Projects
        </RouterLink>
        <span className="ml-auto flex items-center gap-0.5">
          <button type="button" data-slot="add-project-local" aria-label="Add local folder" title="Add local folder" onClick={() => setBrowsing(true)} className={ICON_BUTTON}>
            <FolderPlusIcon className="size-3.5" aria-hidden="true" />
          </button>
          <button type="button" data-slot="add-project-clone" aria-label="Clone from GitHub" title="Clone from GitHub" onClick={() => setCloning(true)} className={ICON_BUTTON}>
            <GithubIcon className="size-3.5" aria-hidden="true" />
          </button>
        </span>
      </div>


      <ReferenceStatusProvider requests={referenceRequests}>
        {shown.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            active={project.id === activeId}
            entries={entriesByProject.get(project.id) ?? []}
            currentRunId={currentRunId}
            now={now}
            onNavigate={onNavigate}
          />
        ))}
      </ReferenceStatusProvider>
      {shown.length === 0 ? <p className="px-3 py-1.5 text-xs text-soft-foreground">No project matches.</p> : null}
      {hidden > 0 ? (
        <button
          type="button"
          data-slot="projects-load-more"
          onClick={() => setLimit((n) => n + PAGE)}
          className="self-start rounded-sm px-3 py-1 text-[12px] text-soft-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Load {Math.min(hidden, PAGE)} more
        </button>
      ) : null}

      {browsing ? <AddProjectDialog open onOpenChange={setBrowsing} /> : null}
      {cloning ? <CloneProjectDialog open onOpenChange={setCloning} /> : null}
    </section>
  )
}

/** One project: its row (name → its tasks; settings and + appear on hover/focus), then
 *  its tasks beneath — the first five, the rest behind "Show N more"; variants folded. */
function ProjectRow({
  project,
  active,
  entries,
  currentRunId,
  now,
  onNavigate,
}: {
  project: ProjectListEntry
  active: boolean
  entries: RunIndexEntry[]
  currentRunId: string | null
  now: number
  onNavigate?: () => void
}) {
  // Replit-style tree (user reference): a chevron folds the project, its tasks hang off a tree
  // line beneath. Only ACTIVE projects start open (user decision): the selected one, and any
  // with live work (running, waiting, blocked, failed); finished-only projects fold so a long
  // registry stays a list of names. The user's own toggle wins once used.
  const live = entries.some((entry) => ATTENTION_RANK[deriveAttention(entry).bucket] <= ATTENTION_RANK.running)
  const [toggled, setToggled] = React.useState<boolean | null>(null)
  const open = toggled ?? (active || live)
  const setOpen = (next: (value: boolean) => boolean) => setToggled(next(open))
  const [expanded, setExpanded] = React.useState(false)
  const missing = project.status === 'missing'
  const hidden = Math.max(0, entries.length - TASK_PREVIEW)
  const shown = expanded ? entries : entries.slice(0, TASK_PREVIEW)
  return (
    <section data-slot="project-task-group" data-project-id={project.id} className="flex flex-col">
      <div
        className={cn(
          'group/row flex h-9 items-center gap-1 rounded-md pr-1 pl-1 transition-colors hover:bg-card md:h-8',
          active && 'bg-muted',
        )}
      >
        <button
          type="button"
          aria-label={open ? `Collapse ${project.name}` : `Expand ${project.name}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-soft-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronDownIcon className={cn('size-3.5 transition-transform', !open && '-rotate-90')} aria-hidden="true" />
        </button>
        <RouterLink
          to={`/p/${project.id}/`}
          data-slot="project-row"
          data-project-id={project.id}
          aria-current={active ? 'page' : undefined}
          aria-disabled={missing || undefined}
          onClick={(event) => {
            if (missing) event.preventDefault()
            else onNavigate?.()
          }}
          title={missing ? `${project.name} (folder missing)` : project.name}
          className={cn(
            'flex h-full min-w-0 flex-1 items-center gap-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground',
            active && 'font-semibold text-foreground',
            missing && 'opacity-50',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
        </RouterLink>
        {/* The row's two actions (user decision): the PROJECT's settings and a new task there,
            shown on hover or focus so the list reads as names. Active is the bold row. */}
        {!missing ? (
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 has-[:focus-visible]:opacity-100">
            <RouterLink
              to={`/p/${project.id}/settings`}
              data-slot="group-settings"
              aria-label={`Settings for ${project.name}`}
              title={`Settings for ${project.name}`}
              onClick={onNavigate}
              className={ICON_BUTTON}
            >
              <SettingsIcon className="size-3.5" aria-hidden="true" />
            </RouterLink>
            <RouterLink
              to={`/p/${project.id}/new`}
              data-slot="group-new-task"
              aria-label={`New task in ${project.name}`}
              title={`New task in ${project.name}`}
              onClick={onNavigate}
              className={ICON_BUTTON}
            >
              <PlusIcon className="size-3.5" aria-hidden="true" />
            </RouterLink>
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="ml-[15px] flex flex-col gap-0.5 border-l border-border pl-1.5 pt-0.5 pb-1">
          {/* No "+ New task" child (user decision): the row's + already starts one. */}
          {shown.length === 0 && !missing ? (
            <p data-slot="group-empty" className="px-2 py-1.5 text-[12px] text-soft-foreground">
              No tasks yet
            </p>
          ) : null}
          {foldVariants(shown).map((row) =>
            row.kind === 'run' ? (
              <IndexRunRow key={row.entry.id} entry={row.entry} currentRunId={currentRunId} now={now} />
            ) : (
              <IndexVariantTile key={row.groupId} projectId={project.id} row={row} currentRunId={currentRunId} now={now} />
            ),
          )}
          {hidden > 0 ? (
            <button
              type="button"
              data-slot="group-show-more"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
              className="self-start rounded-sm px-2 py-1 text-[12px] text-soft-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {expanded ? 'Show less' : `Show ${hidden} more`}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
