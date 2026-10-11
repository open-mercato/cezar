import * as React from 'react'
import { useCommandShortcut, useKeyShortcut } from '@/lib/use-command-shortcut'
import type { ProjectListEntry, RunIndexEntry, RunRecord } from '@open-mercato/cezar-api-client'
import { isUnread } from '@/lib/read-state'
import { orderProjects as orderRegistry } from '@/lib/project-order'
import { useNavigate } from '@/lib/project-router'
import { CommandDialog } from '@/components/ui/command'

export const OPEN_COMMAND_PALETTE_EVENT = 'cezar:open-command-palette'

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))
}

export function orderRuns(runs: readonly RunRecord[]): RunRecord[] {
  return [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export function paletteScore(value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLowerCase()
  if (query === '') return 1
  const haystack = (keywords?.length ? `${value} ${keywords.join(' ')}` : value).toLowerCase()
  const tokens = query.split(/\s+/)
  let total = 0
  for (const token of tokens) {
    const at = haystack.indexOf(token)
    if (at === -1) return 0
    const boundary = at === 0 || !/[a-z0-9]/.test(haystack[at - 1] ?? '')
    total += (boundary ? 1 : 0.5) / (1 + at / 48)
  }
  return total / tokens.length
}

export type PaletteTask = Omit<RunIndexEntry, 'projectId'> & { projectId: string | null }

export function mergeTasks(activeRuns: readonly RunRecord[], runsProjectId: string | null, indexed: readonly RunIndexEntry[] | undefined): PaletteTask[] {
  const mine: PaletteTask[] = orderRuns(activeRuns).map((run) => ({
    projectId: runsProjectId,
    id: run.id,
    title: run.title,
    titleSummary: run.titleSummary,
    titleOrigin: run.titleOrigin,
    status: run.status,
    activity: run.activity,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    seenAt: run.seenAt,
    archived: run.archived,
    autoResumeAt: run.autoResumeAt,
    awaitingAnswerSince: run.awaitingAnswerSince,
    workflow: run.workflow,
    branch: run.branch,
    startedAt: run.startedAt,
  }))
  const live = new Set(mine.map(taskKey))
  const theirs = (indexed ?? []).filter((entry) => !live.has(taskKey(entry))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return [...mine, ...theirs]
}

const taskKey = (task: Pick<PaletteTask, 'projectId' | 'id'>): string => `${task.projectId ?? ''}/${task.id}`

export function partitionTasks(tasks: readonly PaletteTask[]): { recentlyFinished: PaletteTask[]; otherTasks: PaletteTask[] } {
  const recentlyFinished = tasks.filter((task) => isUnread(task)).sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
  const led = new Set(recentlyFinished.map(taskKey))
  return { recentlyFinished, otherTasks: tasks.filter((task) => !led.has(taskKey(task))) }
}

export function orderProjects(projects: readonly ProjectListEntry[], activeProjectId: string | null, storedOrder: readonly string[] = []): ProjectListEntry[] {
  const ordered = orderRegistry(projects, storedOrder)
  return [...ordered.filter((project) => project.id !== activeProjectId), ...ordered.filter((project) => project.id === activeProjectId)]
}

const LazyPaletteBody = React.lazy(async () => import('@/components/command-palette-body').then((module) => ({ default: module.PaletteBody })))

export function CommandPalette() {
  const [open, setOpen] = React.useState(false)
  const navigate = useNavigate()
  useCommandShortcut('k', () => setOpen((current) => !current))
  const newTask = React.useCallback(() => {
    setOpen(false)
    navigate('/new')
  }, [navigate])
  useCommandShortcut('n', newTask)
  useKeyShortcut('c', newTask)
  React.useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
  }, [])
  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search projects, tasks, views, actions, and skills"
      showCloseButton={false}
      filter={paletteScore}
      className="top-[10vh] translate-y-0 sm:max-w-2xl lg:max-w-3xl xl:max-w-4xl"
    >
      {open ? <React.Suspense fallback={null}><LazyPaletteBody close={() => setOpen(false)} /></React.Suspense> : null}
    </CommandDialog>
  )
}
