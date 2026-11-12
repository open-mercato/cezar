import {
  ChevronDownIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  PencilIcon,
  SquareTerminalIcon,
} from 'lucide-react'
import { ManagerBackLink } from '../manager/manager-back-link'
import { cloneElement, Fragment, isValidElement, memo, useEffect, useId, useMemo, useReducer, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link, useNavigate } from '@/lib/project-router'

import {
  useHealth,
  usePatchRun,
  useProjectRepoBase,
  useReferenceProjectId,
  useRuns,
} from '@/api/queries'
import { useRunClaudeAccount } from '@/api/agent-accounts'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { TitleEditInput, useTitleEditor, type TitleEditor } from '@/components/editable-title'
import { TOGGLE_ON_ICON_CLASS } from '@/components/pin-toggle'
import { Pill } from '@/components/pill'
import { ReferenceChip } from '@/components/reference-chip'
import { ReferenceOverflow } from '@/components/reference-overflow'
import { ResolveConflictsButton } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { TabLink } from '@/components/tab-link'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { OpenInMenu, type OpenInChoice } from '@/components/open-in-menu'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { accountPart, LiveUsage, liveUsageParts } from '@/components/live-usage'
import { useLiveUsageEnabled } from '@/lib/live-usage-pref'
import { buildTaskCommands, taskMenuGroups, type TaskCommand } from '@/components/task-palette/commands'
import { ATTENTION_RANK, budgetStop, deriveAttention, isAwaitingAnswer, isIdleClosed, runClosure, type AttentionTone } from '@/lib/attention'
import { formatChord } from '@/lib/keybindings'
import { useKeybindings } from '@/lib/use-keybindings'
import { compactTokens, formatDuration } from '@/lib/format'
import { queuePositions, runTitle } from '@/lib/task-groups'
import { taskWorkspaceFor } from '@/lib/task-workspace-bridge'
import {
  formatCost,
  ownedTaskPr,
  prNumber,
  taskIssueUrl,
  taskPrUrl,
  taskReferences,
  workflowLabel,
} from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { cn, isHttpUrl } from '@/lib/utils'
import { FIXED_VIEW_ORDER, VIEW_PATHS, viewLabel, type ViewId } from '../task-workspace/layout-state'
import { stripGroups, stripTabs } from '../task-workspace/strip'

import {
  isRunActive,
  PRIMARY_ACTION_LABELS,
  primaryRunAction,
  secondaryRunAction,
} from './run-actions'
import { GitActions } from '../task-git/git-toolbar'
import { useRunGitStep } from '../task-git/run-git-step'
import { ImpactChip } from '../task-assets/impact-chip'
import { RunConfirmDialog } from './run-confirm-dialog'
import { TaskWorktreeRemovalDialog } from './task-worktree-removal'
import { useRunEngine } from './run-engine'
import { activeStepIndex, railWanted, stepTally, WorkflowSteps } from './step-rail'
import { useDraft } from './thread-draft'
import { copyToClipboard, useCanOpenTerminal, useRunActions, useRunOpenChoices, type RunActions } from './use-run-actions'
import { writeClipboard } from '@/lib/clipboard'

/**
 * The run header (design 2026-11, Proposal 3 "one header"): two lines above the view strip.
 *
 *  1. The task — status dot, editable title, a status word for the states still open — and, at
 *     the right, ONE contextual primary action (`primaryRunAction`), its companion (Continue or
 *     Stop), Open in… and a ⋯ menu that lists the ⌘P palette's actions with their shortcuts.
 *  2. The facts — workflow · k of n done · branch · ± · PR · issue — and one usage chip whose
 *     popover holds the exact tokens, the cost and the agent that ran.
 *
 * The workflow rail stays, folded, only when it has something to add (more than one step, or a
 * step failing or in flight); the takeover command is one menu item ("Take over in terminal")
 * instead of a permanent mono line. On phones line 1 is the dot, the title and the ⋯; the status
 * word moves down to line 2 with the diff, the PR and the cost.
 *
 * Hosted mode (spec §"Deployment modes"): Terminal disappears when `capabilities.localHandoff` is
 * false (`useCanOpenTerminal`); the takeover command still carries its `cd`.
 */
/** Which run-detail tab this header instance sits above — "Review changes" steps aside while a
 *  Changes view shows. A prop rather than a route match so the header stays testable bare. */
export type RunTab = 'session' | 'changes' | 'commits' | 'files' | 'graph' | 'notes' | 'terminal' | 'preview'

interface RunHeaderProps {
  run: ApiRun
  planTally?: { done: number; total: number }
  tab?: RunTab
  /** Fired the moment "Mark unread" is invoked, BEFORE the mutation — the Session tab uses it
   *  to suppress its auto-mark-read effect for the rest of the visit (#775). Optional because
   *  the three `task-git` tabs render this same header and run no such effect. */
  onMarkedUnread?: () => void
  /** The Session tab's engine picker for the next continuation. Kept out of the three Git tabs:
   *  they share this header but do not own the continuation draft or its pending selection. */
  continuationEngine?: ReactNode
  /** Replaces the route tab links — the task workspace's layout strip (spec `2026-10-07-task-workspace` §5.2). */
  tabs?: ReactNode
  /** Icon controls in the title row, after the ⋯ menu — the workspace's full view. */
  headerActions?: ReactNode
  /** Span the whole window, like the workspace columns under it, instead of the reading measure. */
  wide?: boolean
}

// Every prop must participate: adding one without a comparator is a compile error.
const headerPropComparators = {
  run: (before, after) => before.run === after.run,
  tab: (before, after) => before.tab === after.tab,
  onMarkedUnread: (before, after) => before.onMarkedUnread === after.onMarkedUnread,
  continuationEngine: (before, after) => before.continuationEngine === after.continuationEngine,
  tabs: (before, after) => before.tabs === after.tabs,
  headerActions: (before, after) => before.headerActions === after.headerActions,
  wide: (before, after) => before.wide === after.wide,
  planTally: (before, after) => before.planTally?.done === after.planTally?.done &&
    before.planTally?.total === after.planTally?.total,
} satisfies Record<keyof RunHeaderProps, (before: RunHeaderProps, after: RunHeaderProps) => boolean>
const compareHeaderProps = Object.values(headerPropComparators)

