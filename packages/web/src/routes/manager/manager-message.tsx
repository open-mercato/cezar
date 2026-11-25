import { BellRingIcon, CheckIcon, ChevronRightIcon, CircleAlertIcon, ClockIcon, MessageCircleQuestionIcon, PaperclipIcon, PlayIcon, PowerIcon } from 'lucide-react'
import { memo, useContext, createContext, useEffect, useRef, useState, useMemo, type ComponentProps, type ReactNode } from 'react'
import { Link } from 'react-router'

import { useQueryClient } from '@tanstack/react-query'

import { checkManager, managerAttachmentUrl, sendManagerMessage, stopManager } from '@/api/managers'
import { scheduleDismiss, undoDismiss, usePendingDismissals } from '@/api/questions'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { ZoomableImage } from '@/components/zoomable-image'
import { ReconnectCard, ReconnectedLine } from '@/components/reconnect/reconnect-card'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { StaticChip } from '@/components/chip'
import {
  checkFailureCause,
  ISSUE_LINK_PREFIX,
  managerMessageTime,
  managerReferences,
  parseManagerText,
  parseReferenceLink,
  PR_LINK_PREFIX,
  TASK_LINK_PREFIX,
  type ManagerOrigin,
  type ManagerReferenceProject,
} from '@/lib/managers'
import { cn } from '@/lib/utils'
import { trackManagerMessageSent, trackManagerQuestionAnswered } from '@/lib/manager-telemetry'
import { Markdown, TranscriptLink } from '@/routes/task-thread/markdown'
import { AskForm } from '@/routes/task-thread/ask-card'
import { forgetAskSelections } from '@/routes/task-thread/ask-selections'
import { AskAnswerSummary, askAnswerLines } from '@/routes/task-thread/ask-answer-summary'
import { DismissingNote, QuietClosedAsk, StaleNote } from '@/routes/questions/question-states'
import {
  isImageAttachmentName,
  questionKey,
  type QuestionClosed,
  type QuestionStale,
  type ManagerAsk,
  type ManagerActivityNotice,
  type ManagerAttachment,
  type ManagerCommand,
  type ManagerMessage,
} from '@open-mercato/cezar-api-client'

import { ActionCard, type DecideAction } from './manager-approval'
import { DecisionSources } from './decision-sources'
import { ManagerCard } from './manager-card'
import { ForgeReference, ManagerAskText, ManagerProjectsContext, TaskReference } from './manager-reference'
import { SessionCard, taskPath } from './manager-session-card'
import { ReplyUsageNote, type ReplyUsage } from './manager-plan-usage'

const NO_PROJECTS: readonly ManagerReferenceProject[] = []

const OriginContext = createContext<ManagerOrigin>({ id: '', name: '' })

export { PrTitlesContext, usePrTitles } from './manager-reference'

