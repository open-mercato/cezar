import { FileIcon, KeyboardIcon, PencilIcon } from 'lucide-react'
import * as React from 'react'
import { matchPath, useLocation } from 'react-router'

import { useHealth, usePatchRun, useProjects, useRun, useRunTree } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import {
  paletteScore,
  paletteTaskPath,
  MoreTasks,
  PaletteReferenceStatuses,
  rankTasks,
  searchableTasks,
  TASK_GROUP_CLASS,
  TaskColumnsHeading,
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
import { altGrProblem, BINDABLE_COMMANDS, chordFromEvent, chordProblem, formatChord, isApplePlatform, shortcutsBlocked } from '@/lib/keybindings'
import { commandShortcutHint, isEditableTarget, useCommandShortcut } from '@/lib/use-command-shortcut'
import { useKeybindings } from '@/lib/use-keybindings'
import {
  countTaskCommand,
  searchModes,
  trackPaletteDismissed,
  trackPaletteModes,
  trackPaletteOpened,
  trackTaskSwitched,
  type PaletteMode as SearchMode,
} from '@/lib/telemetry'
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
  /** The commands against the workspace AS IT IS NOW — what runs on Enter or a shortcut. The host
   *  is memoized, so `commands` is as of its last render; tabs and layouts may have moved since. */
  build: () => TaskCommand[]
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
  // Assigning a shortcut (⇧↵ on a row): the next chord pressed is bound to this command.
  const [recording, setRecording] = React.useState<{ id: string; label: string; problem?: string } | null>(null)
  const subjectApi = React.useRef<SubjectApi | null>(null)
  const body = React.useRef<HTMLDivElement>(null)
  const performed = React.useRef(false)
  // A command that opens a dialog keeps its subject after the palette closes, so the dialog's
  // host — and the mutation behind it — stays mounted.
  const keepSubject = React.useRef(false)
  const reopenFor = React.useRef<string | null>(null)
  const keybindings = useKeybindings()

  const close = React.useCallback(() => setOpen(false), [])
  usePaletteExclusion('task', open, close)

  // Telemetry for one palette session (spec 2026-10-17-task-palette): the search modes it used,
  // and whether ⌘P was cycled — sent when it closes. Shapes only, never the text.
  const sessionModes = React.useRef(new Set<SearchMode>())
  const cycled = React.useRef(false)
  const openRef = React.useRef(open)
  openRef.current = open

  const show = React.useCallback((subject: string | null, initialSearch: string, { reopen = false } = {}) => {
    // An opening — not a re-scope of an open palette (Tab, Backspace), and not the palette coming
    // back on its own (after a cross-project Tab's navigation, for the rename shortcut).
    if (!openRef.current && !reopen) trackPaletteOpened(subject ? 'task' : 'task_switch')
    cycled.current = false
    setSubjectId(subject)
    setSearch(initialSearch)
    setSelected('')
    setRenaming(false)
    setRecording(null)
    setCycleTo(null)
    performed.current = false
    keepSubject.current = false
    setOpen(true)
  }, [])

  const taskRows = () =>
    [...(body.current?.querySelectorAll<HTMLElement>(`[cmdk-item][data-slot="${TASK_ROW}"]`) ?? [])]

  useCommandShortcut(
    'p',
    () => {
      if (recording) return
      if (!open) {
        if (pageTaskId) show(pageTaskId, '')
        else show(null, '@')
        return
      }
      // Leaves a rename unsaved — else Enter on the switcher would rename the task to "@".
      setRenaming(false)
      // Repeated ⌘P walks the switcher: the first repeat lands on the previous task.
      if ((renaming || !search.startsWith('@')) && subjectId) {
        setSearch('@')
        cycled.current = true
        setCycleTo({ step: 1 })
        return
      }
      const rows = taskRows()
      const at = rows.findIndex((row) => row.dataset.value === selected)
      cycled.current = true
      setCycleTo({ step: at + 1 >= rows.length ? 0 : at + 1 })
    },
    { inEditable: true },
  )

  React.useEffect(() => {
    if (!cycleTo) return
    // A tick late: a changed search makes cmdk re-select its first row once it has re-filtered.
    const timer = setTimeout(() => {
      const rows = taskRows()
      const row = rows[Math.min(cycleTo.step, rows.length - 1)]
      if (row?.dataset.value) setSelected(row.dataset.value)
      setCycleTo(null)
    }, 0)
    return () => clearTimeout(timer)
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

  // Leaving the page retires a closed palette's subject, so a task no longer on screen stops
  // being polled for its git status. An open dialog (Stop, Delete, Commit) is modal, so nothing
  // navigates while one is up.
  React.useEffect(() => {
    if (!open) setSubjectId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])
  // Closing hands the host back to the task on screen, whose commands the shortcuts run.
  React.useEffect(() => {
    if (!open && !keepSubject.current) setSubjectId(null)
  }, [open])
  // After the two above: a cross-project Tab closes and navigates in one commit, and this
  // re-open has to land last.
  React.useEffect(() => {
    if (reopenFor.current && reopenFor.current === pageTaskId) {
      reopenFor.current = null
      show(pageTaskId, '', { reopen: true })
    }
  }, [pageTaskId, show])
  // A dialog command's subject is kept only while its dialog (and the mutation behind it) is up.
  const dialogDone = React.useCallback(() => {
    if (!keepSubject.current) return
    keepSubject.current = false
    if (!dispatch.current.open) setSubjectId(null)
  }, [])

  const perform = (id: string, beside = false) => {
    const command = subjectApi.current?.build().find((candidate) => candidate.id === id)
    if (!command || command.unavailable) return
    countTaskCommand(command.id, 'palette')
    // Rename edits in place: the palette's input becomes the title field.
    if (command.id === 'rename') {
      command.perform()
      return
    }
    performed.current = true
    keepSubject.current = keepsSubject(command.id)
    setOpen(false)
    const run = beside && command.performBeside ? command.performBeside : command.perform
    // Clipboard writes and new tabs need the key press's user gesture, which a timer loses (WebKit).
    if (needsGesture(command.id)) return run()
    // After the dialog lets go, so a command that focuses something (the composer) or opens a
    // dialog of its own (Stop, Delete, Commit) is not fighting the palette's focus trap.
    setTimeout(run, 0)
  }

  // Stable, so typing does not re-render every memoized task row.
  const pickTask = React.useCallback(
    (task: PaletteTask) => {
      performed.current = true
      trackTaskSwitched(cycled.current ? 'cycle' : 'enter')
      setOpen(false)
      navigate(paletteTaskPath(task))
    },
    [navigate],
  )

  const beginRename = React.useCallback(() => {
    const run = subjectApi.current?.run
    if (!run) return
    setRenaming(true)
    setSearch(runTitle(run))
    // Selected, so typing replaces the old name and an arrow key edits it.
    setTimeout(() => body.current?.querySelector<HTMLInputElement>('[cmdk-input]')?.select(), 0)
  }, [])

  const commitRename = () => {
    const next = search.trim()
    if (next && subjectApi.current) subjectApi.current.rename(next)
    performed.current = true
    setOpen(false)
  }

  const startRecording = (id: string) => {
    if (!keybindings.ready) return
    setRecording({ id, label: bindableLabel(id, subjectApi.current?.commands) })
  }

  // The shortcuts themselves: a bound chord runs its command on the task on screen, palette shut.
  const dispatch = React.useRef({ open, recording, pageTaskId, byChord: new Map<string, string>(), show, beginRename })
  dispatch.current = {
    open,
    recording,
    pageTaskId,
    byChord: new Map([...keybindings.bindings].map(([id, chord]) => [chord, id])),
    show,
    beginRename,
  }
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented) return
      const now = dispatch.current
      if (now.open || now.recording || !now.pageTaskId) return
      const chord = chordFromEvent(event)
      const id = chord ? now.byChord.get(chord) : undefined
      if (!chord || !id || !chordFiresAt(event.target, chord)) return
      if (shortcutsBlocked()) return
      const api = subjectApi.current
      if (!api || api.run.id !== now.pageTaskId) return
      const command = api.build().find((candidate) => candidate.id === id)
      // Not on offer right now (a git step that is not the next one): the chord stays the browser's.
      if (!command) return
      event.preventDefault()
      if (command.unavailable) return void toast(command.unavailable)
      countTaskCommand(command.id, 'shortcut')
      if (command.id === 'rename') {
        now.show(now.pageTaskId, '', { reopen: true })
        setTimeout(now.beginRename, 0)
        return
      }
      command.perform('shortcut')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (recording) {
      // Every key belongs to the recorder — including ⌘K/⌘P, which must not reach their palettes.
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') return setRecording(null)
      const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      if (bare && (event.key === 'Backspace' || event.key === 'Delete')) {
        keybindings.assign(recording.id, null)
        toast(`Removed the shortcut for ${recording.label}`)
        return setRecording(null)
      }
      const chord = chordFromEvent(event.nativeEvent)
      if (!chord) {
        const altGr = altGrProblem(event.nativeEvent)
        if (altGr) setRecording({ ...recording, problem: altGr })
        return
      }
      const problem = chordProblem(chord)
      if (problem) return setRecording({ ...recording, problem: `${formatChord(chord)} — ${problem}` })
      const previous = [...keybindings.bindings].find(([id, held]) => held === chord && id !== recording.id)?.[0]
      keybindings.assign(recording.id, chord)
      toast(
        `${formatChord(chord)} → ${recording.label}${previous ? ` (was ${bindableLabel(previous, subjectApi.current?.commands)})` : ''}`,
      )
      return setRecording(null)
    }
    // An IME's Enter/Tab confirms the composition, not the row.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
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
      trackTaskSwitched('tab')
      actOn({ runId, projectId: row?.dataset.projectId ?? null })
      return
    }
    if (event.key === 'Enter' && event.altKey && row?.dataset.commandId) {
      event.preventDefault()
      perform(row.dataset.commandId, true)
      return
    }
    if (event.key === 'Enter' && event.shiftKey && row?.dataset.commandId && recordable(row.dataset.commandId)) {
      event.preventDefault()
      startRecording(row.dataset.commandId)
      return
    }
    // Backspace on an empty input walks back from a picked task to the switcher.
    if (event.key === 'Backspace' && search === '' && subjectId !== null && subjectId !== pageTaskId) {
      event.preventDefault()
      show(pageTaskId ?? null, '@')
    }
  }

  const { mode, query } = renaming ? { mode: 'all' as const, query: '' } : paletteMode(search, subjectId !== null)
  React.useEffect(() => {
    if (!open || renaming || recording) return
    for (const used of searchModes(query, mode === 'all' ? undefined : mode)) sessionModes.current.add(used)
  }, [open, renaming, recording, query, mode])
  React.useEffect(() => {
    if (open || sessionModes.current.size === 0) return
    trackPaletteModes(sessionModes.current)
    sessionModes.current = new Set()
  }, [open])

  return (
    <>
      {(subjectId ?? pageTaskId) ? (
        <SubjectHost
          key={subjectId ?? pageTaskId}
          runId={(subjectId ?? pageTaskId)!}
          apiRef={subjectApi}
          onCommands={setPublished}
          onRename={beginRename}
          onDialogDone={dialogDone}
          open={open}
        />
      ) : null}
      <CommandDialog
        open={open}
        onOpenChange={(next) => {
          // Radix closes only on Escape or a click outside — every command closes it itself.
          if (!next) trackPaletteDismissed(mode === 'tasks' ? 'tasks' : mode === 'files' ? 'files' : 'actions')
          setOpen(next)
        }}
        title="Task palette"
        description="Act on a task, switch tasks, or open one of its files"
        showCloseButton={false}
        filter={prefixedScore}
        commandProps={{
          value: selected,
          onValueChange: setSelected,
          onKeyDown,
          shouldFilter: !renaming && !recording && mode !== 'files',
        }}
        onOpenAutoFocus={(event) => {
          // Radix selects the input's text on focus; a pre-filled `@` must stay, caret after it.
          const input = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLInputElement>('[cmdk-input]')
          if (!input) return
          event.preventDefault()
          input.focus()
          input.setSelectionRange(input.value.length, input.value.length)
        }}
        onCloseAutoFocus={(event) => {
          // A command chose where focus goes next; do not hand it back to the old element.
          if (performed.current) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (recording) {
            event.preventDefault()
            return setRecording(null)
          }
          if (!renaming) return
          event.preventDefault()
          setRenaming(false)
          setSearch('')
        }}
        // ⌘K's geometry, so the two palettes feel like one surface.
        className="top-[10vh] translate-y-0 sm:max-w-2xl lg:max-w-3xl xl:max-w-4xl"
      >
        <div ref={body} data-slot="task-palette" data-mode={recording ? 'record' : renaming ? 'rename' : mode} className="contents">
          <CommandInput
            placeholder={recording ? 'Press a shortcut — ⌫ removes it, esc cancels' : placeholder(renaming ? 'rename' : mode)}
            value={search}
            onValueChange={setSearch}
          />
          {subjectId && !renaming && mode !== 'tasks' ? <SubjectBar runId={subjectId} picked={subjectId !== pageTaskId} /> : null}
          <CommandList className="max-h-[55vh] min-h-[14rem] sm:max-h-[60vh] lg:max-h-[68vh]">
            {recording ? (
              <CommandGroup heading={`Shortcut for ${recording.label}`}>
                <CommandItem value="record" data-slot="task-palette-recorder" onSelect={() => {}}>
                  <KeyboardIcon aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    {recording.problem ?? 'Press the keys for this command…'}
                  </span>
                  {keybindings.bindings.get(recording.id) ? (
                    <CommandShortcut>{formatChord(keybindings.bindings.get(recording.id)!)}</CommandShortcut>
                  ) : null}
                </CommandItem>
              </CommandGroup>
            ) : renaming ? (
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
                    bindings={keybindings.bindings}
                    onPerform={perform}
                    onRecord={startRecording}
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
                    query={query}
                    onPick={pickTask}
                  />
                ) : null}
              </>
            )}
          </CommandList>
          <PaletteFooter mode={recording ? 'record' : renaming ? 'rename' : mode} />
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

