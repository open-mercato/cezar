import { CircleAlertIcon, CircleCheckIcon, ClockIcon, ExternalLinkIcon, GitMergeIcon, PlugIcon, ZapIcon, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Link } from 'react-router'

import { useProjects, useRunsIndex, useWorkspaceUiState, type ReferenceStatusRequest } from '@/api/queries'
import { chipClass } from '@/components/chip'
import { prTaskRuns } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider, useReferenceStatus } from '@/components/reference-status'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
import { useManagers } from '@/api/managers'
import { deriveAttention } from '@/lib/attention'
import { actionConfirms, actionTitle, managerConfirmOf, type ManagerOrigin } from '@/lib/managers'
import { runTitle } from '@/lib/task-groups'
import { cn } from '@/lib/utils'
import type { ManagerActionRequest, ManagerActionStatus, ManagerMessage, RunRecord } from '@open-mercato/cezar-api-client'

import { DecisionSources } from './decision-sources'
import { ManagerCard } from './manager-card'
import { ForgeReference, ManagerReferenceText } from './manager-reference'
import { taskPath } from './manager-session-card'

export type DecideAction = (actionId: string, decision: 'approve' | 'reject' | 'dismiss', opts?: { onlyIfStale?: boolean }) => Promise<unknown>

type ActionMessage = Extract<ManagerMessage, { kind: 'action' }>

const ACTION_STATUS: Record<ManagerActionStatus, { tone: StatusDotTone; label: string }> = {
  pending: { tone: 'pending', label: 'Waiting for you' },
  running: { tone: 'violet', label: 'Working on it' },
  done: { tone: 'success', label: 'Done' },
  rejected: { tone: 'neutral', label: 'Rejected' },
  failed: { tone: 'danger', label: 'Failed' },
  dismissed: { tone: 'neutral', label: 'Dismissed' },
}

/** A merge says what it did: "Merging…" then "Merged" (the Approvals page shows it live). */
const MERGE_STATUS: Partial<Record<ManagerActionStatus, string>> = { running: 'Merging…', done: 'Merged' }

const statusOf = (message: ActionMessage) => {
  const base = ACTION_STATUS[message.status]
  const merge = message.action.type === 'merge-pr' ? MERGE_STATUS[message.status] : undefined
  return merge ? { ...base, label: merge } : base
}

/** Keyed by string: a type from a newer server must still get a sheet, never a crash. */
const SHEET_COPY: Record<string, { title: string; confirm: string; effect: string } | undefined> = {
  'merge-pr': { title: 'Merge this pull request?', confirm: 'Merge', effect: 'The merge is refused if the pull request changed after this proposal.' },
  'enable-automation': { title: 'Enable this automation?', confirm: 'Enable', effect: 'It starts launching tasks on its own. It is refused if the automation was edited after this proposal.' },
  'add-job': { title: 'Add this job?', confirm: 'Add job', effect: 'It runs unattended on this interval until you remove it.' },
  'connector-call': { title: 'Make this call?', confirm: 'Make call', effect: 'cezar makes exactly this call with these arguments, and nothing else.' },
}

const UNKNOWN_ACTION_COPY = { title: 'Approve this action?', confirm: 'Approve', effect: 'This version of the cockpit cannot describe it.' }

const SHORT_SHA = 12

/** Tasks named on a merge card before the rest fold into '+N'. */
const PR_TASKS_SHOWN = 3

/** The prompt or definition that will actually run, when the action carries one. */
function actionDetail(action: ManagerActionRequest): string | undefined {
  switch (action.type) {
    case 'add-job': return action.prompt
    case 'enable-automation': return action.summary
    case 'connector-call': return JSON.stringify(action.args, null, 2)
    case 'merge-pr': return undefined
  }
}

/** The card's three lines: a connector call's top-level arguments one per line, so a date or a recipient shows without opening it. */
export function actionPreview(action: ManagerActionRequest): string | undefined {
  if (action.type !== 'connector-call') return actionDetail(action)
  return Object.entries(action.args).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')
}


function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-20 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

const NO_REFERENCES: readonly ReferenceStatusRequest[] = []

/** Keyed by string, as `SHEET_COPY` is: a type from a newer server still gets a card. */
const CARD_TITLE: Record<string, string | undefined> = {
  'merge-pr': 'Merge pull request',
  'enable-automation': 'Enable automation',
  'add-job': 'Add job',
  'connector-call': 'Connector call',
}