export const RunHeader = memo(RunHeaderView, (before, after) =>
  compareHeaderProps.every((compare) => compare(before, after)),
)

function RunHeaderView({
  run,
  planTally,
  tab = 'session',
  onMarkedUnread,
  continuationEngine,
  tabs,
  headerActions,
  wide = false,
}: RunHeaderProps) {
  const attention = deriveAttention(run)
  const budget = budgetStop(run)
  const actions = useRunActions(run, { onMarkedUnread })
  // The ⋯ menu's Rename… opens the title's own editor.
  const beginRename = useRef<() => void>(() => {})

  // The queue position a parked run shows in its chip ("Queued #2"). Reads the shared runs-list
  // query — already warm from the sidebar quick-list — because position is a property of the
  // whole queue, not of this record.
  const queuePosition = useRuns(
    useMemo(
      () => (runs: ApiRun[]) =>
        run.status === 'queued' ? queuePositions(runs).get(run.id) : undefined,
      [run.id, run.status],
    ),
  ).data
  const health = useHealth()
  const metricVisibility = usageMetricVisibility(health.data)
  const refs = useRunReferences(run)
  const statusLabel = statusChipLabel(run, queuePosition)

  return (
    <ReferenceStatusProvider projectId={refs.projectId} requests={refs.requests}>
      <header
        data-slot="run-header"
        className="relative z-20 border-b border-border bg-background/95 px-3 pt-2 backdrop-blur md:sticky md:top-0 md:px-6 md:pt-3"
      >
        <div className={cn('mx-auto w-full', !wide && 'max-w-[var(--measure)]')}>
          <ManagerBackLink runId={run.id} />
          {/* `min-h-[30px]` is a `size="sm"` button's height: the row keeps it whether or not an
              action is on offer, so the header — and the work under it — never jumps. */}
          <div data-slot="run-title-row" className="flex min-h-[30px] min-w-0 items-center gap-2.5">
            <StatusDot
              tone={attention.tone}
              pulse={attention.pulse}
              role="img"
              aria-label={attention.label}
              data-slot="run-status-dot"
            />
            <span data-slot="run-identity" className="flex min-w-0 flex-1 items-center gap-2.5">
              <EditableTitle run={run} beginRename={beginRename} />
              {/* The status word, open states only (Proposal 7). On phones it leads line 2. */}
              {statusLabel ? <StatusChip label={statusLabel} className="max-md:hidden" /> : null}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <HeaderActions run={run} actions={actions} changesShowing={tab === 'changes'} onRename={() => beginRename.current()} />
              {headerActions}
            </span>
          </div>

          <MetaRow
            run={run}
            references={refs.references}
            statusLabel={statusLabel}
            planTally={planTally}
            budget={budget}
            continuationEngine={continuationEngine}
            showTokens={metricVisibility.tokens}
            showCost={metricVisibility.cost}
            // `capabilities?.` like `usageMetricVisibility` above it: this header is rendered
            // against minimal health payloads (a `{defaultRunner}`-only answer is pinned by its
            // own test), so every capability read here tolerates an absent object. Absent stays
            // fail-closed — the chip degrades to text rather than linking into a disabled view.
            automationsAvailable={health.data?.capabilities?.automations === true}
          />
          {/* Status, not metadata: "this run wakes itself up at 14:20" belongs with the chip. */}
          <MonitoringSchedule run={run} />
          {/* Who ordered this task, and what it dispatched, are what the run IS doing right now. */}
          <DispatchParentLine run={run} />
          <DispatchChildrenLine run={run} />

          <div data-slot="run-tabs" className="mt-1.5 flex items-end gap-1 md:mt-2.5">
            {tabs ?? <FallbackTabs run={run} tab={tab} terminalAvailable={health.data?.capabilities?.terminal === true} />}
          </div>

          {/* The rail earns its row only when it has more to say than "k of n done" (line 2). */}
          {railWanted(run.steps) ? (
            <div className="border-t border-border pt-1 pb-0 md:pt-2 md:pb-1">
              <WorkflowSteps runId={run.id} steps={run.steps} closedAs={runClosure(run)} />
            </div>
          ) : null}
        </div>

        <RunConfirmDialog
          run={run}
          confirming={actions.confirming}
          lifecycleDelete={actions.lifecycleDelete}
          onOpenChange={(open) => !open && actions.setConfirming(null)}
          onConfirm={(kind) => (kind === 'delete' ? actions.delete.mutate() : actions.cancel.mutate())}
        />
        {actions.worktreeRemovalOpen ? (
          <TaskWorktreeRemovalDialog key={run.id} run={run} pending={actions.removeWorktree.isPending}
            onClose={() => actions.setWorktreeRemovalOpen(false)} onConfirm={() => actions.removeWorktree.mutate()} />
        ) : null}
      </header>
    </ReferenceStatusProvider>
  )
}

/**
 * The status word beside the title — only while the state is still open (Proposal 7: "the word
 * appears only when the dot alone would be ambiguous"). A finished task has its neutral dot and
 * no word. Exported because it IS the grammar: a table test pins every status.
 */
export function statusChipLabel(run: ApiRun, queuePosition?: number): string | null {
  const attention = deriveAttention(run)
  const lifecycle = run.worktreeLifecycle
  if (lifecycle?.needsAttention || lifecycle?.activeOperationId) return sentence(attention.label)
  // Parked for a usage-limit reset: an appointment, not an outcome.
  if (run.status === 'failed' && run.autoResumeAt) return 'Scheduled'
  if (isAwaitingAnswer(run)) return 'Asked'
  if (isIdleClosed(run)) return null
  switch (run.status) {
    case 'review':
      return 'Needs review'
    case 'waiting':
      return budgetStop(run) ? 'Budget reached' : 'Asked'
    case 'queued':
      return run.fallbackEpisode?.pending ? 'Switching agent' : `Queued${queuePosition !== undefined ? ` #${queuePosition}` : ''}`
    case 'running': {
      if (run.activity === 'monitoring') return 'Monitoring'
      // The step name only where there is more than one to tell apart.
      const step = run.steps.length > 1 ? run.steps[activeStepIndex(run.steps)]?.name : undefined
      return step ? `Running · ${step}` : 'Running'
    }
    case 'failed':
      return 'Failed'
    default:
      return null
  }
}