function CommandGroups({
  commands,
  bindings,
  onPerform,
  onRecord,
}: {
  commands: TaskCommand[]
  bindings: ReadonlyMap<string, string>
  onPerform: (id: string) => void
  onRecord: (id: string) => void
}) {
  return (
    <>
      {TASK_COMMAND_GROUPS.map((group) => {
        const members = commands.filter((command) => command.group === group.id && !command.hidden)
        if (members.length === 0) return null
        return (
          <CommandGroup key={group.id} heading={group.heading}>
            {members.map((command) => {
              const chord = shortcutFor(command, bindings)
              return (
                <CommandItem
                  key={command.id}
                  // The id keeps values unique (two layouts may share a label); the heading lets
                  // "git push" or "copy branch" find the row by its group.
                  value={`${group.heading} ${command.label} ${command.id}`}
                  keywords={command.keywords}
                  disabled={command.unavailable !== undefined}
                  data-slot="task-palette-command"
                  data-command-id={command.id}
                  aria-checked={command.pressed}
                  onSelect={() => onPerform(command.id)}
                  className={cn('group/command', command.danger && 'data-[selected=true]:text-danger')}
                >
                  {command.icon}
                  <span className="min-w-0 flex-1 truncate">{command.label}</span>
                  {command.unavailable ? (
                    <span className="shrink-0 truncate text-xs text-soft-foreground">{command.unavailable}</span>
                  ) : command.pressed ? (
                    <span className="shrink-0 text-xs text-primary">on</span>
                  ) : null}
                  {/* The mouse twin of ⇧↵ — only commands that can be bound by id. */}
                  {!recordable(command.id) ? null : (
                    <button
                      type="button"
                      data-slot="task-palette-record"
                      aria-label={`Set a shortcut for ${command.label}`}
                      title="Set a shortcut (⇧↵)"
                      className="hidden shrink-0 rounded p-0.5 text-soft-foreground group-hover/command:inline-flex hover:text-foreground"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation()
                        onRecord(command.id)
                      }}
                    >
                      <KeyboardIcon aria-hidden="true" className="size-3.5!" />
                    </button>
                  )}
                  {chord ? <CommandShortcut>{chord}</CommandShortcut> : null}
                </CommandItem>
              )
            })}
          </CommandGroup>
        )
      })}
    </>
  )
}

