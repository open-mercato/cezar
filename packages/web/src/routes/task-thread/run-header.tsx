import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  CheckIcon,
  CircleStopIcon,
  CopyIcon,
  EllipsisVerticalIcon,
  FileDiffIcon,
  FilesIcon,
  FileTextIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  MailIcon,
  MessageSquareTextIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  ScanEyeIcon,
  SendHorizontalIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from 'lucide-react'
import { Fragment, useMemo, useRef, useState, type ReactNode, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from '@/lib/project-router'

import { ApiError, archiveRun, cancelRun, continueRun, deleteRun, openRunIn, openRunInCli } from '@/api/client'
import {
  queryKeys,
  useAgentProfiles,
  useConfig,
  useHealth,
  useMarkRunUnseen,
  useOpenTargets,
  usePatchRun,
  useProjectRepoBase,
  useReferenceProjectId,
  useProviderStatus,
  useRunHandoff,
} from '@/api/queries'
import { DEFAULT_AGENT_ACCOUNT_ID, type ApiRun, type OpenTarget } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { PixelHammerIcon, RunnerLogo } from '@/components/icons'
import { TitleEditInput, useTitleEditor } from '@/components/editable-title'
import { ReferenceChip } from '@/components/reference-chip'
import { ResolveConflictsButton } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { TabLink } from '@/components/tab-link'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { OpenInMenu, type OpenInChoice } from '@/components/open-in-menu'
import { toast } from '@/components/ui/toaster'
import { DirectionalUsage } from '@/components/directional-usage'
import { runTitle } from '@/lib/task-groups'
import { usableRunners } from '@/lib/provider-status'
import {
  formatCost,
  prNumber,
  taskIssueUrl,
  taskPrUrl,
  taskReferences,
  workflowLabel,
} from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { chipClass, chevron } from '@/components/picker-pill'
import { cn, isHttpUrl } from '@/lib/utils'

import { Markdown } from './markdown'
import { useContinuationProvider } from './continuation-provider'
import { cliTargetResumes, cliTargetRunner, finishLabel, finishTitle, primaryRunCta, resumeHint, runActionFlags } from './run-actions'
import { useFinishRun } from './use-finish-run'

/**
 * The run header (spec §"Task thread" → Header): editable title + status pill, the meta line,
 * the Session | Changes | Files tabs with the action bar, the workflow step rail and the plan
 * mirror — the whole sticky region above the thread.
 *
 * Two deliberate omissions, both seams rather than gaps:
 *  - **VS Code** (spec: `POST /api/runs/:id/open-in-editor`) — the endpoint does not exist yet;
 *    R5 adds it driver-detected. Faking the button against nothing would be dishonest.
 *  - **Hosted mode** (spec §"Deployment modes"): when R5's `capabilities.localHandoff` lands in
 *    `/api/health`, Terminal (and VS Code) must disappear entirely and the resume hint must drop
 *    its `cd`. Today's HealthResponse carries no such field, so Terminal renders per current
 *    (local-only) behavior — the gate goes in where the flags are read, `runActionFlags` callers.
 */
/** Which run-detail tab this header instance sits above — drives the active underline.
 *  A prop rather than a route match so the header stays testable with a bare render. */
export type RunTab = 'session' | 'changes' | 'commits' | 'files'

export function RunHeader({
  run,
  tab = 'session',
  onMarkedUnread,
}: {
  run: ApiRun
  tab?: RunTab
  /** Fired the moment "Mark unread" is invoked, BEFORE the mutation — the Session tab uses it
   *  to suppress its auto-mark-read effect for the rest of the visit (#775). Optional because
   *  the three `task-git` tabs render this same header and run no such effect. */
  onMarkedUnread?: () => void
}) {
  const flags = runActionFlags(run)
  const [notesOpen, setNotesOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  // Deferred a tick: the menu's close restores focus to its trigger, which would blur (and so
  // close) the rename input the moment it mounted. After the restore, autoFocus wins.
  const beginRename = () => setTimeout(() => setRenaming(true), 0)
  const health = useHealth()
  const actions = useRunActions(run, onMarkedUnread)

  return (
    <header
      data-slot="run-header"
      // The after: strip is a background-colored SHADOW under the sticky edge: scrolling content
      // fades into the page instead of guillotining on the border line. SESSION only — the
      // Changes/Commits/Files views start their content flush under the header, so there the
      // overlay would sit on the first rows instead of on scrolled-away text.
      className={cn(
        'sticky top-0 z-20 bg-background/95 px-4 backdrop-blur max-md:border-b max-md:border-border max-md:pt-4 md:px-6',
        // On md+ the bar carries the whole header, so this strip only earns its border and
        // padding when it actually shows something (a rename, the monitoring line, notes).
        (renaming || notesOpen || (run.status === 'running' && run.activity === 'monitoring')) &&
          'border-b border-border pt-3',
        tab === 'session' &&
          "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-5 after:bg-gradient-to-b after:from-background after:to-transparent after:content-['']",
      )}
    >
      <div className="mx-auto w-full max-w-[var(--measure)]">
        {/* No visible title (user decision): the shell's bar crumb already says it. The h1
            stays for assistive tech; renaming opens an inline input over the meta row. */}
        <h1 className="sr-only">{runTitle(run)}</h1>
        {renaming ? <RenameRow run={run} onDone={() => setRenaming(false)} /> : null}

        {/* The stat strip left the header: Plan is the context tab, Status duplicated the paused
            hint, and Cost/Agent/Mode moved to a meta row UNDER the composer (task-thread.tsx). */}
        {/* `capabilities?.` fail-closed (#801): this header renders against minimal health
            payloads, and with automations off the chip degrades to text rather than linking
            into a disabled view. */}
        {/* Below md only (user decision, UX pass): everything — tabs, chips, actions — lives
            on the app bar via the bar-actions portal on desktop; this row is the mobile
            stand-in, where no bar exists. */}
        <div data-slot="run-tabs" className="flex flex-wrap items-end gap-1 md:hidden">
          <TabLink to={`/tasks/${run.id}`} active={tab === 'session'}>
            <MessageSquareTextIcon aria-hidden="true" className="size-3.5" />
            Session
          </TabLink>
          <TabLink to={`/tasks/${run.id}/changes`} active={tab === 'changes'}>
            <FileDiffIcon aria-hidden="true" className="size-3.5" />
            Changes
            {/* The diffstat rides its own tab (UX pass): "+1 −0" is what Changes holds, not a
                separate fact worth a chip of its own. */}
            {run.diffStat ? <DiffStatLabel stat={run.diffStat} className="ml-0.5" /> : null}
          </TabLink>
          <TabLink to={`/tasks/${run.id}/commits`} active={tab === 'commits'}>
            <GitCommitHorizontalIcon aria-hidden="true" className="size-3.5" />
            Commits
          </TabLink>
          <TabLink to={`/tasks/${run.id}/files`} active={tab === 'files'}>
            <FilesIcon aria-hidden="true" className="size-3.5" />
            Files
          </TabLink>
          {/* Below md only: the bar (and its portal) does not exist there, so the chips and
              the kebab keep the row's right side. */}
          <span className="ml-auto flex min-w-0 shrink-0 items-center gap-2 pb-1.5 md:hidden">
            <MetaRow run={run} automationsAvailable={health.data?.capabilities?.automations === true} />
            <ActionsKebab run={run} actions={actions} onToggleNotes={() => setNotesOpen((open) => !open)} onRename={beginRename} />
          </span>
        </div>
        <BarActions>
          {/* The task's views as compact icon tabs (user decision) — the bar carries the whole
              header now: where you are, whose task it is, and what you can do to it. */}
          <span data-slot="bar-tabs" role="tablist" aria-label="Task views" className="flex items-center gap-1.5">
            <BarTab to={`/tasks/${run.id}`} active={tab === 'session'} label="Session">
              <MessageSquareTextIcon aria-hidden="true" className="size-3.5" />
              Session
            </BarTab>
            {/* ONE git entry (user decision): the changes live on the branch, so the branch
                and its ± are one control. It opens the diff; the Changes/Commits split is a
                local toggle inside that area. */}
            <BarTab
              to={`/tasks/${run.id}/changes`}
              active={tab === 'changes' || tab === 'commits'}
              label={run.branch ? `Changes on ${run.branch}` : 'Changes'}
            >
              <GitBranchIcon aria-hidden="true" className="size-3.5" />
              {run.branch ? (
                <span data-slot="bar-branch" className="max-w-[18ch] truncate font-mono">
                  {run.branch}
                </span>
              ) : null}
              {run.diffStat ? <DiffStatLabel stat={run.diffStat} /> : null}
            </BarTab>
            <BarTab to={`/tasks/${run.id}/files`} active={tab === 'files'} label="Files">
              <FilesIcon aria-hidden="true" className="size-3.5" />
              Files
            </BarTab>
          </span>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
          {/* The task's context chips (PR, branch) live on the bar too (user decision) —
              identity beside the verbs that act on it. */}
          <MetaRow run={run} showBranch={false} bare automationsAvailable={health.data?.capabilities?.automations === true} />
          {/* No stateful buttons here (user decision: the bar must not jump as the run moves
              through its lifecycle). The ONE primary CTA floats over the content in a fixed
              spot, and Finish lives in the More menu under its real name. */}
          {/* Terminal is folded into the Open in… menu to save room in the actions row. */}
          {/* Icon-only on the bar (user decision): the full "Open in" label outweighed the row. */}
          <OpenInMenuForRun run={run} canResume={flags.terminal} onResume={() => actions.terminal.mutate()} iconOnly />
          {/* Everything past the state's primary actions folds behind one disclosure (#765). */}
          <SecondaryActionsMenu run={run} actions={actions} onToggleNotes={() => setNotesOpen((open) => !open)} onRename={beginRename} />
        </BarActions>

        <MonitoringSchedule run={run} />


        {/* Workflow steps moved to the context bar above the composer, and the take-over command
            moved to a button UNDER the composer (task-thread.tsx) — the sticky header stays shallow. */}
        {notesOpen ? <NotesPanel runId={run.id} /> : null}
      </div>

      {/* The stateful CTA FLOATS top-center, just under the bar (user decision): one fixed
          spot over the content, so the bar never reflows when Stop becomes Reply becomes
          Review changes — and the eye finds it where a notification would land. Anchored to
          this sticky header, so it centers on the CONTENT column whatever the sidebar's
          width, and stays pinned while the thread scrolls. md+ only — the mobile kebab and
          the composer itself cover small screens. */}
      {/* A full-width frosted band under the bar carries the button (user decision): the CTA
          reads as chrome, and thread text slides under a soft blur instead of colliding with
          a naked pill. The mask fades the blur out toward the bottom edge. */}
      <div
        data-slot="floating-cta"
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 z-30 hidden justify-center pt-2 pb-7 md:flex',
          // The frosted band belongs to SESSION, where thread text scrolls underneath. The git
          // and files tabs have their own toolbar on this line — there the button floats alone
          // in the toolbar's empty middle, and a full-width wash would gray the controls out.
          tab === 'session' &&
            'bg-gradient-to-b from-background/80 via-background/40 to-transparent backdrop-blur-[3px] [mask-image:linear-gradient(to_bottom,black_45%,transparent)]',
        )}
      >
        <span className="pointer-events-auto">
          <PrimaryCtaButton run={run} actions={actions} floating />
        </span>
      </div>

      <ConfirmDialog run={run} actions={actions} />
    </header>
  )
}

