import { FileIcon, PencilIcon } from 'lucide-react'
import * as React from 'react'
import { matchPath, useLocation } from 'react-router'

import { useHealth, usePatchRun, useProjects, useRun, useRunTree } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import {
  paletteScore,
  paletteTaskPath,
  TaskItem,
  usePaletteExclusion,
  usePaletteTasks,
  type PaletteTask,
} from '@/components/command-palette'
import { Pill } from '@/components/pill'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { toast } from '@/components/ui/toaster'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { deriveAttention } from '@/lib/attention'
import { scopeTo, useActiveProjectId, useNavigate } from '@/lib/project-router'
import { orderByRecency, readRecentTasks } from '@/lib/recent-tasks'
import { runTitle } from '@/lib/task-groups'
import { ownedTaskPr } from '@/lib/tasks-table'
import { queueFileOpen, taskWorkspaceFor } from '@/lib/task-workspace-bridge'
import { commandShortcutHint, useCommandShortcut } from '@/lib/use-command-shortcut'
import { cn } from '@/lib/utils'
import { useRunGitStep } from '@/routes/task-git/run-git-step'
import { useRunReferences } from '@/routes/task-thread/run-header'
import { RunConfirmDialog } from '@/routes/task-thread/run-confirm-dialog'
import { copyToClipboard, useCanOpenTerminal, useRunActions, useRunOpenChoices } from '@/routes/task-thread/use-run-actions'

import { buildTaskCommands, TASK_COMMAND_GROUPS, type TaskCommand } from './commands'
import { OPEN_TASK_PALETTE_EVENT, type TaskPaletteSubject } from './open'

/**
 * ⌘P — the task palette (spec 2026-10-17-task-palette). ⌘K finds; ⌘P acts on ONE task, the
 * subject: the task on screen, or whichever one Tab picked from the switcher or from ⌘K.
 *
 * Prefixes, as in VS Code: `@` tasks, `>` commands only, `#` files in the subject's worktree.
 */

export type PaletteMode = 'all' | 'commands' | 'tasks' | 'files'

/** What the input means: its prefix picks the mode, the rest is the query. Without a subject
 *  there is nothing to act on, so a bare query searches tasks. */
export function paletteMode(search: string, hasSubject: boolean): { mode: PaletteMode; query: string } {
  if (search.startsWith('@')) return { mode: 'tasks', query: search.slice(1) }
  if (search.startsWith('>')) return { mode: hasSubject ? 'commands' : 'tasks', query: search.slice(1) }
  if (search.startsWith('#')) return { mode: hasSubject ? 'files' : 'tasks', query: search.slice(1) }
  return { mode: hasSubject ? 'all' : 'tasks', query: search }
}