/** The hint a row prints: its own binding, else the positional ⌘N of the tab it is, else the
 *  workspace's bare key. */
function shortcutFor(command: TaskCommand, bindings: ReadonlyMap<string, string>): string | undefined {
  const own = bindings.get(command.id)
  if (own) return formatChord(own)
  const positional = command.shortcut && /^[1-9]$/.test(command.shortcut) ? bindings.get(`tab:${command.shortcut}`) : undefined
  if (positional) return formatChord(positional)
  return command.shortcut
}

/** Commands whose host the palette keeps mounted after it closes: the ones that open a dialog,
 *  and every git step — the agent's turn it starts must be seen to end (busy state, adoption of an
 *  opened PR), and with no agent to ask Commit opens its dialog. */
const DIALOG_COMMANDS = new Set(['stop', 'delete'])
export const keepsSubject = (id: string) => DIALOG_COMMANDS.has(id) || id.startsWith('git:')

/** Commands that must run inside the key press or click that chose them. */
const needsGesture = (id: string) => id.startsWith('copy:') || id === 'open-pr'

/** Whether ⇧↵ can bind a command: saved layouts are not bound by id. */
const recordable = (id: string) => !id.startsWith('layout:')

/** A command's name for messages — the live row's label when it is listed, else the catalog's. */
function bindableLabel(id: string, commands: readonly TaskCommand[] = []): string {
  return (
    BINDABLE_COMMANDS.find((entry) => entry.id === id)?.label ??
    commands.find((command) => command.id === id)?.label ??
    id
  )
}

