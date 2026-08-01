import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  CheckIcon,
  CircleStopIcon,
  CopyIcon,
  EllipsisVerticalIcon,
  FileTextIcon,
  PencilIcon,
  PlayIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import { Link, useNavigate } from '@/lib/project-router'

import { ApiError, archiveRun, cancelRun, continueRun, deleteRun, openRunIn, openRunInCli } from '@/api/client'
import {
  queryKeys,
  useAgentProfiles,
  useConfig,
  useHealth,
  useOpenTargets,
  usePatchRun,
  useProjectRepoBase,
  useProviderStatus,
  useRunHandoff,
  useRuns,
} from '@/api/queries'
import { DEFAULT_AGENT_ACCOUNT_ID, type ApiRun, type OpenTarget } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { TitleEditInput, useTitleEditor } from '@/components/editable-title'
import { Pill } from '@/components/pill'
import { ReferenceChip } from '@/components/reference-chip'
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
import { deriveAttention } from '@/lib/attention'
import { queuePositions, runTitle } from '@/lib/task-groups'
import { usableRunners } from '@/lib/provider-status'
import { formatCost, prNumber, taskIssueUrl, taskPrUrl, workflowLabel } from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { isHttpUrl } from '@/lib/utils'

import { Markdown } from './markdown'
import { useContinuationProvider } from './continuation-provider'
import { cliTargetResumes, cliTargetRunner, finishTitle, resumeHint, runActionFlags } from './run-actions'
import { WorkflowSteps } from './step-rail'
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
  planTally,
  tab = 'session',
}: {
  run: ApiRun
  planTally?: { done: number; total: number }
  tab?: RunTab
}) {
  const attention = deriveAttention(run)
  const flags = runActionFlags(run)
  const hint = resumeHint(run)
  const [notesOpen, setNotesOpen] = useState(false)
  const actions = useRunActions(run)

  // The queue position a parked run shows in its pill ("queued #2"). Reads the shared runs-list
  // query — already warm from the sidebar quick-list — because position is a property of the
  // whole queue, not of this record.
  const runs = useRuns()
  const health = useHealth()
  const metricVisibility = usageMetricVisibility(health.data)
  const queuePosition =
    run.status === 'queued' ? queuePositions(runs.data ?? []).get(run.id) : undefined

  return (
    <header
      data-slot="run-header"
      className="sticky top-0 z-20 border-b border-border bg-background/95 px-4 pt-3 backdrop-blur md:px-6"
    >
      <div className="mx-auto w-full max-w-[var(--measure)]">
        <div className="flex min-w-0 items-center gap-2">
          <EditableTitle run={run} />
          <span className="ml-auto flex shrink-0 items-center gap-2.5">
            {planTally ? (
              // The plan dock's compact mirror (spec: "mirrored as a compact progress line in
              // the run header").
              <span data-slot="plan-mirror" className="text-[11px] text-soft-foreground tabular-nums">
                Plan {planTally.done}/{planTally.total}
              </span>
            ) : null}
            <Pill dot={attention.tone} pulse={attention.pulse}>
              {attention.label}
              {queuePosition !== undefined ? ` #${queuePosition}` : ''}
            </Pill>
            <ActionsKebab run={run} actions={actions} onToggleNotes={() => setNotesOpen((open) => !open)} />
          </span>
        </div>

        <MetaRow
          run={run}
          showTokens={metricVisibility.tokens}
          showCost={metricVisibility.cost}
        />
        <MonitoringSchedule run={run} />

        <div data-slot="run-tabs" className="mt-2.5 flex items-end gap-1">
          <TabLink to={`/tasks/${run.id}`} active={tab === 'session'}>
            Session
          </TabLink>
          <TabLink to={`/tasks/${run.id}/changes`} active={tab === 'changes'}>
            Changes
          </TabLink>
          <TabLink to={`/tasks/${run.id}/commits`} active={tab === 'commits'}>
            Commits
          </TabLink>
          <TabLink to={`/tasks/${run.id}/files`} active={tab === 'files'}>
            Files
          </TabLink>

          <div data-slot="run-actions" className="ml-auto hidden items-center gap-1 pb-1 md:flex">
            {flags.finish ? (
              <Button variant="outline" size="sm" title={finishTitle(run.status)} onClick={() => actions.finish.mutate()}>
                <CheckIcon aria-hidden="true" />
                Finish
              </Button>
            ) : null}
            {flags.continueRun ? (
              <Button
                variant="outline"
                size="sm"
                title={actions.continuation.reason ?? 'Reopen the session'}
                disabled={actions.continueRun.isPending || !actions.continuation.canContinue}
                onClick={() => actions.continueRun.mutate()}
              >
                <PlayIcon aria-hidden="true" />
                Continue
              </Button>
            ) : null}
            {/* Terminal is folded into the Open in… menu to save room in the actions row. */}
            <OpenInMenuForRun run={run} canResume={flags.terminal} onResume={() => actions.terminal.mutate()} />
            <Button
              variant="ghost"
              size="sm"
              title="Handoff notes — what the agent did and what's left"
              aria-expanded={notesOpen}
              onClick={() => setNotesOpen((open) => !open)}
            >
              <FileTextIcon aria-hidden="true" />
              Notes
            </Button>
            {flags.archive ? (
              <Button variant="ghost" size="sm" onClick={() => actions.archive.mutate()}>
                {run.archived ? <ArchiveRestoreIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
                {run.archived ? 'Unarchive' : 'Archive'}
              </Button>
            ) : null}
            {flags.cancel ? (
              <Button variant="danger-ghost" size="sm" onClick={() => actions.setConfirming('cancel')}>
                <CircleStopIcon aria-hidden="true" />
                Cancel
              </Button>
            ) : null}
            {flags.deleteRun ? (
              <Button variant="danger-ghost" size="sm" onClick={() => actions.setConfirming('delete')}>
                <Trash2Icon aria-hidden="true" />
                Delete
              </Button>
            ) : null}
          </div>
        </div>

        {run.steps.length > 0 ? (
          <div className="border-t border-border pt-2 pb-1">
            <WorkflowSteps runId={run.id} steps={run.steps} />
          </div>
        ) : null}

        {hint ? <ResumeHintLine hint={hint} /> : null}
        {notesOpen ? <NotesPanel runId={run.id} /> : null}
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
}: {
  run: ApiRun
  canResume: boolean
  onResume: () => void
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
function useRunActions(run: ApiRun) {
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
    cancel,
    delete: deleteMutation,
    terminal,
    confirming,
    setConfirming,
  }
}

type RunActions = ReturnType<typeof useRunActions>

async function copyToClipboard(text: string, doneMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(doneMessage)
  } catch {
    // No clipboard access (permissions, http) — show the command itself; it is the payload.
    toast(`Run manually: ${text}`)
  }
}

/**
 * The editable title (#389): a plain h1 with a pencil that only appears on hover (mockup
 * `.pencil-btn`), flipping into an inline input. Enter/blur commit through `usePatchRun`
 * (the server stores it as both `title` and `titleSummary`), Escape abandons the draft.
 * The rename machine itself is shared with the Tasks table (`components/editable-title.tsx`).
 */
function EditableTitle({ run }: { run: ApiRun }) {
  const patch = usePatchRun(run.id)
  const title = runTitle(run)
  const editor = useTitleEditor(title, (next) =>
    patch.mutate({ title: next }, { onError: (error) => toast(error.message, { tone: 'danger' }) }),
  )

  if (editor.editing) {
    return <TitleEditInput editor={editor} className="flex-1 text-[15px] font-semibold" />
  }

  return (
    <span className="group flex min-w-0 items-center gap-1">
      <h1 className="min-w-0 truncate text-[15px] font-semibold" title={run.task}>
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

/** workflow · branch chip · ± on the left; tokens · cost · agent icon on the right (mockup
 *  `.meta-row`, #416). Each part renders only when the record carries it — absence is absence,
 *  not a placeholder. Runner and model no longer sit in the loose dot-list (#416): they read as
 *  a status for the *active* session, so they move into the agent badge next to the token
 *  count, revealed on hover/focus rather than always-on text. */
function MetaRow({
  run,
  showTokens,
  showCost,
}: {
  run: ApiRun
  showTokens: boolean
  showCost: boolean
}) {
  // #526: the issue chip may be synthesized from the CEZ:ISSUE marker, and the only repository
  // such a link may name is the one on screen — never the transcript's.
  const repoBase = useProjectRepoBase()
  // `workflowLabel` so an inline chain shows its first step's name, not the bare "(planned)"
  // placeholder — which reads like a status next to the live status pill.
  const parts: ReactNode[] = [<span key="workflow">{workflowLabel(run)}</span>]
  if (run.branch) {
    parts.push(
      <span
        key="branch"
        data-slot="branch-chip"
        className="rounded-sm border border-border bg-card px-1.5 py-px font-mono text-[11px] font-medium"
      >
        {run.branch}
      </span>,
    )
  }
  const prUrl = taskPrUrl(run)
  if (prUrl && isHttpUrl(prUrl)) {
    const number = prNumber(prUrl)
    parts.push(
      <ReferenceChip
        key="pr"
        reference={{ kind: 'PR', ...(number ? { number: Number(number) } : {}), url: prUrl }}
        taskTitle={runTitle(run)}
        className="h-5"
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
        className="h-5"
      />,
    )
  }
  if (run.diffStat) parts.push(<DiffStatLabel key="diff" stat={run.diffStat} />)
  if (run.automation) {
    parts.push(
      <Link
        key="automation"
        to={`/automations/${encodeURIComponent(run.automation.automationId)}/log`}
        className="rounded-sm border border-border bg-card px-1.5 py-px text-[11px] font-medium hover:text-foreground"
      >
        Automation
      </Link>,
    )
  }

  const usage: ReactNode[] = []
  if (showTokens && (run.inputTokens !== undefined || run.outputTokens !== undefined)) {
    usage.push(
      <DirectionalUsage
        key="tokens"
        inputTokens={run.inputTokens}
        outputTokens={run.outputTokens}
      />,
    )
  }
  if (showCost && run.costUsd) {
    usage.push(
      <span key="cost" className="tabular-nums">
        {formatCost(run.costUsd)}
      </span>,
    )
  }

  return (
    <div
      data-slot="run-meta"
      className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span className="text-soft-foreground" aria-hidden="true">
              ·
            </span>
          ) : null}
          {part}
        </Fragment>
      ))}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {usage.map((part, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <span className="text-soft-foreground" aria-hidden="true">
                ·
              </span>
            ) : null}
            {part}
          </Fragment>
        ))}
        <AgentBadge run={run} />
      </span>
    </div>
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