const CARD_ICON: Record<string, LucideIcon | undefined> = {
  'merge-pr': GitMergeIcon,
  'enable-automation': ZapIcon,
  'add-job': ClockIcon,
  'connector-call': PlugIcon,
}

/** The card's pinned facts (design, Proposal 10): the PR as the tables' chip, the head sha with
 *  what pinning means. The sheet keeps `ActionFacts`, where the link is what a reader checks. */
function CardFacts({ action, projectName, origin }: { action: ManagerActionRequest; projectName: string | undefined; origin: ManagerOrigin }) {
  if (action.type === 'merge-pr') {
    return (
      <>
        <Fact label="Project">{projectName ?? action.projectId}</Fact>
        <Fact label="Pull request">
          {/* The chat's own chip: without the URL it painted an inert span. */}
          <ForgeReference kind="PR" projectId={action.projectId} number={action.number} {...(action.title ? { title: action.title } : {})} />
          {action.title ? <span className="ml-1.5">{action.title}</span> : null}
        </Fact>
        <PrTasks projectId={action.projectId} number={action.number} projectName={projectName} origin={origin} />
        <Fact label="Method">{action.method ?? 'Repository default'}</Fact>
        <Fact label="Head">
          {action.headSha ? (
            <>
              <code title={action.headSha} className="font-mono text-xs">{action.headSha.slice(0, SHORT_SHA)}</code>
              <span className="text-xs text-muted-foreground"> · pinned, a new push refuses</span>
            </>
          ) : 'Latest at merge'}
        </Fact>
      </>
    )
  }
  if (action.type === 'add-job') {
    return (
      <>
        <Fact label="Name">{action.name}</Fact>
        <Fact label="Interval">Every {action.everyMinutes} min</Fact>
      </>
    )
  }
  if (action.type === 'connector-call') {
    return (
      <>
        <Fact label="Connector">{action.connectorName ?? action.connector}</Fact>
        <Fact label="Tool"><code className="font-mono text-xs">{action.tool}</code></Fact>
      </>
    )
  }
  return (
    <>
      <Fact label="Project">{projectName ?? action.projectId}</Fact>
      <Fact label="Name">{action.name ?? action.automationId}</Fact>
      {action.revision === undefined ? null : <Fact label="Revision">{action.revision}</Fact>}
    </>
  )
}

/**
 * The tasks carrying the PR, by the rule Resolve conflicts uses to find its owner (#2199): the
 * creator first. A read of the shared runs index, so a chat of merge cards fetches it once.
 */
function PrTasks({ projectId, number, projectName, origin }: { projectId: string; number: number; projectName: string | undefined; origin: ManagerOrigin }) {
  const runs = useRunsIndex().data?.runs
  const repoBase = useProjects().data?.projects.find((entry) => entry.id === projectId)?.repoUrl
  const tasks = useMemo(() => (runs ? prTaskRuns(runs, projectId, number, repoBase) : []), [runs, projectId, number, repoBase])
  if (tasks.length === 0) return null
  const shown = tasks.slice(0, PR_TASKS_SHOWN)
  const more = tasks.length - shown.length
  return (
    <Fact label={tasks.length === 1 ? 'Task' : 'Tasks'}>
      <span data-slot="manager-action-tasks" className="flex flex-wrap items-center gap-1.5">
        {shown.map((run) => {
          const record = run as unknown as RunRecord
          const attention = deriveAttention(record)
          return (
            // The manager rides the link, so a phone or CezarBot keeps Manager current (#2220).
            <Link
              key={run.id}
              to={taskPath(run.projectId, run.id)}
              state={{ manager: origin }}
              data-slot="manager-action-task"
              data-run={run.id}
              title={attention.label}
              className={cn(chipClass, 'max-w-full min-w-0 no-underline text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50')}
            >
              <StatusDot tone={attention.tone} pulse={attention.pulse} className="shrink-0" />
              <span className="min-w-0 truncate">{runTitle(record)}</span>
              {/* Capped, so a long project name never squeezes the task title to an ellipsis. */}
              {projectName ? <span className="max-w-[45%] shrink-0 truncate text-muted-foreground">· {projectName}</span> : null}
              <span className="sr-only">, {attention.label}</span>
            </Link>
          )
        })}
        {more > 0 ? (
          <span data-slot="manager-action-tasks-more" className="text-xs text-muted-foreground" title={tasks.slice(PR_TASKS_SHOWN).map((run) => runTitle(run as unknown as RunRecord)).join('\n')}>
            +{more}<span className="sr-only"> more {more === 1 ? 'task' : 'tasks'}</span>
          </span>
        ) : null}
      </span>
    </Fact>
  )
}