/** Where a bound chord may fire. In a text field only ⌘/Ctrl chords do — ⌥ and ⌃ type there; in
 *  the terminal only ⌘ on a Mac, since every Ctrl/Alt chord belongs to the shell. */
function chordFiresAt(target: EventTarget | null, chord: string): boolean {
  const usesMod = chord.split('+').includes('Mod')
  if (target instanceof HTMLElement && target.closest('.xterm')) return usesMod && isApplePlatform()
  if (isEditableTarget(target) && !(target instanceof HTMLElement && target.closest('[cmdk-input]'))) return usesMod
  return true
}

function TaskResults({
  recentOnly,
  exclude,
  current,
  query,
  onPick,
}: {
  recentOnly: boolean
  exclude: string | null
  current: string | undefined
  /** The search without its prefix — ranked here so only the rows that show are mounted. */
  query: string
  onPick: (task: PaletteTask) => void
}) {
  const { tasks, multiProject, projectNames, repoBases } = usePaletteTasks()
  const recent = readRecentTasks()
  // Built once per task list; a keystroke only ranks and slices (`rankTasks`).
  const entries = React.useMemo(() => {
    const byRecency = orderByRecency(tasks, (task) => task.id, recent)
    const seen = new Set(recent)
    const listed = recentOnly
      ? byRecency.filter((task) => seen.has(task.id) && task.id !== exclude).slice(0, RECENT_IN_DEFAULT_VIEW)
      : byRecency
    return searchableTasks(listed, projectNames, repoBases)
  }, [tasks, recent, recentOnly, exclude, projectNames, repoBases])
  const { shown, total } = React.useMemo(() => rankTasks(entries, query), [entries, query])
  const [now] = React.useState(Date.now)
  if (shown.length === 0) return null
  return (
    <PaletteReferenceStatuses entries={shown}>
    <CommandGroup heading={<TaskColumnsHeading label={recentOnly ? 'Recent tasks' : 'Tasks'} />} className={TASK_GROUP_CLASS}>
      {shown.map((entry) => (
        <TaskItem
          key={entry.key}
          entry={entry}
          slot={TASK_ROW}
          showProject={multiProject}
          now={now}
          onSelect={onPick}
          current={entry.task.id === current}
        />
      ))}
      <MoreTasks hidden={total - shown.length} />
    </CommandGroup>
    </PaletteReferenceStatuses>
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

function PaletteFooter({ mode }: { mode: PaletteMode | 'rename' | 'record' }) {
  const hints =
    mode === 'record'
      ? ['⌫ remove', 'esc cancel']
      : mode === 'rename'
      ? ['↵ save', 'esc cancel']
      : mode === 'tasks'
        ? ['↵ open', 'tab act on it', `${commandShortcutHint('p')} next`]
        : mode === 'files'
          ? ['↵ open in Code']
          : ['↵ run', '⌥↵ open beside', '⇧↵ set shortcut', '@ tasks', '> commands', '# files']
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
const SubjectHost = React.memo(function SubjectHost(props: {
  runId: string
  /** Changes only on open/close — re-reads the workspace for the listed commands then, and not
   *  on every keystroke. */
  open: boolean
  apiRef: React.RefObject<SubjectApi | null>
  onCommands: (published: { runId: string; commands: TaskCommand[] }) => void
  onRename: () => void
  /** A dialog this host opened has closed, and nothing it started is still in flight. */
  onDialogDone: () => void
}) {
  const run = useRun(props.runId).data
  if (!run) return null
  return <SubjectReferences run={run} {...props} />
})

function SubjectReferences(props: {
  run: ApiRun
  apiRef: React.RefObject<SubjectApi | null>
  onCommands: (published: { runId: string; commands: TaskCommand[] }) => void
  onRename: () => void
  /** A dialog this host opened has closed, and nothing it started is still in flight. */
  onDialogDone: () => void
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
  onDialogDone,
}: {
  run: ApiRun
  apiRef: React.RefObject<SubjectApi | null>
  onCommands: (published: { runId: string; commands: TaskCommand[] }) => void
  onRename: () => void
  /** A dialog this host opened has closed, and nothing it started is still in flight. */
  onDialogDone: () => void
}) {
  const workspace = taskWorkspaceFor(run.id)
  const onScreen = taskIdFromPath(useLocation().pathname) === run.id
  const actions = useRunActions(run, { surface: 'palette', onMarkedUnread: workspace?.markedUnread, onScreen })
  const git = useRunGitStep(run)
  const canTerminal = useCanOpenTerminal(run)
  const openIn = useRunOpenChoices(run, canTerminal)
  const terminalAvailable = useHealth().data?.capabilities?.terminal === true
  const patch = usePatchRun(run.id)
  const navigate = useNavigate()
  const liveProjectId = useLiveProjectId()
  const owned = ownedTaskPr(run)

  const build = () =>
    buildTaskCommands(
    {
      run,
      canResume: openIn.canResumeHere,
      git: git.action,
      gitPending: git.pending,
      workspace: taskWorkspaceFor(run.id),
      terminalAvailable,
      openChoices: openIn.choices,
      prUrl: owned?.url,
      taskUrl: `${window.location.origin}${liveProjectId ? (scopeTo(liveProjectId, `/tasks/${run.id}`) as string) : `/tasks/${run.id}`}`,
    },
    {
      markRead: () => actions.markRead.mutate(),
      markUnread: () => actions.markUnread.mutate(),
      // A shortcut reports itself as the `shortcut` surface; a palette row as `palette` (the hook's).
      pin: (source) => actions.pin.mutate(source === 'shortcut' ? 'shortcut' : undefined),
      archive: (source) => actions.archive.mutate(source === 'shortcut' ? 'shortcut' : undefined),
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
  const commands = build()
  apiRef.current = {
    run,
    commands,
    build,
    rename: (title) =>
      patch.mutate({ title }, { onError: (error) => toast(error.message, { tone: 'danger' }) }),
  }

  const signature = commands
    .map((command) => `${command.id}|${command.label}|${command.unavailable ?? ''}|${command.pressed ? 1 : 0}|${command.shortcut ?? ''}`)
    .join('\n')
  const latest = React.useRef(commands)
  latest.current = commands
  React.useEffect(() => onCommands({ runId: run.id, commands: latest.current }), [signature, onCommands, run.id])

  const busy =
    actions.confirming !== null ||
    git.commitOpen ||
    git.pending !== null ||
    actions.delete.isPending ||
    actions.cancel.isPending
  const wasBusy = React.useRef(busy)
  React.useEffect(() => {
    if (wasBusy.current && !busy) onDialogDone()
    wasBusy.current = busy
  }, [busy, onDialogDone])

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