/**
 * "Open in…" session takeover (#open-in): resume the session in a real terminal, open the run's
 * worktree in a local editor / Finder / terminal / agent CLI, or copy its path.
 *
 * The menu itself is the shared `OpenInMenu` (components/open-in-menu.tsx); what lives here is
 * everything run-SPECIFIC — the resume item, which agent handoffs are currently usable, the
 * `(resume)` labelling, and the copy-path row. Renders when the session can be resumed OR the
 * machine offers worktree targets (both empty in hosted mode → nothing to show).
 */
function OpenInMenuForRun({
  run,
  canResume,
  onResume,
  iconOnly,
}: {
  run: ApiRun
  canResume: boolean
  onResume: () => void
  iconOnly?: boolean
}) {
  const targets = useOpenTargets()
  const providers = useProviderStatus()
  const open = useMutation({
    mutationFn: (target: string) => openRunIn(run.id, target),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const availableRunners = usableRunners(providers.data)
  // The action routes remain authoritative for a stale browser. Once the complete status has
  // arrived, hide only unavailable *agent* handoffs; editors, Finder, and file tools stay
  // available because they do not launch a provider.
  const agentAvailable = (runner: ApiRun['runner']) =>
    !providers.isSuccess || availableRunners.includes(runner ?? 'claude')
  const canResumeHere = canResume && agentAvailable(run.runner)
  const choices: OpenInChoice[] = run.worktreePath
    ? (targets.data?.targets ?? [])
        .filter((target) => {
          const runner = cliTargetRunner(target.id)
          return runner === undefined || agentAvailable(runner)
        })
        // Agent-CLI targets (#402): the one matching this run's own runner resumes THIS run's
        // session when one exists — label that explicitly so it reads as different from just
        // opening the editor/file-manager entries. Every other CLI (wrong backend, or no session
        // yet) still opens, just starts clean — no silent cross-backend resume attempt.
        .map((target) => {
          const resumes = cliTargetResumes(run, target.id)
          return {
            target,
            ...(resumes ? { suffix: ' (resume)', title: "Resume this run's session" } : {}),
          }
        })
    : []
  if (!canResumeHere && choices.length === 0) return null

  const copyPath = () => {
    const path = run.worktreePath
    if (!path) return
    void navigator.clipboard
      .writeText(path)
      .then(() => toast('Worktree path copied'))
      .catch(() => toast(`Path: ${path}`))
  }

  return (
    <OpenInMenu
      choices={choices}
      onPick={(target) => open.mutate(target)}
      // No trailing ellipsis (it read as a truncated label) — the chevron already says "menu".
      label="Open in"
      iconOnly={iconOnly}
      // On the bar every control shares the quiet ghost grammar (user decision).
      triggerVariant={iconOnly ? 'ghost' : 'outline'}
      title="Resume in a terminal, or open the worktree locally"
      leading={
        canResumeHere ? (
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

/** The mutations + confirm state, bundled so the desktop bar and the mobile kebab drive the
 *  exact same behavior. Every failure surfaces the server's own words as a danger toast. */
function useRunActions(run: ApiRun, onMarkedUnread?: () => void) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState<'cancel' | 'delete' | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  const onError = (error: Error) => toast(error.message, { tone: 'danger' })

  // Shared with the review panel's ✓ Accept (use-finish-run.ts) — the review-accept semantics
  // must be ONE implementation, not two buttons that happen to agree today.
  const finish = useFinishRun(run.id)
  const continuation = useContinuationProvider(run)
  const continueMutation = useMutation({
    mutationFn: async () => {
      if (!continuation.canContinue) return null
      return continueRun(run.id, { runner: continuation.runnerOverride })
    },
    onSuccess: (result) => {
      if (result !== null) invalidate()
    },
    onError,
  })
  const archive = useMutation({
    mutationFn: () => archiveRun(run.id, !run.archived),
    onSuccess: invalidate,
    onError,
  })
  // Mark unread (#775) drives the shared optimistic hook rather than a local mutation: the
  // cache choreography (clear `seenAt`, guarded rollback) belongs next to its read twin in
  // queries.ts, and no `invalidate` is wanted here — an invalidation would refetch the list
  // and reinstate the receipt before the server's own answer lands.
  const markUnreadMutation = useMarkRunUnseen()
  const markUnread = {
    isPending: markUnreadMutation.isPending,
    mutate: () => {
      // Before the mutation, so the Session tab's suppression is in place by the time the
      // optimistic write re-renders the thread and re-evaluates its auto-mark-read effect.
      onMarkedUnread?.()
      markUnreadMutation.mutate(run.id, { onError })
    },
  }
  const cancel = useMutation({ mutationFn: () => cancelRun(run.id), onSuccess: invalidate, onError })
  const deleteMutation = useMutation({
    mutationFn: () => deleteRun(run.id),
    onSuccess: () => {
      invalidate()
      // The run is gone — so is this page. Home is the only honest destination.
      void navigate('/')
    },
    onError,
  })
  const terminal = useMutation({
    mutationFn: () => openRunInCli(run.id),
    onError: (error: Error) => {
      // The legacy 409 fallback: no terminal emulator → the server sends the manual command;
      // put it on the clipboard so "no terminal" still ends with the user one paste away.
      if (error instanceof ApiError && error.command) {
        void copyToClipboard(error.command, 'No terminal found — command copied to clipboard.')
        return
      }
      onError(error)
    },
  })

  return {
    finish,
    continuation,
    continueRun: continueMutation,
    archive,
    markUnread,
    cancel,
    delete: deleteMutation,
    terminal,
    confirming,
    setConfirming,
  }
}

type RunActions = ReturnType<typeof useRunActions>

/**
 * The header's ONE stateful CTA (design review): a fixed slot whose label, tone and action follow
 * the lifecycle — Stop while working, Reply when the agent waits, Review changes at the gate,
 * Retry after a failure, Reopen once closed. `primaryRunCta` (run-actions.ts) owns the mapping;
 * this renders it and wires each kind to its verb:
 *  - stop    → the cancel confirm (the same dialog the kebab uses; stopping deserves a confirm)
 *  - reply   → scroll to + focus the composer (the reply IS typing)
 *  - review  → scroll the review panel into view
 *  - retry / reopen → resume the session (gated on the provider's canContinue, like Continue was)
 */
function PrimaryCtaButton({ run, actions, floating = false }: { run: ApiRun; actions: RunActions; floating?: boolean }) {
  const navigate = useNavigate()
  const cta = primaryRunCta(run)
  if (!cta) return null
  const resumes = cta.kind === 'retry' || cta.kind === 'reopen'
  const disabled = resumes && (actions.continueRun.isPending || !actions.continuation.canContinue)
  const iconClass = undefined
  const icon =
    cta.kind === 'stop' ? <CircleStopIcon aria-hidden="true" className={iconClass} />
    : cta.kind === 'reply' ? <SendHorizontalIcon aria-hidden="true" className={iconClass} />
    : cta.kind === 'review' ? <ScanEyeIcon aria-hidden="true" className={iconClass} />
    : cta.kind === 'retry' ? <RotateCcwIcon aria-hidden="true" className={iconClass} />
    : <PlayIcon aria-hidden="true" className={iconClass} />
  const title =
    cta.kind === 'stop' ? 'Stop the run'
    : cta.kind === 'reply' ? 'Reply to the agent'
    : cta.kind === 'review' ? 'Jump to the review'
    : (actions.continuation.reason ?? 'Reopen the session')
  const onClick = () => {
    if (cta.kind === 'stop') actions.setConfirming('cancel')
    else if (cta.kind === 'reply') {
      const focusComposer = () => {
        const composer = document.querySelector<HTMLTextAreaElement>('textarea')
        composer?.scrollIntoView({ block: 'center' })
        composer?.focus()
      }
      if (document.querySelector('textarea')) focusComposer()
      else {
        // Same bar-wide rule as review: the composer is Session's — go there first.
        navigate(`/tasks/${run.id}`)
        requestAnimationFrame(() => requestAnimationFrame(focusComposer))
      }
    } else if (cta.kind === 'review') {
      const panel = document.querySelector('[data-slot="review-panel"]')
      if (panel) {
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else {
        // The button lives on the app bar now, visible from every tab — but the review panel
        // only exists in Session. From elsewhere, go there first; the panel scrolls itself
        // into view on the next frame, once Session has rendered.
        navigate(`/tasks/${run.id}`)
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            document
              .querySelector('[data-slot="review-panel"]')
              ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
          ),
        )
      }
    } else actions.continueRun.mutate()
  }
  return (
    <Button
      data-slot="primary-cta"
      data-cta={cta.kind}
      variant={cta.tone === 'primary' ? 'primary' : cta.tone === 'neutral' ? 'contrast' : 'outline'}
      size={floating ? 'default' : 'sm'}
      title={title}
      disabled={disabled}
      onClick={onClick}
      // Calm states (Reopen, Stop) go SOLID contrast with a violet icon — chrome-black with the
      // brand wink; urgent states keep full purple; failure keeps danger on an outline. The
      // floating variant carries a real shadow — it sits OVER the content.
      className={cn(
        cta.tone === 'danger' && 'border-danger/40 text-danger hover:bg-danger/10',
        floating && 'shadow-lg',
      )}
    >
      {icon}
      {cta.label}
    </Button>
  )
}

async function copyToClipboard(text: string, doneMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(doneMessage)
  } catch {
    // No clipboard access (permissions, http) — show the command itself; it is the payload.
    toast(`Run manually: ${text}`)
  }
}

/** One compact icon tab on the app bar — the underline grammar shrunk to the bar's height.
 *  A real Link, like TabLink: every view is a URL. */
function BarTab({ to, active, label, children }: { to: string; active: boolean; label: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-7 items-center gap-1 rounded-sm px-2 text-[11px] font-medium transition-colors',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </Link>
  )
}

/**
 * The desktop actions, rendered onto the APP BAR's right side (user decision, UX pass) through
 * the shell's `bar-actions` slot — the verbs act on the whole task, so they sit with its name,
 * in view on every tab. Where no bar exists (mobile has none; bare test mounts), the buttons
 * stay here in the header — the kebab still covers small screens, and nothing is lost.
 */
function BarActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setTarget(document.querySelector<HTMLElement>('[data-slot="bar-actions"]'))
  }, [])
  const content = (
    <div data-slot="run-actions" className="hidden items-center gap-1.5 md:flex">
      {children}
    </div>
  )
  return target ? createPortal(content, target) : content
}

