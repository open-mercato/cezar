import { BellRingIcon, ChevronRightIcon, CircleAlertIcon } from 'lucide-react'
import { memo, useContext, createContext, useEffect, useState, useMemo, type ComponentProps } from 'react'
import { Link } from 'react-router'

import { sendManagerMessage } from '@/api/managers'
import { useProjects } from '@/api/queries'
import { ReferenceChip } from '@/components/reference-chip'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { chipClass } from '@/components/picker-pill'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import {
  actionTitle,
  ISSUE_LINK_PREFIX,
  managerMessageTime,
  managerReferences,
  parseManagerText,
  parseReferenceLink,
  PR_LINK_PREFIX,
  TASK_LINK_PREFIX,
  UNKNOWN_PROJECT,
  type ManagerOrigin,
  type ManagerReferenceProject,
} from '@/lib/managers'
import { cn } from '@/lib/utils'
import { Markdown, TranscriptLink } from '@/routes/task-thread/markdown'
import { AskForm } from '@/routes/task-thread/ask-card'
import { forgetAskSelections } from '@/routes/task-thread/ask-selections'
import type { ManagerActionStatus, ManagerAsk, ManagerCommand, ManagerMessage } from '@open-mercato/cezar-api-client'

import { SessionCard, TaskChipLabel, taskPath } from './manager-session-card'

const NO_PROJECTS: readonly ManagerReferenceProject[] = []

const OriginContext = createContext<ManagerOrigin>({ id: '', name: '' })

/** The same bubble the task tables show. Its status comes from the reply's own provider. */
function ForgeReference({ kind, projectId, number }: { kind: 'PR' | 'Issue'; projectId: string; number: number }) {
  const origin = useContext(OriginContext)
  const repoUrl = useProjects().data?.projects.find((project) => project.id === projectId)?.repoUrl
  return (
    <ReferenceChip
      compact
      reference={{ kind, number, ...(repoUrl ? { url: `${repoUrl}/${kind === 'PR' ? 'pull' : 'issues'}/${number}` } : {}) }}
      taskTitle={origin.name}
      {...(projectId === UNKNOWN_PROJECT ? {} : { projectId })}
      className="align-middle no-underline"
    />
  )
}

/** A reference inside a sentence: the markdown stays whole and only the link is swapped. */
function ManagerLink({ href, children, ...props }: ComponentProps<'a'>) {
  const origin = useContext(OriginContext)
  const pr = parseReferenceLink(href, PR_LINK_PREFIX)
  if (pr) return <ForgeReference kind="PR" projectId={pr.projectId} number={Number(pr.id)} />
  const issue = parseReferenceLink(href, ISSUE_LINK_PREFIX)
  if (issue) return <ForgeReference kind="Issue" projectId={issue.projectId} number={Number(issue.id)} />
  const task = parseReferenceLink(href, TASK_LINK_PREFIX)
  if (task) {
    return (
      <Link to={taskPath(task.projectId, task.id)} state={{ manager: origin }} data-slot="manager-task-chip" className={cn(chipClass, 'inline-flex no-underline')}>
        <TaskChipLabel projectId={task.projectId} runId={task.id} />
      </Link>
    )
  }
  return <TranscriptLink href={href} {...props}>{children}</TranscriptLink>
}

const MARKDOWN_COMPONENTS = { a: ManagerLink }

function CommandRow({ command }: { command: ManagerCommand }) {
  return (
    <li className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5">
      <p className={cn('font-mono text-xs break-words', command.isError && 'text-danger')}>{command.summary}</p>
      {command.output ? (
        <pre className="mt-1 max-h-48 overflow-auto font-mono text-micro whitespace-pre-wrap text-muted-foreground">{command.output}</pre>
      ) : null}
    </li>
  )
}