/** A reference inside a sentence: the markdown stays whole and only the link is swapped. */
function ManagerLink({ href, children, ...props }: ComponentProps<'a'>) {
  const origin = useContext(OriginContext)
  const pr = parseReferenceLink(href, PR_LINK_PREFIX)
  if (pr) return <ForgeReference kind="PR" projectId={pr.projectId} number={Number(pr.id)} />
  const issue = parseReferenceLink(href, ISSUE_LINK_PREFIX)
  if (issue) return <ForgeReference kind="Issue" projectId={issue.projectId} number={Number(issue.id)} />
  const task = parseReferenceLink(href, TASK_LINK_PREFIX)
  if (task) return <TaskReference projectId={task.projectId} runId={task.id} origin={origin} />
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
      <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-sm pointer-coarse:min-h-11 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
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

function UserAttachments({ managerId, attachments }: { managerId: string; attachments: readonly ManagerAttachment[] }) {
  return (
    <div data-slot="manager-attachments" className="flex max-w-[80%] flex-wrap items-center justify-end gap-1.5">
      {attachments.map(({ file, name }) => {
        const url = managerAttachmentUrl(managerId, file)
        return isImageAttachmentName(file) ? (
          <ZoomableImage key={file} src={url} alt={name ?? 'attached'} className="max-h-40 max-w-[220px] rounded-md border border-border object-contain" />
        ) : (
          <a
            key={file}
            href={url}
            download={name ?? file}
            data-slot="manager-file"
            className="inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs no-underline hover:bg-muted/70"
          >
            <PaperclipIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{name ?? file}</span>
          </a>
        )
      })}
    </div>
  )
}

export { askAnswerLines }

/** User messages an answered card above them already shows: drawn once, on the card. */
export function answersShownOnCard(messages: readonly ManagerMessage[]): ReadonlySet<string> {
  const shown = new Set<string>()
  messages.forEach((message, index) => {
    const next = messages[index + 1]
    if (message.kind !== 'assistant' || !message.ask || message.askAnswer === undefined || next?.kind !== 'user') return
    if (next.attachments?.length || next.text !== message.askAnswer) return
    if (askAnswerLines(message.ask, next.text)) shown.add(next.id)
  })
  return shown
}

/** A `CEZ:ASK` card. Answering is just the user's next message, so the composer answers it too. */
function ManagerQuestions({
  origin,
  messageId,
  ask,
  answer,
  answerOnCard,
  source,
  closed: closedOnServer,
  stale,
  superseded = false,
}: {
  origin: ManagerOrigin
  messageId: string
  ask: ManagerAsk
  source: ReactNode
  answer: string | undefined
  /** Closed without a card answer (Questions inbox): one quiet line instead of the form. */
  closed?: QuestionClosed | undefined
  /** Suspected out of date: the card stays open, with the amber note. */
  stale?: QuestionStale | undefined
  /** The next row is this answer and is not drawn: the card says it instead. */
  answerOnCard: boolean
  /** Re-asked in full by a later card, in history written before the server closed it (#2307). */
  superseded?: boolean
}) {
  const managerId = origin.id
  const chatActions = useContext(ManagerChatActionsContext)
  const closed = closedOnServer ?? (superseded ? { reason: 'replaced' as const, at: '' } : undefined)
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [localAnswer, setLocalAnswer] = useState<string | undefined>()
  const effectiveAnswer = answer ?? localAnswer
  const effectiveAnswerOnCard = answerOnCard || localAnswer !== undefined
  const card = useMemo(() => ({ id: messageId, questions: ask.questions }), [messageId, ask])
  const answered = useRef<HTMLDivElement>(null)
  // Answered from this card: its chips unmount, so focus lands on what replaced them.
  const sentHere = useRef(false)
  useEffect(() => {
    if (effectiveAnswer === undefined) return
    forgetAskSelections(managerId, card)
    if (!sentHere.current) return
    sentHere.current = false
    const active = document.activeElement
    if (!active || active === document.body || !active.isConnected) answered.current?.focus({ preventScroll: true })
  }, [effectiveAnswer, card, managerId])
  const queryClient = useQueryClient()
  const key = questionKey({ kind: 'manager', managerId, messageId })
  const dismissing = usePendingDismissals().find((entry) => entry.key === key && !entry.error)
  const lines = effectiveAnswer !== undefined && effectiveAnswerOnCard ? askAnswerLines(ask, effectiveAnswer) : null
  if (effectiveAnswer === undefined && closed) {
    const answeredIn = closed.answeredIn?.startsWith('task:') ? closed.answeredIn.slice('task:'.length).split('/') : undefined
    return (
      <QuietClosedAsk
        id={`decision-${messageId}`}
        closed={closed}
        questions={ask.questions}
        asker="manager"
        link={closed.reason === 'replaced' && closed.replacedBy ? (
          <Link to={{ hash: `#decision-${encodeURIComponent(closed.replacedBy)}` }} data-slot="ask-closed-newer" className="font-medium text-foreground underline underline-offset-4">Go to the newer question ↓</Link>
        ) : answeredIn?.length === 2 ? (
          <Link to={`${taskPath(answeredIn[0]!, answeredIn[1]!)}/chat`} className="font-medium text-foreground underline underline-offset-4">Open task</Link>
        ) : undefined}
      />
    )
  }
  if (effectiveAnswer === undefined && dismissing) return <DismissingNote label={dismissing.label} onUndo={() => undoDismiss(key)} />
  if (lines) {
    return (
      <div
        ref={answered}
        id={`decision-${messageId}`}
        tabIndex={-1}
        data-slot="manager-ask"
        data-resolved="true"
        className="flex max-w-full flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="flex items-center gap-1.5">
          <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
          Answered
        </span>
        <ManagerAskText ask={ask} origin={origin}>
          <AskAnswerSummary questions={ask.questions} lines={lines} slot="manager-ask-answers" />
        </ManagerAskText>
      </div>
    )
  }
  if (effectiveAnswer !== undefined) {
    return (
      <div
        ref={answered}
        id={`decision-${messageId}`}
        tabIndex={-1}
        data-slot="manager-ask"
        data-resolved="true"
        className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {/* Answered in other words (typed, or with files): that message below says it (#2038 walk). */}
        <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
        <span>Answered<span className="sr-only">:</span></span>
        <ul data-slot="manager-ask-topics" className="flex min-w-0 flex-wrap gap-1.5">
          {ask.questions.map((question, index) => <li key={index} className="flex min-w-0 max-w-full"><StaticChip>{question.header}</StaticChip></li>)}
        </ul>
      </div>
    )
  }
  const send = async (text: string) => {
    const reactivate = chatActions.confirmReactivate
    if (reactivate && !(await reactivate(text))) {
      const message = `Not sent: ${origin.name} is still inactive. Dismiss closes the question without waking it.`
      setError(message)
      return message
    }
    sentHere.current = true
    setPending(true)
    setError(undefined)
    try {
      await sendManagerMessage(managerId, text, undefined, messageId, reactivate ? { reactivate: true } : undefined)
      setLocalAnswer(text)
      trackManagerMessageSent('question_card', false)
      trackManagerQuestionAnswered('card')
      return undefined
    } catch (failure) {
      sentHere.current = false
      const message = failure instanceof Error ? failure.message : 'Your answer did not reach the manager.'
      setError(message)
      return message
    } finally {
      setPending(false)
    }
  }
  return (
    <ManagerCard
      id={`decision-${messageId}`}
      tabIndex={-1}
      data-slot="manager-ask"
      data-resolved="false"
      icon={<MessageCircleQuestionIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      title="Your decision"
      status={<><StatusDot tone="info" />Open</>}
    >
      {stale ? <StaleNote detail={stale.detail} disabled={isPending} onDismiss={() => scheduleDismiss(queryClient, key, ask.questions[0]?.header ?? 'Question')} /> : null}
      {source}
      {/* The card draws the box and the status, so the form is unframed; its "Other…" and "Need more
          info" chips per question are the design's ghost actions. */}
      <ManagerAskText ask={ask} origin={origin}>
        <AskForm
          ask={card}
          ownerId={managerId}
          delivery={{ mode: 'live', isPending, ...(error ? { error } : {}), send }}
          asker="Your decision"
          framed={false}
        />
      </ManagerAskText>
    </ManagerCard>
  )
}

const THINKING_DELAYS = ['0ms', '160ms', '320ms']

/** A reply with no words yet: without it the row is a bare timestamp, and a phone keyboard hides
 *  the footer spinner. Not a live region — the announcer speaks once the reply settles. */
function Thinking() {
  return (
    <p data-slot="manager-thinking" className="flex items-baseline gap-1 text-sm text-muted-foreground">
      Thinking<span className="sr-only">…</span>
      <span aria-hidden="true" className="inline-flex gap-0.5">
        {THINKING_DELAYS.map((delay) => (
          <span key={delay} style={{ animationDelay: delay }} className="size-1 rounded-full bg-current animate-pulse motion-reduce:animate-none" />
        ))}
      </span>
    </p>
  )
}

function AssistantMessage({
  message,
  origin,
  projects,
  answerOnCard,
  superseded = false,
  authLive = true,
  onRetry,
  planUsage,
}: {
  message: Extract<ManagerMessage, { kind: 'assistant' }>
  origin: ManagerOrigin
  projects: readonly ManagerReferenceProject[]
  answerOnCard: boolean
  superseded?: boolean
  /** The newest failure on its account: the live card. Older ones collapse to a quiet line. */
  authLive?: boolean
  onRetry?: (() => void) | undefined
  /** This reply's plan-limit estimate; absent when the ledger has none (never shown as 0). */
  planUsage?: ReplyUsage | undefined
}) {
  const segments = useMemo(
    () => parseManagerText(message.text, message.commands, projects),
    [message.text, message.commands, projects],
  )
  const references = useMemo(() => managerReferences(segments), [segments])
  return (
    <article data-slot="manager-assistant" data-message-id={message.id} className="min-w-0">
      <p data-slot="manager-message-meta" className="mb-1 flex items-baseline gap-2 text-xs text-muted-foreground">
        {message.turn === 'job' && message.jobName ? <span className="font-medium">{message.automationReport ? 'Automation' : 'Job'}: {message.jobName}</span> : null}
        {message.taskReport ? <span className="font-medium">Task update</span> : message.turn === 'watch' ? <span className="font-medium">Watch check</span> : null}
        <time dateTime={message.at} title={new Date(message.at).toLocaleString()}>{managerMessageTime(message.at)}</time>
      </p>
      {message.important ? (
        <p data-slot="manager-important" className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <BellRingIcon aria-hidden="true" className="size-3.5 text-pending-strong" />
          {message.headline ?? 'Important'}
        </p>
      ) : null}
      <CommandsRow commands={message.commands} />
      {message.streaming && message.text.trim() === '' ? <Thinking /> : null}
      <OriginContext.Provider value={origin}>
        <ReferenceStatusProvider requests={references}>
          <ClampedBody clamp={message.taskReport !== undefined && isLong(message.text)}>
            {segments.map((segment, index) =>
              segment.kind === 'markdown' ? (
                <Markdown key={index} components={MARKDOWN_COMPONENTS}>{segment.text}</Markdown>
              ) : (
                <SessionCard key={index} projectId={segment.projectId} runId={segment.runId} origin={origin} />
              ),
            )}
          </ClampedBody>
        </ReferenceStatusProvider>
      </OriginContext.Provider>
      {message.ask ? (
        <div className="mt-3 max-w-2xl">
          <ManagerQuestions source={<DecisionSources message={message} origin={origin} />} origin={origin} messageId={message.id} ask={message.ask} answer={message.askAnswer} answerOnCard={answerOnCard} closed={message.askClosed} stale={message.askStale} superseded={superseded} />
        </div>
      ) : null}
      {message.stopped ? <p className="mt-1 text-sm text-muted-foreground italic">Response stopped.</p> : null}
      {message.resumeAt ? <ResumeHint managerId={origin.id} at={message.resumeAt} /> : null}
      {message.authFailure && message.turn === 'chat' ? (
        // The reconnect card replaces the red line (spec 2026-11-18-inline-account-reconnect).
        authLive ? (
          <ReconnectCard provider={message.authFailure.provider} profileId={message.authFailure.profileId} place="manager" />
        ) : (
          <ReconnectedLine provider={message.authFailure.provider} profileId={message.authFailure.profileId} signedOutHere />
        )
      ) : message.reconnectedAt ? (
        <ReconnectedLine provider={message.reconnectedFrom?.provider} profileId={message.reconnectedFrom?.profileId} at={message.reconnectedAt} />
      ) : message.error && message.turn !== 'chat' ? (
        <CheckFailedCard managerId={origin.id} turn={message.turn} jobName={message.jobName} error={message.error} at={message.at} />
      ) : message.error ? (
        // No `role="alert"`: a chat opened on old failures must not shout them all; the announcer says new ones.
        <p data-slot="manager-error" className="mt-1 flex items-start gap-1.5 text-sm text-danger">
          <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {message.error}
            {onRetry ? (
              <>
                {' '}
                <button type="button" data-action="manager-retry" className="font-medium text-foreground underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={onRetry}>
                  Try again
                </button>
              </>
            ) : null}
          </span>
        </p>
      ) : null}
      {planUsage && !message.streaming ? <ReplyUsageNote usage={planUsage} /> : null}
    </article>
  )
}

/** What the chat around a row can do for it: open the gear on the account picker. Absent in a
 *  bare render, where the button that needs it stays away. */
export interface ManagerChatActions {
  switchAccount?: () => void
  /** Set while the manager is inactive: confirm reactivating it for this answer (spec 2026-11-19-manager-deactivate). */
  confirmReactivate?: (answer: string) => Promise<boolean>
}

export const ManagerChatActionsContext = createContext<ManagerChatActions>({})

/**
 * A watch or job turn that failed (design, Proposal 10): a cause in words, the raw message under
 * it, and the two things the user can do. Replaces the red line that said "claude CLI exited with
 * code 1" under "Watch check". The next check retries by itself (spec, Watching).
 */
function CheckFailedCard({ managerId, turn, jobName, error, at }: { managerId: string; turn: 'watch' | 'job'; jobName: string | undefined; error: string; at: string }) {
  const cause = checkFailureCause(error)
  const actions = useContext(ManagerChatActionsContext)
  const [retrying, setRetrying] = useState(false)
  const retry = () => {
    setRetrying(true)
    checkManager(managerId)
      .then(() => toast('Check started'))
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
      .finally(() => setRetrying(false))
  }
  return (
    <ManagerCard
      data-slot="manager-check-failed"
      data-cause={cause.kind}
      aria-label={turn === 'job' ? 'Job failed' : 'Check failed'}
      tone="danger"
      className="mt-2"
      icon={<StatusDot tone="danger" />}
      title={turn === 'job' ? `Job failed${jobName ? `: ${jobName}` : ''}` : 'Check failed'}
      status={<time dateTime={at}>{managerMessageTime(at)}</time>}
      actions={(
        <>
          <Button variant="outline" size="sm" disabled={retrying} onClick={retry}>Retry now</Button>
          {cause.switchAccount && actions.switchAccount ? (
            <Button variant="ghost" size="sm" onClick={actions.switchAccount}>Switch account</Button>
          ) : null}
        </>
      )}
    >
      <p>{cause.sentence} {turn === 'job' ? 'It runs again on its own interval.' : 'The next check retries.'}</p>
      <p data-slot="manager-check-failed-raw" className="font-mono text-xs break-words text-muted-foreground">{error}</p>
    </ManagerCard>
  )
}

const CLAMP_LINES = 8
const CLAMP_CHARS = 600

/** A task card's final message can run long: the first lines, then the rest on request. */
const isLong = (text: string): boolean => text.length > CLAMP_CHARS || text.split('\n').length > CLAMP_LINES

function ClampedBody({ clamp, children }: { clamp: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  if (!clamp) return <>{children}</>
  return (
    <div data-slot="manager-task-report" data-expanded={expanded}>
      <div className={cn('relative', !expanded && 'max-h-56 overflow-hidden')}>
        {children}
        {expanded ? null : <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background" />}
      </div>
      <button
        type="button"
        data-action="manager-task-report-expand"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="mt-1 text-xs font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
      >
        {expanded ? 'Show less' : 'Show the whole message'}
      </button>
    </div>
  )
}

/** A usage limit ended the turn: it is waiting, not broken — the task view's auto-resume hint. */
function ResumeHint({ managerId, at }: { managerId: string; at: string }) {
  const [pending, setPending] = useState(false)
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return null
  const label = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(date)
  const cancel = () => {
    setPending(true)
    stopManager(managerId)
      .then(() => toast('This manager will not resume itself'))
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
      .finally(() => setPending(false))
  }
  return (
    <p data-slot="manager-resume-hint" className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <StatusDot tone="pending" pulse />
      <span>
        Usage limit reached — resumes automatically at{' '}
        <time dateTime={at} className="font-medium text-foreground">{label}</time>
      </span>
      <button
        type="button"
        data-action="manager-resume-cancel"
        disabled={pending}
        onClick={cancel}
        className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground disabled:opacity-50"
      >
        Don’t resume
      </button>
    </p>
  )
}

/** One chat row. Memoized: a streaming reply re-renders only the message that grew. */
export const ManagerMessageRow = memo(function ManagerMessageRow({
  message,
  origin,
  onDecide,
  projects = NO_PROJECTS,
  answerOnCard = false,
  superseded = false,
  authLive = true,
  onRetry,
  planUsage,
}: {
  message: ManagerMessage
  origin: ManagerOrigin
  /** False for an older failure on an account whose newest failure draws the live card. */
  authLive?: boolean
  /** Sends the question again; only the newest failed chat reply has one. */
  onRetry?: (() => void) | undefined
  /** An answered card whose answer, the next message, is drawn here and not as its own row. */
  answerOnCard?: boolean
  /** Connected projects: what a bare `#12` or a GitHub URL resolves against. */
  projects?: readonly ManagerReferenceProject[]
  /** Whether this question card is superseded by a newer card with the same header. */
  superseded?: boolean
  /** This reply's plan-limit estimate (spec 2026-11-20-manager-plan-usage-popover, restored 2026-11-22). */
  planUsage?: ReplyUsage | undefined
  onDecide: DecideAction
}) {
  return (
    <ManagerProjectsContext.Provider value={projects}>
      <MessageBody message={message} origin={origin} onDecide={onDecide} projects={projects} answerOnCard={answerOnCard} superseded={superseded} authLive={authLive} onRetry={onRetry} planUsage={planUsage} />
    </ManagerProjectsContext.Provider>
  )
})

function MessageBody({
  message,
  origin,
  onDecide,
  projects,
  answerOnCard,
  superseded,
  authLive,
  onRetry,
  planUsage,
}: {
  message: ManagerMessage
  origin: ManagerOrigin
  onRetry: (() => void) | undefined
  planUsage: ReplyUsage | undefined
  answerOnCard: boolean
  superseded: boolean
  authLive: boolean
  projects: readonly ManagerReferenceProject[]
  onDecide: DecideAction
}) {
  switch (message.kind) {
    case 'user':
      return (
        <div data-slot="manager-user" data-message-id={message.id} className="flex flex-col items-end gap-2">
          {message.text ? (
            <p data-slot="manager-user-bubble" className="max-w-[80%] rounded-xl bg-muted px-4 py-2.5 text-sm break-words whitespace-pre-wrap">{message.text}</p>
          ) : null}
          {message.attachments ? <UserAttachments managerId={origin.id} attachments={message.attachments} /> : null}
        </div>
      )
    case 'assistant':
      return <AssistantMessage message={message} origin={origin} projects={projects} answerOnCard={answerOnCard} superseded={superseded} authLive={authLive} onRetry={onRetry} planUsage={planUsage} />
    case 'action':
      return <ActionCard origin={origin} message={message} onDecide={onDecide} />
    case 'notice':
      if (message.activity) return <ActivityNotice at={message.at} activity={message.activity} />
      return <p data-slot="manager-notice" className="text-center text-xs text-muted-foreground">{message.text}</p>
  }
}

const count = (value: number | undefined, noun: string) => (value === undefined ? null : <span><b className="font-semibold text-foreground">{value}</b> {noun}{value === 1 ? '' : 's'}</span>)

/** The deactivate and reactivate lines (spec 2026-11-19-manager-deactivate, design § 02): a divider,
 *  and after a reactivation the "While inactive" counts the server posted. */
function ActivityNotice({ at, activity }: { at: string; activity: ManagerActivityNotice }) {
  const reactivated = activity.change === 'reactivated'
  const Icon = reactivated ? PlayIcon : PowerIcon
  const time = managerMessageTime(at)
  const counted = [activity.taskUpdates, activity.automationReports, activity.checksSkipped, activity.jobRunsSkipped].some((value) => value !== undefined)
  return (
    <div data-slot="manager-activity-notice" data-change={activity.change} className="flex flex-col gap-2.5">
      <p role="separator" className="flex items-center gap-2.5 text-meta text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        {reactivated ? 'Reactivated' : 'Deactivated'} by you · {time}
      </p>
      {reactivated && counted ? (
        <div data-slot="manager-activity-summary" className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-xl border border-dashed border-border px-3 py-2.5 text-label text-muted-foreground">
          <ClockIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <b className="font-semibold text-foreground">While inactive{activity.since ? ` (${managerMessageTime(activity.since)} → ${time})` : ''}</b>
          {count(activity.taskUpdates, 'task update')}
          {count(activity.automationReports, 'automation report')}
          {count(activity.checksSkipped, 'check')}{activity.checksSkipped !== undefined ? ' skipped' : null}
          {count(activity.jobRunsSkipped, 'job run')}{activity.jobRunsSkipped !== undefined ? ' skipped' : null}
          {activity.catchUp ? <span>catching up now</span> : null}
          <span className="text-muted-foreground">{activity.catchUp ? 'summary posted by cezar · the catch-up check is one model call' : 'posted by cezar · no model call'}</span>
        </div>
      ) : null}
    </div>
  )
}