/**
 * The rename input (#389), now opened from the actions menu (user decision: the header shows
 * no title of its own — the shell's bar does). Renders in the title's old spot, already in
 * edit mode; Enter/blur commit through `usePatchRun`, Escape closes it.
 */
function RenameRow({ run, onDone }: { run: ApiRun; onDone: () => void }) {
  const patch = usePatchRun(run.id)
  const title = runTitle(run)
  const editor = useTitleEditor(title, (next) =>
    patch.mutate({ title: next }, { onError: (error) => toast(error.message, { tone: 'danger' }) }),
  )
  // Open on mount; close the row only after editing actually started, or the mount-time
  // "not editing yet" state would call onDone before begin()'s set lands.
  const startedRef = useRef(false)
  if (editor.editing) startedRef.current = true
  useEffect(() => {
    editor.begin()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once, on mount
  }, [])
  useEffect(() => {
    if (startedRef.current && !editor.editing) onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editor object is not stable
  }, [editor.editing])
  if (!editor.editing) return null
  return (
    <div className="mb-1 flex items-center">
      <TitleEditInput editor={editor} className="flex-1 text-[15px] font-semibold" />
    </div>
  )
}

/** The Claude burst for a claude run, a neutral bot otherwise — the runner's face in the Agent
 *  stat. */
