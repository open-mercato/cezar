import { CircleAlertIcon, ExternalLinkIcon } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'

import { useProjects, useWorkspaceUiState } from '@/api/queries'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
import { actionConfirms, actionTitle } from '@/lib/managers'
import type { ManagerActionRequest, ManagerActionStatus, ManagerMessage } from '@open-mercato/cezar-api-client'

export type DecideAction = (actionId: string, decision: 'approve' | 'reject') => Promise<unknown>

type ActionMessage = Extract<ManagerMessage, { kind: 'action' }>

const ACTION_STATUS: Record<ManagerActionStatus, { tone: StatusDotTone; label: string }> = {
  pending: { tone: 'pending', label: 'Waiting for you' },
  running: { tone: 'violet', label: 'Working on it' },
  done: { tone: 'success', label: 'Done' },
  rejected: { tone: 'neutral', label: 'Rejected' },
  failed: { tone: 'danger', label: 'Failed' },
}

/** Keyed by string: a type from a newer server must still get a sheet, never a crash. */
const SHEET_COPY: Record<string, { title: string; confirm: string; effect: string } | undefined> = {
  'merge-pr': { title: 'Merge this pull request?', confirm: 'Merge', effect: 'The merge is refused if the pull request changed after this proposal.' },
  'enable-automation': { title: 'Enable this automation?', confirm: 'Enable', effect: 'It starts launching tasks on its own. It is refused if the automation was edited after this proposal.' },
  'add-job': { title: 'Add this job?', confirm: 'Add job', effect: 'It runs unattended on this interval until you remove it.' },
}

const UNKNOWN_ACTION_COPY = { title: 'Approve this action?', confirm: 'Approve', effect: 'This version of the cockpit cannot describe it.' }

const SHORT_SHA = 12

/** The prompt or definition that will actually run, when the action carries one. */
function actionDetail(action: ManagerActionRequest): string | undefined {
  if (action.type === 'add-job') return action.prompt
  return action.type === 'enable-automation' ? action.summary : undefined
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-20 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
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
  if (action.type === 'merge-pr') return <MergeFacts action={action} />
  if (action.type === 'add-job') {
    return (
      <>
        <Fact label="Name">{action.name}</Fact>
        <Fact label="Interval">Every {action.everyMinutes} min</Fact>
      </>
    )
  }
  if (action.type !== 'enable-automation') return null
  return (
    <>
      <Fact label="Name">{action.name ?? action.automationId}</Fact>
      {action.revision === undefined ? null : <Fact label="Revision">{action.revision}</Fact>}
    </>
  )
}

/** A bottom sheet below `md`, a centered dialog above it: one tree, so rotating never drops it. */
function ActionSheet({
  message,
  open,
  onClose,
  onApprove,
}: {
  message: ActionMessage
  open: boolean
  onClose: () => void
  onApprove: () => void
}) {
  const { action, status } = message
  const copy = SHEET_COPY[action.type] ?? UNKNOWN_ACTION_COPY
  const detail = actionDetail(action)
  // Decided elsewhere while this was open: the facts stay readable, but nothing is left to approve.
  const pending = status === 'pending'
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        showCloseButton={false}
        data-slot="manager-action-sheet"
        className="max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] max-w-none sm:max-w-none md:max-w-lg max-md:top-auto max-md:bottom-0 max-md:left-0 max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] max-md:data-[state=closed]:zoom-out-100 max-md:data-[state=closed]:slide-out-to-bottom max-md:data-[state=open]:zoom-in-100 max-md:data-[state=open]:slide-in-from-bottom"
      >
        <DialogHeader className="text-left">
          <DialogTitle>{pending ? copy.title : actionTitle(action)}</DialogTitle>
          <DialogDescription>{pending ? copy.effect : ACTION_STATUS[status].label}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          <dl className="flex flex-col gap-2">
            <ActionFacts action={action} />
          </dl>
          {detail ? (
            <pre data-slot="manager-action-full" className="mt-3 rounded-lg bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{detail}</pre>
          ) : null}
        </div>
        <DialogFooter className="flex-row">
          <Button variant="outline" className="h-11 flex-1 md:flex-none" onClick={onClose}>{pending ? 'Cancel' : 'Close'}</Button>
          {pending ? <Button className="h-11 flex-1 md:flex-none" onClick={onApprove}>{copy.confirm}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ActionCard({ message, onDecide }: { message: ActionMessage; onDecide: DecideAction }) {
  const { action } = message
  const status = ACTION_STATUS[message.status]
  const detail = actionDetail(action)
  const setting = useWorkspaceUiState().data?.managerConfirm
  const [sheetOpen, setSheetOpen] = useState(false)
  const [deciding, setDeciding] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  // State only disables the buttons on the next render; a double tap lands before it.
  const inFlight = useRef(false)

  const decide = async (decision: 'approve' | 'reject') => {
    if (inFlight.current) return
    inFlight.current = true
    setDeciding(true)
    setRefusal(undefined)
    try {
      await onDecide(message.id, decision)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setRefusal(reason)
      toast(reason, { tone: 'danger' })
    } finally {
      inFlight.current = false
      setDeciding(false)
    }
  }

  return (
    <section
      data-slot="manager-action"
      data-status={message.status}
      data-action-id={message.id}
      aria-label={actionTitle(action)}
      tabIndex={-1}
      className="w-full rounded-xl border border-border bg-card p-4 outline-none"
    >
      <p className="text-sm font-semibold break-words">{actionTitle(action)}</p>
      <p className="mt-0.5 text-xs break-words text-muted-foreground">
        {action.type === 'add-job' ? `Every ${action.everyMinutes} min` : action.projectId}
        {action.type === 'merge-pr' && action.method ? ` · ${action.method}` : ''}
        {action.type === 'merge-pr' && action.headSha ? ` · ${action.headSha.slice(0, 7)}` : ''}
      </p>
      {/* What will actually run. Three lines here: a prompt can be 20,000 characters, and a nested
          scroller inside the chat traps a thumb. The sheet has it all, with any setting. */}
      {detail ? (
        <div className="mt-2 rounded-lg bg-muted p-2">
          <p data-slot="manager-action-detail" className="line-clamp-3 font-mono text-xs break-words whitespace-pre-wrap">{detail}</p>
          <button
            type="button"
            className="mt-1 rounded-sm text-xs text-muted-foreground underline outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
            onClick={() => setSheetOpen(true)}
          >
            Show all
          </button>
        </div>
      ) : null}
      {message.reason ? <p className="mt-2 text-sm">{message.reason}</p> : null}
      {message.status === 'pending' ? (
        <>
          {refusal ? (
            <p role="alert" data-slot="manager-action-refusal" className="mt-2 flex items-start gap-1.5 text-sm text-danger">
              <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              {refusal}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button variant="outline" className="h-11 flex-1" disabled={deciding} onClick={() => void decide('reject')}>Reject</Button>
            <Button
              className="h-11 flex-1"
              disabled={deciding}
              onClick={() => (actionConfirms(setting, action.type) ? setSheetOpen(true) : void decide('approve'))}
            >
              Approve
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot tone={status.tone} pulse={message.status === 'running'} />
          {message.result ?? status.label}
        </p>
      )}
      <ActionSheet
        message={message}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onApprove={() => {
          setSheetOpen(false)
          void decide('approve')
        }}
      />
    </section>
  )
}