const sentence = (label: string) => label.charAt(0).toUpperCase() + label.slice(1)

function StatusChip({ label, className }: { label: string; className?: string }) {
  return (
    <Pill data-status="" className={cn('shrink-0', className)}>
      {label}
    </Pill>
  )
}

/**
 * The title row's right side: the primary action, its companion, Open in… and the ⋯ menu — and
 * the git step's dialogs. A component of its own because the git step reads the PR's forge
 * status, which only a component rendered INSIDE the header's `ReferenceStatusProvider` can see.
 *
 * The ⋯ menu is rendered FROM the ⌘P palette's command list (`buildTaskCommands`, grouped by
 * `taskMenuGroups`), so the two cannot disagree about what a run offers or what it is called.
 * Unlike the old kebab it keeps what is unavailable, greyed with its reason as the hint.
 */
function HeaderActions({
  run,
  actions,
  changesShowing,
  onRename,
}: {
  run: ApiRun
  actions: RunActions
  changesShowing: boolean
  onRename: () => void
}) {
  const git = useRunGitStep(run)
  const canTerminal = useCanOpenTerminal(run)
  const { choices, canResumeHere, open: openIn } = useRunOpenChoices(run, canTerminal)
  const terminalAvailable = useHealth().data?.capabilities?.terminal === true
  const navigate = useNavigate()
  const { bindings } = useKeybindings()
  const owned = ownedTaskPr(run)
  const prUrl = owned?.url
  // Rename… opens the title's input: the menu closing must not take focus back to its button.
  const intoRename = useRef(false)

  // Read at render: the bridge is published after the workspace commits, so the first paint has
  // no "Write to the agent" row and the next one does — menus are opened later than that.
  const workspace = taskWorkspaceFor(run.id)
  const commands = buildTaskCommands(
    {
      run,
      canResume: canResumeHere,
      git: git.action,
      gitPending: git.pending,
      workspace,
      terminalAvailable,
      openChoices: choices,
      ...(prUrl ? { prUrl } : {}),
      taskUrl: '',
    },
    {
      markRead: () => actions.markRead.mutate(),
      markUnread: () => actions.markUnread.mutate(),
      pin: () => actions.pin.mutate(),
      archive: () => actions.archive.mutate(undefined),
      rename: () => {
        intoRename.current = true
        setTimeout(onRename, 0)
      },
      finish: () => actions.finish.mutate(),
      confirmStop: () => actions.setConfirming('cancel'),
      confirmDelete: () => actions.setConfirming('delete'),
      resumeInTerminal: () => actions.terminal.mutate(),
      removeWorktree: () => actions.setWorktreeRemovalOpen(true),
      gitAction: git.onAction,
      openIn,
      navigate: (to) => navigate(to),
      openUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
      copy: (text, what) => void copyToClipboard(text, `${what} copied`),
    },
  )
  const groups = taskMenuGroups(commands)
  const pending: Record<string, boolean> = {
    'toggle-read': actions.markRead.isPending || actions.markUnread.isPending,
    pin: actions.pin.isPending,
    archive: actions.archive.isPending,
    'remove-worktree': actions.removeWorktree.isPending,
  }

  const primary = primaryRunAction(run, { git: git.action, ...(prUrl ? { prUrl } : {}), changesShowing })
  const secondary = secondaryRunAction(run, primary, git.action)
  // The composer when a Chat column shows one; else bring the chat up (the workspace) or go there.
  const toComposer = () => {
    const bridge = taskWorkspaceFor(run.id)
    if (bridge?.focusComposer) return bridge.focusComposer()
    if (bridge) return bridge.openView('session')
    navigate(`/tasks/${run.id}`)
  }
  const toChanges = () => {
    const bridge = taskWorkspaceFor(run.id)
    if (bridge) return bridge.openView('changes')
    navigate(`/tasks/${run.id}/changes`)
  }
  const perform = (kind: Exclude<NonNullable<typeof primary>['kind'], 'git'>) => {
    switch (kind) {
      case 'answer':
      case 'retry':
        return toComposer()
      case 'review':
        return toChanges()
      case 'open-pr':
        return primary?.kind === 'open-pr' ? window.open(primary.url, '_blank', 'noopener,noreferrer') : undefined
      case 'stop':
        return actions.setConfirming('cancel')
    }
  }

  return (
    <>
      {/* Desktop only: a phone's line 1 is the title and the ⋯, which carries all of this. */}
      <span data-slot="run-primary-actions" className="hidden items-center gap-2 md:flex">
        {primary?.kind === 'git' ? (
          <GitActions action={primary.action} pending={git.pending} variant="primary" onAction={git.onAction} />
        ) : primary ? (
          <Button
            size="sm"
            variant={primary.kind === 'stop' ? 'outline' : 'primary'}
            data-slot="run-primary"
            data-action={`primary:${primary.kind}`}
            className={cn(primary.kind === 'stop' && 'text-danger')}
            onClick={() => perform(primary.kind)}
          >
            {primary.kind === 'open-pr' ? <ExternalLinkIcon aria-hidden="true" /> : null}
            {PRIMARY_ACTION_LABELS[primary.kind]}
          </Button>
        ) : null}
        {secondary?.kind === 'git' ? (
          <GitActions action={secondary.action} pending={git.pending} onAction={git.onAction} />
        ) : secondary ? (
          <Button
            size="sm"
            variant="outline"
            data-slot="run-secondary"
            data-action={`secondary:${secondary.kind}`}
            className={cn(secondary.kind === 'stop' && 'text-danger')}
            onClick={secondary.kind === 'stop' ? () => actions.setConfirming('cancel') : toComposer}
          >
            {secondary.kind === 'stop' ? 'Stop' : 'Continue'}
          </Button>
        ) : null}
        <OpenInMenuForRun run={run} choices={choices} canResume={canResumeHere} onPick={openIn} onResume={() => actions.terminal.mutate()} />
      </span>
      <DropdownMenu>
        <IconTooltip label="More actions">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions" data-slot="run-menu-trigger">
              <EllipsisIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </IconTooltip>
        <DropdownMenuContent
          align="end"
          data-slot="run-actions-menu"
          className="min-w-56"
          onCloseAutoFocus={(event) => {
            if (!intoRename.current) return
            intoRename.current = false
            event.preventDefault()
          }}
        >
          {groups.map((group, index) => (
            <Fragment key={group.id}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel className="text-meta font-normal text-muted-foreground">{group.heading}</DropdownMenuLabel>
              {group.commands.map((command) => (
                <MenuCommand
                  key={command.id}
                  command={command}
                  pending={pending[command.id] === true}
                  shortcut={shortcutOf(command, bindings)}
                />
              ))}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {git.dialogs}
    </>
  )
}

/** The key printed beside a menu item: the user's own chord for it, else the palette's hint. */
function shortcutOf(command: TaskCommand, bindings: ReadonlyMap<string, string>): string | undefined {
  const chord = bindings.get(command.id)
  return chord ? formatChord(chord) : command.shortcut
}

/** One palette command as a menu row — its label, its icon (filled when the toggle is ON), its
 *  shortcut, and its unavailability as the greyed row's hint. Git steps keep `data-action`. */
function MenuCommand({ command, pending, shortcut }: { command: TaskCommand; pending: boolean; shortcut: string | undefined }) {
  const blocked = command.unavailable !== undefined
  return (
    <DropdownMenuItem
      data-command={command.id}
      data-action={command.id.startsWith('git:') ? command.id.slice('git:'.length) : undefined}
      variant={command.danger ? 'destructive' : 'default'}
      disabled={blocked || pending}
      title={command.unavailable}
      aria-pressed={command.pressed !== undefined ? command.pressed : undefined}
      onSelect={() => command.perform()}
    >
      {command.pressed ? onIcon(command.icon) : command.icon}
      <span data-slot="menu-label" className="min-w-0 flex-1 truncate">{command.label}</span>
      {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  )
}

/** The ON pattern on a toggle's icon — violet and filled, as the sidebar and the table paint it. */
function onIcon(icon: ReactNode): ReactNode {
  if (!isValidElement<{ className?: string }>(icon)) return icon
  return cloneElement(icon, { className: cn(icon.props.className, TOGGLE_ON_ICON_CLASS) })
}

/**
 * "Open in…" session takeover (#open-in): resume the session in a real terminal, open the run's
 * worktree in a local editor / Finder / terminal / agent CLI, or copy its path.
 *
 * The menu itself is the shared `OpenInMenu` (components/open-in-menu.tsx); what lives here is
 * everything run-SPECIFIC — the resume item, the `(resume)` labelling, and the copy-path row.
 * Renders when the session can be resumed OR the machine offers worktree targets (both empty in
 * hosted mode → nothing to show).
 */
function OpenInMenuForRun({
  run,
  choices,
  canResume,
  onPick,
  onResume,
}: {
  run: ApiRun
  choices: OpenInChoice[]
  canResume: boolean
  onPick: (targetId: string) => void
  onResume: () => void
}) {
  if (!canResume && choices.length === 0) return null

  const copyPath = () => {
    const path = run.worktreePath
    if (!path) return
    void writeClipboard(path)
      .then(() => toast('Worktree path copied'))
      .catch(() => toast(`Path: ${path}`))
  }

  return (
    <OpenInMenu
      choices={choices}
      onPick={onPick}
      title="Resume in a terminal, or open the worktree locally"
      leading={
        canResume ? (
          <DropdownMenuItem data-target="terminal-resume" onSelect={onResume}>
            <SquareTerminalIcon aria-hidden="true" />
            Terminal (resume session)
          </DropdownMenuItem>
        ) : null
      }
      trailing={
        run.worktreePath ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={copyPath}>
              <CopyIcon aria-hidden="true" />
              Copy worktree path
            </DropdownMenuItem>
          </>
        ) : null
      }
    />
  )
}

/** The tab row when no workspace strip is handed in: the same tabs, in the same groups
 *  (`stripGroups`), as links to each view's page. */
function FallbackTabs({ run, tab, terminalAvailable }: { run: ApiRun; tab: RunTab; terminalAvailable: boolean }) {
  const views = FIXED_VIEW_ORDER.filter(
    (view) => (view !== 'graph' || Boolean(run.workflowDef)) && (view !== 'terminal' || terminalAvailable),
  )
  const activeView: ViewId | 'notes' = tab === 'preview' ? 'browser' : tab
  const groups = stripGroups(stripTabs(views))
  return (
    <>
      {groups.map((group, index) => (
        <Fragment key={group[0]}>
          {index > 0 ? <span role="separator" aria-orientation="vertical" className="mx-1.5 mb-2.5 h-[18px] w-px shrink-0 bg-border" /> : null}
          {group.map((view) =>
            view === 'notes' ? (
              <TabLink key="notes" to={`/tasks/${run.id}/notes`} active={activeView === 'notes'}>
                Notes
              </TabLink>
            ) : (
              <TabLink key={view} to={view === 'session' ? `/tasks/${run.id}` : `/tasks/${run.id}/${VIEW_PATHS[view]}`} active={activeView === view}>
                {viewLabel(view)}
              </TabLink>
            ),
          )}
        </Fragment>
      ))}
    </>
  )
}

/**
 * The editable title (#389): a plain h1 with a pencil that only appears on hover (mockup
 * `.pencil-btn`), flipping into an inline input. Enter/blur commit through `usePatchRun`
 * (the server stores it as both `title` and `titleSummary`), Escape abandons the draft.
 * The rename machine itself is shared with the Tasks table (`components/editable-title.tsx`).
 */
function EditableTitle({ run, beginRename }: { run: ApiRun; beginRename: RefObject<() => void> }) {
  const patch = usePatchRun(run.id)
  const title = runTitle(run)
  const draft = useDraft(run.id, 'title')
  const editor = useTitleEditor(title, (next) =>
    patch.mutate({ title: next }, { onError: (error) => toast(error.message, { tone: 'danger' }) }),
  )
  const drafted: TitleEditor = {
    ...editor,
    setDraft: (value) => {
      editor.setDraft(value)
      draft.setText(value)
    },
    commit: () => {
      editor.commit()
      draft.clear()
    },
    cancel: () => {
      editor.cancel()
      draft.clear()
    },
  }
  beginRename.current = editor.begin

  const begin = useRef(editor.beginWith)
  begin.current = editor.beginWith
  const editing = editor.editing
  useEffect(() => {
    if (editing || !draft.ready || !draft.hasDraft) return
    begin.current(draft.text)
  }, [draft.hasDraft, draft.ready, draft.text, editing])

  if (editor.editing) {
    return <TitleEditInput editor={drafted} className="flex-1 text-lead font-semibold" />
  }

  return (
    <span className="group flex min-w-0 items-center gap-1">
      <h1 className="min-w-0 truncate text-lead font-semibold" title={run.task}>
        {title}
      </h1>
      <button
        type="button"
        aria-label="Rename task"
        onClick={editor.begin}
        className="shrink-0 rounded-sm p-1 text-soft-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <PencilIcon className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  )
}

/** Copyable task branch with confirmation kept local so hovering it does not re-render MetaRow. */
function CopyBranchChip({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (dismissTimer.current !== null) clearTimeout(dismissTimer.current)
    },
    [],
  )

  const copy = () => {
    void writeClipboard(branch)
      .then(() => {
        setCopied(true)
        setTooltipOpen(true)
        if (dismissTimer.current !== null) clearTimeout(dismissTimer.current)
        dismissTimer.current = setTimeout(() => {
          dismissTimer.current = null
          setTooltipOpen(false)
        }, 1_500)
      })
      .catch(() => toast(`Branch: ${branch}`))
  }

  return (
    <TooltipProvider>
      <Tooltip
          open={tooltipOpen}
          onOpenChange={(open) => {
            if (open && dismissTimer.current === null) setCopied(false)
            setTooltipOpen(open)
          }}
        >
          <TooltipTrigger asChild>
            <button
              type="button"
              data-slot="branch-chip"
              className="cursor-copy rounded-sm border border-border bg-card px-1.5 py-px font-mono text-meta font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              aria-label={`Copy branch name ${branch}`}
              onClick={copy}
            >
              {branch}
              <span className="sr-only" role="status">
                {copied ? 'Branch name copied' : ''}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{copied ? 'Copied' : 'Copy branch name'}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** Line 2: workflow · k of n done · branch chip · ± · PR · issue on the left; the usage chip on
 *  the right (mockup `.l2`). Each part renders only when the record carries it — absence is
 *  absence, not a placeholder. On a phone the status word leads it, and the workflow, tally and
 *  branch step aside for the diff, the PR and the cost. */
function MetaRow({
  run,
  references,
  statusLabel,
  planTally,
  budget,
  showTokens,
  showCost,
  automationsAvailable,
  continuationEngine,
}: {
  run: ApiRun
  /** The header's resolved references (`useRunReferences`) — its PR chips are painted here. */
  references: ReturnType<typeof taskReferences>
  statusLabel: string | null
  planTally?: { done: number; total: number }
  budget: ReturnType<typeof budgetStop>
  showTokens: boolean
  showCost: boolean
  continuationEngine?: ReactNode
  /** `capabilities.automations` (#801). A run launched while automations were on keeps its
   *  `run.automation` provenance forever, so the chip must survive the flag going off — as
   *  plain text, because the route it used to link to is disabled. */
  automationsAvailable: boolean
}) {
  // #526: the issue chip may be synthesized from the CEZ:ISSUE marker, and the only repository
  // such a link may name is the one on screen — never the transcript's.
  const repoBase = useProjectRepoBase()
  const phoneOnly = 'md:hidden'
  const desktopOnly = 'max-md:hidden'
  const parts: ReactNode[] = []
  if (statusLabel) parts.push(<StatusChip key="status" label={statusLabel} className={phoneOnly} />)
  // `workflowLabel` so an inline chain shows its first step's name, not the bare "(planned)"
  // placeholder — which reads like a status next to the live status chip.
  parts.push(
    <span key="workflow" className={desktopOnly}>
      {workflowLabel(run)}
    </span>,
  )
  if (run.steps.length > 0) {
    const tally = stepTally(run.steps)
    parts.push(
      <span key="steps" data-slot="step-tally" className={cn('tabular-nums', desktopOnly)}>
        {tally.done} of {tally.total} done
      </span>,
    )
  }
  if (planTally) {
    // The plan dock's compact mirror (spec: "mirrored as a compact progress line in the run
    // header"). Desktop only since #764: on a phone the dock it mirrors is itself on screen.
    parts.push(
      <span key="plan" data-slot="plan-mirror" className="hidden shrink-0 tabular-nums md:inline">
        Plan {planTally.done}/{planTally.total}
      </span>,
    )
  }
  if (budget) {
    parts.push(
      <span key="budget" data-slot="budget-stop" className="shrink-0 tabular-nums">
        Spent {formatCost(budget.spent) || '$0.00'} of {formatCost(budget.ceiling) || '$0.00'}
      </span>,
    )
  }
  const branch = run.branch
  if (branch) {
    parts.push(
      <span key="branch" className={cn('contents', desktopOnly)}>
        <CopyBranchChip branch={branch} />
      </span>,
    )
  }
  // The diff, then EVERY PR the task points at, in `taskReferences` order — the same order, and
  // the same statuses, the global Tasks table paints (see `prChipNodes`).
  if (run.diffStat) parts.push(<DiffStatLabel key="diff" stat={run.diffStat} />)
  parts.push(...prChipNodes(run, references))
  const issueUrl = taskIssueUrl(run, repoBase)
  if (issueUrl && isHttpUrl(issueUrl)) {
    const number = prNumber(issueUrl)
    parts.push(
      <ReferenceChip
        key="issue"
        reference={{ kind: 'Issue', ...(number ? { number: Number(number) } : {}), url: issueUrl }}
        taskTitle={runTitle(run)}
        className={cn('h-5', desktopOnly)}
      />,
    )
  }
  if (run.automation) {
    // Provenance is history and is always shown; only the LINK is gated. Following it with the
    // capability off would land on the disabled `/automations` state, which says nothing about
    // this task.
    parts.push(
      automationsAvailable ? (
        <Link
          key="automation"
          to={`/automations/${encodeURIComponent(run.automation.automationId)}/log`}
          className={cn('rounded-sm border border-border bg-card px-1.5 py-px text-meta font-medium hover:text-foreground', desktopOnly)}
        >
          Automation
        </Link>
      ) : (
        <span
          key="automation"
          data-slot="automation-origin"
          title="Automations are off on this server (CEZ_AUTOMATIONS)"
          className={cn('rounded-sm border border-border bg-card px-1.5 py-px text-meta font-medium', desktopOnly)}
        >
          Automation
        </span>
      ),
    )
  }

  return (
    <div
      data-slot="run-meta"
      className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground md:mt-1.5 md:gap-y-1"
    >
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span className={cn('text-soft-foreground', dotClass(parts, index))} aria-hidden="true">
              ·
            </span>
          ) : null}
          {part}
        </Fragment>
      ))}
      <ImpactChip run={run} />
      <RunUsage
        run={run}
        showTokens={showTokens}
        showCost={showCost}
        continuationEngine={continuationEngine}
        className="ml-auto"
      />
    </div>
  )
}