const stripPrefix = (search: string) => search.replace(/^[@>#]/, '')

/** cmdk hands the filter the raw input; the prefix is grammar, not search text. */
const prefixedScore = (value: string, search: string, keywords?: string[]) =>
  paletteScore(value, stripPrefix(search), keywords)

/** The task a route shows, if any — `/p/:projectId/tasks/:id/…` or the legacy flat spelling. */
export function taskIdFromPath(pathname: string): string | undefined {
  const match = matchPath('/p/:projectId/tasks/:id/*', pathname) ?? matchPath('/tasks/:id/*', pathname)
  return match?.params.id
}

/** The best `limit` paths for `query`, best first — `#` mode filters itself: a worktree index can
 *  hold twenty thousand paths, far more than cmdk should mount as rows. */
export function rankPaths(paths: readonly string[], query: string, limit = 50): string[] {
  const trimmed = query.trim()
  if (trimmed === '') return paths.slice(0, limit)
  const scored: { path: string; score: number }[] = []
  for (const path of paths) {
    // The file name counts double: `#header` should find `run-header.tsx` before a `header/` dir.
    const name = path.slice(path.lastIndexOf('/') + 1)
    const score = paletteScore(path, trimmed) + paletteScore(name, trimmed)
    if (score > 0) scored.push({ path, score })
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return scored.slice(0, limit).map((entry) => entry.path)
}

interface SubjectApi {
  run: ApiRun
  commands: TaskCommand[]
  rename: (title: string) => void
}

const RECENT_IN_DEFAULT_VIEW = 6
const TASK_ROW = 'task-palette-task'

export function TaskPalette() {
  const location = useLocation()
  const pageTaskId = taskIdFromPath(location.pathname)
  const navigate = useNavigate()
  const liveProjectId = useLiveProjectId()

  const [open, setOpen] = React.useState(false)
  const [subjectId, setSubjectId] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState('')
  const [selected, setSelected] = React.useState('')
  const [renaming, setRenaming] = React.useState(false)
  // Steps down the task rows to select once they render — how a repeated ⌘P walks the switcher.
  const [cycleTo, setCycleTo] = React.useState<{ step: number } | null>(null)
  // Tagged with the run they were built for, so a newly picked subject never shows the last one's.
  const [published, setPublished] = React.useState<{ runId: string; commands: TaskCommand[] } | null>(null)
  const subjectApi = React.useRef<SubjectApi | null>(null)
  const body = React.useRef<HTMLDivElement>(null)
  const performed = React.useRef(false)
  const reopenFor = React.useRef<string | null>(null)

  const close = React.useCallback(() => setOpen(false), [])
  usePaletteExclusion('task', open, close)

  const show = React.useCallback((subject: string | null, initialSearch: string) => {
    setSubjectId(subject)
    setSearch(initialSearch)
    setSelected('')
    setRenaming(false)
    setCycleTo(null)
    performed.current = false
    setOpen(true)
  }, [])

  const taskRows = () =>
    [...(body.current?.querySelectorAll<HTMLElement>(`[cmdk-item][data-slot="${TASK_ROW}"]`) ?? [])]

  useCommandShortcut(
    'p',
    () => {
      if (!open) {
        if (pageTaskId) show(pageTaskId, '')
        else show(null, '@')
        return
      }
      // Repeated ⌘P walks the switcher: the first repeat lands on the previous task.
      if (!search.startsWith('@') && subjectId) {
        setSearch('@')
        setCycleTo({ step: 1 })
        return
      }
      const rows = taskRows()
      const at = rows.findIndex((row) => row.dataset.value === selected)
      setCycleTo({ step: at + 1 >= rows.length ? 0 : at + 1 })
    },
    { inEditable: true },
  )

  React.useEffect(() => {
    if (!cycleTo) return
    const rows = taskRows()
    const row = rows[Math.min(cycleTo.step, rows.length - 1)]
    if (row?.dataset.value) setSelected(row.dataset.value)
    setCycleTo(null)
  }, [cycleTo, search])

  /** Act on `subject`: in place when it is in the project on screen, else go there and re-open. */
  const actOn = React.useCallback(
    (subject: TaskPaletteSubject) => {
      if (subject.projectId === null || subject.projectId === liveProjectId) {
        show(subject.runId, '')
        return
      }
      reopenFor.current = subject.runId
      setOpen(false)
      navigate(paletteTaskPath({ id: subject.runId, projectId: subject.projectId }))
    },
    [liveProjectId, navigate, show],
  )

  React.useEffect(() => {
    const onOpen = (event: Event) => {
      const subject = (event as CustomEvent<TaskPaletteSubject | undefined>).detail
      if (subject) actOn(subject)
      else if (pageTaskId) show(pageTaskId, '')
      else show(null, '@')
    }
    window.addEventListener(OPEN_TASK_PALETTE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_TASK_PALETTE_EVENT, onOpen)
  }, [actOn, pageTaskId, show])

  React.useEffect(() => {
    if (reopenFor.current && reopenFor.current === pageTaskId) {
      reopenFor.current = null
      show(pageTaskId, '')
    }
  }, [pageTaskId, show])

  // Leaving the page retires a closed palette's subject, so a task no longer on screen stops
  // being polled for its git status. An open dialog (Stop, Delete, Commit) is modal, so nothing
  // navigates while one is up.
  React.useEffect(() => {
    if (!open) setSubjectId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  const perform = (id: string, beside = false) => {
    const command = subjectApi.current?.commands.find((candidate) => candidate.id === id)
    if (!command || command.unavailable) return
    // Rename edits in place: the palette's input becomes the title field.
    if (command.id === 'rename') {
      command.perform()
      return
    }
    performed.current = true
    setOpen(false)
    const run = beside && command.performBeside ? command.performBeside : command.perform
    // After the dialog lets go, so a command that focuses something (the composer) or opens a
    // dialog of its own (Stop, Delete, Commit) is not fighting the palette's focus trap.
    setTimeout(run, 0)
  }

  const beginRename = React.useCallback(() => {
    const run = subjectApi.current?.run
    if (!run) return
    setRenaming(true)
    setSearch(runTitle(run))
  }, [])

  const commitRename = () => {
    const next = search.trim()
    if (next && subjectApi.current) subjectApi.current.rename(next)
    performed.current = true
    setOpen(false)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (renaming) {
      if (event.key === 'Enter') {
        event.preventDefault()
        commitRename()
      }
      return
    }
    const row = body.current?.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]')
    if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const runId = row?.dataset.slot === TASK_ROW ? row.dataset.runId : undefined
      if (!runId) return
      event.preventDefault()
      actOn({ runId, projectId: row?.dataset.projectId ?? null })
      return
    }
    if (event.key === 'Enter' && event.altKey && row?.dataset.commandId) {
      event.preventDefault()
      perform(row.dataset.commandId, true)
      return
    }
    // Backspace on an empty input walks back from a picked task to the switcher.
    if (event.key === 'Backspace' && search === '' && subjectId !== null && subjectId !== pageTaskId) {
      event.preventDefault()
      show(pageTaskId ?? null, '@')
    }
  }

  const { mode, query } = renaming ? { mode: 'all' as const, query: '' } : paletteMode(search, subjectId !== null)

  return (
    <>
      {subjectId ? (
        <SubjectHost
          key={subjectId}
          runId={subjectId}
          apiRef={subjectApi}
          onCommands={setPublished}
          onRename={beginRename}
        />
      ) : null}
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Task palette"
        description="Act on a task, switch tasks, or open one of its files"
        showCloseButton={false}
        filter={prefixedScore}
        commandProps={{
          value: selected,
          onValueChange: setSelected,
          onKeyDown,
          shouldFilter: !renaming && mode !== 'files',
        }}
        onCloseAutoFocus={(event) => {
          // A command chose where focus goes next; do not hand it back to the old element.
          if (performed.current) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (!renaming) return
          event.preventDefault()
          setRenaming(false)
          setSearch('')
        }}
        // ⌘K's geometry, so the two palettes feel like one surface.
        className="top-[10vh] translate-y-0 sm:max-w-2xl lg:max-w-3xl xl:max-w-4xl"
      >
        <div ref={body} data-slot="task-palette" data-mode={renaming ? 'rename' : mode} className="contents">
          <CommandInput
            placeholder={placeholder(renaming ? 'rename' : mode)}
            value={search}
            onValueChange={setSearch}
          />
          {subjectId && !renaming ? <SubjectBar runId={subjectId} picked={subjectId !== pageTaskId} /> : null}
          <CommandList className="max-h-[55vh] min-h-[14rem] sm:max-h-[60vh] lg:max-h-[68vh]">
            {renaming ? (
              <CommandGroup heading="Rename">
                <CommandItem value="rename" data-slot="task-palette-rename" onSelect={commitRename}>
                  <PencilIcon aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    {search.trim() ? `Rename to “${search.trim()}”` : 'Type the new name'}
                  </span>
                  <CommandShortcut>↵</CommandShortcut>
                </CommandItem>
              </CommandGroup>
            ) : (
              <>
                <CommandEmpty>Nothing matches.</CommandEmpty>
                {mode === 'all' || mode === 'commands' ? (
                  <CommandGroups
                    commands={published?.runId === subjectId ? published.commands : []}
                    onPerform={perform}
                  />
                ) : null}
                {mode === 'files' && subjectId ? (
                  <FileResults
                    runId={subjectId}
                    query={query}
                    onPick={(path) => {
                      performed.current = true
                      setOpen(false)
                      const workspace = taskWorkspaceFor(subjectId)
                      if (workspace) setTimeout(() => workspace.openFile(path), 0)
                      else {
                        queueFileOpen(subjectId, path)
                        navigate(`/tasks/${subjectId}`)
                      }
                    }}
                  />
                ) : null}
                {mode === 'all' || mode === 'tasks' ? (
                  <TaskResults
                    recentOnly={mode === 'all'}
                    exclude={mode === 'all' ? subjectId : null}
                    current={pageTaskId}
                    onPick={(task) => {
                      performed.current = true
                      setOpen(false)
                      navigate(paletteTaskPath(task))
                    }}
                  />
                ) : null}
              </>
            )}
          </CommandList>
          <PaletteFooter mode={renaming ? 'rename' : mode} />
        </div>
      </CommandDialog>
    </>
  )
}

function placeholder(mode: PaletteMode | 'rename'): string {
  switch (mode) {
    case 'rename':
      return 'New name…'
    case 'tasks':
      return 'Switch to a task…'
    case 'files':
      return 'Open a file in this task…'
    case 'commands':
      return 'Run a command on this task…'
    default:
      return 'Act on this task — @ tasks · > commands · # files'
  }
}

/** The project whose live run list the palettes read — see `usePaletteTasks`. */
function useLiveProjectId(): string | null {
  const activeProjectId = useActiveProjectId()
  const projects = useProjects()
  const health = useHealth()
  const bootProjectId = projects.data?.bootProject ?? health.data?.bootProject ?? null
  return (activeProjectId === 'default' ? null : activeProjectId) ?? bootProjectId
}

/** Which task the palette is acting on — the header row under the input. */
function SubjectBar({ runId, picked }: { runId: string; picked: boolean }) {
  const run = useRun(runId).data
  if (!run) return null
  const attention = deriveAttention(run)
  return (
    <div
      data-slot="task-palette-subject"
      className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground"
    >
      <span className="shrink-0">Task</span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{runTitle(run)}</span>
      <Pill className="shrink-0" dot={attention.tone} pulse={attention.pulse}>
        {attention.label}
      </Pill>
      {picked ? <span className="shrink-0 text-soft-foreground">⌫ back to tasks</span> : null}
    </div>
  )
}

function CommandGroups({ commands, onPerform }: { commands: TaskCommand[]; onPerform: (id: string) => void }) {
  return (
    <>
      {TASK_COMMAND_GROUPS.map((group) => {
        const members = commands.filter((command) => command.group === group.id)
        if (members.length === 0) return null
        return (
          <CommandGroup key={group.id} heading={group.heading}>
            {members.map((command) => (
              <CommandItem
                key={command.id}
                // The id keeps values unique (two layouts may share a label); the heading lets
                // "git push" or "copy branch" find the row by its group.
                value={`${group.heading} ${command.label} ${command.id}`}
                keywords={command.keywords}
                disabled={command.unavailable !== undefined}
                data-slot="task-palette-command"
                data-command-id={command.id}
                aria-pressed={command.pressed}
                onSelect={() => onPerform(command.id)}
                className={cn(command.danger && 'data-[selected=true]:text-danger')}
              >
                {command.icon}
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                {command.unavailable ? (
                  <span className="shrink-0 truncate text-xs text-soft-foreground">{command.unavailable}</span>
                ) : command.pressed ? (
                  <span className="shrink-0 text-xs text-primary">on</span>
                ) : null}
                {command.shortcut ? <CommandShortcut>{command.shortcut}</CommandShortcut> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        )
      })}
    </>
  )
}

function TaskResults({
  recentOnly,
  exclude,
  current,
  onPick,
}: {
  recentOnly: boolean
  exclude: string | null
  current: string | undefined
  onPick: (task: PaletteTask) => void
}) {
  const { tasks, multiProject, projectNames } = usePaletteTasks()
  const recent = readRecentTasks()
  const ordered = React.useMemo(() => {
    const byRecency = orderByRecency(tasks, (task) => task.id, recent)
    if (!recentOnly) return byRecency
    const seen = new Set(recent)
    return byRecency.filter((task) => seen.has(task.id) && task.id !== exclude).slice(0, RECENT_IN_DEFAULT_VIEW)
  }, [tasks, recent, recentOnly, exclude])
  const now = Date.now()
  if (ordered.length === 0) return null
  return (
    <CommandGroup heading={recentOnly ? 'Recent tasks' : 'Tasks'}>
      {ordered.map((task) => (
        <TaskItem
          key={`${task.projectId ?? ''}/${task.id}`}
          task={task}
          slot={TASK_ROW}
          projectName={task.projectId === null ? null : (projectNames.get(task.projectId) ?? null)}
          showProject={multiProject}
          now={now}
          onSelect={onPick}
          trailing={task.id === current ? <span className="shrink-0 text-xs text-primary">open</span> : null}
        />
      ))}
    </CommandGroup>
  )
}

function FileResults({ runId, query, onPick }: { runId: string; query: string; onPick: (path: string) => void }) {
  const tree = useRunTree(runId)
  const paths = React.useMemo(() => rankPaths(tree.data?.paths ?? [], query), [tree.data, query])
  if (tree.isPending) {
    return <p className="px-3 py-6 text-center text-xs text-soft-foreground">Loading files…</p>
  }
  if (tree.isError) {
    return <p className="px-3 py-6 text-center text-xs text-soft-foreground">{tree.error.message}</p>
  }
  return (
    <CommandGroup heading="Files">
      {paths.map((path) => {
        const slash = path.lastIndexOf('/')
        return (
          <CommandItem key={path} value={`file ${path}`} data-slot="task-palette-file" onSelect={() => onPick(path)}>
            <FileIcon aria-hidden="true" />
            <span className="shrink-0 font-medium">{path.slice(slash + 1)}</span>
            {slash > 0 ? (
              <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">{path.slice(0, slash)}</span>
            ) : null}
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}

function PaletteFooter({ mode }: { mode: PaletteMode | 'rename' }) {
  const hints =
    mode === 'rename'
      ? ['↵ save', 'esc cancel']
      : mode === 'tasks'
        ? ['↵ open', 'tab act on it', `${commandShortcutHint('p')} next`]
        : mode === 'files'
          ? ['↵ open in Code']
          : ['↵ run', '⌥↵ open beside', '@ tasks', '> commands', '# files']
  return (
    <div
      data-slot="task-palette-footer"
      className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border px-3 py-1.5 text-[11px] text-soft-foreground"
    >
      {hints.map((hint) => (
        <span key={hint}>{hint}</span>
      ))}
    </div>
  )
}

/**
 * The subject's actions, mounted OUTSIDE the dialog: Stop/Delete confirms and the commit dialog
 * must outlive the palette that opened them. Publishes its commands up through `onCommands` when
 * what they say changes; `apiRef` always holds the latest closures for `perform`.
 */
function SubjectHost(props: {
  runId: string
  apiRef: React.RefObject<SubjectApi | null>
  onCommands: (published: { runId: string; commands: TaskCommand[] }) => void
  onRename: () => void
}) {
  const run = useRun(props.runId).data
  if (!run) return null
  return <SubjectReferences run={run} {...props} />
}

function SubjectReferences(props: {
  run: ApiRun
  apiRef: React.RefObject<SubjectApi | null>
  onCommands: (published: { runId: string; commands: TaskCommand[] }) => void
  onRename: () => void
}) {
  // The git step reads the task's PR status; the header asks under the same provider.
  const refs = useRunReferences(props.run)
  return (
    <ReferenceStatusProvider projectId={refs.projectId} requests={refs.requests}>
      <SubjectCommands {...props} />
    </ReferenceStatusProvider>
  )
}

function SubjectCommands({
  run,
  apiRef,
  onCommands,
  onRename,
}: {
  run: ApiRun
  apiRef: React.RefObject<SubjectApi | null>
  onCommands: (published: { runId: string; commands: TaskCommand[] }) => void
  onRename: () => void
}) {
  const workspace = taskWorkspaceFor(run.id)
  const actions = useRunActions(run, { surface: 'palette', onMarkedUnread: workspace?.markedUnread })
  const git = useRunGitStep(run)
  const canTerminal = useCanOpenTerminal(run)
  const openIn = useRunOpenChoices(run, canTerminal)
  const terminalAvailable = useHealth().data?.capabilities?.terminal === true
  const patch = usePatchRun(run.id)
  const navigate = useNavigate()
  const liveProjectId = useLiveProjectId()
  const owned = ownedTaskPr(run)

  const commands = buildTaskCommands(
    {
      run,
      canResume: openIn.canResumeHere,
      git: git.action,
      workspace,
      terminalAvailable,
      openChoices: openIn.choices,
      prUrl: owned?.url,
      taskUrl: `${window.location.origin}${liveProjectId ? (scopeTo(liveProjectId, `/tasks/${run.id}`) as string) : `/tasks/${run.id}`}`,
    },
    {
      markRead: () => actions.markRead.mutate(),
      markUnread: () => actions.markUnread.mutate(),
      pin: () => actions.pin.mutate(),
      archive: () => actions.archive.mutate(),
      rename: onRename,
      finish: () => actions.finish.mutate(),
      confirmStop: () => actions.setConfirming('cancel'),
      confirmDelete: () => actions.setConfirming('delete'),
      resumeInTerminal: () => actions.terminal.mutate(),
      gitAction: git.onAction,
      openIn: openIn.open,
      navigate: (to) => navigate(to),
      openUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
      copy: (text, what) => void copyToClipboard(text, `${what} copied`),
    },
  )
  apiRef.current = {
    run,
    commands,
    rename: (title) =>
      patch.mutate({ title }, { onError: (error) => toast(error.message, { tone: 'danger' }) }),
  }

  const signature = commands
    .map((command) => `${command.id}|${command.label}|${command.unavailable ?? ''}|${command.pressed ? 1 : 0}|${command.shortcut ?? ''}`)
    .join('\n')
  const latest = React.useRef(commands)
  latest.current = commands
  React.useEffect(() => onCommands({ runId: run.id, commands: latest.current }), [signature, onCommands, run.id])

  return (
    <>
      <RunConfirmDialog
        run={run}
        confirming={actions.confirming}
        lifecycleDelete={actions.lifecycleDelete}
        onOpenChange={(open) => !open && actions.setConfirming(null)}
        onConfirm={(kind) => (kind === 'delete' ? actions.delete.mutate() : actions.cancel.mutate())}
      />
      {git.dialogs}
    </>
  )
}
