import {
  ArchiveIcon,
  CheckIcon,
  CircleStopIcon,
  ColumnsIcon,
  CopyIcon,
  ExternalLinkIcon,
  LayoutGridIcon,
  LinkIcon,
  MailIcon,
  Maximize2Icon,
  NotebookTextIcon,
  PanelBottomIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SquareTerminalIcon,
  TerminalIcon,
  TextCursorInputIcon,
  Trash2Icon,
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { openInIcon, type OpenInChoice } from '@/components/open-in-menu'
import type { GitAction, GitActionId } from '@/lib/git-actions'
import type { TaskWorkspaceBridge } from '@/lib/task-workspace-bridge'
import { isRunActive, resumeHint, runActionFlags } from '@/routes/task-thread/run-actions'
import { GIT_ACTION_ICONS } from '@/routes/task-git/git-toolbar'
import { FIXED_VIEW_ORDER, VIEW_PATHS, viewLabel, type ViewId } from '@/routes/task-workspace/layout-state'
import { stripEntries, type StripEntry } from '@/routes/task-workspace/strip'
import { VIEW_ICONS } from '@/routes/task-workspace/view-picker'

/**
 * Everything ⌘P can do to one task (spec 2026-10-17-task-palette), as a pure function of the run
 * and its surroundings. Availability comes from `runActionFlags` and `gitActionPolicy` — the
 * header's own rules — so the palette never offers what the header would hide, and an action the
 * header greys out is listed here greyed out with the same reason.
 */

export type TaskCommandGroup = 'actions' | 'git' | 'views' | 'layout' | 'open' | 'copy'

export const TASK_COMMAND_GROUPS: readonly { id: TaskCommandGroup; heading: string }[] = [
  { id: 'actions', heading: 'Actions' },
  { id: 'git', heading: 'Git' },
  { id: 'views', heading: 'Go to view' },
  { id: 'layout', heading: 'Layout' },
  { id: 'open', heading: 'Open in' },
  { id: 'copy', heading: 'Copy' },
]

export interface TaskCommand {
  id: string
  group: TaskCommandGroup
  label: string
  icon: ReactNode
  /** Extra words the filter matches on, never rendered. */
  keywords?: string[]
  /** The key that does the same thing outside the palette — a hint, never bound here. */
  shortcut?: string
  /** Why it cannot run right now; the row stays, greyed out, with this as its hint. */
  unavailable?: string
  danger?: boolean
  /** A toggle that is ON (pinned, unread, archived, full view). */
  pressed?: boolean
  /** Runs from a shortcut but is not listed — the positional `tab:N` commands. */
  hidden?: boolean
  /** `source` says where it was run from — pin and archive report it to telemetry. */
  perform: (source?: CommandSource) => void
  /** Alt+Enter: the same target opened beside what is on screen. */
  performBeside?: () => void
}

/** Where a command was run from: a palette row, or its keyboard shortcut. */
export type CommandSource = 'palette' | 'shortcut'

export interface TaskCommandHandlers {
  markRead: () => void
  markUnread: () => void
  pin: (source?: CommandSource) => void
  archive: (source?: CommandSource) => void
  rename: () => void
  finish: () => void
  confirmStop: () => void
  confirmDelete: () => void
  resumeInTerminal: () => void
  gitAction: (id: GitActionId) => void
  openIn: (targetId: string) => void
  navigate: (to: string) => void
  openUrl: (url: string) => void
  copy: (text: string, what: string) => void
}

export interface TaskCommandInput {
  run: ApiRun
  /** The header's resume gate (`useCanOpenTerminal`) narrowed by provider availability. */
  canResume: boolean
  git: GitAction | null
  /** Present only when `run` is the task on screen. */
  workspace: TaskWorkspaceBridge | null
  terminalAvailable: boolean
  openChoices: readonly OpenInChoice[]
  /** The task's own PR, when it has one. */
  prUrl?: string
  /** An absolute link to this task, for Copy link. */
  taskUrl: string
}

const icon = (Icon: typeof PinIcon) => <Icon aria-hidden="true" />

export function buildTaskCommands(input: TaskCommandInput, on: TaskCommandHandlers): TaskCommand[] {
  const commands = [
    ...actionCommands(input, on),
    ...gitCommands(input, on),
    ...viewCommands(input, on),
    ...layoutCommands(input),
    ...openCommands(input, on),
    ...copyCommands(input, on),
  ]
  const strip = stripEntries(stripViews(input.run, input.workspace))
  return [...commands, ...tabCommands(strip, commands)]
}

function actionCommands({ run, workspace }: TaskCommandInput, on: TaskCommandHandlers): TaskCommand[] {
  const flags = runActionFlags(run)
  const live = isRunActive(run.status) ? 'Stop the task first' : undefined
  const gated = run.worktreeLifecycle?.activeOperationId ? 'Resolve the worktree operation first' : undefined
  const commands: TaskCommand[] = []
  if (workspace?.focusComposer) {
    commands.push({
      id: 'reply',
      group: 'actions',
      label: 'Write to the agent',
      icon: icon(TextCursorInputIcon),
      keywords: ['composer', 'reply', 'message', 'focus'],
      shortcut: '/',
      perform: workspace.focusComposer,
    })
  }
  if (flags.markRead || flags.markUnread) {
    commands.push({
      id: 'toggle-read',
      group: 'actions',
      label: flags.markRead ? 'Mark read' : 'Mark unread',
      icon: icon(MailIcon),
      keywords: ['unread', 'read', 'seen'],
      pressed: flags.markRead,
      perform: flags.markRead ? on.markRead : on.markUnread,
    })
  }
  commands.push(
    {
      id: 'pin',
      group: 'actions',
      label: run.pinned ? 'Unpin' : 'Pin',
      icon: icon(PinIcon),
      pressed: Boolean(run.pinned),
      ...(flags.pin ? {} : { unavailable: 'Archived tasks can’t be pinned' }),
      perform: on.pin,
    },
    {
      id: 'archive',
      group: 'actions',
      label: run.archived ? 'Unarchive' : 'Archive',
      icon: icon(ArchiveIcon),
      pressed: Boolean(run.archived),
      ...(live ? { unavailable: live } : {}),
      perform: on.archive,
    },
    {
      id: 'rename',
      group: 'actions',
      label: 'Rename…',
      icon: icon(PencilIcon),
      keywords: ['title'],
      perform: on.rename,
    },
  )
  if (flags.finish && run.status === 'waiting') {
    commands.push({
      id: 'end-session',
      group: 'actions',
      label: 'End session',
      icon: icon(CheckIcon),
      keywords: ['finish', 'close', 'done'],
      perform: on.finish,
    })
  }
  if (flags.finish && run.status === 'review') {
    commands.push({
      id: 'accept',
      group: 'actions',
      label: 'Accept changes without a PR',
      icon: icon(CheckIcon),
      keywords: ['finish', 'review', 'done'],
      perform: on.finish,
    })
  }
  if (flags.cancel) {
    commands.push({
      id: 'stop',
      group: 'actions',
      label: 'Stop…',
      icon: icon(CircleStopIcon),
      keywords: ['cancel', 'kill'],
      danger: true,
      perform: on.confirmStop,
    })
  }
  commands.push({
    id: 'delete',
    group: 'actions',
    label: 'Delete…',
    icon: icon(Trash2Icon),
    keywords: ['remove', 'worktree', 'branch'],
    danger: true,
    ...(live || gated ? { unavailable: live ?? gated } : {}),
    perform: on.confirmDelete,
  })
  return commands
}

function gitCommands({ git, prUrl }: TaskCommandInput, on: TaskCommandHandlers): TaskCommand[] {
  const commands: TaskCommand[] = git
    ? [git, ...(git.alternatives ?? [])].map((step) => ({
        id: `git:${step.id}`,
        group: 'git' as const,
        label: step.label,
        icon: GIT_ACTION_ICONS[step.id],
        keywords: ['git'],
        ...(step.enabled ? {} : { unavailable: step.reason ?? 'Not available right now' }),
        perform: () => on.gitAction(step.id),
      }))
    : []
  if (prUrl && /^https?:\/\//.test(prUrl)) {
    commands.push({
      id: 'open-pr',
      group: 'git',
      label: 'Open pull request',
      icon: icon(ExternalLinkIcon),
      keywords: ['pr', 'github'],
      perform: () => on.openUrl(prUrl),
    })
  }
  return commands
}

/** On screen, views switch the workspace's columns; for another task they navigate to its route. */
function viewCommands({ run, workspace, terminalAvailable }: TaskCommandInput, on: TaskCommandHandlers): TaskCommand[] {
  const base = `/tasks/${run.id}`
  const views = stripViews(run, workspace)
  const commands: TaskCommand[] = views.map((view, index) => {
    const Icon = VIEW_ICONS[view]
    return {
      id: `view:${view}`,
      group: 'views',
      label: viewLabel(view),
      icon: <Icon aria-hidden="true" />,
      keywords: ['view', 'go', 'tab', view],
      ...(workspace && index < 9 ? { shortcut: String(index + 1) } : {}),
      pressed: workspace?.activeView === view,
      perform: workspace ? () => workspace.openView(view) : () => on.navigate(`${base}/${VIEW_PATHS[view]}`),
      ...(workspace ? { performBeside: () => workspace.openViewBeside(view) } : {}),
    }
  })
  if (terminalAvailable && !workspace) {
    commands.push({
      id: 'view:terminal',
      group: 'views',
      label: viewLabel('terminal'),
      icon: icon(TerminalIcon),
      keywords: ['view', 'shell'],
      perform: () => on.navigate(`${base}/${VIEW_PATHS.terminal}`),
    })
  }
  commands.push({
    id: 'view:notes',
    group: 'views',
    label: 'Notes',
    icon: icon(NotebookTextIcon),
    keywords: ['view', 'handoff'],
    ...(workspace && views.length < 9 ? { shortcut: String(views.length + 1) } : {}),
    perform: () => on.navigate(`${base}/notes`),
  })
  return commands
}

/** The views on a task's tab row: the workspace's, or — off it (Notes) — the same fixed set. */
function stripViews(run: ApiRun, workspace: TaskWorkspaceBridge | null): readonly ViewId[] {
  return workspace?.views ?? FIXED_VIEW_ORDER.filter((view) => view !== 'graph' || Boolean(run.workflowDef))
}

/** `tab:N` — the tab row's Nth numbered tab (`stripEntries`: views, then Notes), like a browser's
 *  ⌘N. Positional, so they are shortcut targets rather than palette rows; each runs the command of
 *  the tab it lands on — on any page of the task, Notes included. */
function tabCommands(entries: readonly StripEntry[], commands: readonly TaskCommand[]): TaskCommand[] {
  return entries.slice(0, 9).flatMap((entry, index) => {
    const target = commands.find((command) => command.id === entry.id)
    if (!target) return []
    return [
      {
        id: `tab:${index + 1}`,
        group: 'views' as const,
        label: `Tab ${index + 1}: ${entry.label}`,
        icon: icon(LayoutGridIcon),
        hidden: true,
        perform: target.perform,
      },
    ]
  })
}

function layoutCommands({ workspace }: TaskCommandInput): TaskCommand[] {
  if (!workspace) return []
  const commands: TaskCommand[] = workspace.layouts.map((layout) => {
    // Layouts are not numbered (`strip.ts`): no key hint, no ⌘N.
    return {
      id: `layout:${layout.name}`,
      group: 'layout',
      label: layout.label,
      icon: icon(LayoutGridIcon),
      keywords: ['layout', 'switch'],
      pressed: layout.active,
      perform: () => workspace.selectLayout(layout.name),
    }
  })
  commands.push(
    {
      id: 'layout:new',
      group: 'layout',
      label: 'New layout',
      icon: icon(PlusIcon),
      keywords: ['layout', 'create'],
      perform: workspace.newLayout,
    },
    {
      id: 'full-view',
      group: 'layout',
      label: workspace.maximized ? 'Exit full view' : 'Full view',
      icon: icon(Maximize2Icon),
      keywords: ['maximize', 'zen', 'focus'],
      shortcut: 'F',
      pressed: workspace.maximized,
      perform: workspace.toggleMaximized,
    },
  )
  if (workspace.splitView) {
    commands.push({
      id: 'split',
      group: 'layout',
      label: 'Split view',
      icon: icon(ColumnsIcon),
      keywords: ['column', 'side'],
      shortcut: '\\',
      perform: workspace.splitView,
    })
  }
  const terminal = workspace.terminal
  if (terminal.allowed) {
    commands.push({
      id: 'terminal',
      group: 'layout',
      label: terminal.open ? 'Hide terminal' : 'Show terminal',
      icon: icon(PanelBottomIcon),
      keywords: ['shell', 'drawer'],
      shortcut: '`',
      pressed: terminal.open || terminal.inColumn,
      ...(terminal.inColumn ? { unavailable: 'The terminal is open in a column of this layout' } : {}),
      perform: terminal.toggle,
    })
    if (!terminal.inColumn) {
      commands.push({
        id: 'terminal-column',
        group: 'layout',
        label: 'Terminal in a column',
        icon: icon(TerminalIcon),
        keywords: ['shell', 'split'],
        perform: terminal.openInColumn,
      })
    }
  }
  return commands
}

function openCommands({ canResume, openChoices }: TaskCommandInput, on: TaskCommandHandlers): TaskCommand[] {
  const commands: TaskCommand[] = []
  if (canResume) {
    commands.push({
      id: 'open:terminal-resume',
      group: 'open',
      label: 'Terminal (resume session)',
      icon: icon(SquareTerminalIcon),
      keywords: ['open', 'cli', 'resume'],
      perform: on.resumeInTerminal,
    })
  }
  for (const choice of openChoices) {
    const Icon = openInIcon(choice.target)
    commands.push({
      id: `open:${choice.target.id}`,
      group: 'open',
      label: `${choice.target.label}${choice.suffix ?? ''}`,
      icon: <Icon aria-hidden="true" />,
      keywords: ['open', 'in'],
      perform: () => on.openIn(choice.target.id),
    })
  }
  return commands
}

function copyCommands({ run, prUrl, taskUrl }: TaskCommandInput, on: TaskCommandHandlers): TaskCommand[] {
  const copy = (id: string, label: string, text: string | undefined | null, what: string, glyph = CopyIcon): TaskCommand[] =>
    text
      ? [{ id: `copy:${id}`, group: 'copy', label, icon: icon(glyph), keywords: ['copy'], perform: () => on.copy(text, what) }]
      : []
  return [
    ...copy('link', 'Copy task link', taskUrl, 'Task link', LinkIcon),
    ...copy('branch', 'Copy branch name', run.branch, 'Branch name'),
    ...copy('path', 'Copy worktree path', run.worktreePath, 'Worktree path'),
    ...copy('resume', 'Copy resume command', resumeHint(run), 'Resume command'),
    ...copy('pr', 'Copy pull request link', prUrl, 'Pull request link', LinkIcon),
    ...copy('id', 'Copy task id', run.id, 'Task id'),
  ]
}
