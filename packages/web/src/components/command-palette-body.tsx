import { CheckIcon, FolderOpenIcon, LayersIcon, MoonIcon, PlusIcon } from 'lucide-react'
import * as React from 'react'
import { useNavigate as useRouterNavigate } from 'react-router'

import { useHealth, useProjects, useRunsForProject, useRunsIndex, useSkills, useUiState } from '@/api/queries'
import type { PaletteTask } from '@/components/command-palette'
import { mergeTasks, orderProjects, partitionTasks } from '@/components/command-palette'
import { visibleNavItems } from '@/components/nav-items'
import { StatusDot } from '@/components/status-dot'
import { NEXT_THEME } from '@/components/theme-toggle'
import { useTheme } from '@/components/theme-provider'
import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { scopeTo, useActiveProjectId, useNavigate } from '@/lib/project-router'
import { orderSkillsByUsage } from '@/lib/skills'
import { runTitle } from '@/lib/task-groups'
import { useProjectOrder } from '@/lib/use-project-order'

export function PaletteBody({ close }: { close: () => void }) {
  const navigate = useNavigate()
  const routerNavigate = useRouterNavigate()
  const [search, setSearch] = React.useState('')
  const searching = search.trim() !== ''
  const activeProjectId = useActiveProjectId()
  const { theme, setTheme } = useTheme()
  const projects = useProjects()
  const health = useHealth()
  const registry = projects.data
  const bootProjectId = registry?.bootProject ?? health.data?.bootProject ?? null
  const runs = useRunsForProject(activeProjectId, bootProjectId)
  const skills = useSkills()
  const uiState = useUiState()
  const now = Date.now()
  const multiProject = registry !== undefined && registry.projects.length > 1
  const runsIndex = useRunsIndex(multiProject)
  const { order: projectOrder } = useProjectOrder()
  const orderedProjects = React.useMemo(
    () => (multiProject ? orderProjects(registry.projects, activeProjectId, projectOrder) : []),
    [multiProject, registry, activeProjectId, projectOrder],
  )
  const projectNames = React.useMemo(
    () => new Map((registry?.projects ?? []).map((project) => [project.id, project.name])),
    [registry],
  )
  const runsProjectId = (activeProjectId === 'default' ? null : activeProjectId) ?? bootProjectId
  const tasks = React.useMemo(
    () => mergeTasks(runs.data ?? [], runsProjectId, runsIndex.data?.runs),
    [runs.data, runsProjectId, runsIndex.data],
  )
  const partitioned = React.useMemo(() => partitionTasks(tasks), [tasks])
  const recentlyFinished = searching ? [] : partitioned.recentlyFinished
  const otherTasks = searching ? tasks : partitioned.otherTasks
  const showProjectOnTasks = multiProject
  const taskProjectName = (task: PaletteTask): string | null =>
    task.projectId === null ? null : (projectNames.get(task.projectId) ?? null)
  const skillUsage = uiState.data?.skillUsage
  const orderedSkills = React.useMemo(
    () => orderSkillsByUsage(skills.data ?? [], skillUsage),
    [skills.data, skillUsage],
  )
  const go = (to: string) => {
    close()
    navigate(to)
  }
  const goGlobal = (to: string) => {
    close()
    routerNavigate(to)
  }
  const goProject = (projectId: string) => {
    close()
    navigate(scopeTo(projectId, '/'))
  }
  const selectTask = (task: PaletteTask) => {
    close()
    navigate(task.projectId === null ? `/tasks/${task.id}` : scopeTo(task.projectId, `/tasks/${task.id}`))
  }
  const nextTheme = NEXT_THEME[theme]

  return (
    <>
      <CommandInput
        placeholder="Search projects, tasks, views, actions, skills…"
        value={search}
        onValueChange={setSearch}
      />
      <CommandList className="max-h-[55vh] min-h-[14rem] sm:max-h-[60vh] lg:max-h-[68vh]">
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup>
          <CommandItem value="new task" data-slot="palette-view" data-nav-to="/new" onSelect={() => go('/new')}>
            <PlusIcon aria-hidden="true" />
            New task
            <CommandShortcut>C</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        {!searching && recentlyFinished.length > 0 ? (
          <CommandGroup heading="Recently finished">
            {recentlyFinished.map((task) => (
              <TaskItem key={taskKey(task)} task={task} projectName={taskProjectName(task)} showProject={showProjectOnTasks} now={now} onSelect={selectTask} />
            ))}
          </CommandGroup>
        ) : null}
        <CommandGroup heading="Views">
          {multiProject ? (
            <CommandItem value="view All tasks" data-slot="palette-view" data-nav-to="/tasks" onSelect={() => goGlobal('/tasks')}>
              <LayersIcon aria-hidden="true" />
              All tasks
            </CommandItem>
          ) : null}
          {visibleNavItems({
            forge: health.data?.forge?.available === true,
            inbox: health.data?.capabilities.followups === true,
            automations: health.data?.capabilities.automations === true,
            tracker: registry?.projects.find((project) => project.id === (activeProjectId ?? registry.bootProject))?.tracker,
          }).map((item) => {
            const Icon = item.icon
            return <CommandItem key={item.to} value={`view ${item.label}`} data-slot="palette-view" data-nav-to={item.to} onSelect={() => go(item.to)}><Icon aria-hidden="true" />{item.label}</CommandItem>
          })}
        </CommandGroup>
        {orderedProjects.length > 0 ? (
          <CommandGroup heading="Projects">
            {orderedProjects.map((project) => {
              const active = project.id === activeProjectId
              const missing = project.status === 'missing'
              return (
                <CommandItem key={project.id} value={`project ${project.name} ${project.id}`} keywords={[project.root]} data-slot="palette-project" data-project-id={project.id} disabled={missing} onSelect={() => goProject(project.id)}>
                  <FolderOpenIcon aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {missing ? <span className="shrink-0 text-xs text-soft-foreground">folder not found</span> : project.branch !== undefined ? <span className="shrink-0 font-mono text-xs text-soft-foreground">{project.branch}</span> : null}
                  {active ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : null}
                </CommandItem>
              )
            })}
          </CommandGroup>
        ) : null}
        {otherTasks.length > 0 ? <CommandGroup heading="Tasks">{otherTasks.map((task) => <TaskItem key={taskKey(task)} task={task} projectName={taskProjectName(task)} showProject={showProjectOnTasks} now={now} onSelect={selectTask} />)}</CommandGroup> : null}
        <CommandGroup heading="Actions">
          <CommandItem value="action toggle theme" data-slot="palette-action" data-action="toggle-theme" onSelect={() => { setTheme(nextTheme); close() }}>
            <MoonIcon aria-hidden="true" />
            Toggle theme
            <CommandShortcut className="tracking-normal">{theme} → {nextTheme}</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        {orderedSkills.length > 0 ? (
          <CommandGroup heading="Skills">
            {orderedSkills.map((skill) => <CommandItem key={skill.path} value={`skill ${skill.name} ${skill.path}`} keywords={skill.description ? [skill.description] : undefined} data-slot="palette-skill" data-skill={skill.name} onSelect={() => go(`/new?skill=${encodeURIComponent(skill.name)}`)}><span className="shrink-0 font-medium">{skill.name}</span>{skill.description ? <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">{skill.description}</span> : null}</CommandItem>)}
          </CommandGroup>
        ) : null}
      </CommandList>
    </>
  )
}

function taskKey(task: Pick<PaletteTask, 'projectId' | 'id'>): string {
  return `${task.projectId ?? ''}/${task.id}`
}

function TaskItem({ task, projectName, showProject, now, onSelect }: { task: PaletteTask; projectName: string | null; showProject: boolean; now: number; onSelect: (task: PaletteTask) => void }) {
  const attention = deriveAttention(task)
  const label = runTitle(task)
  return <CommandItem value={`task ${label} ${task.id}`} keywords={projectName ? [projectName] : undefined} data-slot="palette-task" data-run-id={task.id} data-project-id={task.projectId ?? undefined} onSelect={() => onSelect(task)}><StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" /><span className="min-w-0 flex-1 truncate">{label}</span>{showProject && projectName ? <span data-slot="palette-task-project" className="shrink-0 truncate text-xs text-soft-foreground">{projectName}</span> : null}<span className="shrink-0 text-xs text-soft-foreground tabular-nums">{shortAge(task.finishedAt ?? task.createdAt, now)}</span></CommandItem>
}
