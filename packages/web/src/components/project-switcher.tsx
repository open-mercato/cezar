import { closestCenter, DndContext } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CheckIcon, ChevronDownIcon, FolderIcon, FolderPlusIcon, GripVerticalIcon, LoaderCircleIcon } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router'

import { useRunsIndex } from '@/api/queries'
import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'
import { AddProjectMenu } from '@/components/add-project-menu'
import { useSidebarNavigate } from '@/components/app-shell'
import { Kbd } from '@/components/kbd'
import { ProjectFolderDialog } from '@/components/project-folder-dialog'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { isNeedsYouStatus } from '@/lib/attention'
import { formatChord, shortcutsBlocked } from '@/lib/keybindings'
import { isEditableTarget } from '@/lib/use-command-shortcut'
import { FOLDER_DND_PREFIX, useProjectArrangement, type ProjectSection } from '@/lib/use-project-arrangement'
import { cn } from '@/lib/utils'

/** ⌘⇧P / Ctrl+Shift+P: ⌘P is the task palette's (spec 2026-10-17-task-palette). */
export const SWITCHER_CHORD = 'Mod+Shift+P'

export function switcherShortcutFromEvent(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>,
): boolean {
  if (typeof event.key !== 'string' || event.key.toLowerCase() !== 'p') return false
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.repeat) return false
  return true
}

/** The registry's status as a dot: `not-git` still runs (single-queue), `missing` does not. */
export function projectStatusTone(status: ProjectListEntry['status']): StatusDotTone {
  return status === 'ok' ? 'success' : status === 'missing' ? 'danger' : 'pending'
}

export interface ProjectCounts {
  needsYou: number
  running: number
}

/** Per project, from the one workspace-wide slim index — never a runs request per row. */
export function projectCounts(runs: readonly RunIndexEntry[] | undefined): Map<string, ProjectCounts> {
  const counts = new Map<string, ProjectCounts>()
  for (const run of runs ?? []) {
    if (run.archived) continue
    const entry = counts.get(run.projectId) ?? { needsYou: 0, running: 0 }
    if (isNeedsYouStatus(run)) entry.needsYou += 1
    else if (run.status === 'running') entry.running += 1
    counts.set(run.projectId, entry)
  }
  return counts
}

/** Name or branch, case-insensitively — the two things a person remembers a repo by. */
export function matchesProjectQuery(project: Pick<ProjectListEntry, 'name' | 'branch'>, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return project.name.toLowerCase().includes(needle) || (project.branch?.toLowerCase().includes(needle) ?? false)
}

/**
 * The sidebar's project switcher (redesign, Proposal 1): the active project as a control, and a
 * searchable popover of every registered project grouped by folder — the per-project tree the
 * sidebar used to be, folded into one picker. Reordering and folders keep working inside the
 * list (`useProjectArrangement`); selecting a project lands on its Now page.
 */