/** Where a meta part shows: everywhere, or on one side of the `md` breakpoint only. */
type Breakpoint = 'phone' | 'desktop'
function visibleOn(part: ReactNode, breakpoint: Breakpoint): boolean {
  if (!isValidElement<{ className?: string }>(part)) return true
  const className = part.props.className ?? ''
  if (className.includes('max-md:hidden')) return breakpoint === 'desktop'
  if (/(^|\s)md:hidden/.test(className)) return breakpoint === 'phone'
  return true
}

/** The dot before `parts[index]` shows on a breakpoint only where that part AND something before
 *  it do — phone and desktop each read their own `a · b · c`, never a stray leading dot. */
function dotClass(parts: readonly ReactNode[], index: number): string | undefined {
  const shown = (breakpoint: Breakpoint) =>
    visibleOn(parts[index], breakpoint) && parts.slice(0, index).some((part) => visibleOn(part, breakpoint))
  const phone = shown('phone')
  const desktop = shown('desktop')
  if (phone && desktop) return undefined
  if (phone) return 'md:hidden'
  if (desktop) return 'max-md:hidden'
  return 'hidden'
}

/** The task's references, resolved once for the whole header so every chip — the PR chips by the
 *  git button, the issue chip in the details row — is answered by the same status batch. */
export function useRunReferences(run: ApiRun) {
  // #526: a chip may be synthesized from a CEZ:PR / CEZ:ISSUE marker, and the only repository
  // such a link may name is the one on screen — never the transcript's.
  const repoBase = useProjectRepoBase()
  // At most a handful of references here, so this is a small batch rather than a table's — but it
  // goes through the same seam, which is what keeps the header's chip and the table's chip
  // answering identically for the same PR.
  const projectId = useReferenceProjectId()
  const references = useMemo(() => taskReferences(run, repoBase), [run, repoBase])
  const requests = useMemo(
    () =>
      projectId === undefined
        ? []
        : references.map((reference) => ({
            projectId,
            kind: reference.kind,
            number: reference.number,
          })),
    [references, projectId],
  )
  return { projectId, references, requests }
}