/** The agent icon by the token counter (#416): hover/focus reveals the runner, account and model —
 *  the answer to "what am I actually running here?" — without turning them into permanent text next
 *  to the live status pill. Always rendered (a run always has an effective runner, `model`
 *  reads "auto" when the runner picks it), and reuses the same click/keyboard-accessible
 *  `DropdownMenu` as the rest of this header instead of inventing a hover-only affordance. */
function AgentBadge({ run }: { run: ApiRun }) {
  // The record keeps only what the caller ASKED for: `POST /api/runs` persists the raw optional
  // `runner` (`src/runs/store.ts`), while the run actually executes as
  // `input.runner ?? config.defaultRunner` (`src/workflows/run.ts`). Mirror that resolution —
  // hardcoding 'claude' would name the wrong agent on a repo whose `defaultRunner` is
  // codex/opencode, and "which agent produced this?" is the one question #416 exists to answer.
  // 'claude' stays the last resort only while the active project's config is in flight.
  // `/api/health` describes the boot project and can name the wrong runner on scoped routes.
  const config = useConfig()
  const profiles = useAgentProfiles()
  const runner = run.runner ?? config.data?.defaultRunner ?? 'claude'
  const model = run.model ?? 'auto'
  // The account is read from the STEP that actually spawned, never from the run's composer
  // override or the project's current selection (spec 2026-07-29-agent-profiles): the override is
  // absent whenever the run just followed the project, and the project's selection can have been
  // changed since — both would name an account this run may never have touched. The last step that
  // recorded one is what ran; `sessionId` and `profileId` are a pair for exactly this reason.
  const accountId = [...run.steps].reverse().find((step) => step.profileId)?.profileId
  const account = accountId === undefined
    ? undefined
    : accountId === DEFAULT_AGENT_ACCOUNT_ID
      ? 'default'
      // A deleted account still names the folder this run's sessions live in, so the id is shown
      // rather than swallowed — "gone" is the useful half of that answer.
      : profiles.data?.profiles.find((p) => p.id === accountId)?.label ?? `${accountId} (removed)`
  const summary = [runner, account, model].filter(Boolean).join(' · ')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="agent-badge"
          title={summary}
          aria-label={`Agent: ${runner}, ${account ? `account ${account}, ` : ''}model ${model}`}
          className="flex min-w-0 shrink items-center gap-1.5 rounded-sm px-1 py-1 text-soft-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <BotIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {/* READ, not just reachable. This was an icon alone, and "which agent, account and model
              produced this?" turned out to be unanswerable without knowing to click it — the whole
              point of the badge. #416 moved runner/model out of the loose dot-list to cut noise;
              this puts them back as ONE quiet, truncating string rather than three chips, and the
              menu still carries the labelled breakdown. */}
          <span data-slot="agent-badge-summary" className="truncate font-mono text-[11px]">
            {summary}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[9rem]">
        <DropdownMenuLabel className="font-mono text-[11px] font-normal text-muted-foreground">
          runner: {runner}
        </DropdownMenuLabel>
        {/* Omitted, not guessed, when no step recorded one: a run from before accounts existed
            cannot be said to have used the discovered account — nothing wrote that down. */}
        {account ? (
          <DropdownMenuLabel
            data-slot="agent-badge-account"
            className="font-mono text-[11px] font-normal text-muted-foreground"
          >
            account: {account}
          </DropdownMenuLabel>
        ) : null}
        <DropdownMenuLabel className="font-mono text-[11px] font-normal text-muted-foreground">
          model: {model}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The <md action surface: everything the desktop bar offers, folded into a kebab menu next to
 *  the pill (the mockup's mobile pattern — `.tabs-row .actions { display:none }` under 768px). */
function ActionsKebab({
  run,
  actions,
  onToggleNotes,
}: {
  run: ApiRun
  actions: RunActions
  onToggleNotes: () => void
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
        {flags.finish ? (
          <DropdownMenuItem onSelect={() => actions.finish.mutate()}>
            <CheckIcon aria-hidden="true" /> Finish
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

/** "take over interactively: cd … && claude --resume …" — the legacy `#d-resume` line, now
 *  copyable. Local-machine phrasing; hosted mode (R5, `capabilities.localHandoff`) will swap the
 *  cd-prefix for a bare resume command. */
function ResumeHintLine({ hint }: { hint: string }) {
  return (
    <button
      type="button"
      data-slot="resume-hint"
      title="Copy the command"
      onClick={() => void copyToClipboard(hint, 'Command copied to clipboard.')}
      className="mb-2 flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left font-mono text-[11px] text-soft-foreground hover:bg-muted hover:text-foreground"
    >
      <CopyIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">take over interactively: {hint}</span>
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