function RunnerIcon({ runner, className }: { runner: ApiRun['runner']; className?: string }) {
  // Every known backend ships a brand logo; only a legacy record with no runner falls to the bot.
  return runner ? (
    <RunnerLogo runner={runner} className={className} />
  ) : (
    <BotIcon className={className} aria-hidden="true" />
  )
}

/** The Agent stat's value: the runner's face and name, a button that opens the runner / account /
 *  model breakdown (spec 2026-07-29-agent-profiles, #416). The account only ever had a home here,
 *  so the click-through keeps it reachable while the strip stays to the mockup's icon + name. */
function AgentStat({ run, runner }: { run: ApiRun; runner: NonNullable<ApiRun['runner']> }) {
  const profiles = useAgentProfiles()
  const model = run.model ?? 'auto'
  // The account is read from the STEP that actually spawned (see the agent-profiles spec): a
  // resumed run reattaches to the session's account, whatever the composer override said.
  const accountId = [...run.steps].reverse().find((step) => step.profileId)?.profileId
  const account =
    accountId === undefined
      ? undefined
      : accountId === DEFAULT_AGENT_ACCOUNT_ID
        ? 'default'
        : profiles.data?.profiles.find((p) => p.id === accountId)?.label ?? `${accountId} (removed)`
  // The canonical `provider/model` the run actually resolved to (#405), shown only when it says
  // something `model` does not (#546): `model` is the free text the caller ASKED for, so on a
  // runner pointed at a custom endpoint the two genuinely differ, and "which provider served
  // this?" is a question only this field answers. Absent on pre-#405 records and skipped when it
  // merely repeats `model` — an identity nothing wrote down is not one this menu may invent.
  const identity = run.modelIdentity && run.modelIdentity !== model ? run.modelIdentity : undefined
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="agent-badge"
          aria-label={`Agent: ${runner}${account ? `, account ${account}` : ''}, model ${model}`}
          className={cn(chipClass, 'text-foreground')}
        >
          <RunnerIcon runner={runner} className="size-4 shrink-0" />
          {runner}
          {chevron}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[9rem]">
        <DropdownMenuLabel className="font-mono text-xs font-normal text-muted-foreground">
          runner: {runner}
        </DropdownMenuLabel>
        {account ? (
          <DropdownMenuLabel
            data-slot="agent-badge-account"
            className="font-mono text-xs font-normal text-muted-foreground"
          >
            account: {account}
          </DropdownMenuLabel>
        ) : null}
        <DropdownMenuLabel className="font-mono text-xs font-normal text-muted-foreground">
          model: {model}
        </DropdownMenuLabel>
        {identity ? (
          <DropdownMenuLabel
            data-slot="agent-badge-identity"
            className="font-mono text-xs font-normal text-muted-foreground"
          >
            identity: {identity}
          </DropdownMenuLabel>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The run's read-only meta — Cost · Tokens · Agent · Mode — as a compact row UNDER the composer
 *  (task-thread.tsx). Plan and Status left the old strip (they became the context tab and the
 *  paused hint); these are the facts that still had nowhere else to live. Each renders only when
 *  the record carries it — absence is absence, not a placeholder. */
export function RunMetaFooter({ run, pickers }: { run: ApiRun; pickers?: ReactNode }) {
  const config = useConfig()
  const health = useHealth()
  const metricVisibility = usageMetricVisibility(health.data)
  // Same resolution as the run actually executes with (input.runner ?? config.defaultRunner).
  const runner = run.runner ?? config.data?.defaultRunner ?? 'claude'
  const model = run.model ?? 'auto'
  const showTokens =
    metricVisibility.tokens && (run.inputTokens !== undefined || run.outputTokens !== undefined)
  const showCost = metricVisibility.cost && !!run.costUsd
  return (
    <div data-slot="run-meta-footer" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      {/* The workflow's one remaining home on the thread (the header chip retired with the
          meta line): which pipeline ran this task. */}
      <FooterStat label="Workflow">
        <span className="truncate">{workflowLabel(run)}</span>
      </FooterStat>
      {showCost ? (
        <FooterStat label="Cost">
          <span className="tabular-nums">{formatCost(run.costUsd!)}</span>
        </FooterStat>
      ) : null}
      {showTokens ? (
        <FooterStat label="Tokens">
          <DirectionalUsage inputTokens={run.inputTokens} outputTokens={run.outputTokens} />
        </FooterStat>
      ) : null}
      {/* When the run can be continued, the runner/model PICKERS (moved out of the composer) go
          here. Otherwise — a live session that can't switch backend — the same facts render as
          read-only pills, so the row reads the same either way instead of flipping to a label list. */}
      {pickers ?? (
        <>
          <AgentStat run={run} runner={runner} />
          <span
            aria-label={`Model ${model}`}
            className={cn(chipClass, 'cursor-default hover:bg-card hover:text-muted-foreground')}
          >
            {model}
          </span>
        </>
      )}
    </div>
  )
}

/** One "LABEL value" pair on the meta footer — small-caps label, body-size value, inline. */
function FooterStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span data-slot="meta-stat" className="inline-flex items-center gap-1.5">
      <span className="text-[10px] font-medium tracking-wide text-soft-foreground uppercase">{label}</span>
      <span className="flex items-center gap-1.5 text-[13px] leading-none font-medium whitespace-nowrap text-foreground">
        {children}
      </span>
    </span>
  )
}

/** workflow, branch chip, ± on the left; the labelled stat strip on the right (mockup
 *  `.meta-row`). Each part renders only when the record carries it — absence is absence,
 *  not a placeholder. */
function MetaRow({
  run,
  showBranch = true,
  bare = false,
  automationsAvailable = false,
}: {
  run: ApiRun
  /** Off on the app bar, where the branch rides the Commits tab instead of a chip. */
  showBranch?: boolean
  /** The app bar's grammar: borderless ghost chips matching the icon tabs. */
  bare?: boolean
  /** `capabilities.automations` (#801). A run launched while automations were on keeps its
   *  `run.automation` provenance forever, so the chip must survive the flag going off — as
   *  plain text, because the route it used to link to is disabled. */
  automationsAvailable?: boolean
}) {
  // #526: the issue chip may be synthesized from the CEZ:ISSUE marker, and the only repository
  // such a link may name is the one on screen — never the transcript's.
  const repoBase = useProjectRepoBase()
  // At most two references here, so this is a batch of one or two rather than of a table — but it
  // goes through the same seam, which is what keeps the header's chip and the table's chip
  // answering identically for the same PR.
  const projectId = useReferenceProjectId()
  const references = useMemo(() => taskReferences(run, repoBase), [run, repoBase])
  const referenceRequests = useMemo(
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
  const parts: ReactNode[] = []
  if (showBranch && run.branch) {
    parts.push(
      <span
        key="branch"
        data-slot="branch-chip"
        className="rounded-sm inline-flex h-6 items-center border border-border bg-card px-2 font-mono text-xs font-medium"
      >
        {run.branch}
      </span>,
    )
  }
  // EVERY PR the task points at, in `taskReferences` order — the same order, and the same
  // statuses, the global Tasks table paints. A task opened on someone else's PR that pushes a
  // follow-up of its own is about both, and its own page is the last place that should have to
  // pick one.
  //
  // A reference with no URL still gets its chip, exactly as All tasks paints it: a number-only
  // reference is what a `CEZ:PR` declaration looks like before any link is scraped, and the two
  // pages read their repository from DIFFERENT places (this one from health's remote, All tasks
  // from the project registry's `repoUrl`) — so "no URL here" never means "nothing to show".
  // `ReferenceChip` degrades such a chip to inert text on its own.
  const prReferences = references.filter((reference) => reference.kind === 'PR')
  for (const reference of prReferences) {
    parts.push(
      <ReferenceChip
        key={`pr-${reference.number}`}
        reference={reference}
        taskTitle={runTitle(run)}
        bare={bare}
        className={bare ? undefined : 'h-5'}
        // Shown only on a chip that IS conflicting — the chip decides that, being the thing that
        // knows — and mounted only while its panel is open. The same component the Tasks table
        // hands its chips, so both send the same prompt on the same seam.
        conflictAction={<ResolveConflictsButton run={run} prNumber={reference.number} />}
      />,
    )
  }
  // The one PR chip `taskReferences` cannot express: a forge URL whose last segment is not a
  // number (`taskPrUrl`'s own tolerance — an unrecognized forge still gets a working link, just
  // without a number cezar would be inventing). Gated on that URL not being painted already,
  // NOT on there being no chips at all: today every `pullRequestUrl` is a GitHub `…/pull/N` and
  // the two are the same test, but a forge whose PR URLs do not end in a number (#847's GitLab
  // adapter) would have a `prNumber` chip standing in front of a link that then never rendered.
  const prUrl = taskPrUrl(run)
  if (prUrl && isHttpUrl(prUrl) && !prReferences.some((reference) => reference.url === prUrl)) {
    parts.push(
      <ReferenceChip
        key="pr"
        reference={{ kind: 'PR', url: prUrl }}
        taskTitle={runTitle(run)}
        className="h-6"
      />,
    )
  }
  const issueUrl = taskIssueUrl(run, repoBase)
  if (issueUrl && isHttpUrl(issueUrl)) {
    const number = prNumber(issueUrl)
    parts.push(
      <ReferenceChip
        key="issue"
        reference={{ kind: 'Issue', ...(number ? { number: Number(number) } : {}), url: issueUrl }}
        taskTitle={runTitle(run)}
        bare={bare}
        className={bare ? undefined : 'h-6'}
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
          className="rounded-sm inline-flex h-6 items-center border border-border bg-card px-2 text-xs font-medium hover:text-foreground"
        >
          Automation
        </Link>
      ) : (
        <span
          key="automation"
          data-slot="automation-origin"
          title="Automations are off on this server (CEZ_AUTOMATIONS)"
          className="rounded-sm inline-flex h-6 items-center border border-border bg-card px-2 text-xs font-medium"
        >
          Automation
        </span>
      ),
    )
  }

  // The provider (#871) is what lets the header's PR/issue chips carry live status — the
  // same seam the task tables hydrate through, so the two surfaces answer identically.
  return (
    <ReferenceStatusProvider projectId={projectId} requests={referenceRequests}>
      <div
        data-slot="run-meta"
        className="flex min-w-0 items-center gap-x-2 text-xs text-muted-foreground"
      >
        {/* Identity chips, spaced by the row gap — no middot separators (house rule). The
            workflow chip left (it lives under the composer) and the diffstat rides the
            Changes tab now, so what remains is the task's references and its branch. */}
        {parts.map((part, index) => (
          <Fragment key={index}>{part}</Fragment>
        ))}
      </div>
    </ReferenceStatusProvider>
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


/** The <md action surface: everything the desktop bar offers, folded into a kebab menu next to
 *  the pill (the mockup's mobile pattern — `.tabs-row .actions { display:none }` under 768px). */
function ActionsKebab({
  run,
  actions,
  onToggleNotes,
  onRename,
}: {
  run: ApiRun
  actions: RunActions
  onToggleNotes: () => void
  onRename: () => void
}) {
  const flags = runActionFlags(run)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Run actions" className="md:hidden">
          <EllipsisVerticalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-slot="run-actions-menu">
        <DropdownMenuItem data-action="rename" onSelect={onRename}>
          <PencilIcon aria-hidden="true" /> Rename
        </DropdownMenuItem>
        {flags.finish ? (
          <DropdownMenuItem title={finishTitle(run.status)} onSelect={() => actions.finish.mutate()}>
            <CheckIcon aria-hidden="true" /> {finishLabel(run.status)}
          </DropdownMenuItem>
        ) : null}
        {flags.continueRun ? (
          <DropdownMenuItem
            disabled={!actions.continuation.canContinue || actions.continueRun.isPending}
            title={actions.continuation.reason}
            onSelect={() => actions.continueRun.mutate()}
          >
            <PlayIcon aria-hidden="true" /> Continue
          </DropdownMenuItem>
        ) : null}
        {flags.terminal ? (
          <DropdownMenuItem onSelect={() => actions.terminal.mutate()}>
            <SquareTerminalIcon aria-hidden="true" /> Terminal
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onToggleNotes}>
          <FileTextIcon aria-hidden="true" /> Notes
        </DropdownMenuItem>
        {flags.markUnread ? (
          <DropdownMenuItem
            disabled={actions.markUnread.isPending}
            onSelect={() => actions.markUnread.mutate()}
          >
            <MailIcon aria-hidden="true" /> Mark unread
          </DropdownMenuItem>
        ) : null}
        {flags.archive ? (
          <DropdownMenuItem onSelect={() => actions.archive.mutate()}>
            {run.archived ? <ArchiveRestoreIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
            {run.archived ? 'Unarchive' : 'Archive'}
          </DropdownMenuItem>
        ) : null}
        {flags.cancel || flags.deleteRun ? <DropdownMenuSeparator /> : null}
        {flags.cancel ? (
          <DropdownMenuItem variant="destructive" onSelect={() => actions.setConfirming('cancel')}>
            <CircleStopIcon aria-hidden="true" /> Cancel
          </DropdownMenuItem>
        ) : null}
        {flags.deleteRun ? (
          <DropdownMenuItem variant="destructive" onSelect={() => actions.setConfirming('delete')}>
            <Trash2Icon aria-hidden="true" /> Delete
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The desktop overflow (#765): the secondary actions that used to crowd the row, folded behind
 *  one "More actions" disclosure. The state's primary actions (Finish / Continue / Open in…) stay
 *  inline beside it; the mobile kebab still carries the full set, so this is desktop-only. Renders
 *  nothing when there is no secondary action for the current state. */
function SecondaryActionsMenu({
  run,
  actions,
  onToggleNotes,
  onRename,
}: {
  run: ApiRun
  actions: RunActions
  onToggleNotes: () => void
  onRename: () => void
}) {
  const flags = runActionFlags(run)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="More actions">
          <EllipsisVerticalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-slot="run-actions-overflow">
        {/* Finish under its REAL name per state (user decision): closing a waiting session and
            accepting a review without a PR are different acts and read as such here. */}
        {flags.finish ? (
          <DropdownMenuItem data-action="finish" title={finishTitle(run.status)} onSelect={() => actions.finish.mutate()}>
            <CheckIcon aria-hidden="true" /> {finishLabel(run.status)}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem data-action="rename" onSelect={onRename}>
          <PencilIcon aria-hidden="true" /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onToggleNotes}>
          <FileTextIcon aria-hidden="true" /> Notes
        </DropdownMenuItem>
        {flags.markUnread ? (
          <DropdownMenuItem
            disabled={actions.markUnread.isPending}
            onSelect={() => actions.markUnread.mutate()}
          >
            <MailIcon aria-hidden="true" /> Mark unread
          </DropdownMenuItem>
        ) : null}
        {flags.archive ? (
          <DropdownMenuItem onSelect={() => actions.archive.mutate()}>
            {run.archived ? <ArchiveRestoreIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
            {run.archived ? 'Unarchive' : 'Archive'}
          </DropdownMenuItem>
        ) : null}
        {flags.cancel || flags.deleteRun ? <DropdownMenuSeparator /> : null}
        {flags.cancel ? (
          <DropdownMenuItem variant="destructive" onSelect={() => actions.setConfirming('cancel')}>
            <CircleStopIcon aria-hidden="true" /> Cancel
          </DropdownMenuItem>
        ) : null}
        {flags.deleteRun ? (
          <DropdownMenuItem variant="destructive" onSelect={() => actions.setConfirming('delete')}>
            <Trash2Icon aria-hidden="true" /> Delete
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The destructive confirms — one dialog, two scripts. Never a native confirm(). */
function ConfirmDialog({ run, actions }: { run: ApiRun; actions: RunActions }) {
  const confirming = actions.confirming
  return (
    <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && actions.setConfirming(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirming === 'delete' ? 'Delete this task?' : 'Cancel this task?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirming === 'delete' ? (
              <>
                This removes the run, its transcript, its worktree and its branch. There is no
                undo.
                <span className="mt-1 block truncate font-medium text-foreground" title={runTitle(run)}>
                  {runTitle(run)}
                </span>
              </>
            ) : (
              'The agent is stopped and the run completes as cancelled. The worktree stays.'
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            className="bg-danger text-danger-foreground hover:brightness-[0.96]"
            onClick={() => {
              if (confirming === 'delete') actions.delete.mutate()
              else actions.cancel.mutate()
              actions.setConfirming(null)
            }}
          >
            {confirming === 'delete' ? 'Delete' : 'Cancel the run'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** "Take over in terminal" — the resume/handoff command (`cd … && claude --resume …`) copied on
 *  click, collapsed from the old full-width monospace line so the raw path never sits on screen.
 *  Mounted UNDER the composer (task-thread.tsx). Renders nothing when the run can't be resumed.
 *  Local-machine phrasing; hosted mode (R5, `capabilities.localHandoff`) will swap the cd-prefix. */
export function TakeOverButton({ run }: { run: ApiRun }) {
  const hint = resumeHint(run)
  if (!hint) return null
  return (
    <button
      type="button"
      data-slot="resume-hint"
      title={`Copy: ${hint}`}
      onClick={() => void copyToClipboard(hint, 'Command copied to clipboard.')}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-soft-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <SquareTerminalIcon className="size-3.5 shrink-0" aria-hidden="true" />
      Take over in terminal
    </button>
  )
}

/** The handoff journal (spec 007) as rendered markdown — fetched only while open. */
function NotesPanel({ runId }: { runId: string }) {
  const handoff = useRunHandoff(runId)
  return (
    <div
      data-slot="notes-panel"
      className="mb-3 max-h-72 overflow-y-auto rounded-md border border-border bg-card px-4 py-3"
    >
      {handoff.isPending ? (
        <p className="text-xs text-soft-foreground">Loading notes…</p>
      ) : handoff.isError ? (
        <p className="text-xs text-danger">{handoff.error.message}</p>
      ) : handoff.data.trim().length > 0 ? (
        <Markdown>{handoff.data}</Markdown>
      ) : (
        <p className="text-xs text-soft-foreground">
          No notes yet — the handoff file is seeded when the task starts.
        </p>
      )}
    </div>
  )
}