/** The task's pull-request chips, one per PR, for the details row. */
function prChipNodes(run: ApiRun, references: ReturnType<typeof taskReferences>): ReactNode[] {
  const chips: ReactNode[] = []
  // EVERY PR the task points at, in `taskReferences` order — the same order, and the same
  // statuses, the global Tasks table paints. A task opened on someone else's PR that pushes a
  // follow-up of its own is about both; the first is on the row and all of them are one hover away.
  //
  // A reference with no URL still gets its chip, exactly as All tasks paints it: a number-only
  // reference is what a `CEZ:PR` declaration looks like before any link is scraped, and the two
  // pages read their repository from DIFFERENT places (this one from health's remote, All tasks
  // from the project registry's `repoUrl`) — so "no URL here" never means "nothing to show".
  // `ReferenceChip` degrades such a chip to inert text on its own.
  const prReferences: { kind: 'PR' | 'Issue'; number?: number; url?: string }[] = references.filter(
    (reference) => reference.kind === 'PR',
  )
  // The one PR `taskReferences` cannot express: a forge URL whose last segment is not a number
  // (`taskPrUrl`'s own tolerance — an unrecognized forge still gets a working link, just without
  // a number cezar would be inventing). Gated on that URL not being listed already, NOT on there
  // being no PRs at all: a forge whose PR URLs do not end in a number (#847's GitLab adapter)
  // would otherwise have a `prNumber` chip standing in front of a link that never rendered.
  const prUrl = taskPrUrl(run)
  if (prUrl && isHttpUrl(prUrl) && !prReferences.some((reference) => reference.url === prUrl)) {
    prReferences.push({ kind: 'PR', url: prUrl })
  }
  const [first] = prReferences
  if (!first) return chips
  // The strongest PR on the row, the rest behind a `+N` — the All tasks table's cell, with the
  // same component, so the two pages show a task's PRs the same way.
  chips.push(
    <span key="pr" data-slot="run-pr-refs" className="flex flex-nowrap items-center gap-1">
      <ReferenceChip
        reference={first}
        taskTitle={runTitle(run)}
        className="h-5 shrink-0"
        // Shown only on a chip that IS conflicting — the chip decides that, being the thing that
        // knows — and mounted only while its panel is open. The same component the Tasks table
        // hands its chips, so both send the same prompt on the same seam.
        conflictAction={<ResolveConflictsButton run={run} prNumber={first.number} />}
      />
      {prReferences.length > 1 ? (
        <ReferenceOverflow
          references={prReferences}
          taskTitle={runTitle(run)}
          hidden={prReferences.length - 1}
          conflictActionFor={(reference) => <ResolveConflictsButton run={run} prNumber={reference.number} />}
        />
      ) : null}
    </span>,
  )
  return chips
}