export function ProjectSwitcher({
  projects,
  activeId,
  singleProject = false,
  onNavigate,
}: {
  projects: ProjectListEntry[]
  /** The project the URL names, else the boot project. */
  activeId: string | null
  /** Hides the registry-widening footer actions (`capabilities.singleProject`). */
  singleProject?: boolean
  /** The drawer's close-on-navigate; defaults to the shell's own context. */
  onNavigate?: () => void
}) {
  const sidebarNavigate = useSidebarNavigate()
  const navigateOut = onNavigate ?? sidebarNavigate
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const navigate = useNavigate()
  const arrangement = useProjectArrangement(projects)
  const { sections, sortable, sensors, announcements, handleDragEnd, editingFolder, setEditingFolder, saveFolder } = arrangement
  // Only while open: a closed switcher costs the workspace nothing (30s stale, stream-reconciled).
  const index = useRunsIndex(open)
  const counts = React.useMemo(() => projectCounts(index.data?.runs), [index.data?.runs])
  const active = projects.find((project) => project.id === activeId) ?? null

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!switcherShortcutFromEvent(event)) return
      if (isEditableTarget(event.target) && !(event.target instanceof HTMLElement && event.target.closest('[cmdk-input]'))) return
      // Our own popover is a dialog too; the chord that opened it closes it.
      if (!open && shortcutsBlocked()) return
      event.preventDefault()
      setOpen((current) => !current)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  const select = React.useCallback(
    (project: ProjectListEntry) => {
      setOpen(false)
      navigateOut?.()
      // A plain router navigate: the target names its own project, so the scoped wrapper would
      // prefix it with the current one.
      navigate(`/p/${encodeURIComponent(project.id)}/`)
    },
    [navigate, navigateOut],
  )

  const visibleSections = sections
    .map((section) => ({ ...section, projects: section.projects.filter((project) => matchesProjectQuery(project, query)) }))
    .filter((section) => query.trim() === '' || section.projects.length > 0)
  const dndIds = visibleSections.flatMap((section) => [
    ...(section.folder ? [`${FOLDER_DND_PREFIX}${section.folder.id}`] : []),
    ...section.projects.map((project) => project.id),
  ])
  const chord = formatChord(SWITCHER_CHORD)

  return (
    <>
      <Popover modal open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery('') }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-slot="project-switcher"
            aria-label={active ? `Project: ${active.name} — switch project` : 'Switch project'}
            aria-keyshortcuts={SWITCHER_CHORD === 'Mod+Shift+P' ? 'Meta+Shift+P Control+Shift+P' : undefined}
            title={`Switch project (${chord})`}
            className={cn(
              'mx-3 mb-2 flex h-9 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-left text-ui font-semibold outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50',
              open && 'border-violet ring-[3px] ring-violet/25',
            )}
          >
            {active ? <StatusDot tone={projectStatusTone(active.status)} /> : null}
            <span data-slot="project-switcher-name" className="min-w-0 truncate">{active?.name ?? 'Projects'}</span>
            {active?.branch ? (
              <span data-slot="project-switcher-branch" className="ml-auto min-w-0 max-w-[45%] truncate font-mono text-micro font-medium text-soft-foreground">
                {active.branch}
              </span>
            ) : null}
            <ChevronDownIcon className={cn('size-3.5 shrink-0 text-soft-foreground', !active?.branch && 'ml-auto')} aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          data-slot="project-switcher-popover"
          className="w-[min(23rem,calc(100vw-2rem))] p-0"
        >
          <Command shouldFilter={false} loop label="Switch project" defaultValue={activeId ?? undefined}>
            <div className="relative">
              <CommandInput placeholder="Search projects…" value={query} onValueChange={setQuery} className="pr-12" />
              <Kbd className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2">{chord}</Kbd>
            </div>
            <CommandList label="Switch project" className="max-h-[min(24rem,60vh)]">
              <CommandEmpty>No project matches.</CommandEmpty>
              <DndContext sensors={sensors} collisionDetection={closestCenter} accessibility={{ announcements }} onDragEnd={handleDragEnd}>
                <SortableContext items={dndIds} strategy={verticalListSortingStrategy}>
                  {visibleSections.map((section) => (
                    <SwitcherSection
                      key={section.folder?.id ?? 'ungrouped'}
                      section={section}
                      searching={query.trim() !== ''}
                      activeId={activeId}
                      counts={counts}
                      sortable={sortable}
                      onSelect={select}
                      onEditFolder={(folder) => setEditingFolder(folder)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </CommandList>
            <div data-slot="project-switcher-footer" className="flex items-center gap-1 border-t border-border px-2 py-1.5">
              {singleProject ? null : <AddProjectMenu />}
              <button
                type="button"
                data-slot="project-folder-create"
                onClick={() => setEditingFolder(null)}
                className="flex h-[30px] items-center gap-[7px] rounded-sm px-2.5 text-label font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <FolderPlusIcon className="size-3.5" aria-hidden="true" />
                New folder
              </button>
              <span className="ml-auto flex items-center gap-1.5 text-micro text-soft-foreground" aria-hidden="true">
                <Kbd>↑↓</Kbd>
                <Kbd>↵</Kbd>
                <Kbd>esc</Kbd>
              </span>
            </div>
          </Command>
        </PopoverContent>
      </Popover>
      {/* Beside the popover, not inside it: a dialog born inside the content dies with it. */}
      {editingFolder !== undefined ? (
        <ProjectFolderDialog
          projects={projects}
          folder={editingFolder}
          onClose={() => setEditingFolder(undefined)}
          onSave={saveFolder}
        />
      ) : null}
    </>
  )
}

function SwitcherSection({
  section,
  searching,
  activeId,
  counts,
  sortable,
  onSelect,
  onEditFolder,
}: {
  section: ProjectSection
  searching: boolean
  activeId: string | null
  counts: Map<string, ProjectCounts>
  sortable: boolean
  onSelect: (project: ProjectListEntry) => void
  onEditFolder: (folder: NonNullable<ProjectSection['folder']>) => void
}) {
  const { folder } = section
  const folderId = folder ? `${FOLDER_DND_PREFIX}${folder.id}` : null
  const canDragFolder = sortable && folder !== null && !searching
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: folderId ?? 'ungrouped',
    disabled: !canDragFolder,
  })
  const heading = (
    <span className="flex items-center gap-1.5">
      {folder ? <FolderIcon className="size-3 shrink-0" aria-hidden="true" /> : null}
      <span className="truncate">{folder ? folder.name : 'No folder'}</span>
      <span className="font-mono font-normal tracking-normal" aria-label={`${section.projects.length} project${section.projects.length === 1 ? '' : 's'}`}>
        · {section.projects.length}
      </span>
      {folder ? (
        <>
          <button
            type="button"
            aria-label={`Edit ${folder.name}`}
            onClick={() => onEditFolder(folder)}
            className="ml-auto rounded px-1 text-xs tracking-normal text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            …
          </button>
          <button
            type="button"
            data-slot="project-folder-grip"
            disabled={!canDragFolder}
            aria-label={`Reorder folder ${folder.name}`}
            className={cn(
              'flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-soft-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              !canDragFolder && 'invisible',
            )}
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon className="size-3" aria-hidden="true" />
          </button>
        </>
      ) : null}
    </span>
  )
  return (
    <div
      ref={folder ? setNodeRef : undefined}
      style={folder ? { transform: CSS.Translate.toString(transform), transition } : undefined}
      data-slot="switcher-section"
      data-folder={folder?.id ?? undefined}
      className={cn(isDragging && 'relative z-10 opacity-40')}
    >
      <CommandGroup heading={heading} className="[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:text-soft-foreground">
        {section.projects.length === 0 && !searching ? (
          <p className="px-2 py-1 text-xs text-soft-foreground">No projects</p>
        ) : null}
        {section.projects.map((project) => (
          <SwitcherRow
            key={project.id}
            project={project}
            current={project.id === activeId}
            counts={counts.get(project.id)}
            sortable={sortable && !searching}
            onSelect={onSelect}
          />
        ))}
      </CommandGroup>
    </div>
  )
}