/** "Ran 2 commands ▸" */
export function CommandsRow({ commands }: { commands: readonly ManagerCommand[] }) {
  const [open, setOpen] = useState(false)
  if (commands.length === 0) return null
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-2" data-slot="manager-commands">
      <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        Ran {commands.length} {commands.length === 1 ? 'command' : 'commands'}
        <ChevronRightIcon aria-hidden="true" className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1.5 flex flex-col gap-1">
          {commands.map((command) => <CommandRow key={command.id} command={command} />)}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A `CEZ:ASK` card. Answering is just the user's next message, so the composer answers it too. */
function ManagerQuestions({
  managerId,
  messageId,
  ask,
  answer,
}: {
  managerId: string
  messageId: string
  ask: ManagerAsk
  answer: string | undefined
}) {
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const card = useMemo(() => ({ id: messageId, questions: ask.questions }), [messageId, ask])
  useEffect(() => {
    if (answer !== undefined) forgetAskSelections(managerId, card)
  }, [answer, card, managerId])
  if (answer !== undefined) {
    return (
      <div data-slot="manager-ask" data-resolved="true" className="rounded-lg border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground">
        <span className="text-soft-foreground">Answered</span>
        <span className="ml-1.5 break-words whitespace-pre-line text-foreground">{answer}</span>
      </div>
    )
  }
  const send = async (text: string) => {
    setPending(true)
    setError(undefined)
    try {
      await sendManagerMessage(managerId, text)
      return undefined
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Your answer did not reach the manager.'
      setError(message)
      return message
    } finally {
      setPending(false)
    }
  }
  return (
    <div data-slot="manager-ask" data-resolved="false">
      <AskForm
        ask={card}
        ownerId={managerId}
        delivery={{ mode: 'live', isPending, ...(error ? { error } : {}), send }}
        asker="Your decision"
      />
    </div>
  )
}

function AssistantMessage({
  message,
  origin,
  projects,
}: {
  message: Extract<ManagerMessage, { kind: 'assistant' }>
  origin: ManagerOrigin
  projects: readonly ManagerReferenceProject[]
}) {
  const segments = useMemo(
    () => parseManagerText(message.text, message.commands, projects),
    [message.text, message.commands, projects],
  )
  const references = useMemo(() => managerReferences(segments), [segments])
  return (
    <article data-slot="manager-assistant" className="min-w-0">
      <p data-slot="manager-message-meta" className="mb-1 flex items-baseline gap-2 text-xs text-soft-foreground">
        {message.turn === 'job' && message.jobName ? <span className="font-medium">Job: {message.jobName}</span> : null}
        {message.turn === 'watch' ? <span className="font-medium">Watch check</span> : null}
        <time dateTime={message.at} title={new Date(message.at).toLocaleString()}>{managerMessageTime(message.at)}</time>
      </p>
      {message.important ? (
        <p data-slot="manager-important" className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <BellRingIcon aria-hidden="true" className="size-3.5 text-pending-strong" />
          {message.headline ?? 'Important'}
        </p>
      ) : null}
      <CommandsRow commands={message.commands} />
      <OriginContext.Provider value={origin}>
        <ReferenceStatusProvider requests={references}>
          {segments.map((segment, index) =>
            segment.kind === 'markdown' ? (
              <Markdown key={index} components={MARKDOWN_COMPONENTS}>{segment.text}</Markdown>
            ) : (
              <SessionCard key={index} projectId={segment.projectId} runId={segment.runId} origin={origin} />
            ),
          )}
        </ReferenceStatusProvider>
      </OriginContext.Provider>
      {message.ask ? (
        <div className="mt-3 max-w-2xl">
          <ManagerQuestions managerId={origin.id} messageId={message.id} ask={message.ask} answer={message.askAnswer} />
        </div>
      ) : null}
      {message.stopped ? <p className="mt-1 text-sm text-muted-foreground italic">Response stopped.</p> : null}
      {message.error ? (
        <p role="alert" className="mt-1 flex items-start gap-1.5 text-sm text-danger">
          <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {message.error}
        </p>
      ) : null}
    </article>
  )
}

const ACTION_STATUS: Record<ManagerActionStatus, { tone: StatusDotTone; label: string }> = {
  pending: { tone: 'pending', label: 'Waiting for you' },
  running: { tone: 'violet', label: 'Working on it' },
  done: { tone: 'success', label: 'Done' },
  rejected: { tone: 'neutral', label: 'Rejected' },
  failed: { tone: 'danger', label: 'Failed' },
}

export function ActionCard({
  message,
  onDecide,
  busy = false,
}: {
  message: Extract<ManagerMessage, { kind: 'action' }>
  onDecide: (actionId: string, decision: 'approve' | 'reject') => void
  busy?: boolean
}) {
  const status = ACTION_STATUS[message.status]
  return (
    <section
      data-slot="manager-action"
      data-status={message.status}
      aria-label={actionTitle(message.action)}
      className="max-w-lg rounded-xl border border-border bg-card p-4"
    >
      <p className="text-sm font-semibold">{actionTitle(message.action)}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {message.action.type === 'add-job' ? `Every ${message.action.everyMinutes} min` : message.action.projectId}
        {message.action.type === 'merge-pr' && message.action.method ? ` · ${message.action.method}` : ''}
      </p>
      {/* What will actually run: an unattended job's prompt or the automation's definition. */}
      {message.action.type === 'add-job' || (message.action.type === 'enable-automation' && message.action.summary) ? (
        <pre data-slot="manager-action-detail" className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">
          {message.action.type === 'add-job' ? message.action.prompt : message.action.summary}
        </pre>
      ) : null}
      {message.reason ? <p className="mt-2 text-sm">{message.reason}</p> : null}
      {message.status === 'pending' ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => onDecide(message.id, 'approve')}>Approve</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide(message.id, 'reject')}>Reject</Button>
        </div>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot tone={status.tone} pulse={message.status === 'running'} />
          {message.result ?? status.label}
        </p>
      )}
    </section>
  )
}

/** One chat row. Memoized: a streaming reply re-renders only the message that grew. */
export const ManagerMessageRow = memo(function ManagerMessageRow({
  message,
  origin,
  onDecide,
  deciding = false,
  projects = NO_PROJECTS,
}: {
  message: ManagerMessage
  origin: ManagerOrigin
  /** Connected projects: what a bare `#12` or a GitHub URL resolves against. */
  projects?: readonly ManagerReferenceProject[]
  onDecide: (actionId: string, decision: 'approve' | 'reject') => void
  deciding?: boolean
}) {
  switch (message.kind) {
    case 'user':
      return (
        <div data-slot="manager-user" className="flex justify-end">
          <p className="max-w-[80%] rounded-xl bg-muted px-4 py-2.5 text-sm break-words whitespace-pre-wrap">{message.text}</p>
        </div>
      )
    case 'assistant':
      return <AssistantMessage message={message} origin={origin} projects={projects} />
    case 'action':
      return <ActionCard message={message} onDecide={onDecide} busy={deciding} />
    case 'notice':
      return <p data-slot="manager-notice" className="text-center text-xs text-soft-foreground">{message.text}</p>
  }
})