/** The live gauges (opt-in), then the one usage chip — what the run has spent, and on what. */
function RunUsage({
  run,
  showTokens,
  showCost,
  continuationEngine,
  className,
}: {
  run: ApiRun
  showTokens: boolean
  showCost: boolean
  continuationEngine?: ReactNode
  className?: string
}) {
  const showLiveUsage = useLiveUsageEnabled() && liveUsageParts(run.liveUsage).length > 0
  const account = accountPart(useRunClaudeAccount(run, showLiveUsage))
  return (
    <span data-slot="run-usage" className={cn('flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground', className)}>
      {showLiveUsage ? <LiveUsage usage={run.liveUsage} account={account} /> : null}
      <UsageChip run={run} showTokens={showTokens} showCost={showCost} continuationEngine={continuationEngine} />
    </span>
  )
}

/**
 * "6m 13s · 46 in · 6.2k out · $0.83" — one mono chip for the run's time, tokens and cost. Its
 * popover is the detail sheet (Proposal 9: anything that needs three lines is a popover with
 * labels): the exact token counts, and the runner, account, model and canonical identity that
 * produced them — the one place `RunRecord.modelIdentity` (#546) is read — plus the engine
 * picker for the next continuation on the Session tab. A phone shows the cost alone.
 */
function UsageChip({
  run,
  showTokens,
  showCost,
  continuationEngine,
}: {
  run: ApiRun
  showTokens: boolean
  showCost: boolean
  continuationEngine?: ReactNode
}) {
  const { runner, account, model, identity, summary } = useRunEngine(run)
  const startedAt = run.startedAt ? Date.parse(run.startedAt) : Number.NaN
  const live = isRunActive(run.status) && !run.finishedAt
  // A running task's clock ticks; a finished one is a fact.
  const now = useNow(1000, live && Number.isFinite(startedAt))
  const endedAt = run.finishedAt ? Date.parse(run.finishedAt) : now
  const duration = Number.isFinite(startedAt) ? formatDuration(endedAt - startedAt) : ''
  const tokens = showTokens && (run.inputTokens !== undefined || run.outputTokens !== undefined)
  const cost = showCost && run.costUsd ? formatCost(run.costUsd) : ''
  const wide = [
    duration,
    tokens ? `${compactTokens(run.inputTokens ?? 0)} in` : '',
    tokens ? `${compactTokens(run.outputTokens ?? 0)} out` : '',
    cost,
  ].filter(Boolean)
  const narrow = [cost || (tokens ? `${compactTokens((run.inputTokens ?? 0) + (run.outputTokens ?? 0))} tokens` : '') || duration].filter(Boolean)
  const exact = (value: number | undefined) => (value === undefined ? '—' : new Intl.NumberFormat().format(value))

  return (
    <Popover>
      <IconTooltip label="Time, tokens, cost and the agent — click for details">
        <PopoverTrigger asChild>
          <button
            type="button"
            data-slot="agent-badge"
            aria-label={`Agent: ${runner}, ${account ? `account ${account}, ` : ''}model ${model}`}
            className="flex shrink-0 items-center gap-1 rounded-sm border border-border bg-card px-1.5 py-px font-mono text-meta tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <span data-slot="usage-summary" className="max-md:hidden">
              {wide.length > 0 ? wide.join(' · ') : summary}
            </span>
            <span className="md:hidden">{narrow.length > 0 ? narrow.join(' · ') : summary}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
          </button>
        </PopoverTrigger>
      </IconTooltip>
      <PopoverContent align="end" data-slot="run-usage-details" className="w-64 p-3 text-xs">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {duration ? (
            <>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="tabular-nums">{duration}</dd>
            </>
          ) : null}
          {tokens ? (
            <>
              <dt className="text-muted-foreground">Input tokens</dt>
              <dd className="tabular-nums">{exact(run.inputTokens)}</dd>
              <dt className="text-muted-foreground">Output tokens</dt>
              <dd className="tabular-nums">{exact(run.outputTokens)}</dd>
            </>
          ) : null}
          {cost ? (
            <>
              <dt className="text-muted-foreground">Cost</dt>
              <dd className="tabular-nums">{cost}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Runner</dt>
          <dd className="font-mono">{runner}</dd>
          {/* Omitted, not guessed, when no step recorded one: a run from before accounts existed
              cannot be said to have used the discovered account — nothing wrote that down. */}
          {account ? (
            <>
              <dt className="text-muted-foreground">Account</dt>
              <dd data-slot="agent-badge-account" className="font-mono">{account}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Model</dt>
          <dd className="font-mono">{model}</dd>
          {identity ? (
            <>
              <dt className="text-muted-foreground">Identity</dt>
              <dd data-slot="agent-badge-identity" className="font-mono">{identity}</dd>
            </>
          ) : null}
        </dl>
        {continuationEngine ? (
          <div data-slot="agent-badge-engine-picker" className="mt-3 border-t border-border pt-2">
            <p className="pb-1 text-meta text-muted-foreground">Next continuation</p>
            {continuationEngine}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * "Dispatched by <parent>" — one row linking a dispatched task back to the task that ordered it
 * (spec `.ai/specs/2026-09-10-dispatch.md`).
 *
 * Provenance, so it renders whether or not `capabilities.dispatch` is still on: a run created by
 * a dispatch keeps its `dispatch.parentRunId` forever, and hiding the line on a server that later
 * turned the flag off would leave a thread that cannot explain who ordered it. The parent's TITLE
 * comes from the run list this page already holds; a parent outside that list (another project,
 * or pruned) still gets its link, labelled by its id.
 */
function DispatchParentLine({ run }: { run: ApiRun }) {
  const runs = useRuns()
  const parentRunId = run.dispatch?.parentRunId
  if (parentRunId === undefined) return null
  const parent = (runs.data ?? []).find((candidate) => candidate.id === parentRunId)
  const attention = parent ? deriveAttention(parent) : null
  return (
    <div
      data-slot="dispatch-parent-line"
      className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden text-xs text-muted-foreground"
    >
      <span className="shrink-0">Dispatched by</span>
      <Link
        to={`/tasks/${parentRunId}`}
        data-slot="dispatch-parent"
        data-run-id={parentRunId}
        className="inline-flex min-w-0 items-center gap-1.5 truncate hover:text-foreground"
      >
        {attention ? <StatusDot tone={attention.tone} pulse={attention.pulse} /> : null}
        <span className="truncate">{parent ? runTitle(parent) : parentRunId}</span>
      </Link>
    </div>
  )
}

/** Above this many dispatched children the Subtasks list starts COLLAPSED. Four chips is roughly
 *  the one row the line was drawn as; a gauntlet parent with a hundred of them wrapped into a wall
 *  that owned the viewport and pushed the transcript off screen — the very thing the original
 *  "deliberately one row" note meant to prevent — so past that row the reader opts in instead. */
const SUBTASKS_OPEN_BY_DEFAULT_MAX = 4

/** Which runs the reader has opened (or closed) the Subtasks list for. Module-level and run-keyed:
 *  a Session → Changes hop remounts this header and plain `useState` would forget the choice,
 *  while run A → run B does NOT remount and `useState` would carry A's choice into B.
 *  Session-lifetime only; nothing persisted. */
const subtasksOpenByRun = new Map<string, boolean>()

/**
 * "Subtasks — <child> · <child> …" — the tasks this one dispatched, behind a disclosure.
 *
 * Derived from the run list this page already holds rather than fetched: a child's link is its
 * id and its dot is its status, both of which `useRuns()` carries and keeps live over the run
 * stream. Nothing renders for a run that dispatched nothing — which is every run on a server
 * that never turned dispatch on.
 *
 * Bounded three ways, because a dispatching parent's child count is unbounded:
 *  - past `SUBTASKS_OPEN_BY_DEFAULT_MAX` the list starts closed, and the summary row carries the
 *    count plus a per-status tally, so a collapsed list still answers "how is the fan-out going";
 *  - open, it scrolls at `max-h-28` (~5 wrapped rows) instead of growing without limit;
 *  - closed, the links leave the DOM rather than hiding visually — no invisible-but-focusable
 *    links in the tab order.
 */
function DispatchChildrenLine({ run }: { run: ApiRun }) {
  const runs = useRuns()
  const [, bumpSubtasks] = useReducer((n: number) => n + 1, 0)
  const listId = useId()
  const children = (runs.data ?? []).filter(
    (candidate) => candidate.dispatch?.parentRunId === run.id,
  )
  if (children.length === 0) return null
  const open = subtasksOpenByRun.get(run.id) ?? children.length <= SUBTASKS_OPEN_BY_DEFAULT_MAX
  const toggle = () => {
    subtasksOpenByRun.set(run.id, !open)
    bumpSubtasks()
  }
  return (
    <div data-slot="dispatch-children" className="mt-1 min-w-0 text-xs text-muted-foreground">
      <button
        type="button"
        data-slot="dispatch-children-toggle"
        aria-controls={listId}
        aria-expanded={open}
        onClick={toggle}
        className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden hover:text-foreground"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cn('size-3 shrink-0 transition-transform', !open && '-rotate-90')}
        />
        <span className="shrink-0">Subtasks</span>
        <span data-slot="dispatch-children-count" className="shrink-0 tabular-nums">
          {children.length}
        </span>
        <SubtaskTally subtasks={children} />
      </button>
      {open ? (
        <div
          id={listId}
          data-slot="dispatch-children-list"
          className="mt-0.5 flex max-h-28 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 overflow-y-auto overscroll-contain pl-[1.125rem]"
        >
          {children.map((child) => {
            const attention = deriveAttention(child)
            return (
              <Link
                key={child.id}
                to={`/tasks/${child.id}`}
                data-slot="dispatch-child"
                data-run-id={child.id}
                title={`${runTitle(child)} — ${attention.label}`}
                className="inline-flex max-w-52 items-center gap-1.5 truncate hover:text-foreground"
              >
                <StatusDot tone={attention.tone} pulse={attention.pulse} />
                <span className="truncate">{runTitle(child)}</span>
              </Link>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/**
 * "3 running · 1 needs you · 20 done" — the children's statuses, counted, in attention order.
 *
 * What makes the collapsed state honest: the point of the row is the fan-out's health, and a bare
 * "Subtasks 100" hides precisely the child that stopped to ask something. Ordered by the canonical
 * `ATTENTION_RANK` (and grouped by `deriveAttention`'s own label) so the rung that wants a human
 * is read first, never buried behind the done pile.
 */
function SubtaskTally({ subtasks }: { subtasks: ApiRun[] }) {
  const byLabel = new Map<string, { tone: AttentionTone; pulse: boolean; rank: number; count: number }>()
  for (const child of subtasks) {
    const attention = deriveAttention(child)
    const seen = byLabel.get(attention.label)
    if (seen) {
      seen.count += 1
      continue
    }
    byLabel.set(attention.label, {
      tone: attention.tone,
      pulse: attention.pulse,
      rank: ATTENTION_RANK[attention.bucket],
      count: 1,
    })
  }
  const tally = [...byLabel.entries()].sort(([, a], [, b]) => a.rank - b.rank || b.count - a.count)
  return (
    <span data-slot="dispatch-children-tally" className="flex min-w-0 items-center gap-2 overflow-hidden">
      {tally.map(([label, group]) => (
        <span key={label} className="inline-flex shrink-0 items-center gap-1">
          <StatusDot tone={group.tone} pulse={group.pulse} />
          <span className="tabular-nums">{group.count}</span>
          <span>{label}</span>
        </span>
      ))}
    </span>
  )
}

function MonitoringSchedule({ run }: { run: ApiRun }) {
  if (run.status !== 'running' || run.activity !== 'monitoring') return null
  if (run.monitoringWakeCapReached) {
    return (
      <p data-slot="monitoring-schedule" role="status" className="mt-1 text-xs text-muted-foreground">
        Automatic checks paused — 40/40 reached
      </p>
    )
  }
  const wakeAt = run.monitoringWakeAt ? new Date(run.monitoringWakeAt) : null
  const validWakeAt = wakeAt && Number.isFinite(wakeAt.getTime()) ? wakeAt : null
  if (!validWakeAt) {
    return (
      <p data-slot="monitoring-schedule" role="status" className="mt-1 text-xs text-muted-foreground">
        Parked — no automatic check scheduled
      </p>
    )
  }
  const label = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'long',
  }).format(validWakeAt)
  return (
    <p data-slot="monitoring-schedule" role="status" className="mt-1 text-xs text-muted-foreground">
      Next automatic check{' '}
      <time dateTime={run.monitoringWakeAt} className="font-medium text-foreground">
        {label}
      </time>
    </p>
  )
}