function SwitcherRow({
  project,
  current,
  counts,
  sortable,
  onSelect,
}: {
  project: ProjectListEntry
  current: boolean
  counts: ProjectCounts | undefined
  sortable: boolean
  onSelect: (project: ProjectListEntry) => void
}) {
  const missing = project.status === 'missing'
  // A missing project holds its place but is not draggable (remove it in Settings → Projects);
  // an unregistered boot folder leads by RULE, so a drag of it could only snap back.
  const canDrag = sortable && !missing && !project.unregistered
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id, disabled: !canDrag })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-slot="switcher-project"
      data-project={project.id}
      data-status={project.status}
      data-current={current ? '' : undefined}
      data-dragging={isDragging ? '' : undefined}
      className={cn(isDragging && 'relative z-10 opacity-40')}
    >
      <CommandItem
        value={project.id}
        disabled={missing}
        onSelect={() => onSelect(project)}
        title={missing ? `${project.root} is gone — remove it in Global settings → Projects` : project.root}
        aria-current={current ? 'true' : undefined}
        className="group/row gap-2 py-1.5 pl-1 pr-2"
      >
        <button
          type="button"
          data-slot="project-grip"
          disabled={!canDrag}
          aria-label={`Reorder ${project.name}`}
          // The grip is dnd-kit's; a click on it must not select the row.
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-soft-foreground opacity-0 outline-none transition-opacity',
            'focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 group-hover/row:opacity-70 group-data-[selected=true]/row:opacity-70 [@media(hover:none)]:opacity-70',
            !canDrag && 'cursor-default opacity-0 group-hover/row:opacity-0 group-data-[selected=true]/row:opacity-0 [@media(hover:none)]:opacity-0',
          )}
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-3.5" aria-hidden="true" />
        </button>
        <StatusDot tone={projectStatusTone(project.status)} />
        <span className={cn('flex min-w-0 flex-1 items-baseline gap-2', missing && 'opacity-55')}>
          <span data-slot="switcher-project-name" className="truncate font-medium">{project.name}</span>
          {project.branch ? (
            <span data-slot="switcher-project-branch" className="truncate font-mono text-micro text-soft-foreground">{project.branch}</span>
          ) : null}
        </span>
        {project.unregistered ? (
          <span data-slot="project-unregistered" title="cezar is serving this folder — it is not in your saved projects." className="shrink-0 rounded-full bg-muted px-[7px] py-px text-micro font-medium text-soft-foreground">
            not saved
          </span>
        ) : null}
        {missing ? (
          <span data-slot="project-missing" className="shrink-0 rounded-full bg-danger/15 px-[7px] py-px text-micro font-medium text-danger">
            folder not found
          </span>
        ) : null}
        {counts?.needsYou ? (
          <span
            data-slot="project-attention"
            title={`${counts.needsYou} task${counts.needsYou === 1 ? '' : 's'} need${counts.needsYou === 1 ? 's' : ''} you`}
            className="shrink-0 rounded-full bg-violet px-1.5 py-px text-micro font-semibold text-violet-foreground tabular-nums"
          >
            {counts.needsYou}
          </span>
        ) : null}
        {counts?.running ? (
          <span data-slot="project-running" title={`${counts.running} running`} className="flex shrink-0 items-center gap-0.5 text-micro text-violet tabular-nums">
            <LoaderCircleIcon className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {counts.running}
          </span>
        ) : null}
        <span className="flex w-3.5 shrink-0 justify-center text-violet" aria-hidden="true">
          {current ? <CheckIcon className="size-3.5" /> : null}
        </span>
      </CommandItem>
    </div>
  )
}