function MergeFacts({ action }: { action: Extract<ManagerActionRequest, { type: 'merge-pr' }> }) {
  const project = useProjects().data?.projects.find((entry) => entry.id === action.projectId)
  return (
    <>
      <Fact label="Project">{project?.name ?? action.projectId}</Fact>
      <Fact label="Pull request">
        {project?.repoUrl ? (
          <a href={`${project.repoUrl}/pull/${action.number}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
            #{action.number}
            <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          </a>
        ) : `#${action.number}`}
      </Fact>
      {action.title ? <Fact label="Title">{action.title}</Fact> : null}
      <Fact label="Method">{action.method ?? 'Repository default'}</Fact>
      <Fact label="Head">
        {action.headSha ? <code title={action.headSha} className="font-mono text-xs">{action.headSha.slice(0, SHORT_SHA)}</code> : 'Latest at merge'}
      </Fact>
    </>
  )
}

/** What the user reads before approving: the pinned facts, by type (mobile spec, Approval cards). */
function ActionFacts({ action }: { action: ManagerActionRequest }) {
  switch (action.type) {
    case 'merge-pr': return <MergeFacts action={action} />
    case 'add-job':
      return (
        <>
          <Fact label="Name">{action.name}</Fact>
          <Fact label="Interval">Every {action.everyMinutes} min</Fact>
        </>
      )
    case 'enable-automation':
      return (
        <>
          <Fact label="Name">{action.name ?? action.automationId}</Fact>
          {action.revision === undefined ? null : <Fact label="Revision">{action.revision}</Fact>}
        </>
      )
    case 'connector-call':
      return (
        <>
          <Fact label="Connector">{action.connectorName ?? action.connector}</Fact>
          <Fact label="Tool"><code className="font-mono text-xs">{action.tool}</code></Fact>
        </>
      )
  }
}

/**
 * A bottom sheet below `md`, a centered dialog above it: one tree, so rotating never drops it.
 * Header and footer stay put while the middle row scrolls, and the sheet rides above the keyboard.
 */
export function SheetContent({ className, ...props }: ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      showCloseButton={false}
      className={cn(
        'max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] max-w-none sm:max-w-none md:max-w-lg max-md:top-auto max-md:bottom-[var(--kb,0px)] max-md:left-0 max-md:max-h-[calc(85dvh-var(--kb,0px))] max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] max-md:data-[state=closed]:zoom-out-100 max-md:data-[state=closed]:slide-out-to-bottom max-md:data-[state=open]:zoom-in-100 max-md:data-[state=open]:slide-in-from-bottom',
        className,
      )}
      {...props}
    />
  )
}

function ActionSheet({
  message,
  open,
  onClose,
  onApprove,
  onCloseAutoFocus,
}: {
  message: ActionMessage
  open: boolean
  onClose: () => void
  onApprove: () => void
  onCloseAutoFocus: (event: Event) => void
}) {
  const { action, status } = message
  const copy = SHEET_COPY[action.type] ?? UNKNOWN_ACTION_COPY
  const detail = actionDetail(action)
  // Decided elsewhere while this was open: the facts stay readable, but nothing is left to approve.
  const pending = status === 'pending'
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <SheetContent onCloseAutoFocus={onCloseAutoFocus} data-slot="manager-action-sheet">
        <DialogHeader className="text-left">
          <DialogTitle>{pending ? copy.title : actionTitle(action)}</DialogTitle>
          <DialogDescription>{pending ? copy.effect : ACTION_STATUS[status].label}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          <dl className="flex flex-col gap-2">
            <ActionFacts action={action} />
          </dl>
          {detail ? (
            <pre data-slot="manager-action-full" className="mt-3 overflow-x-auto rounded-lg bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{detail}</pre>
          ) : null}
        </div>
        <DialogFooter className="flex-row">
          <Button variant="outline" className="h-11 flex-1 md:flex-none" onClick={onClose}>{pending ? 'Cancel' : 'Close'}</Button>
          {pending ? <Button className="h-11 flex-1 md:flex-none" onClick={onApprove}>{copy.confirm}</Button> : null}
        </DialogFooter>
      </SheetContent>
    </Dialog>
  )
}

/** Merge and enable cards already asked about this page session, so a re-render never asks again. */
const staleChecked = new Set<string>()

/**
 * Asks the server once per pending merge card whether its PR is still open, and once per enable
 * card whether its automation is unchanged; an outdated one is closed as `dismissed`. The chip's colour cannot decide this: it can be a cached 'ready'.
 */
export function useDismissStaleMerges(messages: readonly ManagerMessage[], onDecide: DecideAction): void {
  useEffect(() => {
    for (const message of messages) {
      if (message.kind !== 'action' || message.status !== 'pending' || (message.action.type !== 'merge-pr' && message.action.type !== 'enable-automation') || staleChecked.has(message.id)) continue
      staleChecked.add(message.id)
      // A 409 is the answer "still open"; nothing to show.
      onDecide(message.id, 'dismiss', { onlyIfStale: true }).catch(() => {})
    }
  }, [messages, onDecide])
}

/** Merge cards whose chip already reported the PR merged or closed, so the ask goes out once. */
const closedChecked = new Set<string>()

/**
 * The fallback for a PR that merges while the chat is open: the chip's own status, which the
 * cockpit already polls, re-sends the onlyIfStale dismiss. The server confirms before closing.
 */
function DismissWhenPrCloses({ message, onDecide }: { message: ActionMessage; onDecide: DecideAction }) {
  const { action } = message
  const merge = action.type === 'merge-pr' ? action : undefined
  const status = useReferenceStatus('PR', merge?.number, merge?.projectId).status
  const closed = message.status === 'pending' && (status === 'merged' || status === 'closed')
  useEffect(() => {
    if (!closed || closedChecked.has(message.id)) return
    closedChecked.add(message.id)
    onDecide(message.id, 'dismiss', { onlyIfStale: true }).catch(() => {})
  }, [closed, message.id, onDecide])
  return null
}

export function forgetStaleChecks(): void {
  staleChecked.clear()
  closedChecked.clear()
}

export function ActionCard({ origin, message, onDecide }: { origin: ManagerOrigin; message: ActionMessage; onDecide: DecideAction }) {
  const managerId = origin.id
  const { action } = message
  const status = statusOf(message)
  const detail = actionPreview(action)
  const own = useManagers().data?.managers.find((entry) => entry.id === managerId)?.confirm
  const setting = managerConfirmOf(own, useWorkspaceUiState().data?.managerConfirm)
  const projectId = 'projectId' in action ? action.projectId : undefined
  const projectName = useProjects().data?.projects.find((entry) => entry.id === projectId)?.name ?? projectId
  const [sheetOpen, setSheetOpen] = useState(false)
  const [deciding, setDeciding] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  // State only disables the buttons on the next render; a double tap lands before it.
  const inFlight = useRef(false)
  const card = useRef<HTMLElement>(null)
  // Set by the sheet's confirm: its Approve trigger is about to unmount, so focus goes to the card.
  const approvedInSheet = useRef(false)
  // What opened the sheet; a tap leaves <body> focused, so Approve stands in for it.
  const opener = useRef<HTMLElement | null>(null)
  const approveButton = useRef<HTMLButtonElement>(null)
  const openSheet = () => {
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && card.current?.contains(active) ? active : null
    setSheetOpen(true)
  }

  /** The decided card loses its buttons: keep focus on it, unless the reader already moved on. */
  const focusCard = () => {
    const active = document.activeElement
    if (!card.current || (active && active !== document.body && !card.current.contains(active))) return
    card.current.focus({ preventScroll: true })
  }

  const decide = async (decision: 'approve' | 'reject' | 'dismiss') => {
    if (inFlight.current) return
    inFlight.current = true
    setDeciding(true)
    setRefusal(undefined)
    try {
      await onDecide(message.id, decision)
      focusCard()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setRefusal(reason)
      toast(reason, { tone: 'danger' })
    } finally {
      inFlight.current = false
      setDeciding(false)
    }
  }

  const Icon = CARD_ICON[action.type] ?? CircleCheckIcon
  // One card shape (design, Proposal 10): header row, pinned facts, actions row. Its PR chip reads
  // checks and review state through the same provider the task tables use.
  const references = action.type === 'merge-pr' ? [{ projectId: action.projectId, kind: 'PR' as const, number: action.number }] : NO_REFERENCES
  return (
    <ManagerCard
      ref={card}
      id={`decision-${message.id}`}
      data-slot="manager-action"
      data-status={message.status}
      data-action-id={message.id}
      aria-label={actionTitle(action)}
      tone={message.status === 'pending' ? 'info' : 'plain'}
      icon={<Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      title={CARD_TITLE[action.type] ?? 'Approve an action'}
      status={<><StatusDot tone={status.tone} pulse={message.status === 'running'} />{status.label}</>}
      actions={message.status === 'pending' ? (
        <>
          <Button
            ref={approveButton}
            className="max-md:h-10 max-md:flex-1"
            disabled={deciding}
            onClick={() => (actionConfirms(setting, action.type) ? openSheet() : void decide('approve'))}
          >
            Approve
          </Button>
          <Button variant="outline" className="max-md:h-10 max-md:flex-1" disabled={deciding} onClick={() => void decide('reject')}>Reject</Button>
          {/* Neither yes nor no: the proposal is moot, e.g. its PR was merged elsewhere. */}
          <Button variant="ghost" className="ml-auto max-md:h-10" disabled={deciding} onClick={() => void decide('dismiss')}>Dismiss</Button>
        </>
      ) : undefined}
    >
      <DecisionSources message={message} origin={origin} />
      <ReferenceStatusProvider requests={references}>
        {action.type === 'merge-pr' && message.status === 'pending' ? <DismissWhenPrCloses message={message} onDecide={onDecide} /> : null}
        <dl className="flex flex-col gap-1.5">
          <CardFacts action={action} projectName={projectName} origin={origin} />
        </dl>
      </ReferenceStatusProvider>
      {/* What will actually run. Three lines here: a prompt can be 20,000 characters, and a nested
          scroller inside the chat traps a thumb. The sheet has it all, with any setting. */}
      {detail ? (
        <div className="rounded-lg bg-muted p-2">
          <p data-slot="manager-action-detail" className="line-clamp-3 font-mono text-xs break-words whitespace-pre-wrap">{detail}</p>
          <button
            type="button"
            className="mt-1 rounded-sm text-xs text-muted-foreground underline outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
            onClick={openSheet}
          >
            Show all
          </button>
        </div>
      ) : null}
      {message.reason ? <p className="text-sm"><ManagerReferenceText text={message.reason} origin={origin} /></p> : null}
      {/* Always mounted, so the outcome replacing the buttons is announced ('Merged #128'). */}
      <div role="status" data-slot="manager-action-outcome" className="empty:hidden">
        {message.status === 'pending' ? null : (
          // The header already says the status: drawn only when there is a result sentence.
          <p className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', !message.result && 'sr-only')}>
            {message.result ? <StatusDot tone={status.tone} pulse={message.status === 'running'} className="shrink-0" /> : null}
            {/* A connector's raw reply can run to 4,000 characters; the title keeps the clamped rest. */}
            <span className="line-clamp-3 min-w-0 break-words whitespace-pre-wrap" title={message.result}>{message.result ?? status.label}</span>
          </p>
        )}
      </div>
      {refusal && message.status === 'pending' ? (
        <p role="alert" data-slot="manager-action-refusal" className="flex items-start gap-1.5 text-sm text-danger">
          <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {refusal}
        </p>
      ) : null}
      <ActionSheet
        message={message}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const approved = approvedInSheet.current
          approvedInSheet.current = false
          // Cancel and Escape go back where the reader was, never to <body> (round-3 review).
          const back = approved ? undefined : [opener.current, approveButton.current].find((entry) => entry?.isConnected)
          const target = back ?? card.current
          target?.focus({ preventScroll: true })
        }}
        onApprove={() => {
          approvedInSheet.current = true
          setSheetOpen(false)
          void decide('approve')
        }}
      />
    </ManagerCard>
  )
}
